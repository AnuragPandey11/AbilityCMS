"""Plant-level KPIs: the client's `DASHBOARD` panel, computed.

PR, CUF, today's peak power and when it happened, the Plant's start and stop
times, and how many Inverters are functional. Every one of them needs a whole
Plant at once — several Devices' current values, plus the Plant's own capacity —
which is why none of them can be computed in ingest, where a message is one
Device's, and why they live in the scheduler instead.

Three kinds of work, and they are genuinely different:

* **Formula Tags** (PR, CUF, the Inverter count). Arithmetic over aggregates,
  defined as data in `tags.formula` and evaluated by `domain/derived.py`.
* **Stateful Tags** (today's peak and its time, start and stop time). Not
  arithmetic at all: each compares the present value against what has stood so
  far today, so they are written here rather than expressed as a formula.
* **The day boundary.** At 23:55 *Plant-local* the client's sheet says today's
  figures "will be moved" to the YESTERDAY family. A copy, not a calculation.

⚠ **This is the one place isolation is not inherited from the database.** The
scheduler runs with platform privileges, so the `*_v` barrier views do not scope
it and every query here must carry its own `client_id`/`plant_id` predicate. A
missing one leaked another Client's meter into a Financial Report once already
(CLAUDE.md, "Things that surprised the build").
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache import live
from solarcms.domain.assumptions import (
    DAY_ROLLOVER_LOCAL_TIME,
    DAY_ROLLOVER_PAIRS,
    PLANT_ENERGY_SOURCE_PRECEDENCE,
    PLANT_POWER_SOURCE_PRECEDENCE,
    PLANT_RUNNING_THRESHOLD_KW,
    QUALITY_GOOD,
)
from solarcms.domain.derived import DerivedTag, evaluate_all

log = structlog.get_logger(__name__)

# The Device Type that carries a Plant's own figures — the client's `DASHBOARD`
# row, renamed to avoid colliding with the UI concept (seed.py DEVICE_TYPES).
PLANT_KPI_TYPE = "PLANT_KPI"

# A Plant in `draft` has nothing to compute. `commissioning` does: its data is
# flowing and being validated, it is simply excluded from Portfolio totals.
COMPUTED_PLANT_STATUSES = ("active", "commissioning")

# Today's figures, which must stop standing once carried to the YESTERDAY family.
# Everything else recomputes from live values on the next tick and needs no reset.
RESET_AT_DAY_BOUNDARY = (
    "TODAY_PEAK_POWER", "TODAY_PEAK_POWER_TIME", "PLANT_START_TIME", "PLANT_STOP_TIME",
)


@dataclass(slots=True)
class PlantInputs:
    """Everything one Plant's formulas can read, assembled from live values."""

    plant_id: int
    client_id: int
    kpi_device_id: int | None
    timezone: str
    values: dict[str, float] = field(default_factory=dict)
    # Which Device Type supplied the energy and power figures, so a report can
    # say whether it came from the settlement meter or from summing Inverters.
    energy_source: str | None = None
    power_source: str | None = None


def local_hours(moment: datetime, timezone: str) -> float:
    """Hours since local midnight, as a float. 13.75 is 13:45.

    `readings.value` is a float column and every other Tag is a measurement, so a
    time-of-day is stored the same way rather than as a second timestamp column
    that only four Tags would ever use.
    """
    local = moment.astimezone(_zone(timezone))
    return local.hour + local.minute / 60 + local.second / 3600


def _zone(timezone: str) -> ZoneInfo:
    try:
        return ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        # A Plant with an unreadable timezone still needs its KPIs. UTC is wrong
        # by hours, which is visible and reported, rather than silently skipping
        # the Plant entirely.
        log.warning("unknown plant timezone, using UTC", timezone=timezone)
        return ZoneInfo("UTC")


def is_rollover_moment(now: datetime, timezone: str, tick_seconds: int) -> bool:
    """True when `now` falls in the tick that contains local 23:55.

    Compared as a window rather than an equality because the scheduler ticks on
    its own clock: an exact `== 23:55` would miss the boundary on any tick that
    drifted by a second, and the day's figures would never be preserved.
    """
    local = now.astimezone(_zone(timezone))
    hour, minute = DAY_ROLLOVER_LOCAL_TIME
    target = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    delta = (local - target).total_seconds()
    return 0 <= delta < tick_seconds


async def _tag_codes(session: AsyncSession) -> dict[int, str]:
    rows = (await session.execute(text("SELECT id, code FROM tags"))).all()
    return {row.id: row.code for row in rows}


async def _tag_ids(session: AsyncSession) -> dict[str, int]:
    rows = (await session.execute(text("SELECT id, code FROM tags"))).all()
    return {row.code: row.id for row in rows}


async def gather(session: AsyncSession, plant: Any, codes: dict[int, str]) -> PlantInputs:
    """Read every Device's current values and reduce them to formula inputs.

    Current values come from Redis, not from `readings`: they are already there,
    maintained by ingest, and a per-tick scan of a compressed hypertable to learn
    what a Device is doing *right now* would be the wrong tool twice over.
    """
    inputs = PlantInputs(
        plant_id=plant.id, client_id=plant.client_id,
        kpi_device_id=None, timezone=plant.timezone,
    )

    # ⚠ The plant_id predicate is this function's own isolation. The scheduler
    # holds platform privileges and the barrier views do not scope it.
    devices = (await session.execute(text("""
        SELECT d.id, d.rated_capacity_kw, dt.code AS type_code,
               COALESCE(h.comm_status, 'unknown') AS comm_status
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
    """), {"plant_id": plant.id})).all()

    per_type: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    everything: dict[str, list[float]] = defaultdict(list)
    inverters_online = 0

    for device in devices:
        if device.type_code == PLANT_KPI_TYPE:
            inputs.kpi_device_id = device.id
            continue
        if device.type_code == "INVERTER" and device.comm_status == "online":
            inverters_online += 1
        current = await live.read_current_values(device.id)
        for key, raw in current.items():
            if key.startswith("_"):
                continue  # `_ts`, the hash's own timestamp
            try:
                tag_id, value = int(key), float(raw)
            except ValueError:
                continue
            code = codes.get(tag_id)
            if code is None:
                continue
            per_type[device.type_code][code].append(value)
            everything[code].append(value)

    for code, values in everything.items():
        inputs.values[f"SUM.{code}"] = sum(values)
        inputs.values[f"AVG.{code}"] = sum(values) / len(values)
        inputs.values[f"MIN.{code}"] = min(values)
        inputs.values[f"MAX.{code}"] = max(values)
        inputs.values[f"COUNT.{code}"] = float(len(values))
    inputs.values["COUNT.INVERTERS_ONLINE"] = float(inverters_online)

    # Capacities: the denominators of PR and CUF. Absent on a half-onboarded
    # Plant, in which case both are simply undefined rather than zero.
    if plant.dc_capacity_kwp is not None:
        inputs.values["DC_CAPACITY"] = float(plant.dc_capacity_kwp)
    if plant.ac_capacity_kw is not None:
        inputs.values["AC_CAPACITY"] = float(plant.ac_capacity_kw)

    energy, inputs.energy_source = _by_precedence(per_type, PLANT_ENERGY_SOURCE_PRECEDENCE)
    if energy is not None:
        inputs.values["PLANT_ENERGY_TODAY"] = energy
    power, inputs.power_source = _by_precedence(per_type, PLANT_POWER_SOURCE_PRECEDENCE)
    if power is not None:
        inputs.values["PLANT_ACTIVE_POWER"] = power
    return inputs


def _by_precedence(
    per_type: dict[str, dict[str, list[float]]],
    precedence: tuple[tuple[str, str], ...],
) -> tuple[float | None, str | None]:
    """First (Device Type, Tag) in the list that anything actually reported.

    Summed across the Devices of that Type — a Plant with two settlement meters
    exports the sum of both — and it stops at the first Type that has data, so an
    Inverter total never gets added to a meter total and double-counted.
    """
    for type_code, tag_code in precedence:
        values = per_type.get(type_code, {}).get(tag_code)
        if values:
            return sum(values), f"{type_code}.{tag_code}"
    return None, None


def stateful_kpis(
    inputs: PlantInputs, standing: dict[str, float], now: datetime
) -> dict[str, float]:
    """Peak power, peak time, and the Plant's start and stop times.

    `standing` is what the KPI Device already holds for today. These are
    comparisons against the day so far, not arithmetic over other Tags, which is
    why they are here and not in `tags.formula`.
    """
    result: dict[str, float] = {}
    power = inputs.values.get("PLANT_ACTIVE_POWER")
    if power is None:
        return result

    at = local_hours(now, inputs.timezone)
    peak = standing.get("TODAY_PEAK_POWER")
    if peak is None or power > peak:
        result["TODAY_PEAK_POWER"] = power
        result["TODAY_PEAK_POWER_TIME"] = at

    # SUPPLIED: "When the active power is greater than 0.1 MW, that time shall be
    # considered the Plant Start Time." Recorded once per day — the first
    # crossing, not every one, or a passing cloud would rewrite the morning.
    running = power > PLANT_RUNNING_THRESHOLD_KW
    started = standing.get("PLANT_START_TIME")
    if running and started is None:
        result["PLANT_START_TIME"] = at
    # ⚠ Interpretation (T-17): the Stop Time is the *latest* fall below the
    # threshold after a start, so an afternoon cloud updates it and the evening
    # shutdown ends up holding it. Reading it as the first fall would name the
    # first cloud of the day as the moment the Plant stopped.
    elif not running and (started is not None or "PLANT_START_TIME" in result):
        result["PLANT_STOP_TIME"] = at
    return result


async def compute(
    session: AsyncSession, derived: list[DerivedTag], *, tick_seconds: int = 60,
    now: datetime | None = None,
) -> dict[str, int]:
    """One pass over every computable Plant. Returns per-Plant write counts."""
    moment = now or datetime.now(UTC)
    codes = await _tag_codes(session)
    ids = {code: tag_id for tag_id, code in codes.items()}
    plant_formulas = [d for d in derived if d.scope == "plant"]

    plants = (await session.execute(text(f"""
        SELECT id, client_id, timezone, ac_capacity_kw, dc_capacity_kwp
          FROM plants WHERE status IN {COMPUTED_PLANT_STATUSES}
    """))).all()

    written = 0
    rolled = 0
    for plant in plants:
        inputs = await gather(session, plant, codes)
        if inputs.kpi_device_id is None:
            # No KPI panel registered for this Plant. Not an error worth an alarm
            # — a Plant in draft may legitimately have no Devices yet — but it is
            # why its KPI tiles would be empty, so it is said out loud.
            log.debug("plant has no KPI Device", plant_id=plant.id)
            continue

        standing = await _standing_values(inputs.kpi_device_id, codes)
        computed = evaluate_all(plant_formulas, inputs.values)
        computed.update(stateful_kpis(inputs, standing, moment))
        for code in ("PLANT_ACTIVE_POWER", "PLANT_ENERGY_TODAY"):
            if code in inputs.values:
                computed[code] = inputs.values[code]

        if computed:
            await _write(session, inputs, computed, ids, moment)
            written += len(computed)

        if is_rollover_moment(moment, plant.timezone, tick_seconds):
            rolled += await _roll_over(session, inputs, standing | computed, ids, moment)

    if written or rolled:
        log.info("plant kpis computed", plants=len(plants), values=written,
                 rolled_over=rolled)
    return {"plants": len(plants), "values": written, "rolled_over": rolled}


async def _standing_values(device_id: int, codes: dict[int, str]) -> dict[str, float]:
    """What the KPI Device holds right now, keyed by Tag code."""
    current = await live.read_current_values(device_id)
    standing: dict[str, float] = {}
    for key, raw in current.items():
        if key.startswith("_"):
            continue
        try:
            code = codes.get(int(key))
            if code is not None:
                standing[code] = float(raw)
        except ValueError:
            continue
    return standing


async def _write(
    session: AsyncSession, inputs: PlantInputs, values: dict[str, float],
    ids: dict[str, int], moment: datetime,
) -> None:
    """Persist computed values as Readings, then publish them live.

    Written as ordinary Readings against the KPI Device: they then age through
    the same retention cascade, appear in the same charts, and are exportable by
    the same endpoint as a measured value. A parallel "KPI table" would have
    needed every one of those built again.
    """
    rows = [
        {"time": moment, "client_id": inputs.client_id,
         "device_id": inputs.kpi_device_id, "tag_id": ids[code], "value": value,
         "quality": QUALITY_GOOD}
        for code, value in values.items() if code in ids
    ]
    if not rows:
        return
    await session.execute(text("""
        INSERT INTO readings (time, client_id, device_id, tag_id, value, quality,
                              source_time)
        VALUES (:time, :client_id, :device_id, :tag_id, :value, :quality, NULL)
    """), rows)

    assert inputs.kpi_device_id is not None
    await live.write_current_values(
        inputs.kpi_device_id, {ids[c]: v for c, v in values.items() if c in ids}, moment
    )
    await live.write_plant_rollup(inputs.plant_id, {
        **{code: value for code, value in values.items()},
        "energy_source": inputs.energy_source or "none",
        "at": moment.isoformat(),
    })
    await live.publish_live(inputs.client_id, inputs.plant_id, {
        "device_id": inputs.kpi_device_id,
        "values": {str(ids[c]): v for c, v in values.items() if c in ids},
        "at": moment.isoformat(),
    })


async def _roll_over(
    session: AsyncSession, inputs: PlantInputs, standing: dict[str, float],
    ids: dict[str, int], moment: datetime,
) -> int:
    """Copy today's figures into the YESTERDAY family. SUPPLIED behaviour.

    "AT 11:55 PM PR DATA WILL BE MOVE TO THIS PARAMETER" — the client's own note.
    A copy, deliberately: whatever produced today's number, yesterday's is the
    same number, and recomputing it from a different source at a different moment
    would produce a figure their reports disagree with.
    """
    carried = {
        target: standing[source]
        for source, target in DAY_ROLLOVER_PAIRS
        if source in standing and target in ids
    }
    if not carried:
        return 0
    await _write(session, inputs, carried, ids, moment)

    # Then stop today's figures standing. Without this, tomorrow's peak is
    # compared against today's and never beats it, and the Plant's start time
    # stays at whatever hour it first generated on the day this began — a fault
    # that would take a month of wrong reports to notice.
    assert inputs.kpi_device_id is not None
    await live.clear_current_values(
        inputs.kpi_device_id,
        [ids[code] for code in RESET_AT_DAY_BOUNDARY if code in ids],
    )
    log.info("day rollover", plant_id=inputs.plant_id, carried=sorted(carried),
             local_time=f"{DAY_ROLLOVER_LOCAL_TIME[0]:02d}:{DAY_ROLLOVER_LOCAL_TIME[1]:02d}")
    return len(carried)
