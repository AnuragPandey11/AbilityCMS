"""Grid, Plant and Inverter availability over a KPI period (⚠ PROPOSED).

The rules are `domain/availability.py`'s; this reads the minutes and keeps the
completed days. Each Plant-local day is folded once, at one-minute resolution,
and its **tally** (minutes judged and down at each level) kept in Redis under
a key carrying every input a person can change — the Devices and their sizes,
planned work, the Plant's location, its last edit — so an edit is a new key,
never a stale figure. A period is today's live fold plus its completed days'
tallies, summed: a month is a ratio of the month's minutes, never a mean of
daily percentages, and the 10-minute stop rule means the same thing in every
period.

A day that ended under 48 hours ago is kept only 15 minutes, since replayed
backlogs and late materialisations still change it. `agg_1m` is kept for a
year, so a day older than that is not counted, and a
request works out at most `AVAILABILITY_DAYS_PER_PASS` uncounted days — the
response says how many are still to come. Read through the barrier views with
the Plant's own Device and Tag ids (`services/scope.py`); the scheduler calls
this with platform privileges, and every query is bounded by those ids.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache.live import get_redis
from solarcms.domain import availability as rules
from solarcms.domain.assumptions import (
    AVAILABILITY_CURTAILED_AT_OR_BELOW_KW,
    AVAILABILITY_DAYLIGHT_SUN_ELEVATION_DEG,
    AVAILABILITY_DAYLIGHT_W_PER_M2,
    AVAILABILITY_DAYS_PER_PASS,
    AVAILABILITY_GRID_FREQUENCY_HZ,
    AVAILABILITY_ZERO_FRACTION,
    GRID_STATUS_SOURCE,
    HEALTH_DEGRADED_MULTIPLIER,
    INVERTER_DOWNTIME_MIN_MINUTES,
    INVERTER_PRODUCING_ABOVE_KW,
    PLANT_IRRADIANCE_LIVE_SOURCE,
    PLANT_OPERATING_SOURCE,
)
from solarcms.domain.sun import solar_elevation_deg
from solarcms.logging import get_logger

log = get_logger(__name__)

DAY_KEY = "availability:v1:{plant_id}:{day}:{digest}"
#: A day that ended this recently may still change: the client's broker replays
#: backlogs, and `agg_1m` rows added late are materialised late. It is kept
#: briefly, so what arrives afterwards is counted.
RECENT_DAY = timedelta(hours=48)
RECENT_DAY_TTL_S = 15 * 60
#: After that a day changes only if history is replayed into it by hand
#: (`backfill-device`, `refresh-aggregates`); clear `availability:v1:{plant}:*`
#: then, or its old tally stands for the rest of this time.
DAY_TTL_S = 400 * 86_400
#: Today moves every minute; the snapshot loop asks for four periods a minute.
TODAY_TTL_S = 50
#: `agg_1m`'s retention (`domain/tiering`): older days have no minutes left.
MINUTE_RETENTION = timedelta(days=365)
MINUTE = timedelta(minutes=1)

INVERTER = PLANT_OPERATING_SOURCE  # ("INVERTER", "AC_ACTIVE_POWER")
STATION = PLANT_IRRADIANCE_LIVE_SOURCE  # ("WMS", "GHI")
BREAKER = GRID_STATUS_SOURCE  # ("VCB", "VCB_ON_FEEDBACK")
FREQUENCY = "FREQUENCY"
HV_VOLTAGES = ("HV_VOLTAGE_RY", "HV_VOLTAGE_YB", "HV_VOLTAGE_BR")
PPC_ENABLE = "ACTIVE_POWER_CONTROL_ENABLE"
PPC_SETPOINT = "ACTIVE_POWER_SETPOINT"
#: The grid meter: the sealed settlement instrument first, else the solar MFMs.
METER_TYPES = ("ABT_METER", "MFM")

_TAGS = (INVERTER[1], STATION[1], BREAKER[1], FREQUENCY, *HV_VOLTAGES, PPC_ENABLE, PPC_SETPOINT)
_TYPES = (INVERTER[0], STATION[0], BREAKER[0], *METER_TYPES, "PPC")
#: Every number the fold uses: a changed constant is a new key for every day.
_RULES = (AVAILABILITY_DAYLIGHT_W_PER_M2, AVAILABILITY_DAYLIGHT_SUN_ELEVATION_DEG,
          AVAILABILITY_GRID_FREQUENCY_HZ, AVAILABILITY_ZERO_FRACTION,
          AVAILABILITY_CURTAILED_AT_OR_BELOW_KW, INVERTER_PRODUCING_ABOVE_KW,
          INVERTER_DOWNTIME_MIN_MINUTES)


@dataclass(frozen=True, slots=True)
class _Binding:
    device_id: int
    code: str
    type_code: str
    rated_kw: float | None
    measures_generation: bool
    tag_id: int
    tag_code: str
    valid_min: float | None
    valid_max: float | None
    hold_minutes: int


@dataclass(frozen=True, slots=True)
class _Inputs:
    """Which Devices answer which part, as one Plant is wired now."""

    bindings: list[_Binding]
    inverters: dict[int, _Binding]
    stations: list[_Binding]
    meters: dict[int, list[_Binding]]
    breakers: list[_Binding]
    controllers: dict[int, dict[str, _Binding]]
    planned: list[tuple[int | None, datetime, datetime | None]]

    @property
    def grid_type(self) -> str | None:
        return next((b.type_code for bs in self.meters.values() for b in bs), None)


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _midnight(day: date, zone: ZoneInfo) -> datetime:
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(UTC)


async def _inputs(session: AsyncSession, plant_id: int) -> _Inputs:
    rows = (await session.execute(text("""
        SELECT d.id, d.code, dt.code AS type_code, d.rated_capacity_kw,
               d.measures_generation, t.id AS tag_id, t.code AS tag_code,
               COALESCE(b.valid_min, t.valid_min) AS valid_min,
               COALESCE(b.valid_max, t.valid_max) AS valid_max,
               GREATEST(d.expected_interval_s, coalesce(t.min_interval_s, 0), 60)
                   AS stored_every_s
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          JOIN device_tag_bindings b ON b.device_id = d.id AND b.enabled
          JOIN tags t ON t.id = b.tag_id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
           AND dt.code = ANY(:types) AND t.code = ANY(:tags)
         ORDER BY d.code, t.code
    """), {"plant_id": plant_id, "types": list(_TYPES), "tags": list(_TAGS)})).all()
    bindings = [
        _Binding(
            device_id=r.id, code=r.code, type_code=r.type_code,
            rated_kw=float(r.rated_capacity_kw) if r.rated_capacity_kw is not None else None,
            measures_generation=bool(r.measures_generation), tag_id=r.tag_id,
            tag_code=r.tag_code,
            valid_min=float(r.valid_min) if r.valid_min is not None else None,
            valid_max=float(r.valid_max) if r.valid_max is not None else None,
            # A value stands until the sweep would call the Device late, as the
            # operating rule and the Inverter ranking hold it.
            hold_minutes=int(HEALTH_DEGRADED_MULTIPLIER * r.stored_every_s // 60),
        )
        for r in rows
    ]

    def of(type_code: str, tag_code: str) -> list[_Binding]:
        return [b for b in bindings if b.type_code == type_code and b.tag_code == tag_code]

    # Only an HV meter can tell the grid from the Plant: an LT meter reads a dead
    # bus whenever the Plant's own breaker opens. ABT first; an MFM only if it
    # measures the solar output and is bound to an HV voltage.
    meters: dict[int, list[_Binding]] = {}
    for type_code in METER_TYPES:
        by_device: dict[int, list[_Binding]] = defaultdict(list)
        for b in bindings:
            if b.type_code == type_code and b.tag_code in (FREQUENCY, *HV_VOLTAGES) \
                    and (type_code == "ABT_METER" or b.measures_generation):
                by_device[b.device_id].append(b)
        qualified = {
            device_id: bs for device_id, bs in by_device.items()
            if any(b.tag_code in HV_VOLTAGES for b in bs)
        }
        if qualified:
            meters = qualified
            break

    controllers: dict[int, dict[str, _Binding]] = defaultdict(dict)
    for b in bindings:
        if b.type_code == "PPC" and b.tag_code in (PPC_ENABLE, PPC_SETPOINT):
            controllers[b.device_id][b.tag_code] = b

    planned = [
        (r.device_id, r.starts_at, r.ends_at)
        for r in (await session.execute(text("""
            SELECT device_id, starts_at, ends_at FROM maintenance_windows
             WHERE plant_id = :plant_id ORDER BY starts_at, device_id
        """), {"plant_id": plant_id})).all()
    ]
    return _Inputs(
        bindings=bindings,
        inverters={b.device_id: b for b in of(*INVERTER)},
        stations=of(*STATION),
        meters=meters,
        breakers=of(*BREAKER),
        controllers=dict(controllers),
        planned=planned,
    )


def _digest(inputs: _Inputs, plant: Any, edited_at: Any) -> str:
    raw = json.dumps({
        "bindings": [
            [b.device_id, b.tag_id, b.rated_kw, b.measures_generation,
             b.valid_min, b.valid_max, b.hold_minutes]
            for b in inputs.bindings
        ],
        "planned": [[d, str(s), str(e)] for d, s, e in inputs.planned],
        "where": [str(plant.latitude), str(plant.longitude), plant.timezone],
        "edited": str(edited_at),
        "rules": [str(r) for r in _RULES],
    }, sort_keys=True)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def _zero(binding: _Binding) -> float:
    """What counts as zero for this Tag: a share of its range, never exactly 0."""
    if binding.valid_min is None or binding.valid_max is None:
        return 1e-9
    return max(1e-9, abs(binding.valid_max - binding.valid_min) * AVAILABILITY_ZERO_FRACTION)


async def _fold_day(
    session: AsyncSession, inputs: _Inputs, plant: Any, start: datetime, end: datetime,
) -> rules.Tally:
    """Fold [start, end) — one Plant-local day, or today so far — minute by minute."""
    first = start.replace(second=0, microsecond=0)
    n = max(0, math.ceil((end - first) / MINUTE))
    if n == 0 or not inputs.bindings:
        return rules.Tally()
    lookback = timedelta(minutes=max(b.hold_minutes for b in inputs.bindings))
    grid_tags = {b.tag_id for bs in inputs.meters.values() for b in bs}
    rows = (await session.execute(text("""
        SELECT a.device_id, a.tag_id,
               array_agg(CAST(EXTRACT(EPOCH FROM a.bucket - CAST(:first AS timestamptz))
                              / 60 AS integer) ORDER BY a.bucket) AS at,
               array_agg(a.min_value ORDER BY a.bucket) AS low,
               array_agg(a.max_value ORDER BY a.bucket) AS high,
               array_agg(a.avg_value ORDER BY a.bucket) AS mean,
               array_agg(coalesce(a.worst_quality, 0) <> 0 ORDER BY a.bucket) AS flagged
          FROM agg_1m_v a
         WHERE a.device_id = ANY(:device_ids) AND a.tag_id = ANY(:tag_ids)
           AND a.bucket >= :from_ AND a.bucket < :end
           AND a.min_value IS NOT NULL
         GROUP BY a.device_id, a.tag_id
    """), {"device_ids": sorted({b.device_id for b in inputs.bindings}),
           "tag_ids": sorted({b.tag_id for b in inputs.bindings}),
           "first": first, "from_": first - lookback, "end": end})).all()
    raw = {(r.device_id, r.tag_id): r for r in rows}

    def buckets(binding: _Binding) -> rules.Buckets | None:
        row = raw.get((binding.device_id, binding.tag_id))
        if row is None:
            return None
        keep_flagged = binding.tag_id in grid_tags and binding.type_code in METER_TYPES
        at: list[int] = []
        low: list[float] = []
        high: list[float] = []
        mean: list[float] = []
        flagged: list[bool] = []
        for m, lo, hi, me, fl in zip(row.at, row.low, row.high, row.mean, row.flagged,
                                     strict=True):
            # A flagged bucket is never a reading — except the grid's, where a
            # refused zero is the outage itself (`domain/availability`).
            if fl and not keep_flagged:
                continue
            at.append(int(m))
            low.append(float(lo))
            high.append(float(hi))
            mean.append(float(me) if me is not None else float(lo))
            flagged.append(bool(fl))
        return rules.Buckets(binding.device_id, binding.hold_minutes, at, low, high, mean,
                             flagged)

    def present(items: Sequence[rules.Buckets | None]) -> list[rules.Buckets]:
        return [item for item in items if item is not None]

    meters = []
    for device_id, bs in inputs.meters.items():
        frequency = next((b for b in bs if b.tag_code == FREQUENCY), None)
        voltages = [b for b in bs if b.tag_code in HV_VOLTAGES]
        meters.append(rules.Meter(
            device_id=device_id,
            frequency=buckets(frequency) if frequency else None,
            voltages=present([buckets(v) for v in voltages]),
            frequency_zero=_zero(frequency) if frequency else 1e-9,
            voltage_zero=min((_zero(v) for v in voltages), default=1e-9),
        ))
    controllers = [
        rules.Controller(device_id,
                         enable=buckets(tags[PPC_ENABLE]) if PPC_ENABLE in tags else None,
                         setpoint=buckets(tags[PPC_SETPOINT]) if PPC_SETPOINT in tags else None)
        for device_id, tags in inputs.controllers.items()
    ]

    def minute_range(s: datetime, e: datetime | None) -> tuple[int, int]:
        return (math.floor((s - first) / MINUTE),
                math.ceil(((e or end) - first) / MINUTE))

    whole_plant = [minute_range(s, e) for d, s, e in inputs.planned
                   if d is None and s < end and (e is None or e > first)]
    inverters = []
    for device_id, binding in inputs.inverters.items():
        power = buckets(binding) or rules.Buckets(device_id, binding.hold_minutes, [], [], [], [])
        inverters.append(rules.Inverter(
            device_id=device_id, power=power,
            planned=[minute_range(s, e) for d, s, e in inputs.planned
                     if d == device_id and s < end and (e is None or e > first)],
        ))

    sun: list[float] | None = None
    if plant.latitude is not None and plant.longitude is not None:
        lat, lon = float(plant.latitude), float(plant.longitude)
        sun = [solar_elevation_deg(lat, lon, first + t * MINUTE) for t in range(n)]

    return rules.fold(rules.PlantMinutes(
        minutes=n,
        stations=present([buckets(b) for b in inputs.stations]),
        sun_elevation=sun,
        meters=meters,
        breakers=present([buckets(b) for b in inputs.breakers]),
        controllers=controllers,
        inverters=inverters,
        planned=whole_plant,
    ))


async def _redis_get(keys: list[str]) -> list[str | None]:
    if not keys:
        return []
    try:
        values: list[str | None] = await get_redis().mget(keys)
        return values
    except Exception as exc:  # an unreachable Redis is a slower answer, never a failed one
        log.warning("availability tallies unreadable", error=str(exc))
        return [None] * len(keys)


async def _redis_set(key: str, tally: rules.Tally, ttl: int) -> None:
    try:
        await get_redis().set(key, json.dumps(tally.to_json()), ex=ttl)
    except Exception as exc:
        log.warning("availability tally not kept", error=str(exc))


async def plant_levels(
    session: AsyncSession, plant_id: int, start: datetime, now: datetime,
) -> dict[str, Any]:
    """The three figures for [start, now), with the minutes behind them."""
    plant = (await session.execute(text("""
        SELECT p.latitude, p.longitude, p.timezone,
               (SELECT max(plant_edited_at) FROM plant_snapshots s
                 WHERE s.plant_id = p.id) AS edited_at
          FROM plants p WHERE p.id = :plant_id
    """), {"plant_id": plant_id})).first()
    if plant is None:
        return _undefined("the Plant could not be read")
    zone = _zone(plant.timezone)
    inputs = await _inputs(session, plant_id)
    digest = _digest(inputs, plant, plant.edited_at)

    today = now.astimezone(zone).date()
    first_day = start.astimezone(zone).date()
    oldest = (now - MINUTE_RETENTION).astimezone(zone).date()
    days = [first_day + timedelta(days=k) for k in range((today - first_day).days)]
    beyond = [d for d in days if d <= oldest]
    completed = [d for d in days if d > oldest]

    keys = [DAY_KEY.format(plant_id=plant_id, day=d.isoformat(), digest=digest)
            for d in completed]
    today_key = DAY_KEY.format(plant_id=plant_id, day=f"today-{today.isoformat()}",
                               digest=digest)
    cached = await _redis_get([*keys, today_key])

    total = rules.Tally()
    counted = pending = 0
    worked = 0
    # Newest first, so a period still filling has its most recent days.
    for day, key, raw in sorted(zip(completed, keys, cached, strict=False), reverse=True):
        if raw is not None:
            total = total + rules.Tally.from_json(json.loads(raw))
            counted += 1
        elif worked < AVAILABILITY_DAYS_PER_PASS:
            day_end = _midnight(day + timedelta(days=1), zone)
            tally = await _fold_day(session, inputs, plant, _midnight(day, zone), day_end)
            await _redis_set(key, tally,
                             RECENT_DAY_TTL_S if now - day_end < RECENT_DAY else DAY_TTL_S)
            total = total + tally
            counted += 1
            worked += 1
        else:
            pending += 1

    raw_today = cached[-1] if cached else None
    if raw_today is not None:
        total = total + rules.Tally.from_json(json.loads(raw_today))
    else:
        tally = await _fold_day(session, inputs, plant,
                                max(start, _midnight(today, zone)), now)
        await _redis_set(today_key, tally, TODAY_TTL_S)
        total = total + tally

    weights = {device_id: b.rated_kw for device_id, b in inputs.inverters.items()}
    grid, plant_figure, inverter, basis = rules.figures(
        total, has_meter=bool(inputs.meters), weights=weights)
    worst = rules.worst_inverter(total)
    return {
        "variant": rules.VARIANT,
        "grid": {
            **_figure(grid),
            "judged_minutes": total.grid.judged, "down_minutes": total.grid.down,
            "no_data_minutes": total.grid.no_data,
            "source": ({"device_type_code": inputs.grid_type,
                        "device_count": len(inputs.meters)} if inputs.meters else None),
        },
        "plant": {
            **_figure(plant_figure),
            "judged_minutes": total.plant.judged, "down_minutes": total.plant.down,
            "no_data_minutes": total.plant.no_data,
            # Judged with nothing to say whether the grid was there: a grid
            # outage in these minutes reads as the Plant's.
            "without_grid_minutes": total.plant_without_grid,
        },
        "inverter": {
            **_figure(inverter),
            "weighted_by": basis,
            "inverter_count": len(inputs.inverters),
            "judged_minutes": sum(level.judged for level in total.inverters.values()),
            "down_minutes": sum(level.down for level in total.inverters.values()),
            "worst": ({"device_id": worst[0], "device_code": inputs.inverters[worst[0]].code,
                       "down_minutes": worst[1]}
                      if worst is not None and worst[0] in inputs.inverters else None),
        },
        "daylight_minutes": total.daylight,
        "no_sun_minutes": total.no_sun,
        "unattributed_minutes": total.unattributed,
        "curtailed_minutes": total.curtailed,
        "planned_minutes": total.planned,
        # Whole days before today: counted, still to be worked out, and too old
        # for minute data. Today is always counted.
        "days_counted": counted,
        "days_pending": pending,
        "days_beyond_retention": len(beyond),
    }


def _figure(figure: rules.Figure) -> dict[str, Any]:
    return {"value": figure.value, "variant": rules.VARIANT, "undefined_reason": figure.reason}


def _undefined(reason: str) -> dict[str, Any]:
    """Every figure undefined, for the same reason — never three zeros."""
    blank = {"value": None, "variant": rules.VARIANT, "undefined_reason": reason,
             "judged_minutes": 0, "down_minutes": 0, "no_data_minutes": 0}
    return {
        "variant": rules.VARIANT,
        # Not worked out at all — never to be read as "nothing measures it".
        "failed": True,
        "grid": {**blank, "source": None},
        "plant": {**blank, "without_grid_minutes": 0},
        "inverter": {**blank, "weighted_by": "count", "inverter_count": 0, "worst": None},
        "daylight_minutes": 0, "no_sun_minutes": 0, "unattributed_minutes": 0,
        "curtailed_minutes": 0, "planned_minutes": 0,
        "days_counted": 0, "days_pending": 0, "days_beyond_retention": 0,
    }


async def plant_levels_or_reason(
    session: AsyncSession, plant_id: int, start: datetime, now: datetime,
) -> dict[str, Any]:
    """`plant_levels`, or every figure undefined with a reason if it failed.

    The three are new and every other KPI must not fall with them; the failure
    is logged with its stack and the screen says the figures could not be
    worked out — never a blank that reads as a Plant with no data.
    """
    try:
        # A savepoint, so a failed statement here leaves the transaction the
        # other KPIs are read in usable rather than aborted.
        async with session.begin_nested():
            return await plant_levels(session, plant_id, start, now)
    except Exception:
        log.exception("availability levels failed", plant_id=plant_id)
        return _undefined("could not be worked out — the error is in the API log")
