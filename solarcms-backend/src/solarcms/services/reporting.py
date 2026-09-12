"""Report rendering: query the aggregate tiers, produce XLSX and PDF.

BACKEND_SPEC §13 Phase 9, MASTER §6.6.

Two rules shape everything here:

* **Reports render from aggregate tiers, never raw `readings`.** A monthly
  all-Plant Report is a query over `agg_1d`, not a scan of billions of rows.
* **I-11: Financial Reports are computed from ABT Meter Readings, never MFM.**
  The ABT Meter is the sealed, revenue-grade settlement instrument; an MFM is
  operational monitoring with no commercial standing. A Financial Report with no
  ABT Meter available *fails* rather than falling back — producing an invoice
  figure from the wrong instrument is worse than producing none.

PDF rendering uses WeasyPrint, which is an optional extra (`pip install -e
".[reports]"`) because it needs system pango/cairo. When it is absent the XLSX is
still produced and the PDF is reported as unavailable, rather than the whole run
failing: a Report that arrives in one format beats a Report that does not arrive.
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import structlog
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.formulas import co2_avoided_kg, cuf, performance_ratio, specific_yield
from solarcms.domain.tiering import Tier

log = structlog.get_logger(__name__)

# Device Types whose Readings may be used for a Financial Report (I-11).
SETTLEMENT_DEVICE_TYPES = ("ABT_METER",)


class FinancialSourceUnavailable(RuntimeError):
    """A Financial Report was requested but no ABT Meter Reading is available."""


@dataclass
class ReportData:
    definition_code: str
    title: str
    period_start: datetime
    period_end: datetime
    tier: Tier
    rows: list[dict[str, Any]] = field(default_factory=list)
    kpis: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


async def gather(
    session: AsyncSession, *, definition_id: int, period_start: datetime,
    period_end: datetime, client_id: int,
) -> ReportData:
    """Collect the data one Report needs, from the correct tier."""
    definition = (await session.execute(text("""
        SELECT code, name, query_spec, is_financial
          FROM report_definitions WHERE id = :id
    """), {"id": definition_id})).first()
    if definition is None:
        raise ValueError(f"report definition {definition_id} not found")

    spec = definition.query_spec or {}
    # Daily granularity for anything month-scale or longer; hourly below that.
    span_days = (period_end - period_start).days
    tier = Tier.AGG_1D if span_days > 31 else Tier.AGG_1H

    data = ReportData(
        definition_code=definition.code, title=definition.name,
        period_start=period_start, period_end=period_end, tier=tier,
    )

    device_filter = ""
    if definition.is_financial:
        # I-11 enforced in the query itself, not by a caller remembering to pass
        # the right device_ids.
        device_filter = """
            AND d.device_model_id IN (
                SELECT dm.id FROM device_models dm
                  JOIN device_types dt ON dt.id = dm.device_type_id
                 WHERE dt.code = ANY(:settlement_types))
        """
        data.notes.append(
            "Financial Report: computed exclusively from ABT Meter Readings (I-11). "
            "MFM Readings are excluded regardless of availability."
        )

    params: dict[str, Any] = {
        "start": period_start, "end": period_end,
        "settlement_types": list(SETTLEMENT_DEVICE_TYPES),
        "energy_tag": spec.get("energy_tag", "ENERGY_EXPORT_TOTAL"),
        "client_id": client_id,
    }

    rows = (await session.execute(text(f"""
        SELECT p.code AS plant_code, d.code AS device_code, t.code AS tag_code,
               t.unit,
               min(a.bucket) AS first_bucket, max(a.bucket) AS last_bucket,
               min(a.last_value) AS first_value, max(a.last_value) AS last_value,
               avg(a.avg_value) AS mean_value, max(a.max_value) AS peak_value,
               sum(a.sample_count) AS samples
          FROM {tier.value}_v a
          JOIN devices d ON d.id = a.device_id
          JOIN plants  p ON p.id = d.plant_id
          JOIN tags    t ON t.id = a.tag_id
         WHERE a.bucket >= :start AND a.bucket < :end
           AND t.code = :energy_tag
           -- ⚠ Explicit, and load-bearing. The scheduler runs with platform
           -- privileges because it serves every Client, so the barrier views do
           -- NOT scope these rows — `app_is_platform_admin()` is true and they
           -- return everything. Without this predicate a Report would silently
           -- include other Clients' generation, and a Financial Report would
           -- invoice against another Client's meter.
           AND d.client_id = :client_id
           {device_filter}
         GROUP BY p.code, d.code, t.code, t.unit
         ORDER BY p.code, d.code
    """), params)).all()

    if definition.is_financial and not rows:
        raise FinancialSourceUnavailable(
            "no ABT Meter Readings exist for this period; a Financial Report cannot "
            "be produced from an MFM (I-11)"
        )

    data.rows = [dict(row._mapping) for row in rows]

    total_energy = sum(
        float(r["last_value"] or 0) - float(r["first_value"] or 0) for r in data.rows
    )
    plant = (await session.execute(text("""
        SELECT sum(dc_capacity_kwp) AS dc, sum(ac_capacity_kw) AS ac,
               max(r.grid_emission_factor_kg_per_kwh) AS grid_factor
          FROM plants p LEFT JOIN regions r ON r.id = p.region_id
         WHERE p.client_id = :client_id AND p.status = 'active'
    """), {"client_id": client_id})).first()

    hours = max((period_end - period_start).total_seconds() / 3600.0, 1.0)
    dc = float(plant.dc if plant and plant.dc else 0.0)
    ac = float(plant.ac if plant and plant.ac else 0.0)
    grid_factor = float(plant.grid_factor) if plant and plant.grid_factor else None

    # Each KPI travels with the formula variant that produced it, so a figure can
    # be identified and recomputed when the client's definitions arrive (OPEN-16).
    for name, result in (
        ("specific_yield", specific_yield(total_energy, dc)),
        ("cuf", cuf(total_energy, ac, hours)),
        ("performance_ratio", performance_ratio(total_energy, 0.0, dc)),
        ("co2_avoided_kg", co2_avoided_kg(total_energy, grid_factor)),
    ):
        data.kpis[name] = {
            "value": result.value, "variant": result.variant,
            "undefined_reason": result.undefined_reason,
        }
    data.kpis["energy_kwh"] = total_energy
    data.notes.append(
        "All KPI formulas are provisional pending OPEN-16; each figure records the "
        "variant used so it can be recomputed when the client supplies theirs."
    )
    data.notes.append(f"Rendered from the {tier.value} tier, never raw readings.")
    return data


def render_xlsx(data: ReportData) -> bytes:
    """Workbook with a summary sheet and a data sheet."""
    book = Workbook()
    summary = book.active
    assert summary is not None
    summary.title = "Summary"

    summary["A1"] = data.title
    summary["A1"].font = Font(size=14, bold=True)
    summary["A2"] = (f"{data.period_start:%d-%m-%Y %H:%M} to "
                     f"{data.period_end:%d-%m-%Y %H:%M}")

    row = 4
    for key, value in data.kpis.items():
        summary.cell(row=row, column=1, value=key.replace("_", " ").title())
        if isinstance(value, dict):
            summary.cell(row=row, column=2,
                         value="—" if value["value"] is None else round(value["value"], 4))
            # The variant is carried into the workbook itself: a figure that
            # leaves the system without its provenance cannot be reconciled later.
            summary.cell(row=row, column=3, value=value["variant"])
            if value.get("undefined_reason"):
                summary.cell(row=row, column=4, value=value["undefined_reason"])
        else:
            summary.cell(row=row, column=2, value=round(float(value), 3))
        row += 1

    row += 1
    for note in data.notes:
        cell = summary.cell(row=row, column=1, value=note)
        cell.alignment = Alignment(wrap_text=True)
        row += 1

    sheet = book.create_sheet("Data")
    headers = ["Plant", "Device", "Tag", "Unit", "First", "Last", "Delta",
               "Mean", "Peak", "Samples"]
    for column, header in enumerate(headers, start=1):
        cell = sheet.cell(row=1, column=column, value=header)
        cell.font = Font(bold=True)
    for index, record in enumerate(data.rows, start=2):
        first = float(record["first_value"] or 0)
        last = float(record["last_value"] or 0)
        for column, value in enumerate([
            record["plant_code"], record["device_code"], record["tag_code"],
            record["unit"], first, last, last - first,
            float(record["mean_value"] or 0), float(record["peak_value"] or 0),
            int(record["samples"] or 0),
        ], start=1):
            sheet.cell(row=index, column=column, value=value)
    for column in range(1, len(headers) + 1):
        sheet.column_dimensions[get_column_letter(column)].width = 16

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def render_html(data: ReportData) -> str:
    """The PDF source. Kept separate so it is renderable without WeasyPrint."""
    def kpi_row(name: str, value: Any) -> str:
        if isinstance(value, dict):
            shown = "—" if value["value"] is None else f"{value['value']:.4f}"
            note = value.get("undefined_reason") or value["variant"]
            return f"<tr><td>{name}</td><td>{shown}</td><td>{note}</td></tr>"
        return f"<tr><td>{name}</td><td>{float(value):.3f}</td><td></td></tr>"

    rows = "".join(
        f"<tr><td>{r['plant_code']}</td><td>{r['device_code']}</td>"
        f"<td>{r['tag_code']}</td><td>{r['unit']}</td>"
        f"<td>{float(r['last_value'] or 0) - float(r['first_value'] or 0):.2f}</td></tr>"
        for r in data.rows
    )
    kpis = "".join(kpi_row(k.replace("_", " ").title(), v) for k, v in data.kpis.items())
    notes = "".join(f"<li>{n}</li>" for n in data.notes)
    # Dates as DD-MM-YYYY per tender §28.
    return f"""<!doctype html><html><head><meta charset="utf-8">
<style>
 body {{ font-family: sans-serif; font-size: 11px; margin: 24px; }}
 h1 {{ font-size: 18px; margin-bottom: 2px; }}
 .period {{ color: #555; margin-bottom: 16px; }}
 table {{ border-collapse: collapse; width: 100%; margin-bottom: 18px; }}
 th, td {{ border: 1px solid #ccc; padding: 4px 6px; text-align: left; }}
 th {{ background: #f2f2f2; }}
 .notes {{ color: #555; font-size: 10px; }}
</style></head><body>
<h1>{data.title}</h1>
<div class="period">{data.period_start:%d-%m-%Y %H:%M} to {data.period_end:%d-%m-%Y %H:%M}
 &middot; source tier: {data.tier.value}</div>
<h2>Key figures</h2>
<table><tr><th>Metric</th><th>Value</th><th>Variant / note</th></tr>{kpis}</table>
<h2>Detail</h2>
<table><tr><th>Plant</th><th>Device</th><th>Tag</th><th>Unit</th><th>Delta</th></tr>
{rows}</table>
<ul class="notes">{notes}</ul>
</body></html>"""


def render_pdf(data: ReportData) -> bytes | None:
    """PDF, or None when WeasyPrint is unavailable.

    Returning None rather than raising: the XLSX has already been produced by the
    time this runs, and failing the whole run over an optional system dependency
    would withhold a Report that is otherwise complete.
    """
    try:
        from weasyprint import HTML
    except ImportError:
        log.warning("weasyprint unavailable; PDF skipped",
                    hint='install with: pip install -e ".[reports]"')
        return None
    return bytes(HTML(string=render_html(data)).write_pdf())
