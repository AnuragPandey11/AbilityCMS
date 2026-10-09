"""Each Inverter's downtime, availability and the energy its stops cost.

The Inverter ranking (Inverter Monitoring) puts every Inverter of a Plant side
by side over a period: what it generated, how much of the time it was
available, its PR, how long it stood still and what that cost. Generation and
PR are the existing rules (`counters.plant_energy`, `formulas.performance_ratio`);
this module holds the one rule that is new, **downtime** — ⚠ PROPOSED, the user's
choices of 9 Oct 2026, constants in `assumptions.py`:

* A minute is **judged** for an Inverter when more than half of the *other*
  reporting Inverters at the Plant are producing. Then, and only then, does
  standing still say something about this machine rather than about the sky:
  at night, under a dark cloud, or at a Plant whose grid has dropped, every
  Inverter stops together and none of them is down.
* In a judged minute an Inverter is **producing** (output above
  `INVERTER_PRODUCING_ABOVE_KW`), **stopped** (reporting, at or below it), or
  **no data** (nothing heard within its hold). No data is never downtime —
  absence alone never proves equipment (Guardrail 16) — and is reported beside
  it, so a gap still shows.
* A stop counts as **downtime** only once it lasts `INVERTER_DOWNTIME_MIN_MINUTES`
  without a break; shorter ones count as available. Inverters wake minutes
  apart at dawn, and without this the last to rise would accrue a fault a day.
* Minutes inside planned maintenance are set aside — neither available nor
  down — as they are excluded from coverage elsewhere.
* **Availability** is the share of judged minutes with data that were not
  downtime. Undefined, never 1.0, when there was nothing to judge: a lone
  Inverter has no neighbours to compare with, and that is said, not hidden.
* **Energy lost** is counted only while down (the user's choice): in each down
  minute, the median producing neighbour's output per kWp of panels, times this
  Inverter's own kWp. Undefined where a size it needs is not recorded — never
  estimated (the user's choice) — and exactly zero when it never went down.

Each Device's value is **held** between its own readings for its hold, as the
Plant's operating rule holds it (`operating.held_series`): an Inverter on an
86 s cycle is otherwise missing from a third of all minutes, and every one of
those would read as no data.

Pure: minute indices and floats in, figures out. `services/inverter_ranking.py`
reads the minutes and does the I/O.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from statistics import median

from solarcms.domain.assumptions import (
    INVERTER_DOWNTIME_MIN_MINUTES,
    INVERTER_PRODUCING_ABOVE_KW,
)

_NO_DATA, _PRODUCING, _STOPPED = 0, 1, 2


@dataclass(frozen=True, slots=True)
class InverterMinutes:
    """One Inverter's good one-minute AC output, as the fold needs it.

    `minutes` are indices from the window's first minute, ascending; a value
    before the window (a negative index) is how a value held across its start
    is known. `planned` are [start, end) minute ranges of planned work.
    """

    device_id: int
    dc_kwp: float | None
    hold_minutes: int
    minutes: Sequence[int]
    mean_kw: Sequence[float]
    peak_kw: Sequence[float]
    planned: Sequence[tuple[int, int]] = ()


@dataclass(frozen=True, slots=True)
class Stop:
    """One counted stop: [start, end) in minute indices, and what it cost."""

    start: int
    end: int
    lost_kwh: float | None
    # Still stopped at the window's last minute, so its end is not known yet.
    ongoing: bool = False


@dataclass(frozen=True, slots=True)
class InverterTime:
    device_id: int
    #: Minutes the other Inverters were generating — what this one is judged over.
    judged_minutes: int
    producing_minutes: int
    #: Stops long enough to count, in minutes.
    downtime_minutes: int
    #: Stops too short to count; these count as available.
    short_stop_minutes: int
    no_data_minutes: int
    planned_minutes: int
    stops: tuple[Stop, ...]
    availability: float | None
    availability_reason: str | None
    lost_kwh: float | None
    lost_reason: str | None


@dataclass(slots=True)
class _Tally:
    judged: int = 0
    producing: int = 0
    downtime: int = 0
    short: int = 0
    no_data: int = 0
    planned: int = 0
    stops: list[Stop] = field(default_factory=list)
    # The stop in progress: its first minute and each minute's expected kWh,
    # None where a size it needs is missing.
    run_start: int | None = None
    run: list[float | None] = field(default_factory=list)

    def close(self, *, min_stop: int, ongoing: bool = False) -> None:
        if self.run_start is None:
            return
        length = len(self.run)
        if length >= min_stop:
            self.downtime += length
            known = [value for value in self.run if value is not None]
            lost = sum(known) if len(known) == length else None
            self.stops.append(Stop(self.run_start, self.run_start + length, lost, ongoing))
        else:
            self.short += length
        self.run_start = None
        self.run = []


@dataclass(frozen=True, slots=True)
class Folded:
    """Every Inverter's time, and how much of the period anything was heard.

    `heard_minutes` is how much of the period at least one Inverter was
    reporting, and `generating_minutes` how much at least one was producing —
    the coverage every figure above is read against (Guardrail 18). A Plant
    whose data stopped at 03:00 and came back at 15:00 judges availability over
    the afternoon alone, and must say so rather than read "100%" for the day.
    """

    inverters: dict[int, InverterTime]
    minutes: int
    heard_minutes: int
    generating_minutes: int


def _planned_mask(ranges: Sequence[tuple[int, int]], minutes: int) -> bytearray | None:
    if not ranges:
        return None
    mask = bytearray(minutes)
    for start, end in ranges:
        for t in range(max(0, start), min(minutes, end)):
            mask[t] = 1
    return mask


def fold(
    inverters: Sequence[InverterMinutes],
    minutes: int,
    *,
    producing_above_kw: float = INVERTER_PRODUCING_ABOVE_KW,
    min_stop_minutes: int = INVERTER_DOWNTIME_MIN_MINUTES,
) -> Folded:
    """Fold `minutes` minutes of every Inverter at a Plant into their downtime."""
    count = len(inverters)
    pointers = [0] * count
    seen: list[int | None] = [None] * count
    mean = [0.0] * count
    peak = [0.0] * count
    state = [_NO_DATA] * count
    tallies = [_Tally() for _ in inverters]
    planned = [_planned_mask(inv.planned, minutes) for inv in inverters]
    sized = [(k, inv.dc_kwp) for k, inv in enumerate(inverters) if inv.dc_kwp]
    heard = generating = 0

    for t in range(minutes):
        reporting = producing = 0
        for k, inv in enumerate(inverters):
            at, p = inv.minutes, pointers[k]
            while p < len(at) and at[p] <= t:
                seen[k], mean[k], peak[k] = at[p], inv.mean_kw[p], inv.peak_kw[p]
                p += 1
            pointers[k] = p
            last = seen[k]
            if last is not None and t - last <= inv.hold_minutes:
                reporting += 1
                if peak[k] > producing_above_kw:
                    producing += 1
                    state[k] = _PRODUCING
                else:
                    state[k] = _STOPPED
            else:
                state[k] = _NO_DATA

        heard += reporting > 0
        generating += producing > 0
        if producing == 0:
            # Nobody generating: night, or a Plant-wide stop. No one is judged.
            for tally in tallies:
                tally.close(min_stop=min_stop_minutes)
            continue

        # The typical producing neighbour's output per kWp, worked out once per
        # minute and only if some Inverter is stopped and sized.
        per_kwp: float | None = None
        per_kwp_known = False
        for k, inv in enumerate(inverters):
            tally, here = tallies[k], state[k]
            others_reporting = reporting - (here != _NO_DATA)
            others_producing = producing - (here == _PRODUCING)
            if others_reporting == 0 or 2 * others_producing <= others_reporting:
                tally.close(min_stop=min_stop_minutes)
                continue
            mask = planned[k]
            if mask is not None and mask[t]:
                tally.planned += 1
                tally.close(min_stop=min_stop_minutes)
                continue
            tally.judged += 1
            if here == _NO_DATA:
                tally.no_data += 1
                tally.close(min_stop=min_stop_minutes)
            elif here == _PRODUCING:
                tally.producing += 1
                tally.close(min_stop=min_stop_minutes)
            else:
                expected: float | None = None
                if inv.dc_kwp:
                    if not per_kwp_known:
                        # A stopped Inverter is not producing, so every producing
                        # one is a neighbour.
                        rates = [max(0.0, mean[j]) / kwp for j, kwp in sized
                                 if state[j] == _PRODUCING]
                        per_kwp = median(rates) if rates else None
                        per_kwp_known = True
                    if per_kwp is not None:
                        expected = per_kwp * inv.dc_kwp / 60.0
                if tally.run_start is None:
                    tally.run_start = t
                tally.run.append(expected)

    out: dict[int, InverterTime] = {}
    for inv, tally in zip(inverters, tallies, strict=True):
        tally.close(min_stop=min_stop_minutes, ongoing=True)
        out[inv.device_id] = _result(inv, tally, count)
    return Folded(out, minutes, heard, generating)


def _result(inv: InverterMinutes, tally: _Tally, count: int) -> InverterTime:
    with_data = tally.producing + tally.downtime + tally.short
    availability: float | None = None
    reason: str | None = None
    if count < 2:
        reason = "the only Inverter at this Plant: there is no neighbour to compare its stops with"
    elif tally.judged == 0:
        reason = "the other Inverters were not generating at any point in this period"
    elif with_data == 0:
        reason = "it sent nothing while the other Inverters were generating"
    else:
        availability = (with_data - tally.downtime) / with_data

    lost: float | None = None
    lost_reason: str | None = None
    if availability is None:
        lost_reason = reason
    elif not tally.stops:
        lost = 0.0
    elif all(stop.lost_kwh is not None for stop in tally.stops):
        lost = sum(stop.lost_kwh or 0.0 for stop in tally.stops)
    elif not inv.dc_kwp:
        lost_reason = "no DC size is recorded for this Inverter"
    else:
        lost_reason = "no generating neighbour has a DC size recorded"

    return InverterTime(
        device_id=inv.device_id,
        judged_minutes=tally.judged,
        producing_minutes=tally.producing,
        downtime_minutes=tally.downtime,
        short_stop_minutes=tally.short,
        no_data_minutes=tally.no_data,
        planned_minutes=tally.planned,
        stops=tuple(tally.stops),
        availability=availability,
        availability_reason=reason,
        lost_kwh=lost,
        lost_reason=lost_reason,
    )
