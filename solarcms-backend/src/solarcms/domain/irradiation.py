"""A Plant's sunlight from its weather stations, and which of them to believe. Pure — no I/O.

PR divides the Plant's energy by its sunlight, so a weather station's fault
lands in PR — and lands quietly, as a figure that looks like a result. Three
rules, ⚠ PROPOSED on 15 Oct 2026; the client has supplied none:

* **A station's own daily register first; its live GHI, integrated, where the
  register is missing or stuck.** VARDHMAN_GROUP's two stations send their
  daily total (`AGHI`) as 0 all day while their live `GHI` reads the sun, and
  the Plant had no PR at all. Integrating W/m² over time is how insolation is
  measured in the first place (IEC 61724-1), so the stand-in is the same
  sensor's own reading rather than an estimate — but it is our arithmetic, not
  the station's, and every screen that uses it says so.
* **A station reading no sun beside one that does is not measuring.** The
  client's formula takes the mean of the stations (`AVG.GHI_CUMULATIVE`), and a
  mean assumes every station is a sensor: one that sends 0 halves the Plant's
  sun and doubles its PR, with nothing on the screen to say so. It is left out,
  and named.
* **Working stations that disagree are reported, never resolved.** Two sensors
  more than 10% apart are a dirty, shaded or misaligned sensor, or a gap in one
  of them; which is right is a site visit, not arithmetic.

The same rules serve a whole period (`plant_irradiation`), each day or month
of a Report (`irradiation_by_label`, judged afresh for each), and a single
moment (`not_measuring`, for the live tiles and the Plant KPI formula's inputs).
"""

from __future__ import annotations

import statistics
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from itertools import pairwise
from typing import Literal

from solarcms.domain.assumptions import (
    HEALTH_DEGRADED_MULTIPLIER,
    IRRADIANCE_DAYLIGHT_W_PER_M2,
    IRRADIANCE_DEAD_SHARE,
    IRRADIANCE_SUN_TAGS,
    IRRADIATION_JUDGED_KWH_PER_M2,
    IRRADIATION_STATION_SPREAD,
    MAX_IRRADIATION_KWH_PER_M2_PER_HOUR,
)
from solarcms.domain.counters import (
    CounterIntegral,
    CounterSample,
    CounterStep,
    DeviceSeries,
    bucket_steps,
    integrate_counter,
)
from solarcms.domain.slots import WithheldReading

IrradiationSource = Literal["register", "live_ghi"]

# The daily totals of the live sun Tags (`GHI_CUMULATIVE`, `GTI_CUMULATIVE`).
_DAILY_TOTALS: tuple[str, ...] = tuple(f"{tag}_CUMULATIVE" for tag in IRRADIANCE_SUN_TAGS)


# ── A station's live irradiance, integrated ────────────────────────────────

@dataclass(frozen=True, slots=True)
class IrradianceBucket:
    """One aggregate bucket of a live irradiance Tag (W/m²)."""

    start: datetime
    mean_w_per_m2: float | None
    # False when the bucket held a flagged reading: not data (Guardrail 23).
    good: bool = True


@dataclass(frozen=True, slots=True)
class LiveIrradiance:
    """One station's live irradiance over a period, integrated to kWh/m²."""

    device_id: int
    device_code: str
    integral: CounterIntegral


def live_hold(
    starts: Sequence[datetime], width: timedelta, recorded_spacing_s: float,
) -> timedelta:
    """How long a station's live reading may be held across empty time to the
    next one (`integrate_irradiance`): the empty time its own spacing leaves by
    design, doubled as the health sweep allows a Device.

    The spacing is the slower of how often it sends and how often its GHI is
    kept, as recorded — or, where its buckets fall further apart than the
    tier's width, the median gap between them: GHI stored every five minutes
    before 14 Oct 2026 left four minutes in five empty, and only the data says
    so now. ⚠ Only the time *between* buckets is ever held. On a tier as coarse
    as the spacing — an hourly bucket of a station sending every minute — a
    missing bucket is an hour nobody measured, and is never filled.
    """
    gaps = [(b - a).total_seconds() for a, b in pairwise(sorted(starts))]
    median = statistics.median(gaps) if gaps else 0.0
    width_s = width.total_seconds()
    spacing_s = max(recorded_spacing_s, median if median > width_s else 0.0)
    return timedelta(seconds=max(0.0, HEALTH_DEGRADED_MULTIPLIER * spacing_s - width_s))


def integrate_irradiance(
    buckets: Sequence[IrradianceBucket], width: timedelta, now: datetime,
    hold: timedelta = timedelta(0),
) -> CounterIntegral:
    """kWh/m² from W/m²: each bucket's mean times the time it spans.

    One step per bucket, stamped at the end of the span it is credited with and
    `since` at its start, so a per-day breakdown attributes it exactly as it
    does a register's step. The bucket still filling spans only up to `now`.

    A bucket's mean is **held until the next bucket** when the empty time
    between them is no longer than `hold` — the station's own spacing
    (`live_hold`). GHI stored once a minute from a
    station sending every 30 to 86 s leaves minutes empty by design, and they
    were not dark: counted as nothing, they put SPINNING_AND_GENERAL_MILLS'
    live sunlight for 9 Oct 2026 at 0.58 kWh/m² instead of 0.84, and its PR at
    158.5% instead of 109.3% (measured 21 Oct). The same hold the operating
    status gives each Device between its own readings.

    Beyond `hold` a missing bucket adds nothing rather than being filled in
    (Guardrail 18), and a flagged one is not data and is never held across. A
    negative mean — a sensor's dark offset — adds nothing either: irradiance
    below zero is not sunlight taken away.

    ⚠ A bucket counts whole once it holds any reading, so a station that went
    quiet half-way through one is credited with all of it at the mean of what
    it sent. Callers read no coarser than the hourly tier, where that is at most
    an hour at either edge of an outage; from the daily tier a station silent
    at night would be credited with its daytime mean for twenty-four hours.
    """
    steps: list[CounterStep] = []
    total = 0.0
    ordered = sorted(buckets, key=lambda item: item.start)
    for index, bucket in enumerate(ordered):
        if not bucket.good or bucket.mean_w_per_m2 is None:
            continue
        end = min(bucket.start + width, now)
        following = ordered[index + 1] if index + 1 < len(ordered) else None
        if (following is not None and following.good and following.mean_w_per_m2 is not None
                and timedelta(0) < following.start - end <= hold):
            end = min(following.start, now)
        hours = (end - bucket.start).total_seconds() / 3600.0
        if hours <= 0:
            continue
        amount = max(bucket.mean_w_per_m2, 0.0) * hours / 1000.0
        steps.append(CounterStep(end, amount, bucket.start))
        total += amount
    return CounterIntegral(
        total=total, steps=tuple(steps), anomalies=(), samples=len(steps),
        first=CounterSample(steps[0].since or steps[0].at, 0.0) if steps else None,
        last=CounterSample(steps[-1].at, total) if steps else None,
    )


# ── One station, then the Plant ─────────────────────────────────────────────

def _dark_beside(total: float, brightest: float | None) -> bool:
    """`total` is next to nothing where `brightest`, under the same sky, saw the sun."""
    return (
        brightest is not None
        and brightest >= IRRADIATION_JUDGED_KWH_PER_M2
        and total < IRRADIANCE_DEAD_SHARE * brightest
    )


def choose_source(
    register: float | None, live: float | None,
) -> tuple[float | None, IrradiationSource | None]:
    """One station's sunlight over a span, and which of its readings gave it.

    Its own daily register, unless the register is next to nothing where the
    same station's live GHI saw the sun — then the live GHI, integrated. A
    station with only one of the two uses that one.
    """
    if register is not None and not _dark_beside(register, live):
        return register, "register"
    if live is not None:
        return live, "live_ghi"
    return None, None


@dataclass(frozen=True, slots=True)
class StationIrradiation:
    device_id: int
    device_code: str
    # Its own daily register, integrated — None when it reported fewer than two.
    register: CounterIntegral | None
    # Its live GHI, integrated — None when it sent no usable bucket.
    live: CounterIntegral | None
    source: IrradiationSource | None
    total: float | None
    # Set when it read no sun beside a station that did: not measuring.
    excluded_reason: str | None = None

    @property
    def used(self) -> bool:
        return self.total is not None and self.excluded_reason is None


@dataclass(frozen=True, slots=True)
class PlantIrradiation:
    """kWh/m² over the period — the mean of the stations measuring — or None
    when no station reported. Every station considered is listed, used or not.
    """

    value: float | None
    stations: tuple[StationIrradiation, ...] = field(default_factory=tuple)
    undefined_reason: str | None = None
    # (highest - lowest) / mean of the stations used — set only when it passes
    # IRRADIATION_STATION_SPREAD, and never acted on.
    spread: float | None = None

    @property
    def used(self) -> tuple[StationIrradiation, ...]:
        return tuple(station for station in self.stations if station.used)

    @property
    def from_live(self) -> bool:
        """True when any station used gave its live GHI rather than its register."""
        return any(station.source == "live_ghi" for station in self.used)


def _judge(
    totals: Sequence[tuple[str, float]],
) -> tuple[float | None, dict[int, str], float | None]:
    """The mean of the stations measuring; which were not, by index, and why;
    and how far apart those measuring are, when further than they should be."""
    if not totals:
        return None, {}, None
    brightest_code, brightest = max(totals, key=lambda item: item[1])
    excluded = {
        index: (f"read {total:.2f} kWh/m² while {brightest_code} read "
                f"{brightest:.2f} — not measuring")
        for index, (_code, total) in enumerate(totals)
        if _dark_beside(total, brightest)
    }
    # Never empty: the brightest is not dark beside itself.
    kept = [total for index, (_code, total) in enumerate(totals) if index not in excluded]
    mean = sum(kept) / len(kept)
    spread = None
    if len(kept) >= 2 and mean >= IRRADIATION_JUDGED_KWH_PER_M2:
        apart = (max(kept) - min(kept)) / mean
        if apart > IRRADIATION_STATION_SPREAD:
            spread = apart
    return mean, excluded, spread


def plant_irradiation(
    registers: Sequence[DeviceSeries], live: Sequence[LiveIrradiance] = (),
) -> PlantIrradiation:
    """The Plant's sunlight over a period, in kWh/m².

    Each station's own figure (`choose_source`), the stations reading no sun
    beside one that did left out, and the mean of the rest — a mean, as the
    client's own PR formula takes one (`AVG.GHI_CUMULATIVE`): two stations on
    one Plant measure the same sky, and summing them would double it. A
    register is integrated rather than maxed, because it resets every
    midnight — the maximum over a month is one day's sun, not thirty.
    """
    codes: dict[int, str] = {}
    integrals: dict[int, CounterIntegral] = {}
    for item in registers:
        if len(item.samples) >= 2:
            integrals[item.device_id] = integrate_counter(
                item.samples, max_rate_per_hour=MAX_IRRADIATION_KWH_PER_M2_PER_HOUR,
                resets_expected=True)
            codes[item.device_id] = item.device_code
    lives: dict[int, CounterIntegral] = {}
    for reading in live:
        if reading.integral.samples:
            lives[reading.device_id] = reading.integral
            codes.setdefault(reading.device_id, reading.device_code)
    if not codes:
        return PlantIrradiation(None, (), "no weather station reported in the period")

    order = sorted(codes, key=lambda device_id: (codes[device_id], device_id))
    chosen = [
        (device_id, *choose_source(
            integrals[device_id].total if device_id in integrals else None,
            lives[device_id].total if device_id in lives else None))
        for device_id in order
    ]
    mean, excluded, spread = _judge(
        [(codes[device_id], total) for device_id, total, _source in chosen
         if total is not None])
    stations = tuple(
        StationIrradiation(
            device_id=device_id, device_code=codes[device_id],
            register=integrals.get(device_id), live=lives.get(device_id),
            source=source, total=total, excluded_reason=excluded.get(index))
        for index, (device_id, total, source) in enumerate(chosen)
    )
    return PlantIrradiation(mean, stations, spread=spread)


def irradiation_by_label(
    irradiation: PlantIrradiation, label: Callable[[datetime], str],
) -> dict[str, float]:
    """The Plant's sunlight per label — a local day, a month — by the same
    rules, judged afresh for each label.

    A register that stuck on Tuesday gives way to its live GHI for Tuesday
    alone, a station reading no sun on Tuesday is left out of Tuesday alone, and
    only the stations with readings under a label count for it — so a station
    that was down on Tuesday does not halve Tuesday's sun.
    """
    none: dict[str, float] = {}
    per_station = [
        (station.device_code,
         bucket_steps(station.register.steps, label) if station.register else none,
         bucket_steps(station.live.steps, label) if station.live else none)
        for station in irradiation.stations
    ]
    names = {name for _code, register, live in per_station for name in (*register, *live)}
    result: dict[str, float] = {}
    for name in names:
        totals: list[tuple[str, float]] = []
        for code, register, live in per_station:
            total, _source = choose_source(register.get(name), live.get(name))
            if total is not None:
                totals.append((code, total))
        mean, _excluded, _spread = _judge(totals)
        if mean is not None:
            result[name] = mean
    return result


def irradiation_notes(irradiation: PlantIrradiation, plant_code: str | None = None) -> list[str]:
    """What a Report must say about where its sunlight came from — one
    sentence per thing that is not simply "each station's own total"."""
    who = f"{plant_code}: " if plant_code else ""
    notes: list[str] = []
    live = [s.device_code for s in irradiation.used if s.source == "live_ghi"]
    if live:
        notes.append(
            f"{who}irradiation for {', '.join(live)} is integrated from the station's live "
            "GHI, because its own daily total read next to nothing while the live sensor "
            "saw the sun. That integration is this platform's arithmetic, not a figure the "
            "station reported (⚠ PROPOSED).")
    notes.extend(
        f"{who}{s.device_code} is left out of the irradiation: it {s.excluded_reason}."
        for s in irradiation.stations if s.excluded_reason is not None)
    if irradiation.spread is not None:
        notes.append(
            f"{who}the weather stations used differ by {irradiation.spread:.0%} — a dirty, "
            "shaded or misaligned sensor, or a gap in one of them. Their mean is used; "
            "which is right needs checking on site.")
    return notes


# ── A moment: the live tiles and the Plant KPI formula's inputs ────────────

@dataclass(frozen=True, slots=True)
class StationValues:
    """One weather station's current values, by Tag code."""

    device_id: int
    device_code: str
    values: Mapping[str, float]


def not_measuring(stations: Sequence[StationValues]) -> tuple[WithheldReading, ...]:
    """Current readings that cannot be measurements: next to nothing beside a
    reading of the same kind that sees the sun.

    Live irradiance (GHI, GTI, plane-of-array) is judged against the brightest
    of all of them across the Plant, once that is daylight: each includes the
    diffuse sky, so none is near zero while another reads 600 W/m². A daily
    total is judged only against the same total at the Plant's other stations:
    at dawn a register honestly reads 0.00 while the live sensor already reads
    60 W/m², so a station alone is never judged on its total.
    """
    withheld: list[WithheldReading] = []

    live = [
        (station, tag, value)
        for station in stations for tag, value in station.values.items()
        if tag in IRRADIANCE_SUN_TAGS
    ]
    if live:
        sky_station, sky_tag, sky = max(live, key=lambda item: item[2])
        if sky >= IRRADIANCE_DAYLIGHT_W_PER_M2:
            withheld.extend(
                WithheldReading(
                    station.device_id, station.device_code, tag, value,
                    f"{tag} reads {value:.0f} W/m² while {sky_tag} at "
                    f"{sky_station.device_code} reads {sky:.0f} — not measuring")
                for station, tag, value in live
                if value < IRRADIANCE_DEAD_SHARE * sky
            )

    for tag in _DAILY_TOTALS:
        readings = [(station, station.values[tag]) for station in stations
                    if tag in station.values]
        if len(readings) < 2:
            continue
        top_station, top = max(readings, key=lambda item: item[1])
        withheld.extend(
            WithheldReading(
                station.device_id, station.device_code, tag, value,
                f"{tag} reads {value:.2f} kWh/m² while {top_station.device_code} reads "
                f"{top:.2f} — not measuring")
            for station, value in readings
            if _dark_beside(value, top)
        )
    return tuple(withheld)
