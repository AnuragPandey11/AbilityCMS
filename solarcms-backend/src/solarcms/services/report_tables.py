"""Report tables — one Plant, one run of days, one table.

The Reports screen's live preview, and the CSV, Excel and PDF downloads beside
it, from a single computation — so a file is always exactly what the screen
showed. Five kinds, after the client's reference screen:

    daily_plant    one row per Plant-local day
    monthly_plant  one row per calendar month the period touches
    inverter       one row per Inverter
    weather        one row per day, from the Weather Station
    alarm          one row per Alarm opened in the period

This is not `services/reporting`, which renders a *Client's* Report definitions
out of band for the scheduler, settlement included. This answers while the
reader waits, for one Plant, and never produces a Financial Report: I-11 keeps
those on the ABT-only path, where no fallback exists to be taken by accident.

Rules held here, each for a reason recorded elsewhere:

* **Aggregates only, through the `_v` views** (MASTER §6.6, migrations
  0008/0010) — the API holds no privilege on the telemetry relations.
* **Energy is the KPI screen's figure**: `domain/counters`, one Device Type
  per Plant by `PLANT_ENERGY_COUNTER_PRECEDENCE`, refused steps reported.
* **Nothing to read is `None`, never 0.0** — a dash in every format.
* **A per-day breakdown never reads the daily tier.** Its buckets are cut at
  UTC midnight, 05:30 in Kolkata, so a day's energy would land on the next
  local day. `_day_tier` stops at hourly.
* **Peaks and means come from 15-minute buckets whatever the period.** Read
  from the tier `select_tier` picks, "last 30 days" would quote hourly peaks
  and "last 7 days" quarter-hourly ones, and the same day would carry two
  different peaks depending on which button was pressed.
* **Flagged readings are left out of every peak and mean, and counted.** One
  out-of-range value would otherwise *be* the day's maximum (Guardrail 23).

`fetch_*` reads; `build_*` is pure and is what the tests drive.
"""

from __future__ import annotations

import csv
import html
import io
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import structlog
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import (
    PLANT_ENERGY_COUNTER_PRECEDENCE,
    PLANT_FREQUENCY_SOURCE_PRECEDENCE,
    PLANT_IMPORT_COUNTER_PRECEDENCE,
    PLANT_IRRADIATION_SOURCE,
    PLANT_POWER_SOURCE_PRECEDENCE,
    QUALITY_GOOD,
    REPORT_RATIO_CEILING,
)
from solarcms.domain.counters import (
    CounterStep,
    DeviceEnergy,
    DeviceSeries,
    PlantEnergy,
    bucket_steps,
    plant_energy,
    plant_irradiation,
)
from solarcms.domain.formulas import (
    FormulaResult,
    availability,
    cuf,
    performance_ratio,
    specific_yield,
)
from solarcms.domain.health_logic import uptime_seconds_from_events
from solarcms.domain.periods import ReportWindow, local_midnight
from solarcms.domain.tiering import TIERS, Tier, bucket_start, select_tier
from solarcms.services.energy import read_counter_series
from solarcms.services.reporting import BOLD, HEADER_FILL, MUTED

log = structlog.get_logger(__name__)

REPORT_KINDS: dict[str, str] = {
    "daily_plant": "Daily Plant Report",
    "monthly_plant": "Monthly Plant Report",
    "inverter": "Inverter Report",
    "weather": "Weather Report",
    "alarm": "Alarm Report",
}

# An Alarm Report longer than this is cut and says so; a flapping rule can
# open thousands in a month, and past this the table is not being read.
MAX_ALARM_ROWS = 5_000

ColumnKind = Literal["date", "month", "datetime", "text", "number", "percent", "count"]


@dataclass(frozen=True, slots=True)
class Column:
    key: str
    label: str
    kind: ColumnKind = "number"
    unit: str = ""
    digits: int = 1

    @property
    def heading(self) -> str:
        return f"{self.label} ({self.unit})" if self.unit else self.label


@dataclass(frozen=True, slots=True)
class PlantInfo:
    id: int
    client_id: int
    code: str
    name: str
    timezone: str
    dc_kwp: float | None
    ac_kw: float | None

    @property
    def zone(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)


@dataclass
class ReportTable:
    kind: str
    plant: PlantInfo
    window: ReportWindow
    columns: list[Column]
    rows: list[dict[str, Any]]
    notes: list[str] = field(default_factory=list)
    # (row index, column key, why) — a figure shown unaltered but outside what
    # the quantity can physically be (Guardrail 33).
    flags: list[tuple[int, str, str]] = field(default_factory=list)
    source_tier: str | None = None
    truncated: bool = False
    # A custom report's own name; the standard ones are titled by their kind.
    title_text: str | None = None

    def __post_init__(self) -> None:
        # A column of dashes needs its reason stated once, or it reads as a
        # broken Report rather than a Plant with no such instrument
        # (Guardrail 26). Here, so no builder can forget it.
        empty = [c.label for c in self.columns
                 if c.kind in ("number", "percent", "count") and self.rows
                 and all(row.get(c.key) is None for row in self.rows)]
        if empty:
            which = ", ".join(empty)
            self.notes.append(
                f"Nothing reported {which} in the period; "
                f"{'those columns are' if len(empty) > 1 else 'that column is'} empty, "
                "not zero.")

    @property
    def title(self) -> str:
        return self.title_text or REPORT_KINDS.get(self.kind, "Report")

    @property
    def filename_stem(self) -> str:
        window = self.window
        if not window.timed:
            return (f"{self.plant.code}_{self.kind}_"
                    f"{window.first_day:%Y%m%d}_{window.last_day:%Y%m%d}")
        begins, ends = window.from_time or _DAY_BEGINS, window.to_time or _DAY_ENDS
        return (f"{self.plant.code}_{self.kind}_"
                f"{window.first_day:%Y%m%d}T{begins:%H%M}_{window.last_day:%Y%m%d}T{ends:%H%M}")


# How a whole day's edges read beside a clock time chosen for the other end.
_DAY_BEGINS = time(0, 0)
_DAY_ENDS = time(23, 59)


def clock(at: time | None) -> str | None:
    """`HH:MM`, or None for a day's own edge — how a window's times travel."""
    return at.strftime("%H:%M") if at else None


# ── Units and labels ─────────────────────────────────────────────────────────

_UNIT_DISPLAY = {"degC": "°C", "W/m2": "W/m²", "kWh/m2": "kWh/m²"}

_TYPE_NAMES = {"ABT_METER": "ABT Meter", "MFM": "MFM", "INVERTER": "Inverters",
               "WMS": "Weather Station"}


def _source_phrase(type_code: str | None, device_count: int) -> str:
    """"the MFM", "the 17 Inverters summed" — what a figure was read from."""
    if type_code is None:
        return "nothing"
    if type_code == "INVERTER":
        return f"the {device_count} Inverter{'s' if device_count != 1 else ''} summed"
    name = _TYPE_NAMES.get(type_code, type_code)
    return f"the {name}" if device_count <= 1 else f"the {device_count} {name}s summed"


def _energy_label(energy: PlantEnergy) -> str:
    # A meter's register is what left the Plant; an Inverter's is what it
    # made. The reference calls the column "Export energy", which is true only
    # of the first.
    if energy.device_type_code in ("ABT_METER", "MFM"):
        return "Export energy"
    if energy.device_type_code == "INVERTER":
        return "Energy generated"
    return "Energy"


def _energy_note(energy: PlantEnergy, *, per: str) -> str:
    if energy.value is None:
        return ("Energy is not known: " + "; ".join(p.reason for p in energy.passed_over)
                + ".")
    source = _source_phrase(energy.device_type_code, len(energy.devices))
    passed = "".join(f" {p.reason[0].upper()}{p.reason[1:]}." for p in energy.passed_over)
    return (f"Energy is read from {source} ({energy.tag_code}), each step counted to the {per} it "
            f"was read in.{passed} The order — ABT Meter, then MFM, then Inverters — is "
            "provisional until the client says which register is binding (OPEN-14).")


def _tier_resolution(tier: Tier) -> timedelta:
    return next(spec.resolution for spec in TIERS if spec.tier == tier)


def _resolution_phrase(tier: Tier) -> str:
    minutes = int(_tier_resolution(tier).total_seconds() // 60)
    return f"{minutes}-minute" if minutes < 60 else f"{minutes // 60}-hour"


# ── Tiers ────────────────────────────────────────────────────────────────────

def _day_tier(window: ReportWindow, now: datetime) -> Tier:
    """The tier for register series that are split into local days or months:
    whatever `select_tier` picks, but never the daily tier (see the module)."""
    tier = select_tier(window.start, window.end, now, finest=Tier.AGG_1M)
    return Tier.AGG_1H if tier == Tier.AGG_1D else tier


def _stats_tier(window: ReportWindow, now: datetime) -> Tier:
    """15-minute buckets while they are retained, else hourly (see the module)."""
    age = now - window.start
    for spec in TIERS:
        if spec.tier in (Tier.AGG_15M, Tier.AGG_1H, Tier.AGG_1D) and age <= spec.retention:
            return spec.tier
    return Tier.AGG_1D


# ── Reading ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class Stat:
    """One Tag's readings over a span, flagged readings left out."""

    # The highest bucket, summed across the Devices that reported in it — a
    # Plant's power from several Inverters. The bucket's mean for one Device.
    peak_sum: float | None
    mean: float | None
    highest: float | None
    samples: int
    # Buckets holding a flagged reading, left out of every figure above.
    flagged: int = 0
    # The most Devices with a good reading in any one bucket — how many a
    # Plant figure summed. Read from the data, never assumed from the Type.
    devices: int = 1
    # Buckets holding at least one good reading: what coverage counts.
    buckets: int = 0


# A bucket counts only when every reading in it was good. The constant is an
# int from `assumptions`, interpolated rather than bound: asyncpg types a bind
# from its first use, and this appears in several FILTERs.
_GOOD = f"coalesce(a.worst_quality, {int(QUALITY_GOOD)}) = {int(QUALITY_GOOD)}"


async def fetch_plant(session: AsyncSession, plant_id: int) -> PlantInfo | None:
    """The Plant, if this caller can see it — RLS decides, as everywhere."""
    row = (await session.execute(text("""
        SELECT id, client_id, code, name, timezone, dc_capacity_kwp, ac_capacity_kw
          FROM plants WHERE id = :plant_id
    """), {"plant_id": plant_id})).first()
    if row is None:
        return None
    zone = row.timezone or "UTC"
    try:
        ZoneInfo(zone)
    except (ValueError, ZoneInfoNotFoundError):
        # A zone the tz database does not know must not fail the Report; the
        # Report then says UTC, which is what its days are counted in.
        log.warning("unknown plant timezone; reporting in UTC", plant_id=plant_id, zone=zone)
        zone = "UTC"
    return PlantInfo(
        id=row.id, client_id=row.client_id, code=row.code, name=row.name,
        timezone=zone,
        dc_kwp=float(row.dc_capacity_kwp) if row.dc_capacity_kwp else None,
        ac_kw=float(row.ac_capacity_kw) if row.ac_capacity_kw else None,
    )


async def fetch_day_stats(
    session: AsyncSession, plant: PlantInfo, window: ReportWindow, tier: Tier,
    pairs: Sequence[tuple[str, str]],
) -> dict[tuple[str, str], dict[date, Stat]]:
    """Per (Device Type, Tag), per Plant-local day: peak, mean, highest.

    Two levels because a Plant's power from twelve Inverters is a sum *per
    bucket*: summing each Inverter's own peak would add maxima that happened
    at different times. The relation is the `Tier` enum's, never a caller's.
    """
    rows = (await session.execute(text(f"""
        WITH per_bucket AS (
            SELECT dt.code AS type_code, t.code AS tag_code, a.bucket,
                   sum(a.avg_value) FILTER (WHERE {_GOOD})                  AS summed,
                   sum(a.avg_value * a.sample_count) FILTER (WHERE {_GOOD}) AS weighted,
                   sum(a.sample_count) FILTER (WHERE {_GOOD})               AS samples,
                   max(a.max_value) FILTER (WHERE {_GOOD})                  AS highest,
                   count(*) FILTER (WHERE NOT {_GOOD})                      AS flagged,
                   count(*) FILTER (WHERE {_GOOD})                          AS devices
              FROM {tier.value}_v a
              JOIN devices d        ON d.id = a.device_id
              JOIN device_models dm ON dm.id = d.device_model_id
              JOIN device_types dt  ON dt.id = dm.device_type_id
              JOIN tags t           ON t.id = a.tag_id
             WHERE d.plant_id = :plant_id
               AND a.bucket >= :start AND a.bucket < :end
               AND (dt.code || ':' || t.code) = ANY(:pairs)
             GROUP BY dt.code, t.code, a.bucket
        )
        SELECT type_code, tag_code,
               CAST(bucket AT TIME ZONE CAST(:tz AS text) AS date) AS day,
               max(summed)                           AS peak_sum,
               sum(weighted) / NULLIF(sum(samples), 0) AS mean,
               max(highest)                          AS highest,
               coalesce(sum(samples), 0)             AS samples,
               coalesce(sum(flagged), 0)             AS flagged,
               coalesce(max(devices), 0)             AS devices,
               count(*) FILTER (WHERE samples > 0)   AS buckets
          FROM per_bucket
         GROUP BY 1, 2, 3
    """), {"plant_id": plant.id, "start": window.start, "end": window.end,
           "tz": plant.timezone,
           "pairs": [f"{type_code}:{tag_code}" for type_code, tag_code in pairs]})).all()

    result: dict[tuple[str, str], dict[date, Stat]] = {}
    for row in rows:
        result.setdefault((row.type_code, row.tag_code), {})[row.day] = Stat(
            peak_sum=_float(row.peak_sum), mean=_float(row.mean),
            highest=_float(row.highest), samples=int(row.samples),
            flagged=int(row.flagged), devices=int(row.devices), buckets=int(row.buckets))
    return result


async def fetch_device_stats(
    session: AsyncSession, plant: PlantInfo, window: ReportWindow, tier: Tier,
    device_ids: Sequence[int], tags: Sequence[str],
) -> dict[tuple[int, str], Stat]:
    """Per (Device, Tag) over the whole window: highest and mean."""
    if not device_ids:
        return {}
    rows = (await session.execute(text(f"""
        SELECT a.device_id, t.code AS tag_code,
               sum(a.avg_value * a.sample_count) FILTER (WHERE {_GOOD})
                 / NULLIF(sum(a.sample_count) FILTER (WHERE {_GOOD}), 0) AS mean,
               max(a.max_value) FILTER (WHERE {_GOOD})                   AS highest,
               coalesce(sum(a.sample_count) FILTER (WHERE {_GOOD}), 0)   AS samples,
               count(*) FILTER (WHERE NOT {_GOOD})                       AS flagged,
               count(*) FILTER (WHERE {_GOOD})                           AS buckets
          FROM {tier.value}_v a
          JOIN devices d ON d.id = a.device_id
          JOIN tags t    ON t.id = a.tag_id
         WHERE d.plant_id = :plant_id AND a.device_id = ANY(:device_ids)
           AND t.code = ANY(:tags)
           AND a.bucket >= :start AND a.bucket < :end
         GROUP BY a.device_id, t.code
    """), {"plant_id": plant.id, "device_ids": list(device_ids), "tags": list(tags),
           "start": window.start, "end": window.end})).all()
    return {
        (row.device_id, row.tag_code): Stat(
            peak_sum=_float(row.highest), mean=_float(row.mean),
            highest=_float(row.highest), samples=int(row.samples),
            flagged=int(row.flagged), buckets=int(row.buckets))
        for row in rows
    }


@dataclass(frozen=True, slots=True)
class DeviceRecord:
    id: int
    code: str
    name: str
    created_at: datetime


async def fetch_devices(
    session: AsyncSession, plant_id: int, type_code: str,
) -> list[DeviceRecord]:
    """Every registered Device of a Type — active or not, since a Device retired
    last week still generated before it was."""
    rows = (await session.execute(text("""
        SELECT d.id, d.code, d.name, d.created_at
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
         WHERE d.plant_id = :plant_id AND dt.code = :type_code
         ORDER BY d.code
    """), {"plant_id": plant_id, "type_code": type_code})).all()
    return [DeviceRecord(row.id, row.code, row.name, row.created_at) for row in rows]


async def fetch_availability(
    session: AsyncSession, devices: Sequence[DeviceRecord], window: ReportWindow,
) -> dict[int, FormulaResult]:
    """Each Device's time-weighted availability over the window, from its
    health transitions — the same rule the KPI screen applies to a Plant."""
    if not devices:
        return {}
    rows = (await session.execute(text("""
        SELECT device_id, occurred_at, to_status FROM (
            SELECT DISTINCT ON (e.device_id) e.device_id, e.occurred_at, e.to_status
              FROM device_health_events e
             WHERE e.device_id = ANY(:device_ids) AND e.occurred_at <= :start
             ORDER BY e.device_id, e.occurred_at DESC
        ) before_start
        UNION ALL
        SELECT e.device_id, e.occurred_at, e.to_status
          FROM device_health_events e
         WHERE e.device_id = ANY(:device_ids)
           AND e.occurred_at > :start AND e.occurred_at < :end
         ORDER BY device_id, occurred_at
    """), {"device_ids": [d.id for d in devices], "start": window.start,
           "end": window.end})).all()
    events: dict[int, list[tuple[datetime, str]]] = {}
    for row in rows:
        events.setdefault(row.device_id, []).append((row.occurred_at, row.to_status))
    return {
        device.id: device_availability(events.get(device.id, []), device.created_at, window)
        for device in devices
    }


def device_availability(
    events: list[tuple[datetime, str]], created_at: datetime, window: ReportWindow,
) -> FormulaResult:
    """Availability from the later of the window's start and registration."""
    since = max(window.start, created_at)
    weighed = (window.end - since).total_seconds()
    if weighed <= 0:
        return FormulaResult(None, "availability", "not registered during the period")
    up, excluded = uptime_seconds_from_events(events, since, window.end)
    if weighed - excluded <= 0:
        return FormulaResult(None, "availability", "never reported in the period")
    return availability(up, weighed, excluded)


@dataclass(frozen=True, slots=True)
class AlarmRecord:
    opened_at: datetime
    severity: str
    subject: str
    rule_name: str
    classification: str | None
    state: str
    acknowledged_at: datetime | None
    resolved_at: datetime | None
    message: str


async def fetch_alarms(
    session: AsyncSession, plant_id: int, window: ReportWindow, limit: int,
) -> list[AlarmRecord]:
    """Alarms opened in the window. RLS on `alarms` scopes them, as on the
    Alarms screen; the Plant predicate only narrows."""
    rows = (await session.execute(text("""
        SELECT a.opened_at, a.severity, a.state, a.classification, a.message,
               a.acknowledged_at, a.resolved_at,
               coalesce(d.code, a.subject, '') AS subject, r.name AS rule_name
          FROM alarms a
          JOIN alarm_rules r ON r.id = a.rule_id
          LEFT JOIN devices d ON d.id = a.device_id
         WHERE a.plant_id = :plant_id
           AND a.opened_at >= :start AND a.opened_at < :end
         ORDER BY a.opened_at, a.id
         LIMIT :limit
    """), {"plant_id": plant_id, "start": window.start, "end": window.end,
           "limit": limit})).all()
    return [
        AlarmRecord(row.opened_at, row.severity, row.subject, row.rule_name,
                    row.classification, row.state, row.acknowledged_at,
                    row.resolved_at, row.message)
        for row in rows
    ]


def _float(value: Any) -> float | None:
    return None if value is None else float(value)


# ── Composing: the I/O for each kind, then its pure builder ─────────────────

async def compose(
    session: AsyncSession, kind: str, plant: PlantInfo, window: ReportWindow,
    now: datetime,
) -> ReportTable:
    if kind not in REPORT_KINDS:
        raise ValueError(f"unknown report kind {kind!r}")

    table, reads = await _compose(session, kind, plant, window, now)
    table.notes[:0] = period_notes(table, now, reads)
    return table


# What reads the stats tier, in a sentence about the period's edges.
_STATS_READ = "peaks, averages and coverage"


async def _compose(
    session: AsyncSession, kind: str, plant: PlantInfo, window: ReportWindow,
    now: datetime,
) -> tuple[ReportTable, list[tuple[str, Tier]]]:
    """The table, and what was read from which tier — for `period_notes`."""
    if kind == "alarm":
        alarms = await fetch_alarms(session, plant.id, window, MAX_ALARM_ROWS + 1)
        return build_alarm(plant, window, alarms), []

    day_tier = _day_tier(window, now)
    stats_tier = _stats_tier(window, now)

    if kind == "inverter":
        inverters = await fetch_devices(session, plant.id, "INVERTER")
        counter_tier = select_tier(window.start, window.end, now, finest=Tier.AGG_1M)
        series = (await read_counter_series(
            session, tier=counter_tier, pairs=[("INVERTER", "ENERGY_TOTAL")],
            start=window.start, end=window.end, plant_ids=[plant.id],
        )).get(plant.id, [])
        device_stats = await fetch_device_stats(
            session, plant, window, stats_tier, [i.id for i in inverters],
            ["AC_ACTIVE_POWER", "DC_POWER", "DEVICE_TEMPERATURE"])
        uptime = await fetch_availability(session, inverters, window)
        return build_inverter(plant, window, inverters, series, device_stats, uptime,
                              counter_tier=counter_tier, stats_tier=stats_tier), [
            ("energy registers", counter_tier), (_STATS_READ, stats_tier)]

    if kind == "weather":
        pairs = [("WMS", tag) for tag in (
            "GHI", "AMBIENT_TEMPERATURE", "MODULE_TEMPERATURE", "WIND_SPEED", "HUMIDITY")]
        stats = await fetch_day_stats(session, plant, window, stats_tier, pairs)
        series = (await read_counter_series(
            session, tier=day_tier,
            pairs=[PLANT_IRRADIATION_SOURCE, ("WMS", "GTI_CUMULATIVE")],
            start=window.start, end=window.end, plant_ids=[plant.id],
        )).get(plant.id, [])
        return build_weather(plant, window, series, stats,
                             counter_tier=day_tier, stats_tier=stats_tier), [
            ("irradiation registers", day_tier), (_STATS_READ, stats_tier)]

    # daily_plant and monthly_plant read the same registers; only the monthly
    # one has PR, and so needs the sun.
    sun = [PLANT_IRRADIATION_SOURCE] if kind == "monthly_plant" else []
    series = (await read_counter_series(
        session, tier=day_tier,
        pairs=[*PLANT_ENERGY_COUNTER_PRECEDENCE, *PLANT_IMPORT_COUNTER_PRECEDENCE, *sun],
        start=window.start, end=window.end, plant_ids=[plant.id],
    )).get(plant.id, [])
    stats = await fetch_day_stats(
        session, plant, window, stats_tier,
        [*PLANT_POWER_SOURCE_PRECEDENCE, *PLANT_FREQUENCY_SOURCE_PRECEDENCE])
    builder = build_daily_plant if kind == "daily_plant" else build_monthly_plant
    registers = "energy and irradiation registers" if sun else "energy registers"
    return builder(plant, window, series, stats,
                   counter_tier=day_tier, stats_tier=stats_tier), [
        (registers, day_tier), (_STATS_READ, stats_tier)]


# ── A period cut inside a day ────────────────────────────────────────────────

def _moment(at: datetime, zone: ZoneInfo) -> str:
    return at.astimezone(zone).strftime("%H:%M on %d-%m-%Y")


def _span(begins: datetime, ends: datetime, zone: ZoneInfo) -> str:
    """"06:00 to 18:00 on 28-09-2026", or with both dates when they differ."""
    first, last = begins.astimezone(zone), ends.astimezone(zone)
    if first.date() == last.date():
        return f"{first:%H:%M} to {last:%H:%M} on {first:%d-%m-%Y}"
    return f"{_moment(begins, zone)} to {_moment(ends, zone)}"


def _align_up(at: datetime, tier: Tier) -> datetime:
    """The first `tier` bucket boundary at or after `at`."""
    floor = bucket_start(at, tier)
    return at if floor == at else floor + _tier_resolution(tier)


def period_notes(
    table: ReportTable, now: datetime, reads: Sequence[tuple[str, Tier]],
) -> list[str]:
    """What a Report cut inside a day covers, said first. Empty for whole days.

    Two things the rows cannot say themselves. A day's row covers only the part
    of it the period entered, and its Date column does not show which part.
    And an aggregate is read in whole buckets — `bucket >= start AND bucket <
    end` — so a time inside a bucket moves the edge: the bucket holding the
    start is left out, the one holding the end read whole. A time on the
    bucket's boundary moves nothing and gets no note; nor does an end cut short
    at now, which is how every day in progress is read.
    """
    window, zone = table.window, table.plant.zone
    if not window.timed:
        return []
    begins = (f"{window.from_time:%H:%M} on {window.first_day:%d-%m-%Y}"
              if window.from_time else f"the start of {window.first_day:%d-%m-%Y}")
    ends = (f"{window.to_time:%H:%M} on {window.last_day:%d-%m-%Y}"
            if window.to_time else f"the end of {window.last_day:%d-%m-%Y}")
    if window.from_time and window.to_time and window.first_day == window.last_day:
        span = (f"from {window.from_time:%H:%M} to {window.to_time:%H:%M} on "
                f"{window.first_day:%d-%m-%Y}")
    else:
        span = f"from {begins} to {ends}"
    sentence = f"The period runs {span}, on the Plant's clock ({table.plant.timezone})"
    unit = {"daily_plant": "day", "weather": "day", "monthly_plant": "month"}.get(table.kind)
    if unit is not None:
        first, last = window.first_day, window.last_day
        if unit == "day" and first == last:
            sentence += "; the row covers only that part of the day"
        elif unit == "month" and (first.year, first.month) == (last.year, last.month):
            sentence += "; the row covers only the part of its month inside it"
        else:
            which = ("first and last" if window.from_time and window.to_time
                     else "first" if window.from_time else "last")
            rows = ("rows cover only the part of their" if which == "first and last"
                    else "row covers only the part of its")
            sentence += f"; the {which} {rows} {unit} inside it"
    notes = [sentence + "."]

    chosen_end = window.to_time is not None and window.end < now
    by_tier: dict[Tier, list[str]] = {}
    for what, tier in reads:
        by_tier.setdefault(tier, []).append(what)
    for tier, whats in by_tier.items():
        read_from = _align_up(window.start, tier) if window.from_time else window.start
        read_to = _align_up(window.end, tier) if chosen_end else window.end
        clauses = []
        if read_from != window.start:
            clauses.append("the bucket holding the start is left out")
        if read_to != window.end:
            clauses.append(f"the {'one' if clauses else 'bucket'} holding the end is read whole")
        if not clauses:
            continue
        subject = " and ".join(whats)
        notes.append(
            f"{subject[0].upper()}{subject[1:]} are read in {_resolution_phrase(tier)} buckets, "
            f"so they cover {_span(read_from, read_to, zone)}: {' and '.join(clauses)}.")
    return notes


# ── Shared arithmetic ────────────────────────────────────────────────────────

def pick_source(
    stats: dict[tuple[str, str], dict[date, Stat]],
    precedence: Sequence[tuple[str, str]],
) -> tuple[tuple[str, str] | None, dict[date, Stat]]:
    """The first pair in `precedence` with any good reading in the window.

    Once per window, not per day: a table whose peak came from the meter on
    Monday and from the Inverters on Tuesday would compare two instruments
    down one column without saying so.
    """
    for pair in precedence:
        days = stats.get(pair, {})
        if any(stat.samples > 0 for stat in days.values()):
            return pair, days
    return None, {}


@dataclass(frozen=True, slots=True)
class Attributed:
    """A register's steps summed per label, and what no label can claim."""

    totals: dict[str, float]
    # Accrued between two readings under different labels — across an outage
    # that spanned midnight. Which day it belongs to is not known.
    unattributed: float = 0.0
    spans: tuple[tuple[datetime, datetime], ...] = ()


# The accrual interval of a step is `(since, at]`: its end belongs to it.
_INSTANT = timedelta(microseconds=1)


def split_steps(steps: Sequence[CounterStep], label: Callable[[datetime], str]) -> Attributed:
    """Sum a lifetime register's steps per label, counting only the steps
    whose two readings share it.

    ⚠ `bucket_steps` hands a step to its later reading's label. Readings
    minutes apart make that harmless; an outage does not. The register silent
    from the evening of 25 Sep to the afternoon of the 28th stepped once, by
    277 kWh, and all of it became the 28th's — so the 28th read 1,309 kWh
    under "last 7 days" and 1,032 kWh under "today", whose window began at
    its midnight and never saw the step. That step is counted to no row now,
    and stated beside the table instead. A midnight step on a working day
    carries the night's nothing, so nothing real is lost to this.

    Not for a register that restarts at local midnight (irradiation): after a
    restart its reading *is* that day's, whenever the reading before it was.

    A step accrued over `(since, at]`, so one ending exactly at midnight is the
    day before's — which is where every quarter-hour bucket's last step ends.
    """
    totals: dict[str, float] = {}
    unattributed = 0.0
    spans: list[tuple[datetime, datetime]] = []
    for step in steps:
        name = label(step.at - _INSTANT)
        if step.since is not None and label(step.since) != name:
            unattributed += step.amount
            if step.amount > 0:
                spans.append((step.since, step.at))
            continue
        totals[name] = totals.get(name, 0.0) + step.amount
    return Attributed(totals, unattributed, tuple(spans))


def _unattributed_note(
    what: str, attributed: Attributed, zone: ZoneInfo, unit: str = "kWh",
) -> str | None:
    if attributed.unattributed <= 0:
        return None
    shown = ", ".join(
        f"{since.astimezone(zone):%d-%m-%Y %H:%M} to {at.astimezone(zone):%d-%m-%Y %H:%M}"
        for since, at in attributed.spans[:3])
    more = f" and {len(attributed.spans) - 3} more" if len(attributed.spans) > 3 else ""
    return (f"{attributed.unattributed:,.1f} {unit} of {what} accrued while the register "
            f"went unread across a day boundary ({shown}{more}) and is in no row: which "
            "day it belongs to is not known.")


def _coverage(buckets: int, hours: float, tier: Tier) -> float | None:
    """The share of a span's `tier` slots holding a good reading, in percent.

    Beside a figure rather than folded into it (Guardrail 18): a day seen for
    three hours makes a total that is low and plausible, and only this says
    why. A slot still filling counts as a slot.
    """
    slots = math.ceil(hours * 3600.0 / _tier_resolution(tier).total_seconds() - 1e-9)
    if slots <= 0:
        return None
    return min(100.0, buckets / slots * 100.0)


def _coverage_note(stats_tier: Tier, source: str, per: str) -> str:
    return (f"Coverage is the share of the {per}'s {_resolution_phrase(stats_tier)} slots — "
            f"so far, for today — in which {source} reported. A low figure means the row "
            "saw only part of the span; it is never corrected for.")


def _flagged_total(*groups: dict[date, Stat]) -> int:
    return sum(stat.flagged for days in groups for stat in days.values())


def _hours_in(day: date, window: ReportWindow, plant: PlantInfo) -> float:
    """How much of a local day the window covers — all of it, or up to now."""
    begins = max(local_midnight(day, plant.zone), window.start)
    ends = min(local_midnight(day + timedelta(days=1), plant.zone), window.end)
    return max(0.0, (ends - begins).total_seconds() / 3600.0)


def _labeller(zone: ZoneInfo, fmt: str) -> Callable[[datetime], str]:
    def label(at: datetime) -> str:
        return at.astimezone(zone).strftime(fmt)
    return label


def _day_key(zone: ZoneInfo) -> Callable[[datetime], str]:
    return _labeller(zone, "%Y-%m-%d")


def _month_key(zone: ZoneInfo) -> Callable[[datetime], str]:
    return _labeller(zone, "%Y-%m")


def _station_means(
    stations: Sequence[DeviceEnergy], label: Callable[[datetime], str],
) -> dict[str, float]:
    """Irradiation per label, the mean across the stations that read it.

    A mean, as `plant_irradiation` takes one — two stations see one sky — and
    over the stations *with* that label, so a station that was down on
    Tuesday does not halve Tuesday's sun.
    """
    # `(since, at]`, as in `split_steps`: a reading at midnight is the day before's.
    per_station = [bucket_steps(s.integral.steps, lambda at: label(at - _INSTANT))
                   for s in stations]
    labels = {name for totals in per_station for name in totals}
    return {
        name: sum(t[name] for t in per_station if name in t)
        / sum(1 for t in per_station if name in t)
        for name in labels
    }


def _refused_note(energy: PlantEnergy, label: Callable[[datetime], str]) -> str | None:
    if not energy.anomalies:
        return None
    where = sorted({label(anomaly.at) for _series, anomaly in energy.anomalies})
    return (f"{len(energy.anomalies)} energy counter step(s) went backwards or jumped further "
            f"than the Plant could produce and were not counted ({', '.join(where)}); those "
            "rows are short by an amount this Report cannot state.")


def _flagged_note(count: int) -> str | None:
    if not count:
        return None
    return (f"{count} bucket(s) held a flagged reading (out of range or unparseable) and were "
            "left out of every peak and average. They are stored, not discarded.")


# ── Daily Plant Report ───────────────────────────────────────────────────────

def build_daily_plant(
    plant: PlantInfo, window: ReportWindow, series: Sequence[DeviceSeries],
    stats: dict[tuple[str, str], dict[date, Stat]], *,
    counter_tier: Tier, stats_tier: Tier,
) -> ReportTable:
    zone = plant.zone
    ac = plant.ac_kw or None
    energy = plant_energy(series, PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=ac)
    imports = plant_energy(series, PLANT_IMPORT_COUNTER_PRECEDENCE, plant_ac_capacity_kw=ac)
    made_by_day = split_steps(energy.steps, _day_key(zone))
    imported_by_day = split_steps(imports.steps, _day_key(zone))
    by_day, import_by_day = made_by_day.totals, imported_by_day.totals
    power_pair, power = pick_source(stats, PLANT_POWER_SOURCE_PRECEDENCE)
    freq_pair, frequency = pick_source(stats, PLANT_FREQUENCY_SOURCE_PRECEDENCE)

    rows: list[dict[str, Any]] = []
    for day in window.days:
        key = day.isoformat()
        made = by_day.get(key) if energy.value is not None else None
        hours = _hours_in(day, window, plant)
        power_day = power.get(day)
        freq_day = frequency.get(day)
        rows.append({
            "date": key,
            # Energy over the day's hours: the true time-mean of power, night
            # included, and it cannot disagree with the energy beside it.
            "avg_power_kw": made / hours if made is not None and hours > 0 else None,
            "peak_power_kw": power_day.peak_sum if power_day else None,
            "energy_kwh": made,
            "import_kwh": import_by_day.get(key) if imports.value is not None else None,
            "avg_frequency_hz": freq_day.mean if freq_day else None,
            "coverage": (_coverage(power_day.buckets if power_day else 0, hours, stats_tier)
                         if power_pair else None),
        })

    columns = [
        Column("date", "Date", "date"),
        Column("avg_power_kw", "Avg power", unit="kW"),
        Column("peak_power_kw", "Peak power", unit="kW"),
        Column("energy_kwh", _energy_label(energy), unit="kWh"),
        Column("import_kwh", "Import energy", unit="kWh"),
        Column("avg_frequency_hz", "Avg frequency", unit="Hz", digits=2),
        Column("coverage", "Coverage", "percent", unit="%", digits=0),
    ]

    power_devices = _device_count(power)
    power_source = _source_phrase(power_pair[0] if power_pair else None, power_devices)
    notes = [
        _energy_note(energy, per="day"),
        "Avg power is the day's energy divided by its hours — so far, for today — the "
        "mean over the whole day, night included.",
        (f"Peak power is the highest {_resolution_phrase(stats_tier)} average of "
         f"{_source_phrase(power_pair[0], power_devices)}."
         if power_pair else "Peak power is not known: no meter or Inverter reported "
                            "active power in the period."),
        ("Import is read from the meters' import register."
         if imports.value is not None else
         "Import is not known: no meter reported an import register twice in the period. "
         "An Inverter measures what it generates, never what the Plant drew."),
        (f"Frequency is the mean of every good reading from "
         f"{_TYPE_NAMES.get(freq_pair[0], freq_pair[0])}."
         if freq_pair else "Frequency is not known: nothing reported it in the period."),
    ]
    if power_pair:
        notes.append(_coverage_note(stats_tier, power_source, "day"))
    notes += [n for n in (_unattributed_note("energy", made_by_day, zone),
                          _unattributed_note("import", imported_by_day, zone),
                          _refused_note(energy, _day_key(zone)),
                          _flagged_note(_flagged_total(power, frequency))) if n]
    notes.append("A dash is a day with nothing to read, never a day that made nothing. "
                 f"Registers read from the {counter_tier.value} tier.")
    return ReportTable("daily_plant", plant, window, columns, rows, notes,
                       source_tier=counter_tier.value)


def _device_count(days: dict[date, Stat]) -> int:
    """The most Devices summed into any one bucket of the window."""
    return max((stat.devices for stat in days.values()), default=0)


# ── Monthly Plant Report ─────────────────────────────────────────────────────

def _months(window: ReportWindow) -> list[tuple[str, list[date]]]:
    """Each calendar month the window touches, with its days inside it."""
    months: dict[str, list[date]] = {}
    for day in window.days:
        months.setdefault(f"{day:%Y-%m}", []).append(day)
    return list(months.items())


def build_monthly_plant(
    plant: PlantInfo, window: ReportWindow, series: Sequence[DeviceSeries],
    stats: dict[tuple[str, str], dict[date, Stat]], *,
    counter_tier: Tier, stats_tier: Tier,
) -> ReportTable:
    zone = plant.zone
    ac = plant.ac_kw or None
    dc = plant.dc_kwp or 0.0
    energy = plant_energy(series, PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=ac)
    imports = plant_energy(series, PLANT_IMPORT_COUNTER_PRECEDENCE, plant_ac_capacity_kw=ac)
    stations = [s for s in series if (s.device_type_code, s.tag_code) == PLANT_IRRADIATION_SOURCE]
    irradiation = plant_irradiation(stations)
    made_by_month = split_steps(energy.steps, _month_key(zone))
    imported_by_month = split_steps(imports.steps, _month_key(zone))
    by_month, import_by_month = made_by_month.totals, imported_by_month.totals
    irr_by_month = _station_means(irradiation.stations, _month_key(zone))
    power_pair, power = pick_source(stats, PLANT_POWER_SOURCE_PRECEDENCE)

    # CUF divides by the hours the Plant could be measured in: a Plant first
    # heard on the 20th was not idle for the nineteen days before it existed.
    firsts = [d.integral.first.at for d in energy.devices if d.integral.first]
    measured_from = min(firsts) if firsts else None

    rows: list[dict[str, Any]] = []
    flags: list[tuple[int, str, str]] = []
    for month, days in _months(window):
        made = by_month.get(month) if energy.value is not None else None
        irr = irr_by_month.get(month) if irradiation.value is not None else None
        peaks = [peak for d in days if d in power
                 if (peak := power[d].peak_sum) is not None]
        span_hours = sum(_hours_in(d, window, plant) for d in days)
        seen = sum(power[d].buckets for d in days if d in power)
        begins = max(local_midnight(days[0], zone), window.start)
        if measured_from is not None:
            begins = max(begins, measured_from)
        ends = min(local_midnight(days[-1] + timedelta(days=1), zone), window.end)
        hours = max(0.0, (ends - begins).total_seconds() / 3600.0)

        pr = cuf_value = yield_value = None
        if made is not None:
            yield_value = specific_yield(made, dc).value
            cuf_value = cuf(made, plant.ac_kw or 0.0, hours).value
            if irr is not None:
                pr = performance_ratio(made, irr * 1000.0, dc).value
        index = len(rows)
        for key, ratio in (("performance_ratio", pr), ("cuf", cuf_value)):
            # Shown unaltered and flagged, never clamped (Guardrail 33).
            if ratio is not None and not 0.0 <= ratio <= REPORT_RATIO_CEILING:
                flags.append((index, key,
                              "outside what the ratio can physically be — the energy and "
                              "the irradiation or hours cover different spans"))
        rows.append({
            "month": month,
            "days": len(days),
            "energy_kwh": made,
            "import_kwh": import_by_month.get(month) if imports.value is not None else None,
            "peak_power_kw": max(peaks) if peaks else None,
            "irradiation_kwh_m2": irr,
            "specific_yield": yield_value,
            # Percent columns carry the percentage, in every format alike.
            "performance_ratio": pr * 100.0 if pr is not None else None,
            "cuf": cuf_value * 100.0 if cuf_value is not None else None,
            "coverage": _coverage(seen, span_hours, stats_tier) if power_pair else None,
        })

    columns = [
        Column("month", "Month", "month"),
        Column("days", "Days", "count", digits=0),
        Column("energy_kwh", _energy_label(energy), unit="kWh"),
        Column("import_kwh", "Import energy", unit="kWh"),
        Column("peak_power_kw", "Peak power", unit="kW"),
        Column("irradiation_kwh_m2", "Irradiation (GHI)", unit="kWh/m²", digits=2),
        Column("specific_yield", "Specific yield", unit="kWh/kWp", digits=2),
        Column("performance_ratio", "PR", "percent", unit="%", digits=1),
        Column("cuf", "CUF", "percent", unit="%", digits=1),
        Column("coverage", "Coverage", "percent", unit="%", digits=0),
    ]
    notes = [
        _energy_note(energy, per="month"),
        "A month the period only partly covers is only partly counted: Days says how many "
        "of its days are in this Report.",
        (f"Peak power is the highest {_resolution_phrase(stats_tier)} average of "
         f"{_source_phrase(power_pair[0], _device_count(power))}."
         if power_pair else "Peak power is not known: nothing reported active power."),
        ("Irradiation is the mean of the Weather Stations' daily GHI registers."
         if irradiation.value is not None else
         "Irradiation is not known — no Weather Station reported twice — so PR is not "
         "either."),
        "PR is energy over DC capacity, over irradiation in kWh/m²; CUF is energy over AC "
        "capacity times the hours the Plant could be measured in. Both are provisional pending "
        "the client's formulas (OPEN-16).",
    ]
    if power_pair:
        notes.append(_coverage_note(
            stats_tier, _source_phrase(power_pair[0], _device_count(power)), "month"))
    notes += [n for n in (_unattributed_note("energy", made_by_month, zone),
                          _unattributed_note("import", imported_by_month, zone),
                          _refused_note(energy, _month_key(zone)),
                          _flagged_note(_flagged_total(power))) if n]
    notes.append(f"Registers read from the {counter_tier.value} tier.")
    return ReportTable("monthly_plant", plant, window, columns, rows, notes, flags,
                       source_tier=counter_tier.value)


# ── Inverter Report ──────────────────────────────────────────────────────────

def build_inverter(
    plant: PlantInfo, window: ReportWindow, inverters: Sequence[DeviceRecord],
    series: Sequence[DeviceSeries], stats: dict[tuple[int, str], Stat],
    uptime: dict[int, FormulaResult], *, counter_tier: Tier, stats_tier: Tier,
) -> ReportTable:
    energy = plant_energy(series, (("INVERTER", "ENERGY_TOTAL"),),
                          plant_ac_capacity_kw=plant.ac_kw or None)
    by_device = {d.series.device_id: d for d in energy.devices}

    rows: list[dict[str, Any]] = []
    flagged = 0
    for inverter in inverters:
        counted = by_device.get(inverter.id)
        share = uptime.get(inverter.id)
        cells: dict[str, Any] = {
            "device": inverter.code,
            "energy_kwh": counted.integral.total if counted else None,
            "refused": len(counted.integral.anomalies) if counted else 0,
            "availability": (share.value * 100.0
                             if share is not None and share.value is not None else None),
        }
        for key, tag in (("peak_ac_kw", "AC_ACTIVE_POWER"), ("peak_dc_kw", "DC_POWER"),
                         ("max_temperature_c", "DEVICE_TEMPERATURE")):
            stat = stats.get((inverter.id, tag))
            cells[key] = stat.highest if stat else None
            flagged += stat.flagged if stat else 0
        # Owed from registration, not from the period's start: an Inverter
        # added on Thursday was not silent on Monday.
        owed = (window.end - max(window.start, inverter.created_at)).total_seconds() / 3600.0
        power = stats.get((inverter.id, "AC_ACTIVE_POWER"))
        cells["coverage"] = _coverage(power.buckets if power else 0, owed, stats_tier)
        rows.append(cells)

    columns = [
        Column("device", "Inverter", "text"),
        Column("energy_kwh", "Energy generated", unit="kWh"),
        Column("peak_ac_kw", "Peak AC power", unit="kW"),
        Column("peak_dc_kw", "Peak DC power", unit="kW"),
        Column("max_temperature_c", "Max internal temperature", unit="°C"),
        Column("availability", "Availability", "percent", unit="%", digits=1),
        Column("refused", "Readings refused", "count", digits=0),
        Column("coverage", "Coverage", "percent", unit="%", digits=0),
    ]
    notes = [
        "Energy is each Inverter's own lifetime register (ENERGY_TOTAL), counted step by "
        "step; a dash is an Inverter that did not report it twice in the period.",
        f"Peaks are the highest {_resolution_phrase(stats_tier)} maximum of each reading.",
        "Availability is time-weighted from each Inverter's health transitions, from the "
        "later of the period's start and its registration; time it was never heard from is "
        "left out rather than counted as down. Provisional pending the client's definition "
        "(OPEN-16).",
        f"Coverage is the share of the {_resolution_phrase(stats_tier)} slots since the "
        "period began (or the Inverter was registered) in which it reported active power.",
    ]
    if not inverters:
        notes.insert(0, "No Inverter is registered at this Plant.")
    if energy.anomalies:
        notes.append(f"{len(energy.anomalies)} register step(s) were refused as generation — "
                     "see Readings refused; those Inverters' energy is short.")
    if note := _flagged_note(flagged):
        notes.append(note)
    notes.append(f"Registers read from the {counter_tier.value} tier.")
    return ReportTable("inverter", plant, window, columns, rows, notes,
                       source_tier=counter_tier.value)


# ── Weather Report ───────────────────────────────────────────────────────────

def build_weather(
    plant: PlantInfo, window: ReportWindow, series: Sequence[DeviceSeries],
    stats: dict[tuple[str, str], dict[date, Stat]], *,
    counter_tier: Tier, stats_tier: Tier,
) -> ReportTable:
    zone = plant.zone
    ghi = plant_irradiation([s for s in series if s.tag_code == "GHI_CUMULATIVE"])
    gti = plant_irradiation([s for s in series if s.tag_code == "GTI_CUMULATIVE"])
    ghi_by_day = _station_means(ghi.stations, _day_key(zone))
    gti_by_day = _station_means(gti.stations, _day_key(zone))

    def of(tag: str) -> dict[date, Stat]:
        return stats.get(("WMS", tag), {})

    rows: list[dict[str, Any]] = []
    for day in window.days:
        key = day.isoformat()
        peak = of("GHI").get(day)
        ambient = of("AMBIENT_TEMPERATURE").get(day)
        module = of("MODULE_TEMPERATURE").get(day)
        wind = of("WIND_SPEED").get(day)
        humidity = of("HUMIDITY").get(day)
        rows.append({
            "date": key,
            "ghi_kwh_m2": ghi_by_day.get(key) if ghi.value is not None else None,
            "gti_kwh_m2": gti_by_day.get(key) if gti.value is not None else None,
            "peak_ghi_w_m2": peak.highest if peak else None,
            "avg_ambient_c": ambient.mean if ambient else None,
            "max_module_c": module.highest if module else None,
            "avg_wind_m_s": wind.mean if wind else None,
            "avg_humidity": humidity.mean if humidity else None,
            "coverage": _coverage(peak.buckets if peak else 0,
                                  _hours_in(day, window, plant), stats_tier),
        })

    columns = [
        Column("date", "Date", "date"),
        Column("ghi_kwh_m2", "Irradiation (GHI)", unit="kWh/m²", digits=2),
        Column("gti_kwh_m2", "Irradiation (GTI)", unit="kWh/m²", digits=2),
        Column("peak_ghi_w_m2", "Peak irradiance (GHI)", unit="W/m²", digits=0),
        Column("avg_ambient_c", "Avg ambient temperature", unit="°C"),
        Column("max_module_c", "Max module temperature", unit="°C"),
        Column("avg_wind_m_s", "Avg wind speed", unit="m/s"),
        Column("avg_humidity", "Avg humidity", unit="%", digits=0),
        Column("coverage", "Coverage", "percent", unit="%", digits=0),
    ]
    stations = {s.device_id for s in series}
    notes = [
        ("Irradiation is each Weather Station's daily register (restarting at local "
         "midnight), integrated per day and averaged across stations."
         if stations else "No Weather Station reported an irradiation register in the "
                          "period."),
        f"Peaks are the highest {_resolution_phrase(stats_tier)} maximum; averages are "
        "over every good reading of the day.",
        _coverage_note(stats_tier, "the Weather Station's irradiance (GHI)", "day"),
    ]
    if note := _flagged_note(_flagged_total(*(of(t) for t in (
            "GHI", "AMBIENT_TEMPERATURE", "MODULE_TEMPERATURE", "WIND_SPEED", "HUMIDITY")))):
        notes.append(note)
    notes.append("A dash is a day with nothing to read. "
                 f"Registers read from the {counter_tier.value} tier.")
    return ReportTable("weather", plant, window, columns, rows, notes,
                       source_tier=counter_tier.value)


# ── Alarm Report ─────────────────────────────────────────────────────────────

def build_alarm(
    plant: PlantInfo, window: ReportWindow, alarms: Sequence[AlarmRecord],
) -> ReportTable:
    truncated = len(alarms) > MAX_ALARM_ROWS
    zone = plant.zone
    rows: list[dict[str, Any]] = []
    for alarm in alarms[:MAX_ALARM_ROWS]:
        rows.append({
            "opened_at": _local_iso(alarm.opened_at, zone),
            "severity": alarm.severity,
            "device": alarm.subject,
            "alarm": alarm.rule_name,
            "classification": alarm.classification or "",
            "state": alarm.state,
            "acknowledged_at": _local_iso(alarm.acknowledged_at, zone),
            "resolved_at": _local_iso(alarm.resolved_at, zone),
            # Open Alarms have no duration yet — a dash, not "so far", because
            # a figure that keeps growing reads differently in a file tomorrow.
            "duration_min": ((alarm.resolved_at - alarm.opened_at).total_seconds() / 60.0
                             if alarm.resolved_at else None),
            "message": alarm.message,
        })
    columns = [
        Column("opened_at", "Opened", "datetime"),
        Column("severity", "Severity", "text"),
        Column("device", "Device", "text"),
        Column("alarm", "Alarm", "text"),
        Column("classification", "Classification", "text"),
        Column("state", "State", "text"),
        Column("acknowledged_at", "Acknowledged", "datetime"),
        Column("resolved_at", "Resolved", "datetime"),
        Column("duration_min", "Duration", unit="min", digits=0),
        Column("message", "Message", "text"),
    ]
    notes = ["Alarms opened in the period, oldest first, in the Plant's local time. "
             "Duration is from opening to resolution; an Alarm still open has none yet."]
    if truncated:
        notes.insert(0, f"Only the first {MAX_ALARM_ROWS:,} Alarms are listed; narrow the "
                        "period for the rest.")
    if not rows:
        notes.insert(0, "No Alarm was opened at this Plant in the period.")
    return ReportTable("alarm", plant, window, columns, rows, notes, truncated=truncated)


def _local_iso(at: datetime | None, zone: ZoneInfo) -> str | None:
    return at.astimezone(zone).isoformat(timespec="seconds") if at else None


# ── Rendering ────────────────────────────────────────────────────────────────

def to_payload(table: ReportTable, now: datetime) -> dict[str, Any]:
    return {
        "kind": table.kind,
        "title": table.title,
        "plant": {"id": table.plant.id, "code": table.plant.code,
                  "name": table.plant.name, "timezone": table.plant.timezone},
        "period": table.window.period,
        "first_day": table.window.first_day.isoformat(),
        "last_day": table.window.last_day.isoformat(),
        # The chosen clock times, or null where that end is a whole day's edge.
        "from_time": clock(table.window.from_time),
        "to_time": clock(table.window.to_time),
        "start": table.window.start,
        "end": table.window.end,
        "source_tier": table.source_tier,
        "columns": [{"key": c.key, "label": c.label, "kind": c.kind, "unit": c.unit,
                     "digits": c.digits} for c in table.columns],
        "rows": [_json_row(table.columns, row) for row in table.rows],
        "flags": [{"row": index, "key": key, "reason": reason}
                  for index, key, reason in table.flags],
        "notes": table.notes,
        "truncated": table.truncated,
        "generated_at": now,
    }


def _json_row(columns: Sequence[Column], row: dict[str, Any]) -> dict[str, Any]:
    """Numbers rounded to what the column shows — and NaN, which JSON cannot
    carry, as nothing to read."""
    out: dict[str, Any] = {}
    for column in columns:
        value = row.get(column.key)
        if isinstance(value, float):
            value = None if math.isnan(value) else round(value, column.digits + 2)
        out[column.key] = value
    return out


def _period_text(table: ReportTable) -> str:
    window = table.window
    first, last = window.first_day, window.last_day
    if not window.timed:
        days = f"{first:%d-%m-%Y}" if first == last else f"{first:%d-%m-%Y} to {last:%d-%m-%Y}"
        return f"{days} ({table.plant.timezone})"
    # One end timed shows the other's edge too: "06:00 to" what, otherwise?
    begins, ends = window.from_time or _DAY_BEGINS, window.to_time or _DAY_ENDS
    span = (f"{first:%d-%m-%Y} {begins:%H:%M} to {ends:%H:%M}" if first == last
            else f"{first:%d-%m-%Y} {begins:%H:%M} to {last:%d-%m-%Y} {ends:%H:%M}")
    return f"{span} ({table.plant.timezone})"


def display(column: Column, value: Any, *, thousands: bool = True) -> str:
    """A cell as text — the PDF's, and the CSV's with `thousands=False`."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    if column.kind == "date":
        return datetime.strptime(value, "%Y-%m-%d").strftime("%d-%m-%Y")
    if column.kind == "month":
        return datetime.strptime(value, "%Y-%m").strftime("%b %Y")
    if column.kind == "datetime":
        return datetime.fromisoformat(value).strftime("%d-%m-%Y %H:%M:%S")
    if column.kind == "text":
        return str(value)
    if column.kind == "count":
        return f"{int(value):,}" if thousands else str(int(value))
    number = float(value)
    return f"{number:,.{column.digits}f}" if thousands else f"{number:.{column.digits}f}"


def render_csv(table: ReportTable) -> str:
    """Header and rows only — no title block, so it opens as a table anywhere."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([c.heading for c in table.columns])
    for row in table.rows:
        writer.writerow([display(c, row.get(c.key), thousands=False) for c in table.columns])
    return buffer.getvalue()


_XLSX_FORMATS = {0: "#,##0", 1: "#,##0.0", 2: "#,##0.00", 3: "#,##0.000"}


def render_xlsx(table: ReportTable) -> bytes:
    book = Workbook()
    sheet = book.active
    assert sheet is not None
    sheet.title = table.title[:31]
    sheet["A1"] = table.title
    sheet["A1"].font = Font(size=14, bold=True)
    sheet["A2"] = f"{table.plant.name} ({table.plant.code}) · {_period_text(table)}"
    sheet["A2"].font = MUTED

    header_row = 4
    for index, column in enumerate(table.columns, start=1):
        cell = sheet.cell(row=header_row, column=index, value=column.heading)
        cell.font = BOLD
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        width = 30 if column.key == "message" else max(12, min(28, len(column.heading) + 4))
        sheet.column_dimensions[get_column_letter(index)].width = width
    sheet.row_dimensions[header_row].height = 30

    line = header_row
    for row in table.rows:
        line += 1
        for index, column in enumerate(table.columns, start=1):
            value = row.get(column.key)
            if value is None:
                # A grey dash, never a zero, for "nothing to read".
                cell = sheet.cell(row=line, column=index, value="—")
                cell.font = MUTED
                cell.alignment = Alignment(horizontal="right")
                continue
            if column.kind == "date":
                sheet.cell(row=line, column=index,
                           value=datetime.strptime(value, "%Y-%m-%d")
                           ).number_format = "dd-mm-yyyy"
            elif column.kind == "month":
                sheet.cell(row=line, column=index,
                           value=datetime.strptime(value, "%Y-%m")).number_format = "mmm yyyy"
            elif column.kind == "datetime":
                # openpyxl cannot write an aware datetime; the zone is on line 2.
                sheet.cell(row=line, column=index,
                           value=datetime.fromisoformat(value).replace(tzinfo=None)
                           ).number_format = "dd-mm-yyyy hh:mm:ss"
            elif column.kind == "text":
                sheet.cell(row=line, column=index, value=str(value))
            else:
                sheet.cell(row=line, column=index, value=float(value)).number_format = \
                    _XLSX_FORMATS.get(column.digits, "#,##0.00")
    if not table.rows:
        line += 1
        sheet.cell(row=line, column=1, value="No rows.").font = MUTED
    sheet.freeze_panes = sheet.cell(row=header_row + 1, column=1)

    line += 2
    for note in table.notes:
        cell = sheet.cell(row=line, column=1, value=note)
        cell.font = MUTED
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        sheet.merge_cells(start_row=line, start_column=1, end_row=line,
                          end_column=max(len(table.columns), 4))
        sheet.row_dimensions[line].height = 15 * max(1, math.ceil(len(note) / 120))
        line += 1

    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def render_html(table: ReportTable) -> str:
    """The PDF's source, and the printable page when PDF rendering is absent."""
    esc = html.escape
    flagged = {(index, key) for index, key, _reason in table.flags}
    head = "".join(f"<th>{esc(c.heading)}</th>" for c in table.columns)
    body = "".join(
        "<tr>" + "".join(
            f"<td class='{'t' if c.kind in ('text', 'date', 'month', 'datetime') else 'n'}"
            f"{' f' if (index, c.key) in flagged else ''}'>"
            f"{esc(display(c, row.get(c.key)) or '—')}</td>"
            for c in table.columns) + "</tr>"
        for index, row in enumerate(table.rows)
    ) or f"<tr><td colspan='{len(table.columns)}' class='m'>No rows.</td></tr>"
    notes = "".join(f"<li>{esc(n)}</li>" for n in table.notes)
    landscape = "landscape" if len(table.columns) > 6 else "portrait"
    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>{esc(table.title)} — {esc(table.plant.code)}</title>
<style>
 @page {{ size: A4 {landscape}; margin: 14mm; }}
 body {{ font-family: -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 10px;
        color: #21263b; margin: 0; }}
 h1 {{ font-size: 16px; margin: 0 0 2px; }}
 .sub {{ color: #555; margin-bottom: 12px; }}
 table {{ border-collapse: collapse; width: 100%; }}
 th, td {{ border: 1px solid #d4d8de; padding: 3px 5px; }}
 th {{ background: #eef1f5; text-align: left; font-weight: 600; }}
 td.n {{ text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }}
 td.f {{ background: #fdf1e3; }}
 thead {{ display: table-header-group; }}
 tr {{ page-break-inside: avoid; }}
 ul {{ color: #555; font-size: 9px; padding-left: 14px; margin-top: 10px; }}
 .m {{ color: #777; }}
</style></head><body>
<h1>{esc(table.title)}</h1>
<div class="sub">{esc(table.plant.name)} ({esc(table.plant.code)}) ·
 {esc(_period_text(table))}</div>
<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>
<ul>{notes}</ul>
</body></html>"""


def render_pdf(table: ReportTable) -> bytes | None:
    """PDF, or None when WeasyPrint is not installed (the `reports` extra)."""
    try:
        from weasyprint import HTML
    except ImportError:
        log.warning("weasyprint unavailable; report table PDF skipped",
                    hint='install with: pip install -e ".[reports]"')
        return None
    return bytes(HTML(string=render_html(table)).write_pdf())

