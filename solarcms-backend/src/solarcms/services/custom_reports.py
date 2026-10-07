"""Custom reports: any Devices' readings, across Plants, at the interval the client picks.

The table this builds is the same `ReportTable` the standard reports build, so
the preview, CSV, Excel and PDF are rendered by the same code and cannot
disagree (CLAUDE.md, "The Reports screen previews what it downloads").

Everything is read through the request's RLS session: a Device the caller
cannot see is refused by name, never silently left out, and a saved report run
by someone else shows them only what they may see.

Values come from the 15-minute or 1-minute tier (`domain/custom_reports.plan`),
re-bucketed to the chosen interval on the **first Plant's clock**. A bucket
flagged for a rejected value is left out of every summary and counted in the
notes (Guardrail 23); an interval nobody reported is empty, never zero.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.custom_reports import LABELS, ReportTooLarge, changes, plan, summary_for
from solarcms.domain.periods import report_window
from solarcms.domain.tiering import Tier
from solarcms.schemas.reports import CustomReportDefinition
from solarcms.services.report_tables import Column, PlantInfo, ReportTable, period_notes


class ReportRefused(ValueError):
    """A definition that cannot be run, with a sentence the reader can act on."""


def _digits(unit: str | None) -> int:
    # Power factor (`ratio`) to two decimals, as on every screen.
    return 0 if unit in ("count", "code", "bool") else 2


async def catalog(session: AsyncSession, plant_ids: list[int]) -> dict[str, Any]:
    """The Devices of the chosen Plants and the readings each one sends."""
    plants = (await session.execute(text("""
        SELECT p.id, p.code, p.name, p.timezone, c.code AS client_code
          FROM plants p JOIN clients c ON c.id = p.client_id
         WHERE p.id = ANY(:ids) ORDER BY p.code
    """), {"ids": plant_ids})).all()
    visible = [p.id for p in plants]
    devices = (await session.execute(text("""
        SELECT d.id, d.code, d.name, d.plant_id, dt.code AS type_code, dt.name AS type_name
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt ON dt.id = dm.device_type_id
         WHERE d.plant_id = ANY(:ids) AND d.status <> 'decommissioned'
         ORDER BY d.plant_id, dt.code, d.code
    """), {"ids": visible})).all()
    device_ids = [d.id for d in devices]
    tags: dict[int, list[dict[str, Any]]] = defaultdict(list)
    if device_ids:
        # Every Tag a Device is bound to — and the calculated ones it has
        # actually produced in the last week, which have no binding of their own.
        rows = (await session.execute(text("""
            SELECT DISTINCT x.device_id, t.code, t.name, t.unit, t.category, t.is_cumulative
              FROM (
                    SELECT b.device_id, b.tag_id FROM device_tag_bindings b
                     WHERE b.device_id = ANY(:ids) AND b.enabled
                    UNION
                    SELECT a.device_id, a.tag_id FROM agg_1h_v a
                      JOIN tags f ON f.id = a.tag_id AND f.formula IS NOT NULL
                     WHERE a.device_id = ANY(:ids) AND a.bucket > now() - interval '7 days'
                   ) x
              JOIN tags t ON t.id = x.tag_id
             ORDER BY x.device_id, t.code
        """), {"ids": device_ids})).all()
        for row in rows:
            tags[row.device_id].append({
                "code": row.code, "name": row.name, "unit": row.unit,
                "category": row.category, "cumulative": row.is_cumulative,
            })
    return {
        "plants": [{"id": p.id, "code": p.code, "name": p.name, "timezone": p.timezone,
                    "client_code": p.client_code} for p in plants],
        "devices": [{"id": d.id, "code": d.code, "name": d.name, "plant_id": d.plant_id,
                     "type_code": d.type_code, "type_name": d.type_name,
                     "tags": tags.get(d.id, [])} for d in devices],
    }


async def build(
    session: AsyncSession, definition: CustomReportDefinition, now: datetime,
) -> ReportTable:
    """The table a custom report shows and downloads."""
    device_ids = sorted({s.device_id for s in definition.series})
    devices = {
        row.id: row for row in (await session.execute(text("""
            SELECT d.id, d.code, d.plant_id, p.code AS plant_code, p.name AS plant_name,
                   p.timezone, p.client_id
              FROM devices d JOIN plants p ON p.id = d.plant_id
             WHERE d.id = ANY(:ids)
        """), {"ids": device_ids})).all()
    }
    missing = [i for i in device_ids if i not in devices]
    if missing:
        raise ReportRefused(
            f"{len(missing)} of the chosen Devices {'is' if len(missing) == 1 else 'are'} "
            "not visible to you any more; "
            "remove them from the report and run it again.")
    tag_codes = sorted({s.tag_code for s in definition.series})
    tags = {
        row.code: row for row in (await session.execute(text("""
            SELECT id, code, name, unit, rollup_method, is_cumulative
              FROM tags WHERE code = ANY(:codes)
        """), {"codes": tag_codes})).all()
    }
    unknown = [c for c in tag_codes if c not in tags]
    if unknown:
        raise ReportRefused(f"There is no reading called {', '.join(unknown)}.")

    # The first Plant's clock decides the days and the interval boundaries.
    first = devices[definition.series[0].device_id]
    zone = ZoneInfo(first.timezone)
    try:
        window = report_window(definition.period, now, zone, definition.from_date,
                               definition.to_date, definition.from_time, definition.to_time)
    except ValueError as exc:
        raise ReportRefused(str(exc)) from exc
    try:
        report_plan = plan(definition.interval_minutes, window.start, window.end,
                           len(definition.series), now)
    except ReportTooLarge as exc:
        raise ReportRefused(str(exc)) from exc

    view = f"{report_plan.tier}_v"
    rows = (await session.execute(text(f"""
        SELECT time_bucket(make_interval(mins => CAST(:interval AS integer)), a.bucket,
                           CAST(:zone AS text), CAST(:origin AS timestamptz)) AS interval_start,
               a.device_id, a.tag_id,
               sum(a.avg_value * a.sample_count) FILTER (WHERE good)
                 / NULLIF(sum(a.sample_count) FILTER (WHERE good), 0) AS avg_v,
               min(a.min_value) FILTER (WHERE good) AS min_v,
               max(a.max_value) FILTER (WHERE good) AS max_v,
               last(a.last_value, a.bucket) FILTER (WHERE good) AS last_v,
               first(a.min_value, a.bucket) FILTER (WHERE good) AS first_v,
               count(*) FILTER (WHERE NOT good) AS flagged
          FROM (SELECT *, COALESCE(worst_quality, 0) = 0 AS good FROM {view}
                 WHERE device_id = ANY(:devices) AND tag_id = ANY(:tags)
                   AND bucket >= :start AND bucket < :end) a
         GROUP BY 1, 2, 3
    """), {"interval": definition.interval_minutes, "zone": first.timezone,
           "origin": window.start, "devices": device_ids,
           "tags": [tags[c].id for c in tag_codes], "start": window.start,
           "end": window.end})).all()

    by_series: dict[tuple[int, int], dict[datetime, Any]] = defaultdict(dict)
    flagged = 0
    for row in rows:
        # Not `row.t`: on a SQLAlchemy Row that is the row itself, as a tuple.
        by_series[(row.device_id, row.tag_id)][row.interval_start] = row
        flagged += int(row.flagged or 0)

    times = [window.start + report_plan.interval * i for i in range(report_plan.rows)]
    # The Plant is named in a heading only when there is more than one to tell apart.
    several_plants = len({d.plant_id for d in devices.values()}) > 1
    columns = [Column("time", "Time", "datetime")]
    table_rows: list[dict[str, Any]] = [
        {"time": moment.astimezone(zone).isoformat()} for moment in times]
    summaries: dict[str, list[str]] = defaultdict(list)
    for index, ref in enumerate(definition.series):
        device = devices[ref.device_id]
        tag = tags[ref.tag_code]
        how = summary_for(tag.rollup_method, tag.is_cumulative, definition.aggregation)
        key = f"c{index}"
        columns.append(Column(
            key,
            f"{device.plant_code} · {device.code} · {tag.name}" if several_plants
            else f"{device.code} · {tag.name}",
            "count" if tag.unit in ("count", "code", "bool") else "number",
            "" if tag.unit in ("code", "bool") else (tag.unit or ""), _digits(tag.unit)))
        summaries[LABELS[how]].append(tag.name)
        series = by_series.get((ref.device_id, tag.id), {})
        if how == "change":
            lasts = [_float(series[t].last_v) if t in series else None for t in times]
            firsts = [_float(series[t].first_v) if t in series else None for t in times]
            values = changes(lasts, firsts)
        else:
            column = {"avg": "avg_v", "min": "min_v", "max": "max_v", "last": "last_v"}[how]
            values = [_float(getattr(series[t], column)) if t in series else None for t in times]
        for row_index, value in enumerate(values):
            table_rows[row_index][key] = value

    plant_codes = sorted({d.plant_code for d in devices.values()})
    info = PlantInfo(
        id=first.plant_id, client_id=first.client_id,
        code=(plant_codes[0] if len(plant_codes) == 1
              else f"{plant_codes[0]}+{len(plant_codes) - 1}"),
        name=first.plant_name if len(plant_codes) == 1 else f"{len(plant_codes)} Plants",
        timezone=first.timezone, dc_kwp=None, ac_kw=None,
    )
    table = ReportTable(
        kind="custom", plant=info, window=window, columns=columns, rows=table_rows,
        source_tier=report_plan.tier, title_text=definition.name or "Custom report",
    )
    interval_text = _interval_text(definition.interval_minutes)
    table.notes.insert(0, f"One row every {interval_text}, showing " + "; ".join(
        f"the {label} of {', '.join(sorted(set(names))[:4])}"
        f"{' and others' if len(set(names)) > 4 else ''}"
        for label, names in summaries.items()) + ".")
    if definition.aggregation == "change" and LABELS["change"] not in summaries:
        table.notes.append("“Change” applies to registers only; none of these readings is one, "
                           "so each keeps its own summary.")
    zones = {d.timezone for d in devices.values()}
    if len(zones) > 1:
        table.notes.append(f"The chosen Plants keep different clocks; every time here is "
                           f"{first.plant_code}'s ({first.timezone}).")
    if flagged:
        table.notes.append(f"{flagged:,} {report_plan.tier.removeprefix('agg_')} period(s) held "
                           "a rejected value and were left out of the figures.")
    table.notes[:0] = period_notes(table, now, [("readings", Tier(report_plan.tier))])
    return table


def _float(value: Any) -> float | None:
    return None if value is None else float(value)


def _interval_text(minutes: int) -> str:
    if minutes % (24 * 60) == 0:
        days = minutes // (24 * 60)
        return "day" if days == 1 else f"{days} days"
    if minutes % 60 == 0:
        hours = minutes // 60
        return "hour" if hours == 1 else f"{hours} hours"
    return "minute" if minutes == 1 else f"{minutes} minutes"
