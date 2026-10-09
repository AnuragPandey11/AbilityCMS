"""A Plant's KPIs — PR, CUF, availability, CO2, energy — for any period.

Moved here from the Plants router (9 Oct 2026) so that the API and the
scheduler run **the same code**: the scheduler now works each Plant's figures
out once a minute and stores them (`services/snapshots.py`), and the screens
read the stored copy instead of recomputing the whole day on every refresh
(docs/CAPACITY_AND_DEPLOYMENT.md §4.4). Every rule below is unchanged — the
calendar periods on the Plant's clock, "undefined, never 0.0", coverage beside
every value, a published value beating a computed one — because nothing below
was rewritten, only moved.

⚠ Reads are scoped by the Plant's own Device ids (`services/scope.py`), which
is what keeps one Plant's cost independent of the fleet's size (§4.9). Under
the scheduler's platform context the barrier views do not scope anything, so
those ids are also what keeps one Plant's figures from another's.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.absence import Coverage, assess_coverage
from solarcms.domain.assumptions import (
    AVAILABILITY_VARIANT,
    PLANT_ENERGY_COUNTER_PRECEDENCE,
    PLANT_IRRADIATION_SOURCE,
)
from solarcms.domain.counters import DeviceSeries, plant_energy, plant_irradiation
from solarcms.domain.formulas import (
    FormulaResult,
    availability,
    co2_avoided_kg,
    cuf,
    performance_ratio,
    specific_yield,
)
from solarcms.domain.health_logic import uptime_seconds_from_events
from solarcms.domain.periods import (
    ComparisonWindow,
    measured_since,
    period_start,
    previous_window,
)
from solarcms.domain.tiering import Tier, bucket_start, select_tier
from solarcms.services import scope
from solarcms.services.energy import (
    counter_anomalies_payload,
    energy_source_payload,
    read_counter_series,
    split_by_pair,
)


def plant_zone(name: str | None) -> ZoneInfo:
    """The Plant's zone. UTC for one that cannot be read: wrong by hours, which
    is visible, rather than a KPI that fails outright."""
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


async def first_reading(session: AsyncSession, plant_id: int) -> datetime | None:
    """When the Plant first reported anything — to the minute while that is held.

    Found on the daily tier, which keeps ten years, then refined on the minute
    tier, which keeps one: lifetime CUF divides by the hours since this, and a
    day's imprecision on a two-day-old Plant would halve it. Devices with no
    topic are left out — the Plant KPI panel's rows are written by the
    scheduler, so its first one says when the scheduler started, not the Plant.
    """
    # The Plant's own Device ids, passed into the view, so the scan never
    # touches another Plant's rows (`services/scope.py`, §4.9).
    devices = await scope.device_ids(session, plant_ids=[plant_id], with_topic=True)
    if not devices:
        return None
    day = (await session.execute(text("""
        SELECT a.bucket FROM agg_1d_v a
         WHERE a.device_id = ANY(:device_ids)
         ORDER BY a.bucket LIMIT 1
    """), {"device_ids": devices})).scalar()
    if day is None:
        return None
    minute = (await session.execute(text("""
        SELECT a.bucket FROM agg_1m_v a
         WHERE a.device_id = ANY(:device_ids)
           AND a.bucket >= :day AND a.bucket < :next_day
         ORDER BY a.bucket LIMIT 1
    """), {"device_ids": devices, "day": day, "next_day": day + timedelta(days=1)})).scalar()
    first: datetime = minute or day
    return first


async def counter_series(
    session: AsyncSession, plant_id: int, tier: Tier, start: datetime, lifetime: bool,
    pairs: list[tuple[str, str]] | tuple[tuple[str, str], ...],
    *, block_id: int | None = None, end: datetime | None = None,
) -> list[DeviceSeries]:
    """One Plant's (or Block's) register series from `tier`, from `start`.

    A lifetime begins at the first reading, which falls inside a bucket, so the
    read is floored to the bucket holding it — otherwise that bucket is skipped
    and its hour is lost again. Nothing precedes a first reading, so the floor
    admits nothing from outside the period. Calendar periods begin at the
    Plant's midnight and are not floored: that would admit the evening before.

    `end` bounds a window in the past — the previous period a KPI is compared
    against. None reads up to now.
    """
    from_ = bucket_start(start, tier) if lifetime else start
    if block_id is not None:
        found = await read_counter_series(
            session, tier=tier, block_id=block_id, start=from_, end=end, pairs=pairs)
    else:
        found = await read_counter_series(
            session, tier=tier, plant_ids=[plant_id], start=from_, end=end, pairs=pairs)
    return found.get(plant_id, [])


async def meters_and_stations(
    session: AsyncSession, plant_id: int, tier: Tier, start: datetime, lifetime: bool,
    end: datetime | None = None,
) -> tuple[list[DeviceSeries], list[DeviceSeries]]:
    """The energy meters' and weather stations' register series over a window.

    Energy from each meter's own counter, and irradiation from the weather
    stations — aggregates, never raw readings (MASTER §6.6).

    ⚠ Irradiation is never read coarser than hourly. Its register restarts
    at the Plant's midnight, and a daily bucket is cut at UTC midnight — for
    Kolkata, 05:30 local — so every day's `last` is taken after the restart
    and each day's sun reads as nothing. Only a lifetime over a year old
    selects the daily tier, which is why this never showed on a young fleet.
    """
    irradiation_tier = Tier.AGG_1H if tier == Tier.AGG_1D else tier
    if irradiation_tier == tier:
        series = await counter_series(
            session, plant_id, tier, start, lifetime,
            [*PLANT_ENERGY_COUNTER_PRECEDENCE, PLANT_IRRADIATION_SOURCE], end=end)
        stations, meters = split_by_pair(series, PLANT_IRRADIATION_SOURCE)
        return meters, stations
    meters = await counter_series(
        session, plant_id, tier, start, lifetime, PLANT_ENERGY_COUNTER_PRECEDENCE, end=end)
    stations = await counter_series(
        session, plant_id, irradiation_tier, start, lifetime, [PLANT_IRRADIATION_SOURCE],
        end=end)
    return meters, stations


async def plant_coverage(
    session: AsyncSession, plant_id: int, tier: Tier, start: datetime, end: datetime,
    lifetime: bool,
) -> Coverage:
    """How much of `start`..`end` the Plant's figures actually saw.

    A gap does not make a figure look wrong; it makes it look *low*. An
    average over fewer samples is still an average and a total over a hole is
    simply smaller, so a communication outage reads as underperformance — and
    for availability, as nothing having happened. Reporting coverage beside
    the value is what makes the difference visible. It never corrects the
    figure: correcting it would be inventing data.

    ⚠ Per *binding*, and against the Tag's own throttle — not per Device.
    A Device publishing every 86 s does not store 86 s of every Tag: ingest
    throttles each Tag to its `min_interval_s`, so a Tag throttled to 300 s
    stores one sample in every three or four messages. Counting one sample per
    Tag per message expected 367k readings a day from this Plant against
    26.6k stored and reported 7% coverage on a Plant that was entirely
    healthy — a false alarm of exactly the kind this is meant to remove.

    `created_at` clamps the window too: a Device registered an hour ago owes
    nothing for the twenty-three before it existed. For a window in the past
    the Devices and bindings are today's — the history of bindings is not
    kept — so a Device retired since is not owed for, and one added since owes
    nothing.
    """
    expected = (await session.execute(text("""
        SELECT coalesce(sum(
                   GREATEST(0, EXTRACT(EPOCH FROM (
                       CAST(:end AS timestamptz)
                       - GREATEST(CAST(:start AS timestamptz), d.created_at)
                   )))
                   / GREATEST(d.expected_interval_s,
                              coalesce(t.min_interval_s, 0), 1)
               ), 0)::bigint AS expected,
               min(GREATEST(CAST(:start AS timestamptz), d.created_at)) AS expected_since
          FROM device_tag_bindings b
          JOIN devices d ON d.id = b.device_id
          JOIN tags t    ON t.id = b.tag_id
         WHERE d.plant_id = :plant_id AND d.status = 'active'
           AND d.source_address IS NOT NULL AND b.enabled
    """), {"plant_id": plant_id, "start": start, "end": end})).first()
    expected_row = expected.expected if expected else 0
    # ⚠ Missing time is measured over the span readings were expected in, the
    # same span the count above covers — not the whole period. Measured over
    # the period, a Plant registered two days ago reported "3,075.9 days of
    # the period missing" under lifetime.
    coverage_since = min((expected.expected_since if expected else None) or end, end)

    devices = await scope.device_ids(session, plant_ids=[plant_id])
    received_row = await _received_samples(
        session, devices, tier, bucket_start(start, tier) if lifetime else start, end)

    # Planned work is an *explained* absence and must not count against the
    # Plant. A gap is an unexplained one and must stay visible. A window not
    # yet begun contributes nothing, rather than a negative span.
    excluded_s = (await session.execute(text("""
        SELECT coalesce(sum(EXTRACT(EPOCH FROM (
                   least(coalesce(w.ends_at, CAST(:end AS timestamptz)),
                         CAST(:end AS timestamptz))
                 - greatest(w.starts_at, CAST(:start AS timestamptz))))), 0)
          FROM maintenance_windows w
         WHERE w.plant_id = :plant_id AND w.device_id IS NULL
           AND coalesce(w.ends_at, CAST(:end AS timestamptz)) > CAST(:start AS timestamptz)
           AND w.starts_at < CAST(:end AS timestamptz)
    """), {"plant_id": plant_id, "start": coverage_since, "end": end})).scalar()

    return assess_coverage(
        int(expected_row or 0), int(received_row or 0),
        max(0.0, (end - coverage_since).total_seconds()),
        excluded_seconds=float(excluded_s or 0.0),
    )


QUARTER_HOUR = timedelta(minutes=15)


async def _received_samples(
    session: AsyncSession, devices: list[int], tier: Tier, start: datetime, end: datetime,
) -> int:
    """How many samples the Plant's Devices stored in [start, end).

    On the 1-minute tier the whole quarter-hours are summed from `agg_15m`
    instead — fifteen times fewer rows, and the same total, since each
    15-minute `sample_count` *is* the sum of its minutes' (the tier is defined
    that way). Only the quarter-hour still in progress is read by the minute.
    It is what kept coverage costing more with every hour of the day
    (docs/CAPACITY_AND_DEPLOYMENT.md §4.4, §4.9).
    """
    if not devices:
        return 0
    epoch = datetime(2000, 1, 1, tzinfo=UTC)
    aligned = (start - epoch) % QUARTER_HOUR == timedelta(0)
    if tier != Tier.AGG_1M or not aligned:
        total = (await session.execute(text(f"""
            SELECT coalesce(sum(a.sample_count), 0)::bigint
              FROM {tier.value}_v a
             WHERE a.device_id = ANY(:device_ids) AND a.bucket >= :start AND a.bucket < :end
        """), {"device_ids": devices, "start": start, "end": end})).scalar()
        return int(total or 0)
    whole_until = max(start, end - (end - epoch) % QUARTER_HOUR)
    total = (await session.execute(text("""
        SELECT (SELECT coalesce(sum(q.sample_count), 0)::bigint FROM agg_15m_v q
                 WHERE q.device_id = ANY(:device_ids)
                   AND q.bucket >= :start AND q.bucket < :whole_until)
             + (SELECT coalesce(sum(m.sample_count), 0)::bigint FROM agg_1m_v m
                 WHERE m.device_id = ANY(:device_ids)
                   AND m.bucket >= :whole_until AND m.bucket < :end)
    """), {"device_ids": devices, "start": start, "whole_until": whole_until,
           "end": end})).scalar()
    return int(total or 0)


def coverage_payload(coverage: Coverage) -> dict[str, Any]:
    return {
        "ratio": coverage.ratio,
        "complete": coverage.complete,
        "expected_samples": coverage.expected_samples,
        "received_samples": coverage.received_samples,
        "missing_seconds": round(coverage.missing_seconds),
        "excluded_seconds": round(coverage.excluded_seconds),
    }


def render_formula(result: FormulaResult) -> dict[str, Any]:
    return {"value": result.value, "variant": result.variant,
            "undefined_reason": result.undefined_reason}


async def previous_figures(
    session: AsyncSession, plant_id: int, window: ComparisonWindow, now: datetime,
    dc_kwp: float, ac_kw: float,
) -> dict[str, Any]:
    """PR and CUF over the previous period, to the same point — what the
    dials compare today's figures against.

    Computed exactly as the current figures are: the same counters, the same
    precedence, the same formulas, its own tier and its own coverage. ⚠ Never
    the Plant KPI panel's YESTERDAY Tags: the scheduler computes PR from GHI and
    CUF over a whole 24 hours, so comparing those with these puts two different
    calculations on one dial and reads their difference as a change in the
    Plant.
    """
    tier = select_tier(window.start, window.end, now, finest=Tier.AGG_1M)
    meters, stations = await meters_and_stations(
        session, plant_id, tier, window.start, False, end=window.end)
    energy_result = plant_energy(
        meters, PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=ac_kw or None)
    irradiation = plant_irradiation(stations)
    if energy_result.value is None:
        reason = energy_result.undefined_reason
        pr = FormulaResult(None, performance_ratio(0.0, 0.0, 0.0).variant, reason)
        cuf_result = FormulaResult(None, cuf(0.0, 0.0, 0.0).variant, reason)
    else:
        hours = (window.end - window.measured_since).total_seconds() / 3600.0
        pr = performance_ratio(
            energy_result.value, (irradiation.value or 0.0) * 1000.0, dc_kwp)
        cuf_result = cuf(energy_result.value, ac_kw, hours)
    coverage = await plant_coverage(session, plant_id, tier, window.start, window.end, False)
    return {
        "period_start": window.start,
        "period_end": window.end,
        "measured_since": window.measured_since,
        "source_tier": tier.value,
        "performance_ratio": render_formula(pr),
        "cuf": render_formula(cuf_result),
        "counter_anomalies": counter_anomalies_payload(energy_result),
        "coverage": coverage_payload(coverage),
    }


async def plant_availability(
    session: AsyncSession, plant_id: int, start: datetime, now: datetime,
) -> FormulaResult:
    """Availability over the period, time-weighted from `device_health_events`.

    It was the share of Devices online *at this moment*, multiplied by the
    period's hours and divided by them again — so it read 100% under
    "lifetime" for any Plant that happened to be healthy when asked, and did
    not depend on the period at all. Each Device is weighed from the later of
    the period's start and its registration, starting from whatever status it
    last had before that; never-seen (`unknown`) time is excluded rather than
    counted as downtime (`uptime_seconds_from_events`).
    """
    devices = (await session.execute(text("""
        SELECT d.id, GREATEST(:start, d.created_at) AS since
          FROM devices d
         WHERE d.plant_id = :plant_id AND d.status = 'active'
           AND d.source_address IS NOT NULL
    """), {"plant_id": plant_id, "start": start})).all()
    if not devices:
        return FormulaResult(None, AVAILABILITY_VARIANT, "no Devices registered")

    # The last transition at or before the period began — the status each
    # Device entered it with — and every transition since.
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
         WHERE e.device_id = ANY(:device_ids) AND e.occurred_at > :start
         ORDER BY device_id, occurred_at
    """), {"device_ids": [device.id for device in devices], "start": start})).all()
    events: dict[int, list[tuple[datetime, str]]] = {}
    for row in rows:
        events.setdefault(row.device_id, []).append((row.occurred_at, row.to_status))

    uptime = excluded = weighed = 0.0
    for device in devices:
        up, out = uptime_seconds_from_events(events.get(device.id, []), device.since, now)
        uptime += up
        excluded += out
        weighed += max(0.0, (now - device.since).total_seconds())
    if weighed - excluded <= 0:
        return FormulaResult(None, AVAILABILITY_VARIANT, "no Device has reported in the period")
    return availability(uptime, weighed, excluded)


async def compute_plant_kpis(
    session: AsyncSession, plant_id: int, period: str, *, compare: bool,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """PR, CUF, availability, CO2 — each reported with the formula variant used.

    ⚠ Every figure here is provisional (OPEN-16). The variant travels with the
    value so that when the client's definitions arrive, historical figures can be
    identified and recomputed rather than silently superseded.
    """
    plant = (await session.execute(text("""
        SELECT p.dc_capacity_kwp, p.ac_capacity_kw, p.timezone,
               r.grid_emission_factor_kg_per_kwh AS grid_factor
          FROM plants p LEFT JOIN regions r ON r.id = p.region_id
         WHERE p.id = :plant_id
    """), {"plant_id": plant_id})).first()
    if plant is None:
        return None

    now = now or datetime.now(UTC)
    zone = plant_zone(plant.timezone)
    # A calendar period in the Plant's own zone — today since its midnight, the
    # month since the 1st, the year since 1 January — and lifetime since its
    # first reading. See `domain/periods`.
    first_seen = await first_reading(session, plant_id)
    start = period_start(period, now, zone, first_seen) or now
    since = measured_since(start, first_seen)

    # ⚠ The tier is *selected*, not hardcoded. It used to be `agg_1h_v` for
    # every period, which made "today" the worst-served figure on the platform:
    # the hourly tier sits furthest down a hierarchical cascade and is the last
    # to see a Reading, so the one KPI an operator watches minute to minute was
    # computed from the coarsest and slowest source available.
    #
    # `select_tier` already answers this — it is the same function the readings
    # read path uses — and for a one-day range it returns `agg_1m`, one bucket
    # above raw. Coarser periods still get coarser tiers, which is correct:
    # a month-to-date total does not need minute resolution and should not pay
    # for 43,200 buckets per Tag to compute one subtraction.
    #
    # ⚠ Never raw, though: everything below reads bucket columns, and a
    # calendar "today" is under six hours old until dawn, which would select
    # `readings` and fail every query on it.
    tier = select_tier(start, now, now, finest=Tier.AGG_1M)

    # ⚠ This used to be `max(last_value) - min(last_value)` across every Device
    # at the Plant. That subtracted the MFM's reading from the ABT Meter's on a
    # Plant with both (56,602 kWh in four minutes), and counted every counter
    # reset as generation (a 240 kWp rooftop at 1.6 GWh "today"). Each Device is
    # now integrated step by step, one Device Type answers by precedence, and a
    # step that goes backwards or exceeds what the Plant could produce is
    # refused and reported in `counter_anomalies` — see `domain/counters`.
    lifetime = period == "lifetime"
    meters, stations = await meters_and_stations(session, plant_id, tier, start, lifetime)

    dc_kwp = float(plant.dc_capacity_kwp or 0.0)
    ac_kw = float(plant.ac_capacity_kw or 0.0)
    # The hours since the later of the period's start and the Plant's first
    # reading, not the period's full length — see `measured_since`.
    hours = (now - since).total_seconds() / 3600.0 if since else 0.0
    grid_factor = float(plant.grid_factor) if plant.grid_factor is not None else None

    energy_result = plant_energy(
        meters, PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=ac_kw or None)
    irradiation = plant_irradiation(stations)
    # GHI_CUMULATIVE is kWh/m2; performance_ratio wants Wh/m2 over the period.
    irradiation_wh = (irradiation.value or 0.0) * 1000.0

    if energy_result.value is None:
        # Nothing to read is not "made nothing": every figure built on energy
        # is undefined, with the reason, rather than a confident zero.
        reason = energy_result.undefined_reason
        energy_kwh = 0.0
        pr = FormulaResult(None, performance_ratio(0.0, 0.0, 0.0).variant, reason)
        cuf_result = FormulaResult(None, cuf(0.0, 0.0, 0.0).variant, reason)
        co2 = FormulaResult(None, co2_avoided_kg(0.0, grid_factor).variant, reason)
        yield_result = FormulaResult(None, specific_yield(0.0, 0.0).variant, reason)
    else:
        energy_kwh = energy_result.value
        pr = performance_ratio(energy_kwh, irradiation_wh, dc_kwp)
        cuf_result = cuf(energy_kwh, ac_kw, hours)
        co2 = co2_avoided_kg(energy_kwh, grid_factor)
        yield_result = specific_yield(energy_kwh, dc_kwp)

    avail = await plant_availability(session, plant_id, start, now)
    coverage = await plant_coverage(session, plant_id, tier, start, now, lifetime)

    # The same figures over the previous period to the same point, for the
    # dials to compare against. None when there is no previous period
    # (lifetime) or the Plant had not reported before it ended.
    previous: dict[str, Any] | None = None
    if compare:
        window = previous_window(period, now, zone, first_seen)
        if window is not None:
            previous = await previous_figures(
                session, plant_id, window, now, dc_kwp, ac_kw)

    return {
        "plant_id": plant_id, "period": period,
        # When these figures were worked out. The scheduler stores them once a
        # minute (`services/snapshots.py`); a screen may say how old they are.
        "computed_at": now,
        # Where the period began (the Plant's midnight, 1st, 1 January, or first
        # reading) and when the Plant could first be measured within it — what
        # CUF's hours count from.
        "period_start": start,
        "measured_since": since,
        # Which tier answered. Provenance, for the same reason a dashboard slot
        # carries it: two figures computed from different tiers are different
        # claims, and "the number looks stale" is otherwise unanswerable.
        "source_tier": tier.value,
        "energy_kwh": energy_kwh,
        # Which meter the energy came from (OPEN-14 decides the order; until
        # then it is `PLANT_ENERGY_COUNTER_PRECEDENCE`), and the steps refused
        # as generation. ⚠ A non-empty `counter_anomalies` means the energy —
        # and PR, CUF and CO2 with it — is short by an amount nobody can know.
        "energy_source": energy_source_payload(energy_result),
        "counter_anomalies": counter_anomalies_payload(energy_result),
        "irradiation_kwh_m2": {
            "value": irradiation.value,
            "station_count": len(irradiation.stations),
            "undefined_reason": irradiation.undefined_reason,
        },
        "performance_ratio": render_formula(pr),
        "cuf": render_formula(cuf_result),
        "availability": render_formula(avail),
        "co2_avoided_kg": render_formula(co2),
        # The period's energy over DC capacity — the same energy PR and CUF are
        # computed from, so the three cannot disagree about how much was made.
        "specific_yield": render_formula(yield_result),
        # ⚠ Read this before the figures above. A period with a hole in it
        # produces numbers that look plausible and are low, and nothing else on
        # the response can tell you that happened.
        "coverage": coverage_payload(coverage),
        # Only with `compare=true`; see `previous_figures`. It carries its own
        # coverage, because a comparison against a day with a hole in it moves
        # the delta as surely as a hole today moves the figure.
        "previous": previous,
        "assumptions_note": (
            "All KPI formulas are provisional pending OPEN-16. The client's own "
            "definitions may differ by percentage points."
        ),
    }
