"""One Plant's forecast: the facts `domain/forecast.py` needs, gathered once a minute.

── The same claim as the card it sits in ───────────────────────────────────
The power forecast is of the figure the Current Power card shows — the source
the dashboard resolved for `kpi.current_power` on this Plant, read through the
same slot catalogue — and the energy forecast of the figure "Today's Energy"
shows (`kpi.energy_today`, also Energy Summary's "Energy Generated Today"). A
forecast of the Inverters' output printed under a meter's reading would invite
somebody to read the difference as a loss.

── Complete days only ──────────────────────────────────────────────────────
A 15-minute bucket summed across Devices is used only when every Device of the
source contributed to it; a partial bucket reads low and would teach the
profile that the Plant is weaker than it is. A day's energy total is used only
when every Device's readings show the day's end (`register_day_totals`) — a day
cut short by an outage is left out rather than read as a dull day.

Read-only, through the request's own RLS session. Cached per Plant for
`FORECAST_CACHE_S`: the history behind it changes once every 15 minutes, and a
dashboard asks every few seconds.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache.live import get_redis
from solarcms.domain.assumptions import (
    FORECAST_BACKTEST_DAYS,
    FORECAST_CACHE_S,
    FORECAST_CLEARNESS_BUCKETS,
    FORECAST_HISTORY_DAYS,
    FORECAST_REGISTER_SETTLED_MIN,
)
from solarcms.domain.forecast import (
    SLOT_MINUTES,
    SLOTS_PER_DAY,
    DayValues,
    RegisterBucket,
    backtest,
    build_profile,
    clearness,
    daily_energy,
    forecast_at,
    history_window,
    register_day_totals,
)
from solarcms.domain.slots import ResolvedSlot, resolve_all
from solarcms.services.dashboard import counter_pairs, gather, load_slot_specs

POWER_SLOT = "kpi.current_power"
ENERGY_SLOT = "kpi.energy_today"
CACHE_KEY = "forecast:v1:{plant_id}"


def _cache_key(plant_id: int) -> str:
    return CACHE_KEY.format(plant_id=plant_id)


async def plant_forecast(
    session: AsyncSession, plant_id: int, now: datetime,
) -> dict[str, Any] | None:
    """The forecast payload, or None when the Plant is not visible to the caller."""
    plant = (await session.execute(text("""
        SELECT id, timezone, ac_capacity_kw FROM plants WHERE id = :id
    """), {"id": plant_id})).first()
    if plant is None:
        return None
    # The visibility check above runs every time; only then is a cached
    # answer handed out, so the cache cannot leak a Plant across Clients.
    redis = get_redis()
    cached = await redis.get(_cache_key(plant_id))
    if cached:
        payload: dict[str, Any] = json.loads(cached)
        return payload
    payload = await _compute(session, plant_id, plant.timezone,
                             float(plant.ac_capacity_kw) if plant.ac_capacity_kw else None, now)
    await redis.set(_cache_key(plant_id), json.dumps(payload, default=str), ex=FORECAST_CACHE_S)
    return payload


async def _resolved(session: AsyncSession, plant_id: int) -> dict[str, ResolvedSlot]:
    specs, _notes = await load_slot_specs(session, plant_id)
    wanted = [s for s in specs if s.code in (POWER_SLOT, ENERGY_SLOT)]
    if not wanted:
        return {}
    facts, units = await gather(session, plant_id, counter_pairs(wanted))
    return {slot.slot_code: slot for slot in resolve_all(wanted, facts, units)}


def _combine(values: list[float], aggregate: str, expected: int) -> float | None:
    """One bucket across the source's Devices — only when every one contributed."""
    if not values:
        return None
    if aggregate == "sum":
        return sum(values) if len(values) == expected else None
    if aggregate == "avg":
        return sum(values) / len(values)
    if aggregate == "max":
        return max(values)
    if aggregate == "min":
        return min(values)
    # first / last: a single Device answers.
    return values[0]


async def _tag_id(session: AsyncSession, code: str | None) -> tuple[int, str | None] | None:
    if code is None:
        return None
    row = (await session.execute(
        text("SELECT id, unit FROM tags WHERE code = :code"), {"code": code})).first()
    return (row.id, row.unit) if row else None


async def _power_days(
    session: AsyncSession, slot: ResolvedSlot, zone: ZoneInfo, since: datetime, now: datetime,
) -> tuple[dict[date, list[float | None]], datetime | None]:
    """15-minute output per local day, and when the latest completed bucket ended."""
    source = slot.source
    assert source is not None
    tag = await _tag_id(session, source.tag_code)
    if tag is None or not source.device_ids:
        return {}, None
    rows = (await session.execute(text("""
        SELECT bucket, device_id, avg_value, worst_quality
          FROM agg_15m_v
         WHERE device_id = ANY(:ids) AND tag_id = :tag
           AND bucket >= :since AND bucket <= :until
    """), {"ids": list(source.device_ids), "tag": tag[0], "since": since,
           "until": now - timedelta(minutes=SLOT_MINUTES)})).all()
    by_bucket: dict[datetime, list[float]] = defaultdict(list)
    for row in rows:
        # A flagged bucket is not data (Guardrail 23), here as on every chart.
        if row.avg_value is None or (row.worst_quality or 0) != 0:
            continue
        by_bucket[row.bucket].append(float(row.avg_value))
    days: dict[date, list[float | None]] = {}
    latest_end: datetime | None = None
    for bucket, values in by_bucket.items():
        value = _combine(values, source.aggregate, len(source.device_ids))
        if value is None:
            continue
        local = bucket.astimezone(zone)
        slot_index = (local.hour * 60 + local.minute) // SLOT_MINUTES
        day = days.setdefault(local.date(), [None] * SLOTS_PER_DAY)
        day[slot_index] = value
        end = bucket + timedelta(minutes=SLOT_MINUTES)
        latest_end = end if latest_end is None or end > latest_end else latest_end
    return days, latest_end


async def _energy_totals(
    session: AsyncSession, slot: ResolvedSlot, zone: ZoneInfo, since: datetime,
) -> dict[date, float]:
    """Each complete local day's total from a daily register, across the source's Devices."""
    source = slot.source
    assert source is not None
    tag = await _tag_id(session, source.tag_code)
    if tag is None or not source.device_ids:
        return {}
    rows = (await session.execute(text("""
        SELECT device_id, bucket, min_value, max_value
          FROM agg_15m_v
         WHERE device_id = ANY(:ids) AND tag_id = :tag AND bucket >= :since
           AND COALESCE(worst_quality, 0) = 0
           AND min_value IS NOT NULL AND max_value IS NOT NULL
    """), {"ids": list(source.device_ids), "tag": tag[0], "since": since})).all()
    buckets: dict[int, dict[date, list[RegisterBucket]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        local = row.bucket.astimezone(zone)
        buckets[row.device_id][local.date()].append((
            (local.hour * 60 + local.minute) // SLOT_MINUTES,
            float(row.min_value), float(row.max_value),
        ))
    settled_slots = -(-FORECAST_REGISTER_SETTLED_MIN // SLOT_MINUTES)
    per_day: dict[date, list[float]] = defaultdict(list)
    for days in buckets.values():
        for day, total in register_day_totals(days, settled_slots=settled_slots).items():
            per_day[day].append(total)
    totals: dict[date, float] = {}
    for day, values in per_day.items():
        value = _combine(values, source.aggregate, len(source.device_ids))
        if value is not None:
            totals[day] = value
    return totals


def _at(day: date, slot: int, zone: ZoneInfo) -> datetime:
    start = datetime(day.year, day.month, day.day, tzinfo=zone)
    return (start + timedelta(minutes=slot * SLOT_MINUTES)).astimezone(UTC)


def _round(value: float | None) -> float | None:
    return None if value is None else round(value, 2)


async def _compute(
    session: AsyncSession, plant_id: int, timezone: str, ac_capacity_kw: float | None,
    now: datetime,
) -> dict[str, Any]:
    zone = ZoneInfo(timezone)
    today = now.astimezone(zone).date()
    first_day = today - timedelta(days=FORECAST_HISTORY_DAYS + FORECAST_BACKTEST_DAYS + 1)
    since = datetime(first_day.year, first_day.month, first_day.day, tzinfo=zone).astimezone(UTC)
    slots = await _resolved(session, plant_id)

    payload: dict[str, Any] = {
        "plant_id": plant_id, "generated_at": now, "timezone": timezone,
        "method": (
            "From this Plant's own last 14 days, with no weather forecast: the next "
            "hours follow how bright it is now along the Plant's clear-day curve, "
            "easing into its typical day; tomorrow and the week ahead are its typical day."
        ),
        "power": None, "energy": None,
    }

    power_slot = slots.get(POWER_SLOT)
    if power_slot is None or power_slot.source is None or not power_slot.source.device_ids:
        payload["power_unavailable"] = "Nothing at this Plant answers Current Power."
    else:
        payload["power"] = await _power_payload(session, power_slot, zone, today, since, now,
                                                ac_capacity_kw)

    energy_slot = slots.get(ENERGY_SLOT)
    if energy_slot is None or energy_slot.source is None or not energy_slot.source.device_ids:
        payload["energy_unavailable"] = "Nothing at this Plant answers Today's Energy."
    else:
        payload["energy"] = await _energy_payload(session, energy_slot, zone, today, since)
    return payload


async def _power_payload(
    session: AsyncSession, slot: ResolvedSlot, zone: ZoneInfo, today: date,
    since: datetime, now: datetime, ac_capacity_kw: float | None,
) -> dict[str, Any]:
    source = slot.source
    assert source is not None
    days, latest_end = await _power_days(session, slot, zone, since, now)
    profile = build_profile(history_window(days, today))
    # The nameplate limits a forecast only when the two are in the same unit.
    cap = ac_capacity_kw if slot.unit == "kW" else None
    base: dict[str, Any] = {
        "unit": slot.unit,
        "source": {"device_type_code": source.device_type_code, "tag_code": source.tag_code,
                   "aggregate": source.aggregate, "device_count": source.device_count},
        "history_days": profile.days,
    }
    if profile.days == 0 or all(v is None for v in profile.typical):
        return {**base, "unavailable": "Not enough recent history at this Plant to forecast from."}

    today_values: DayValues = days.get(today, [None] * SLOTS_PER_DAY)
    completed = [
        (s, v) for s in range(SLOTS_PER_DAY)
        if (v := today_values[s]) is not None
    ]
    recent = completed[-FORECAST_CLEARNESS_BUCKETS:]
    k = clearness(recent, profile)
    # Hours ahead are measured from the end of the latest completed bucket —
    # the last thing actually known.
    known_until = latest_end if latest_end and latest_end.astimezone(zone).date() == today else None
    anchor = known_until or now

    def ahead(target: datetime) -> float:
        return max(0.0, (target - anchor).total_seconds() / 3600)

    def at_time(moment: datetime) -> tuple[int, float | None]:
        local = moment.astimezone(zone)
        slot_index = (local.hour * 60 + local.minute) // SLOT_MINUTES
        if local.date() != today:
            # Past midnight: tomorrow's typical day, with nothing carried over.
            return slot_index, forecast_at(profile, None, slot_index, ahead(moment), cap=cap)
        return slot_index, forecast_at(profile, k, slot_index, ahead(moment), cap=cap)

    next_15 = now + timedelta(minutes=15)
    next_60 = now + timedelta(minutes=60)
    rest_of_today = []
    for s in range(SLOTS_PER_DAY):
        moment = _at(today, s, zone)
        actual = today_values[s]
        forecast = (
            forecast_at(profile, k, s, ahead(moment), cap=cap)
            if moment >= anchor - timedelta(minutes=SLOT_MINUTES) else None
        )
        rest_of_today.append({
            "at": moment, "actual": _round(actual), "forecast": _round(forecast),
            "typical": _round(profile.typical[s]),
            "low": _round(profile.low[s]), "high": _round(profile.high[s]),
        })
    tomorrow = today + timedelta(days=1)
    day_ahead = [
        {"at": _at(tomorrow, s, zone), "forecast": _round(profile.typical[s]),
         "low": _round(profile.low[s]), "high": _round(profile.high[s])}
        for s in range(SLOTS_PER_DAY)
    ]

    checked = sorted(d for d in days if d < today)[-FORECAST_BACKTEST_DAYS:]
    accuracy_15, pairs_15 = backtest(days, checked, 1, cap=cap)
    accuracy_60, _ = backtest(days, checked, 4, cap=cap)
    recent_days = set(checked[-2:])
    return {
        **base,
        "now": {"at": anchor, "value": _round(completed[-1][1]) if completed else None},
        "clearness": _round(k),
        "next_15m": {"at": next_15, "value": _round(at_time(next_15)[1])},
        "next_1h": {"at": next_60, "value": _round(at_time(next_60)[1])},
        "today": rest_of_today,
        "day_ahead": {"date": tomorrow, "profile": day_ahead},
        "accuracy": [
            {"horizon_minutes": a.horizon_minutes, "samples": a.samples,
             "mae": _round(a.mae), "relative": _round(a.relative)}
            for a in (accuracy_15, accuracy_60)
        ],
        "versus_actual": [
            {"at": _at(day, target, zone), "forecast": _round(f), "actual": _round(a)}
            for day, target, f, a in pairs_15 if day in recent_days
        ],
    }


async def _energy_payload(
    session: AsyncSession, slot: ResolvedSlot, zone: ZoneInfo, today: date, since: datetime,
) -> dict[str, Any]:
    source = slot.source
    assert source is not None
    totals = await _energy_totals(session, slot, zone, since)
    base: dict[str, Any] = {
        "unit": slot.unit,
        "source": {"device_type_code": source.device_type_code, "tag_code": source.tag_code,
                   "aggregate": source.aggregate, "device_count": source.device_count},
        "complete_days": len([d for d in totals if d < today]),
    }
    estimate = daily_energy(totals, today)
    if estimate is None:
        return {**base, "unavailable":
                "Not enough complete days of energy at this Plant to forecast from."}
    week = [
        {"date": today + timedelta(days=i), "value": _round(estimate.value),
         "low": _round(estimate.low), "high": _round(estimate.high)}
        for i in range(1, 8)
    ]
    checked = sorted(d for d in totals if d < today)[-FORECAST_BACKTEST_DAYS:]
    versus: list[dict[str, Any]] = []
    errors: list[float] = []
    actuals: list[float] = []
    for day in checked:
        past = daily_energy(totals, day)
        if past is None:
            continue
        versus.append({"date": day, "forecast": _round(past.value), "low": _round(past.low),
                       "high": _round(past.high), "actual": _round(totals[day])})
        errors.append(abs(past.value - totals[day]))
        actuals.append(totals[day])
    mean_actual = sum(actuals) / len(actuals) if actuals else 0.0
    return {
        **base,
        "history_days": estimate.days,
        "tomorrow": week[0],
        "week": week,
        "versus_actual": versus,
        "accuracy": {
            "samples": len(errors),
            "mae": _round(sum(errors) / len(errors)) if errors else None,
            "relative": _round(sum(errors) / len(errors) / mean_actual)
            if errors and mean_actual > 0 else None,
        },
    }
