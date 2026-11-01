"""The Revenue screen's figures: energy, revenue, expected and loss per period,
the trends, and every Plant side by side.

The rules are `domain/revenue.py` (⚠ PROPOSED); this module reads. Energy is
counted exactly as the Reports count it — `read_counter_series` and
`plant_energy`, the same backwards and jump checks — so a month here and a
month in the Monthly Plant Report cannot disagree about the same register.

Reads are per calendar month and cached in Redis: a past month's registers do
not change, so the financial year and the yearly trend are a sum of cached
months rather than a year of hourly rows read on every request. The cache key
carries the Devices whose registers count (a meter marked as not measuring the
solar output changes it), and a past month is kept 6 hours, not for ever,
because a replayed backlog or a refreshed aggregate can still change it.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache.live import get_redis
from solarcms.domain.assumptions import (
    PLANT_IMPORT_COUNTER_PRECEDENCE,
    REVENUE_EXPORT_COUNTER_PRECEDENCE,
    REVENUE_GENERATION_COUNTER_PRECEDENCE,
    REVENUE_SETTLEMENT_TYPE,
    REVENUE_TREND_DAYS,
    REVENUE_TREND_MAX_YEARS,
    REVENUE_TREND_MONTHS,
    REVENUE_YEAR_START_MONTH,
)
from solarcms.domain.counters import DeviceSeries, plant_energy
from solarcms.domain.periods import local_midnight
from solarcms.domain.revenue import (
    LossRow,
    PowerSlot,
    basis,
    expected_energy,
    financial_year_label,
    financial_year_start,
    month_start,
    months_back,
    next_financial_year,
    next_month,
    rest_of_today_kwh,
    revenue,
    total_loss,
)
from solarcms.domain.tiering import TIERS, Tier, select_tier
from solarcms.services import scope
from solarcms.services.energy import read_counter_series
from solarcms.services.forecast import plant_forecast
from solarcms.services.inverter_ranking import ranking
from solarcms.services.kpis import first_reading, plant_zone

PERIODS = ("today", "month", "year")
GRANULARITIES = ("day", "month", "year")

CACHE_KEY = "revenue:v1:{plant_id}:{start}:{end}:{digest}"
LIVE_CACHE_S = 60
PAST_CACHE_S = 6 * 3600

_PAIRS: tuple[tuple[str, str], ...] = tuple(dict.fromkeys((
    *REVENUE_EXPORT_COUNTER_PRECEDENCE,
    *PLANT_IMPORT_COUNTER_PRECEDENCE,
    *REVENUE_GENERATION_COUNTER_PRECEDENCE,
)))
_INSTANT = timedelta(microseconds=1)

_TYPE_WORDS = {"ABT_METER": "ABT Meter", "MFM": "MFM", "INVERTER": "Inverters"}


@dataclass(frozen=True, slots=True)
class PlantRow:
    id: int
    code: str
    name: str
    client_name: str | None
    zone: ZoneInfo
    ac_kw: float | None
    tariff: float | None


@dataclass(frozen=True, slots=True)
class Energy:
    """One span's registers, each None where nothing could answer."""

    exported_kwh: float | None
    export_type: str | None
    export_devices: int
    imported_kwh: float | None
    generated_kwh: float | None
    generation_type: str | None
    refused_steps: int

    @staticmethod
    def of(series: Sequence[DeviceSeries], ac_kw: float | None) -> Energy:
        export = plant_energy(series, REVENUE_EXPORT_COUNTER_PRECEDENCE,
                              plant_ac_capacity_kw=ac_kw)
        imports = plant_energy(series, PLANT_IMPORT_COUNTER_PRECEDENCE,
                               plant_ac_capacity_kw=ac_kw)
        made = plant_energy(series, REVENUE_GENERATION_COUNTER_PRECEDENCE,
                            plant_ac_capacity_kw=ac_kw)
        return Energy(
            exported_kwh=export.value, export_type=export.device_type_code,
            export_devices=len(export.devices),
            imported_kwh=imports.value,
            generated_kwh=made.value, generation_type=made.device_type_code,
            refused_steps=len(export.anomalies) + len(imports.anomalies) + len(made.anomalies),
        )


def _sum(values: Sequence[float | None]) -> float | None:
    known = [v for v in values if v is not None]
    return sum(known) if known else None


def _combine(parts: Sequence[Energy]) -> tuple[Energy, list[str]]:
    """Several spans' energy as one, and the Types each figure came from."""
    export_types = [p.export_type for p in parts if p.export_type]
    generation_types = [p.generation_type for p in parts if p.generation_type]
    combined = Energy(
        exported_kwh=_sum([p.exported_kwh for p in parts]),
        export_type=(export_types[0] if len(set(export_types)) == 1 else
                     ("mixed" if export_types else None)),
        export_devices=max((p.export_devices for p in parts), default=0),
        imported_kwh=_sum([p.imported_kwh for p in parts]),
        generated_kwh=_sum([p.generated_kwh for p in parts]),
        generation_type=(generation_types[0] if len(set(generation_types)) == 1 else
                         ("mixed" if generation_types else None)),
        refused_steps=sum(p.refused_steps for p in parts),
    )
    return combined, export_types


async def fetch_plant(session: AsyncSession, plant_id: int) -> PlantRow | None:
    row = (await session.execute(text("""
        SELECT p.id, p.code, p.name, c.name AS client_name, p.timezone,
               p.ac_capacity_kw, p.energy_tariff_inr_per_kwh
          FROM plants p LEFT JOIN clients c ON c.id = p.client_id
         WHERE p.id = :id
    """), {"id": plant_id})).first()
    if row is None:
        return None
    return PlantRow(
        id=row.id, code=row.code, name=row.name, client_name=row.client_name,
        zone=plant_zone(row.timezone),
        ac_kw=float(row.ac_capacity_kw) if row.ac_capacity_kw else None,
        tariff=float(row.energy_tariff_inr_per_kwh)
        if row.energy_tariff_inr_per_kwh is not None else None,
    )


def _counter_tier(start: datetime, end: datetime, now: datetime) -> Tier:
    """As the Reports choose: never the daily tier, which is cut at UTC midnight."""
    tier = select_tier(start, end, now, finest=Tier.AGG_1M)
    return Tier.AGG_1H if tier == Tier.AGG_1D else tier


async def _digest(session: AsyncSession, plant_id: int) -> str:
    """The Devices whose registers count, so a changed set is a new cache entry."""
    ids = await scope.device_ids(
        session, plant_ids=[plant_id], type_codes=[t for t, _ in _PAIRS], generation_only=True)
    return hashlib.sha1(json.dumps(sorted(ids)).encode()).hexdigest()[:12]


async def _series(
    session: AsyncSession, plant: PlantRow, start: datetime, end: datetime, now: datetime,
    tier: Tier | None = None,
) -> list[DeviceSeries]:
    return (await read_counter_series(
        session, tier=tier or _counter_tier(start, end, now), pairs=_PAIRS,
        start=start, end=end, plant_ids=[plant.id],
    )).get(plant.id, [])


def _past_day_tier(start: datetime, now: datetime) -> Tier:
    """A whole past day: quarter-hours while they are kept, else hours — the
    minute tier would read 1,440 rows a Device for a figure 96 give."""
    retention = next(spec.retention for spec in TIERS if spec.tier == Tier.AGG_15M)
    return Tier.AGG_15M if now - start <= retention else Tier.AGG_1H


async def _span_energy(
    session: AsyncSession, plant: PlantRow, start: datetime, end: datetime, now: datetime,
    digest: str, tier: Tier | None = None,
) -> Energy:
    """One span's energy, cached — briefly while it is still running.

    Each span is read on its own, from where its registers stood at its first
    reading, so a day after an outage keeps its own energy; the step across
    the outage belongs to no span (as in the Reports' `split_steps`).
    """
    live = end >= now
    stop = min(end, now)
    key = CACHE_KEY.format(plant_id=plant.id, start=start.isoformat(),
                           end=end.isoformat(), digest=f"{digest}:{tier.value if tier else ''}")
    redis = get_redis()
    cached = await redis.get(key)
    if cached:
        return Energy(**json.loads(cached))
    energy = Energy.of(await _series(session, plant, start, stop, now, tier), plant.ac_kw)
    await redis.set(key, json.dumps(asdict(energy)), ex=LIVE_CACHE_S if live else PAST_CACHE_S)
    return energy


async def _month_energy(
    session: AsyncSession, plant: PlantRow, first: date, now: datetime, digest: str,
) -> Energy:
    return await _span_energy(
        session, plant, local_midnight(first, plant.zone),
        local_midnight(next_month(first), plant.zone), now, digest)


def _figures(energy: Energy, tariff: float | None) -> dict[str, Any]:
    money = revenue(energy.exported_kwh, tariff)
    return {
        "generated_kwh": energy.generated_kwh,
        "exported_kwh": energy.exported_kwh,
        "imported_kwh": energy.imported_kwh,
        "revenue_inr": money.value,
        "revenue_reason": money.reason,
    }


def _source(
    export_types: Sequence[str], devices: int, generation_type: str | None,
) -> dict[str, Any]:
    kind = basis(export_types)
    named = sorted(set(export_types))
    return {
        "basis": kind,
        "export_device_type_code": named[0] if len(named) == 1 else None,
        "export_device_types": named,
        "export_device_count": devices,
        "generation_device_type_code": generation_type,
        "words": (
            None if kind is None else
            (f"{_TYPE_WORDS.get(named[0], named[0])} export register — settlement"
             if kind == "settlement" else
             "Estimate — from the "
             + " and ".join(_TYPE_WORDS.get(t, t) for t in named)
             + ", not the settlement (ABT) meter")
        ),
    }


# ── The summary ──────────────────────────────────────────────────────────────

async def _today_energy(
    session: AsyncSession, plant: PlantRow, now: datetime, digest: str,
) -> Energy:
    today = now.astimezone(plant.zone).date()
    return await _span_energy(
        session, plant, local_midnight(today, plant.zone),
        local_midnight(today + timedelta(days=1), plant.zone), now, digest)


async def _year_parts(
    session: AsyncSession, plant: PlantRow, first: date, now: datetime, digest: str,
) -> list[Energy]:
    """Each month of the financial year beginning `first`, up to this one."""
    this_month = month_start(now.astimezone(plant.zone).date())
    parts: list[Energy] = []
    cursor = first
    stop = next_financial_year(first)
    while cursor < stop and cursor <= this_month:
        parts.append(await _month_energy(session, plant, cursor, now, digest))
        cursor = next_month(cursor)
    return parts


async def period_energy(
    session: AsyncSession, plant: PlantRow, period: str, now: datetime, digest: str,
) -> tuple[Energy, list[str]]:
    today = now.astimezone(plant.zone).date()
    if period == "today":
        energy = await _today_energy(session, plant, now, digest)
        return energy, [energy.export_type] if energy.export_type else []
    if period == "month":
        energy = await _month_energy(session, plant, month_start(today), now, digest)
        return energy, [energy.export_type] if energy.export_type else []
    if period == "year":
        return _combine(await _year_parts(
            session, plant, financial_year_start(today), now, digest))
    raise ValueError(f"unknown revenue period {period!r}")


def _rest_of_today(
    forecast: dict[str, Any] | None, now: datetime,
) -> tuple[float | None, str | None]:
    power = (forecast or {}).get("power")
    if not power or power.get("unavailable") or not power.get("today"):
        return None, ((power or {}).get("unavailable")
                      or (forecast or {}).get("power_unavailable")
                      or "the forecast has no power curve for this Plant")
    if power.get("unit") != "kW":
        return None, f"the forecast is in {power.get('unit') or 'no unit'}, not kW"
    slots = [
        PowerSlot(
            at=datetime.fromisoformat(str(entry["at"])),
            minutes=15,
            forecast_kw=float(entry["forecast"]) if entry.get("forecast") is not None else None,
        )
        for entry in power["today"]
    ]
    # Slots already past carry no forecast; only those from now on are asked.
    rest = rest_of_today_kwh([s for s in slots if s.at + timedelta(minutes=15) > now], now)
    return rest, None if rest is not None else "the forecast has a gap in the rest of today"


def _typical_day(forecast: dict[str, Any] | None) -> tuple[float | None, str | None]:
    energy = (forecast or {}).get("energy")
    if not energy or energy.get("unavailable"):
        return None, ((energy or {}).get("unavailable")
                      or (forecast or {}).get("energy_unavailable")
                      or "the forecast has no typical day for this Plant")
    if energy.get("unit") != "kWh":
        return None, f"the forecast's energy is in {energy.get('unit') or 'no unit'}, not kWh"
    value = (energy.get("tomorrow") or {}).get("value")
    return (float(value), None) if value is not None else (None, "no typical day yet")


async def _loss(
    session: AsyncSession, plant: PlantRow, period: str, now: datetime,
) -> dict[str, Any]:
    """The Inverter ranking's downtime loss, summed; at most a month at a time."""
    today = now.astimezone(plant.zone).date()
    if period == "year":
        return {"value": None, "floor": False, "missing": [],
                "reason": "worked out a month at a time — see This month"}
    try:
        payload = (await ranking(session, plant.id, "today", now) if period == "today" else
                   await ranking(session, plant.id, "custom", now, month_start(today), today))
    except ValueError as exc:
        return {"value": None, "floor": False, "missing": [], "reason": str(exc)}
    if payload is None:
        return {"value": None, "floor": False, "missing": [], "reason": "plant not found"}
    rows = [
        LossRow(code=row["code"], loss_inr=row["loss_inr"]["value"],
                downtime_hours=row["downtime_hours"])
        for row in payload["inverters"]
    ]
    total = total_loss(rows, plant.tariff)
    downtime = _sum([row.downtime_hours for row in rows])
    return {"value": total.value, "floor": total.floor, "missing": list(total.missing),
            "reason": total.reason, "downtime_hours": downtime}


async def plant_revenue(
    session: AsyncSession, plant_id: int, now: datetime,
) -> dict[str, Any] | None:
    """Today, this month and this financial year; None when the Plant is not visible."""
    plant = await fetch_plant(session, plant_id)
    if plant is None:
        return None
    digest = await _digest(session, plant_id)
    today = now.astimezone(plant.zone).date()
    fy_first = financial_year_start(today)
    forecast = await plant_forecast(session, plant_id, now)
    rest, rest_reason = _rest_of_today(forecast, now)
    typical, typical_reason = _typical_day(forecast)

    days_left = {
        "today": 0,
        "month": (next_month(month_start(today)) - today).days - 1,
        "year": (next_financial_year(fy_first) - today).days - 1,
    }
    labels = {
        "today": f"{today:%d-%m-%Y}",
        "month": f"{today:%B %Y}",
        "year": financial_year_label(fy_first),
    }
    periods: dict[str, Any] = {}
    for period in PERIODS:
        energy, types = await period_energy(session, plant, period, now, digest)
        expected_kwh, expected_reason = expected_energy(
            energy.exported_kwh, rest, typical, days_left[period])
        if expected_reason and rest_reason and "rest of today" in expected_reason:
            expected_reason = rest_reason
        elif expected_reason and typical_reason and "typical day" in expected_reason:
            expected_reason = typical_reason
        expected = revenue(expected_kwh, plant.tariff, what="export") if expected_kwh is not None \
            else None
        periods[period] = {
            "label": labels[period],
            **_figures(energy, plant.tariff),
            "source": _source(types, energy.export_devices, energy.generation_type),
            "refused_steps": energy.refused_steps,
            "expected": {
                "exported_kwh": expected_kwh,
                "revenue_inr": expected.value if expected else None,
                "reason": (expected.reason if expected else None) or expected_reason,
                "days_carried": days_left[period],
            },
            "loss": await _loss(session, plant, period, now),
        }

    return {
        "plant_id": plant.id,
        "timezone": plant.zone.key,
        "computed_at": datetime.now(UTC).isoformat(),
        "tariff_inr_per_kwh": plant.tariff,
        "financial_year_start_month": REVENUE_YEAR_START_MONTH,
        "settlement_device_type_code": REVENUE_SETTLEMENT_TYPE,
        "periods": periods,
        "rule": {
            "revenue": "Exported energy times the Plant's tariff.",
            "export": "The ABT Meter's export register where the Plant has one; otherwise the "
                      "MFM's, labelled an estimate. Never the Inverters: generation is not export.",
            "expected": "Revenue so far, plus the Plant's own forecast for the rest of today and "
                        "its typical day (last 14 days) for each day still to come, times tariff. "
                        "It cannot foresee cloud.",
            "loss": "Each Inverter's rated AC kW times hours down times tariff, as on the Inverter "
                    "ranking — a ceiling, full output assumed for every minute down.",
            "status": "PROPOSED",
        },
    }


# ── The trend ────────────────────────────────────────────────────────────────

async def revenue_trend(
    session: AsyncSession, plant_id: int, granularity: str, now: datetime,
) -> dict[str, Any] | None:
    """Revenue per day (last 30), month (last 12) or financial year."""
    if granularity not in GRANULARITIES:
        raise ValueError(f"granularity is one of {', '.join(GRANULARITIES)}")
    plant = await fetch_plant(session, plant_id)
    if plant is None:
        return None
    digest = await _digest(session, plant_id)
    today = now.astimezone(plant.zone).date()
    points: list[dict[str, Any]] = []
    notes: list[str] = []
    types: list[str] = []

    if granularity == "day":
        first = today - timedelta(days=REVENUE_TREND_DAYS - 1)
        for offset in range(REVENUE_TREND_DAYS):
            day = first + timedelta(days=offset)
            if day == today:
                # The very figure the summary's "Today" shows.
                energy = await _today_energy(session, plant, now, digest)
            else:
                start = local_midnight(day, plant.zone)
                energy = await _span_energy(
                    session, plant, start, local_midnight(day + timedelta(days=1), plant.zone),
                    now, digest, _past_day_tier(start, now))
            if energy.export_type:
                types.append(energy.export_type)
            points.append(_point(day.isoformat(), f"{day:%d %b}", day, day + timedelta(days=1),
                                 energy, plant.tariff, current=day == today))
        notes.append("Each day is read on its own. Energy counted across an outage that "
                     "spanned midnight belongs to no day, so the days can sum to less than "
                     "the month.")
    elif granularity == "month":
        seen = await first_reading(session, plant.id)
        oldest = month_start(seen.astimezone(plant.zone).date()) if seen else month_start(today)
        months = [m for m in months_back(month_start(today), REVENUE_TREND_MONTHS) if m >= oldest]
        for first in months:
            energy = await _month_energy(session, plant, first, now, digest)
            if energy.export_type:
                types.append(energy.export_type)
            points.append(_point(first.isoformat(), f"{first:%b %Y}", first, next_month(first),
                                 energy, plant.tariff, current=first == month_start(today)))
    else:
        seen = await first_reading(session, plant.id)
        this_fy = financial_year_start(today)
        oldest = financial_year_start(seen.astimezone(plant.zone).date()) if seen else this_fy
        starts: list[date] = []
        cursor = this_fy
        while cursor >= oldest and len(starts) < REVENUE_TREND_MAX_YEARS:
            starts.insert(0, cursor)
            cursor = date(cursor.year - 1, cursor.month, 1)
        if cursor >= oldest:
            notes.append(f"Only the last {REVENUE_TREND_MAX_YEARS} financial years are shown.")
        for first in starts:
            combined, year_types = _combine(await _year_parts(session, plant, first, now, digest))
            types.extend(year_types)
            points.append(_point(first.isoformat(), financial_year_label(first), first,
                                 next_financial_year(first), combined, plant.tariff,
                                 current=first == this_fy))

    if plant.tariff is not None:
        notes.append("Every bar uses today's tariff: the tariff's history is not recorded.")
    return {
        "plant_id": plant.id,
        "granularity": granularity,
        "timezone": plant.zone.key,
        "tariff_inr_per_kwh": plant.tariff,
        "source": _source(types, 0, None),
        "points": points,
        "notes": notes,
    }


def _point(
    key: str, label: str, first: date, stop: date, energy: Energy, tariff: float | None,
    *, current: bool,
) -> dict[str, Any]:
    figures = _figures(energy, tariff)
    return {
        "key": key, "label": label,
        "first_day": first.isoformat(), "last_day": (stop - timedelta(days=1)).isoformat(),
        "in_progress": current,
        # "mixed" (ABT some months, MFM others) is not settlement.
        "basis": basis([energy.export_type]),
        **figures,
    }


# ── Every Plant ──────────────────────────────────────────────────────────────

async def fleet_revenue(
    session: AsyncSession, period: str, now: datetime,
) -> dict[str, Any]:
    """Each visible, active Plant's figures for one period — RLS decides which."""
    if period not in PERIODS:
        raise ValueError(f"period is one of {', '.join(PERIODS)}")
    ids = (await session.execute(text("""
        SELECT id FROM plants WHERE status = 'active' ORDER BY name
    """))).scalars().all()
    rows: list[dict[str, Any]] = []
    for plant_id in ids:
        plant = await fetch_plant(session, plant_id)
        if plant is None:
            continue
        digest = await _digest(session, plant_id)
        energy, types = await period_energy(session, plant, period, now, digest)
        rows.append({
            "plant_id": plant.id, "code": plant.code, "name": plant.name,
            "client_name": plant.client_name,
            "tariff_inr_per_kwh": plant.tariff,
            **_figures(energy, plant.tariff),
            "source": _source(types, energy.export_devices, energy.generation_type),
        })
    return {"period": period, "computed_at": datetime.now(UTC).isoformat(), "plants": rows}

