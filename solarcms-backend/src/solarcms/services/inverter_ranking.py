"""The Inverter ranking: every Inverter of a Plant over a period, side by side.

Generation, availability, PR, downtime, no-data time and the energy — and the
rupees — the stops cost, for the Inverter Monitoring screen. The rules:

* **Generation** is each Inverter's own lifetime register (`ENERGY_TOTAL`)
  counted step by step on the tier `select_tier` picks — exactly as the
  Inverter Report counts it, so the two never disagree about the same day.
* **PR** is that energy over the Plant's irradiation (the same stations and
  rule as the Plant's own PR, `counters.plant_irradiation`) and this Inverter's
  own DC size. No size, no PR — never estimated (the user's choice).
* **Availability, downtime, no data and energy lost** are
  `domain/inverter_ranking.fold` over one-minute AC output (⚠ PROPOSED).
* **Loss** is energy lost times the Plant's tariff, where one is recorded.

Read through the `*_v` barrier views with the Plant's own Device and Tag ids
(`services/scope.py`): one Plant's cost never grows with the fleet. Cached 60 s
per Plant and period — the minutes behind it change once a minute — after the
visibility check, so the cache cannot hand one Client's figures to another.
The key carries every input a person can edit here (sizes, tariff, variants),
so a corrected size shows at once rather than a minute later.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache.live import get_redis
from solarcms.domain.assumptions import (
    HEALTH_DEGRADED_MULTIPLIER,
    INVERTER_DOWNTIME_MIN_MINUTES,
    INVERTER_PRODUCING_ABOVE_KW,
    PLANT_IRRADIATION_SOURCE,
    PLANT_OPERATING_SOURCE,
)
from solarcms.domain.counters import plant_energy, plant_irradiation
from solarcms.domain.formulas import performance_ratio
from solarcms.domain.inverter_ranking import Folded, InverterMinutes, fold
from solarcms.domain.periods import ReportWindow, report_window
from solarcms.domain.tiering import Tier, select_tier
from solarcms.services import scope
from solarcms.services.energy import read_counter_series, split_by_pair
from solarcms.services.kpis import plant_zone

ENERGY_PAIR = ("INVERTER", "ENERGY_TOTAL")
CACHE_KEY = "inverter_ranking:v1:{plant_id}:{digest}"
#: While the period reaches now, the figures move each minute.
LIVE_CACHE_S = 60
#: A period wholly in the past changes only if history is replayed into it.
PAST_CACHE_S = 600
#: A minute-by-minute fold over every Inverter: a month is the most a screen
#: request reads. Longer spans belong to the Inverter Report.
MAX_DAYS = 31
#: The longest list of stops returned per Inverter; the count is always whole.
MAX_STOPS = 50
MINUTE = timedelta(minutes=1)


@dataclass(frozen=True, slots=True)
class Inverter:
    id: int
    code: str
    name: str
    variant: str | None
    dc_kwp: float | None
    rated_kw: float | None
    comm_status: str | None
    #: Bound to AC active power: without it the fold has nothing to read.
    bound: bool
    hold_minutes: int


async def ranking(
    session: AsyncSession, plant_id: int, period: str, now: datetime,
    from_date: date | None = None, to_date: date | None = None,
    from_time: time | None = None, to_time: time | None = None,
) -> dict[str, Any] | None:
    """The ranking payload, or None when the Plant is not visible to the caller.

    Raises ValueError with a sentence for the reader for a period that cannot
    be read (the router answers 422).
    """
    plant = (await session.execute(text("""
        SELECT id, timezone, dc_capacity_kwp, ac_capacity_kw, energy_tariff_inr_per_kwh
          FROM plants WHERE id = :id
    """), {"id": plant_id})).first()
    if plant is None:
        return None
    zone = plant_zone(plant.timezone)
    window = report_window(period, now, zone, from_date, to_date, from_time, to_time)
    if (window.last_day - window.first_day).days + 1 > MAX_DAYS:
        raise ValueError(
            f"the Inverter ranking covers at most {MAX_DAYS} days; the Inverter "
            "Report covers longer periods")

    inverters = await _inverters(session, plant_id)
    tariff = _float(plant.energy_tariff_inr_per_kwh)
    digest = hashlib.sha1(json.dumps([
        period, window.start.isoformat(), window.last_day.isoformat(),
        str(window.to_time), tariff,
        [(i.id, i.dc_kwp, i.variant, i.bound) for i in inverters],
    ]).encode()).hexdigest()[:16]
    key = CACHE_KEY.format(plant_id=plant_id, digest=digest)
    redis = get_redis()
    cached = await redis.get(key)
    if cached:
        payload: dict[str, Any] = json.loads(cached)
        return payload

    payload = await _compute(session, plant, zone, window, inverters, tariff, now)
    live = window.end >= now - MINUTE
    await redis.set(key, json.dumps(payload, default=str),
                    ex=LIVE_CACHE_S if live else PAST_CACHE_S)
    return payload


def _float(value: Any) -> float | None:
    return None if value is None else float(value)


async def _inverters(session: AsyncSession, plant_id: int) -> list[Inverter]:
    """The Plant's Inverters, retired ones aside, with how long each value holds.

    A value holds until the health sweep would call the Device late, as the
    Plant's operating rule holds it (`services/operating._hold`).
    """
    type_code, tag_code = PLANT_OPERATING_SOURCE
    rows = (await session.execute(text("""
        SELECT d.id, d.code, d.name, dm.variant, d.dc_capacity_kwp, d.rated_capacity_kw,
               h.comm_status, b.id IS NOT NULL AS bound,
               GREATEST(d.expected_interval_s, coalesce(t.min_interval_s, 0), 60)
                   AS stored_every_s
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          LEFT JOIN tags t ON t.code = :tag_code
          LEFT JOIN device_tag_bindings b
                 ON b.device_id = d.id AND b.tag_id = t.id AND b.enabled
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id AND dt.code = :type_code
           AND d.status <> 'decommissioned'
         ORDER BY d.code
    """), {"plant_id": plant_id, "type_code": type_code, "tag_code": tag_code})).all()
    return [
        Inverter(
            id=row.id, code=row.code, name=row.name, variant=row.variant,
            dc_kwp=_float(row.dc_capacity_kwp), rated_kw=_float(row.rated_capacity_kw),
            comm_status=row.comm_status, bound=bool(row.bound),
            hold_minutes=int(HEALTH_DEGRADED_MULTIPLIER * row.stored_every_s // 60),
        )
        for row in rows
    ]


async def _minutes(
    session: AsyncSession, inverters: Sequence[Inverter], window: ReportWindow,
) -> tuple[dict[int, tuple[list[int], list[float], list[float]]], dict[int, int]]:
    """Each Inverter's good one-minute AC output as minute indices from the
    window's first minute, and how many flagged minutes were left out.

    One row per Inverter, arrays aggregated in the database: a month of a
    seventeen-Inverter Plant is ~730k minutes, and as Python row objects that
    would cost hundreds of megabytes for one request.
    """
    bound = [i for i in inverters if i.bound]
    if not bound:
        return {}, {}
    tags = await scope.tag_ids(session, [PLANT_OPERATING_SOURCE[1]])
    if not tags:
        return {}, {}
    lookback = timedelta(minutes=max(i.hold_minutes for i in bound))
    first = _floor_minute(window.start)
    rows = (await session.execute(text("""
        SELECT a.device_id,
               array_agg(CAST(EXTRACT(EPOCH FROM a.bucket - CAST(:first AS timestamptz))
                              / 60 AS integer) ORDER BY a.bucket)
                   FILTER (WHERE coalesce(a.worst_quality, 0) = 0
                             AND a.max_value IS NOT NULL) AS at,
               array_agg(a.avg_value ORDER BY a.bucket)
                   FILTER (WHERE coalesce(a.worst_quality, 0) = 0
                             AND a.max_value IS NOT NULL) AS mean_kw,
               array_agg(a.max_value ORDER BY a.bucket)
                   FILTER (WHERE coalesce(a.worst_quality, 0) = 0
                             AND a.max_value IS NOT NULL) AS peak_kw,
               count(*) FILTER (WHERE coalesce(a.worst_quality, 0) <> 0
                                  AND a.bucket >= CAST(:first AS timestamptz)) AS flagged
          FROM agg_1m_v a
         WHERE a.device_id = ANY(:device_ids) AND a.tag_id = ANY(:tag_ids)
           AND a.bucket >= :from_ AND a.bucket < :end
         GROUP BY a.device_id
    """), {"device_ids": [i.id for i in bound], "tag_ids": tags, "first": first,
          "from_": first - lookback, "end": window.end})).all()
    series = {
        row.device_id: (
            list(row.at or []),
            [float(v) if v is not None else 0.0 for v in (row.mean_kw or [])],
            [float(v) for v in (row.peak_kw or [])],
        )
        for row in rows
    }
    return series, {row.device_id: int(row.flagged or 0) for row in rows}


async def _planned(
    session: AsyncSession, plant_id: int, window: ReportWindow,
) -> list[tuple[int | None, int, int]]:
    """Planned work in the window as (Device or None for the whole Plant,
    first minute, end minute)."""
    first = _floor_minute(window.start)
    rows = (await session.execute(text("""
        SELECT device_id, starts_at, coalesce(ends_at, CAST(:end AS timestamptz)) AS ends_at
          FROM maintenance_windows
         WHERE plant_id = :plant_id AND starts_at < CAST(:end AS timestamptz)
           AND coalesce(ends_at, CAST(:end AS timestamptz)) > CAST(:start AS timestamptz)
    """), {"plant_id": plant_id, "start": window.start, "end": window.end})).all()
    return [
        (row.device_id,
         math.floor((row.starts_at - first) / MINUTE),
         math.ceil((row.ends_at - first) / MINUTE))
        for row in rows
    ]


def _floor_minute(at: datetime) -> datetime:
    return at.replace(second=0, microsecond=0)


async def _energy(
    session: AsyncSession, plant_id: int, window: ReportWindow, now: datetime,
    ac_kw: float | None,
) -> tuple[dict[int, tuple[float, int]], float | None, str | None, Tier]:
    """Each Inverter's generation (kWh, refused steps) and the Plant's
    irradiation (kWh/m²) or why there is none — the Inverter Report's and the
    Plant PR's own rules."""
    tier = select_tier(window.start, window.end, now, finest=Tier.AGG_1M)
    # Irradiation never from the daily tier: its register restarts at the
    # Plant's midnight and a daily bucket is cut at UTC's (services/kpis).
    sun_tier = Tier.AGG_1H if tier == Tier.AGG_1D else tier
    pairs = [ENERGY_PAIR] + ([PLANT_IRRADIATION_SOURCE] if sun_tier == tier else [])
    series = (await read_counter_series(
        session, tier=tier, pairs=pairs, start=window.start, end=window.end,
        plant_ids=[plant_id])).get(plant_id, [])
    registers, stations = split_by_pair(series, ENERGY_PAIR)
    if sun_tier != tier:
        stations = (await read_counter_series(
            session, tier=sun_tier, pairs=[PLANT_IRRADIATION_SOURCE], start=window.start,
            end=window.end, plant_ids=[plant_id])).get(plant_id, [])
    energy = plant_energy(registers, (ENERGY_PAIR,), plant_ac_capacity_kw=ac_kw or None)
    generation = {
        item.series.device_id: (item.integral.total, len(item.integral.anomalies))
        for item in energy.devices
    }
    sun = plant_irradiation(stations)
    return generation, sun.value, sun.undefined_reason, tier


async def _compute(
    session: AsyncSession, plant: Any, zone: ZoneInfo, window: ReportWindow,
    inverters: list[Inverter], tariff: float | None, now: datetime,
) -> dict[str, Any]:
    first = _floor_minute(window.start)
    span = max(0, math.ceil((window.end - first) / MINUTE))
    minutes, flagged = await _minutes(session, inverters, window)
    planned = await _planned(session, plant.id, window)
    generation, irradiation, irradiation_reason, tier = await _energy(
        session, plant.id, window, now, _float(plant.ac_capacity_kw))

    result: Folded = fold([
        InverterMinutes(
            device_id=inv.id, dc_kwp=inv.dc_kwp, hold_minutes=inv.hold_minutes,
            minutes=minutes.get(inv.id, ([], [], []))[0],
            mean_kw=minutes.get(inv.id, ([], [], []))[1],
            peak_kw=minutes.get(inv.id, ([], [], []))[2],
            planned=[(s, e) for device, s, e in planned
                     if device is None or device == inv.id],
        )
        for inv in inverters if inv.bound
    ], span)
    folded = result.inverters

    def stamp(minute: int) -> str:
        return (first + minute * MINUTE).isoformat()

    rows = []
    for inv in inverters:
        made = generation.get(inv.id)
        energy_kwh = made[0] if made else None
        pr_value: float | None = None
        pr_reason: str | None = None
        if energy_kwh is None:
            pr_reason = "its energy register did not report twice in the period"
        elif not inv.dc_kwp:
            pr_reason = "no DC size is recorded for this Inverter"
        elif irradiation is None:
            pr_reason = irradiation_reason or "no irradiation was measured"
        else:
            pr = performance_ratio(energy_kwh, irradiation * 1000.0, inv.dc_kwp)
            pr_value, pr_reason = pr.value, pr.undefined_reason

        time_ = folded.get(inv.id)
        availability: float | None
        availability_reason: str | None
        lost_kwh: float | None
        lost_reason: str | None
        if time_ is None:
            unbound = "it is not bound to AC active power, so its output is never read"
            availability, availability_reason = None, unbound
            lost_kwh, lost_reason = None, unbound
        else:
            availability, availability_reason = time_.availability, time_.availability_reason
            lost_kwh, lost_reason = time_.lost_kwh, time_.lost_reason
        loss_inr: float | None = None
        loss_reason: str | None = lost_reason
        if lost_kwh is not None:
            if tariff is None:
                loss_reason = "no tariff is recorded for this Plant"
            else:
                loss_inr, loss_reason = lost_kwh * tariff, None

        rows.append({
            "device_id": inv.id,
            "code": inv.code,
            "name": inv.name,
            "variant": inv.variant,
            "comm_status": inv.comm_status,
            "dc_capacity_kwp": inv.dc_kwp,
            "rated_capacity_kw": inv.rated_kw,
            "generation_kwh": energy_kwh,
            "generation_reason": None if made else
                "its energy register did not report twice in the period",
            "refused_steps": made[1] if made else 0,
            "availability": {"value": availability, "undefined_reason": availability_reason},
            "performance_ratio": {"value": pr_value, "undefined_reason": pr_reason},
            "generating_hours": _hours(time_.judged_minutes) if time_ else 0.0,
            "downtime_hours": _hours(time_.downtime_minutes) if time_ else None,
            "short_stop_hours": _hours(time_.short_stop_minutes) if time_ else None,
            "no_data_hours": _hours(time_.no_data_minutes) if time_ else None,
            "planned_hours": _hours(time_.planned_minutes) if time_ else 0.0,
            "stop_count": len(time_.stops) if time_ else 0,
            "stops": [
                {"start": stamp(stop.start), "end": stamp(stop.end),
                 "minutes": stop.end - stop.start, "lost_kwh": stop.lost_kwh,
                 "ongoing": stop.ongoing}
                for stop in (time_.stops[-MAX_STOPS:] if time_ else ())
            ],
            "lost_kwh": {"value": lost_kwh, "undefined_reason": lost_reason},
            "loss_inr": {"value": loss_inr, "undefined_reason": loss_reason},
            "flagged_minutes": flagged.get(inv.id, 0),
        })

    return {
        "plant_id": plant.id,
        "period": window.period,
        "first_day": window.first_day.isoformat(),
        "last_day": window.last_day.isoformat(),
        "period_start": window.start.isoformat(),
        "period_end": window.end.isoformat(),
        "timezone": zone.key,
        "computed_at": datetime.now(UTC).isoformat(),
        "tariff_inr_per_kwh": tariff,
        "irradiation_kwh_m2": irradiation,
        "irradiation_reason": irradiation_reason,
        "energy_tier": tier.value,
        # What every figure is read against (Guardrail 18): how much of the
        # period any Inverter was heard, and any was generating. A gap the
        # whole Plant shared is judged by nobody, so it shows here, not as
        # one Inverter's no-data time.
        "coverage": {
            "period_hours": _hours(result.minutes),
            "heard_hours": _hours(result.heard_minutes),
            "generating_hours": _hours(result.generating_minutes),
        },
        "rule": {
            "producing_above_kw": INVERTER_PRODUCING_ABOVE_KW,
            "min_stop_minutes": INVERTER_DOWNTIME_MIN_MINUTES,
            "status": "PROPOSED",
        },
        "inverters": rows,
    }


def _hours(minutes: int) -> float:
    return round(minutes / 60.0, 3)
