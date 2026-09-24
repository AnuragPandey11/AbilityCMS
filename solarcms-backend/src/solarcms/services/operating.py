"""The Plant Status card: running, start, stop, peak and the grid.

Everything here is **derived from stored history on each request**, never
remembered between requests. A start time kept in a cache is lost when the
process restarts and is wrong for any day the process was down at dawn; the
day's readings are the evidence either way, so they are what is read. It is the
same reasoning that makes absence debounce derive from the data each sweep.

Three sources, each chosen for a reason:

* **Running, start, stop** — the Inverters' summed AC output
  (`PLANT_OPERATING_SOURCE`) folded by `domain/operating`.
* **Peak** — the maximum of whatever the Current Power tile resolves to on
  this Plant, found by resolving that slot rather than naming a Tag here. On a
  Plant with a settlement meter the tile is the meter, and a peak taken from
  the Inverters would be a different claim printed beside it.
* **Grid** — the breakers' ON FEEDBACK contact (`GRID_STATUS_SOURCE`), from
  current values, because a contact's state *now* is the question.

Read through the `*_v` barrier views: the API holds no privilege on the
telemetry relations, and the views scope every row to Plants this session can
see (migrations 0008/0010).
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache import live
from solarcms.domain.assumptions import (
    GRID_STATUS_SOURCE,
    HEALTH_DEGRADED_MULTIPLIER,
    PLANT_OPERATING_SOURCE,
    PLANT_START_ABOVE_KW,
    PLANT_STOP_AT_OR_BELOW_KW,
)
from solarcms.domain.operating import (
    Breaker,
    OperatingDay,
    grid_status,
    held_series,
    operating_day,
    peak,
)
from solarcms.domain.slots import KIND_DEVICE_TAG, resolve_all
from solarcms.services import dashboard

# The slot whose history the peak is the maximum of. A slot code, not a Tag:
# which Device answers it is the resolver's decision on each Plant.
CURRENT_POWER_SLOT = "kpi.current_power"

# One-minute buckets: the finest aggregate, and start and stop are stated to
# the minute. Not raw readings, because a Plant's day of them is tens of
# thousands of rows per request.
RESOLUTION = "agg_1m"
BUCKET = timedelta(minutes=1)


def _zone(name: str | None) -> ZoneInfo:
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def _midnight(day: date, zone: ZoneInfo) -> datetime:
    """The start of a Plant-local calendar day, in UTC."""
    return datetime.combine(day, time.min, tzinfo=zone).astimezone(UTC)


async def _devices(
    session: AsyncSession, plant_id: int, type_code: str, tag_code: str
) -> list[Any]:
    """The Plant's Devices of one Type bound to one Tag, with how long a value holds."""
    return list((await session.execute(text("""
        SELECT d.id, d.code, COALESCE(h.comm_status, 'unknown') AS comm_status,
               GREATEST(d.expected_interval_s, coalesce(t.min_interval_s, 0), 60)
                   AS stored_every_s
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          JOIN device_tag_bindings b ON b.device_id = d.id AND b.enabled
          JOIN tags t ON t.id = b.tag_id AND t.code = :tag_code
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
           AND dt.code = :type_code
         ORDER BY d.code
    """), {"plant_id": plant_id, "type_code": type_code, "tag_code": tag_code})).all())


def _hold(devices: list[Any]) -> dict[int, timedelta]:
    """How long each Device's value stands: until the sweep would call it late."""
    return {
        device.id: timedelta(seconds=HEALTH_DEGRADED_MULTIPLIER * device.stored_every_s)
        for device in devices
    }


async def _series(
    session: AsyncSession, devices: list[Any], tag_code: str, aggregate: str,
    start: datetime, end: datetime,
) -> tuple[list[tuple[datetime, float | None]], int]:
    """Those Devices' combined per-minute series, and how many buckets were flagged.

    Each bucket's `max_value`: "the moment it rose above 0.5" is the first
    reading above it, and a one-minute average of a ramp would place it late.
    A bucket holding any flagged reading is left out and counted — a flagged
    value is stored, never plotted as data, and here never a start.
    """
    if not devices:
        return [], 0
    rows = (await session.execute(text("""
        SELECT a.bucket, a.device_id, a.max_value,
               coalesce(a.worst_quality, 0) <> 0 AS flagged
          FROM agg_1m_v a JOIN tags t ON t.id = a.tag_id
         WHERE a.device_id = ANY(:device_ids) AND t.code = :tag_code
           AND a.bucket >= :start AND a.bucket < :end
         ORDER BY a.bucket, a.device_id
    """), {"device_ids": [device.id for device in devices], "tag_code": tag_code,
          "start": start, "end": end})).all()
    good = [
        (row.bucket, row.device_id, float(row.max_value))
        for row in rows if not row.flagged and row.max_value is not None
    ]
    flagged = sum(1 for row in rows if row.flagged)
    return held_series(good, _hold(devices), aggregate), flagged


def _observed(at: datetime | None, after: datetime | None, gap: timedelta) -> bool:
    """Whether a transition was seen happen, rather than found already done.

    Seen when the sample before it is no further back than a Device's value
    holds for: then the change happened inside one ordinary reporting interval.
    Across a longer silence it happened somewhere in the silence, and the time
    printed is only when it was first *heard*.
    """
    return at is not None and after is not None and at - after <= gap


def _day_json(day: date, folded: OperatingDay, gap: timedelta) -> dict[str, Any]:
    return {
        "date": day.isoformat(),
        "start_at": folded.start,
        # The last moment the Plant is known to have been off before it — so
        # an unobserved start reads "between 00:00 and 13:55", not "13:55".
        "start_after": folded.start_after,
        "start_observed": _observed(folded.start, folded.start_after, gap),
        "stop_at": folded.stop,
        "stop_after": folded.stop_after,
        "stop_observed": _observed(folded.stop, folded.stop_after, gap),
        # Still generating at the day's last reading. For a finished day with no
        # stop, this is what separates "went quiet while running" from "never ran".
        "ended_running": folded.running,
        "last_sample_at": folded.last_sample,
    }


async def _peak(
    session: AsyncSession, plant_id: int, start: datetime, end: datetime,
) -> dict[str, Any]:
    """Today's maximum of the Current Power tile's own source."""
    specs, _ = await dashboard.load_slot_specs(session, plant_id)
    spec = next((candidate for candidate in specs if candidate.code == CURRENT_POWER_SLOT), None)
    if spec is None:
        return {"value": None, "at": None, "unit": None, "source": None,
                "undefined_reason": "the Current Power slot is not configured"}
    facts, units = await dashboard.gather(session, plant_id)
    resolved = resolve_all([spec], facts, units)[0]
    source = resolved.source
    if source is None or source.kind != KIND_DEVICE_TAG or source.tag_code is None:
        return {"value": None, "at": None, "unit": resolved.unit, "source": None,
                "undefined_reason": "nothing at this Plant can answer Current Power"}

    candidates = await _devices(
        session, plant_id, source.device_type_code or "", source.tag_code)
    if source.aggregate == "first":
        # The one Device the tile is reading now, or the first bound if none is.
        chosen = [d for d in candidates if d.id in source.device_ids][:1] or candidates[:1]
    else:
        chosen = candidates
    series, _ = await _series(
        session, chosen, source.tag_code, source.aggregate, start, end)
    found = peak(series)
    return {
        "value": None if found is None else found[1],
        "at": None if found is None else found[0],
        "unit": resolved.unit,
        "source": {
            "device_type_code": source.device_type_code, "tag_code": source.tag_code,
            "aggregate": source.aggregate, "device_count": len(chosen),
        },
        "undefined_reason": None if found is not None else "no reading of it today",
    }


async def _grid(session: AsyncSession, plant_id: int) -> dict[str, Any]:
    type_code, tag_code = GRID_STATUS_SOURCE
    breakers = await _devices(session, plant_id, type_code, tag_code)
    tag_id = (await session.execute(
        text("SELECT id FROM tags WHERE code = :code"), {"code": tag_code})).scalar()
    contacts: list[Breaker] = []
    for breaker in breakers:
        raw = (await live.read_current_values(breaker.id)).get(str(tag_id))
        try:
            # A contact is stored as 1.0 or 0.0 (`coerce_value`).
            closed = None if raw is None else float(raw) != 0.0
        except ValueError:
            closed = None
        contacts.append(Breaker(closed=closed, online=breaker.comm_status == "online"))
    status = grid_status(contacts)
    return {
        "state": status.state, "breakers": status.breakers,
        "reporting": status.reporting, "closed": status.closed, "open": status.open,
        "undefined_reason": status.reason,
        "source": {"device_type_code": type_code, "tag_code": tag_code},
    }


async def _operating(
    session: AsyncSession, devices: list[Any], tag_code: str, zone: ZoneInfo,
    moment: datetime, *, whose: str,
) -> dict[str, Any]:
    """Running, start and stop for a set of Devices summed — a Plant's Inverters,
    or one Inverter alone. `whose` names them in the reasons ("Inverter")."""
    today = moment.astimezone(zone).date()
    yesterday = today - timedelta(days=1)
    today_start = _midnight(today, zone)
    yesterday_start = _midnight(yesterday, zone)

    series, flagged = await _series(
        session, devices, tag_code, "sum", yesterday_start, moment + BUCKET)
    folded_yesterday = operating_day(s for s in series if s[0] < today_start)
    folded_today = operating_day(s for s in series if s[0] >= today_start)

    # The state now. "Running" is only said on fresh evidence: Inverters that
    # went quiet mid-afternoon leave a running fold behind them, and silence is
    # not a stop — but neither is it still running.
    reporting = sum(1 for device in devices if device.comm_status == "online")
    longest_hold = max(_hold(devices).values(), default=timedelta(0))
    gap = longest_hold + BUCKET
    state: str | None
    reason: str | None = None
    if not devices:
        state, reason = None, f"nothing here is bound to {tag_code}"
    elif folded_today.running and (
        folded_today.last_sample is None or moment - folded_today.last_sample > gap
    ):
        state, reason = "unknown", f"no {whose} has reported since it was last generating"
    elif folded_today.running:
        state = "running"
    elif folded_today.start is not None:
        state = "stopped"
    elif folded_today.last_sample is None:
        state, reason = "unknown", f"no {whose} reading today"
    else:
        state = "not_started"

    return {
        "operating": {
            "state": state,
            "undefined_reason": reason,
            "last_sample_at": folded_today.last_sample or folded_yesterday.last_sample,
            "source": {"device_type_code": PLANT_OPERATING_SOURCE[0], "tag_code": tag_code,
                       "aggregate": "sum", "device_count": len(devices),
                       "reporting": reporting},
            "start_above": PLANT_START_ABOVE_KW,
            "stop_at_or_below": PLANT_STOP_AT_OR_BELOW_KW,
            "unit": "kW",
            "resolution": RESOLUTION,
            "flagged_buckets": flagged,
        },
        "today": _day_json(today, folded_today, gap),
        "yesterday": _day_json(yesterday, folded_yesterday, gap),
    }


async def operating_status(
    session: AsyncSession, plant_id: int, timezone: str | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The whole card's derived half. Weather and totals come from the slots."""
    moment = now or datetime.now(UTC)
    zone = _zone(timezone)
    today_start = _midnight(moment.astimezone(zone).date(), zone)
    type_code, tag_code = PLANT_OPERATING_SOURCE
    inverters = await _devices(session, plant_id, type_code, tag_code)
    return {
        "plant_id": plant_id,
        "as_of": moment,
        **(await _operating(session, inverters, tag_code, zone, moment, whose="Inverter")),
        "peak": await _peak(session, plant_id, today_start, moment + BUCKET),
        "grid": await _grid(session, plant_id),
    }


async def device_operating_status(
    session: AsyncSession, device_id: int, now: datetime | None = None,
) -> dict[str, Any] | None:
    """The same rule for one Device on its own output — the Inverter view's
    "operating status". None when the Device is not visible to this session.

    The thresholds are the Plant's, applied to one machine: a Plant starts
    when the first of its Inverters does, so an Inverter's own start is the
    same crossing seen from inside it.
    """
    moment = now or datetime.now(UTC)
    _, tag_code = PLANT_OPERATING_SOURCE
    found = (await session.execute(text("""
        SELECT d.id, d.plant_id, p.timezone
          FROM devices d JOIN plants p ON p.id = d.plant_id
         WHERE d.id = :device_id
    """), {"device_id": device_id})).first()
    if found is None:
        return None
    rows = (await session.execute(text("""
        SELECT d.id, d.code, COALESCE(h.comm_status, 'unknown') AS comm_status,
               GREATEST(d.expected_interval_s, coalesce(t.min_interval_s, 0), 60)
                   AS stored_every_s
          FROM devices d
          JOIN device_tag_bindings b ON b.device_id = d.id AND b.enabled
          JOIN tags t ON t.id = b.tag_id AND t.code = :tag_code
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.id = :device_id
    """), {"device_id": device_id, "tag_code": tag_code})).all()
    return {
        "device_id": device_id,
        "plant_id": found.plant_id,
        "as_of": moment,
        **(await _operating(
            session, list(rows), tag_code, _zone(found.timezone), moment, whose="Inverter")),
    }
