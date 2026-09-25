"""Whether the Plant is generating, when it started and stopped, and the grid.

The Plant Status card answers three questions nothing else on the platform
answers directly, and all three are *rules* rather than readings:

* **Running, and since when.** The Plant starts the first time its Inverters'
  summed AC output rises above `PLANT_START_ABOVE_KW`, and stops the moment it
  falls back to `PLANT_STOP_AT_OR_BELOW_KW`. The gap between the two thresholds
  is hysteresis: a Plant hovering at 0.3 kW at dawn neither starts nor stops.
* **Its peak.** The largest value of the series the Current Power tile reads —
  a maximum, which needs no rule beyond "the earliest one wins a tie".
* **The grid.** Whether the breakers at the Plant's boundary are closed.

⚠ **A restart takes the stop back.** An Inverter bank that trips at 11:00 and
recovers at 11:30 has not stopped for the day, so a start after a stop clears
the stop rather than leaving 11:00 on the card all afternoon. The start stays
the first crossing: a passing trip does not move the morning. This is the
same reading T-17 took of the client's sheet — the *latest* fall is the stop.

Pure, like everything in `domain/`: samples in, answers out. The API folds this
over a day's stored history (`services/operating.py`); the scheduler applies
`transition` one live sample at a time to keep the Plant KPI Device's
`PLANT_START_TIME` / `PLANT_STOP_TIME` current. Both use this one rule, so the
card and the client's DASHBOARD row cannot be answering different questions.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

from solarcms.domain.assumptions import PLANT_START_ABOVE_KW, PLANT_STOP_AT_OR_BELOW_KW

Transition = Literal["start", "stop"]


def transition(
    running: bool,
    power: float,
    *,
    start_above: float = PLANT_START_ABOVE_KW,
    stop_at_or_below: float = PLANT_STOP_AT_OR_BELOW_KW,
) -> Transition | None:
    """What one sample does to a Plant that is (or is not) running."""
    if not running and power > start_above:
        return "start"
    if running and power <= stop_at_or_below:
        return "stop"
    return None


@dataclass(frozen=True, slots=True)
class OperatingDay:
    """One Plant-local day, as far as the samples reach."""

    start: datetime | None = None
    stop: datetime | None = None
    running: bool = False
    # The last sample that said anything, so a caller can tell "stopped at
    # 18:40" from "stopped at 18:40 and nothing since, including now".
    last_sample: datetime | None = None
    # The sample just before each transition — the last moment the Plant is
    # *known* to have been in its previous state. A transition is only as
    # precise as the gap between the two: a Plant first heard at 13:55 already
    # generating started at some unknown time before that, and `start_after`
    # is None there, because nothing that day said otherwise.
    start_after: datetime | None = None
    stop_after: datetime | None = None


def operating_day(
    samples: Iterable[tuple[datetime, float | None]],
    *,
    start_above: float = PLANT_START_ABOVE_KW,
    stop_at_or_below: float = PLANT_STOP_AT_OR_BELOW_KW,
) -> OperatingDay:
    """Fold a day's samples, ascending, into its start, stop and state.

    Each day begins *not running*: a Plant's day is its own, and yesterday's
    last state carried across midnight would give today no start at all. A
    missing sample (`None`) is no evidence either way and changes nothing —
    silence is not a stop, and silence is not a start either, which is what
    `start_after` and `stop_after` let a caller say.
    """
    start: datetime | None = None
    stop: datetime | None = None
    start_after: datetime | None = None
    stop_after: datetime | None = None
    running = False
    last: datetime | None = None
    for at, power in samples:
        if power is None:
            continue
        change = transition(
            running, power, start_above=start_above, stop_at_or_below=stop_at_or_below)
        if change == "start":
            running = True
            if start is None:
                start, start_after = at, last
            stop = stop_after = None
        elif change == "stop":
            running = False
            stop, stop_after = at, last
        last = at
    return OperatingDay(
        start=start, stop=stop, running=running, last_sample=last,
        start_after=start_after, stop_after=stop_after,
    )


def held_series(
    rows: Iterable[tuple[datetime, int, float]],
    hold: Mapping[int, timedelta],
    aggregate: str,
) -> list[tuple[datetime, float | None]]:
    """Several Devices' bucketed values combined into one series, per bucket.

    ⚠ Each Device's last value is **held** until its next one, for at most
    `hold[device]`. Without that, a sum is taken over whichever Devices happened
    to report inside each bucket: an Inverter on an 86 s cycle is absent from a
    third of all minutes, so a Plant of seventeen reads as eleven or twelve and
    its peak comes out a third low. Past the hold the Device drops out rather
    than being carried forward indefinitely, because a value that old is no
    longer evidence of anything.

    `rows` must be ascending by time. Emits one entry per bucket that held any
    row; `None` where every Device's hold had expired.
    """
    latest: dict[int, tuple[datetime, float]] = {}
    out: list[tuple[datetime, float | None]] = []
    current: datetime | None = None

    def emit(at: datetime) -> None:
        values = [
            value for device, (seen, value) in latest.items()
            if at - seen <= hold.get(device, timedelta(0))
        ]
        out.append((at, combine(values, aggregate)))

    for at, device, value in rows:
        if current is not None and at != current:
            emit(current)
        current = at
        latest[device] = (at, value)
    if current is not None:
        emit(current)
    return out


def combine(values: Sequence[float], aggregate: str) -> float | None:
    """One instant's values across Devices, the way the source says to."""
    if not values:
        return None
    if aggregate == "sum":
        return float(sum(values))
    if aggregate == "avg":
        return float(sum(values) / len(values))
    if aggregate == "min":
        return float(min(values))
    if aggregate == "max":
        return float(max(values))
    # `first` is the single-Device case; the caller passes one Device.
    return float(values[0])


def first_crossing(
    samples: Iterable[tuple[datetime, float | None]],
    window_start: datetime,
    window_end: datetime,
    kind: Transition,
    *,
    start_above: float = PLANT_START_ABOVE_KW,
    stop_at_or_below: float = PLANT_STOP_AT_OR_BELOW_KW,
) -> datetime | None:
    """The exact reading, inside one bucket, at which a start or stop happened.

    The day is folded per minute, so a transition is first known to the minute.
    Replayed over the raw readings of that minute — each Device held at its
    last value, as the fold holds it — the crossing lands on the timestamp of
    the reading that made it, which is what lets a start be printed to the
    second without the seconds being invented. None when no reading in the
    window crosses: the caller keeps the minute.
    """
    for at, value in samples:
        if value is None or not window_start <= at < window_end:
            continue
        if kind == "start" and value > start_above:
            return at
        if kind == "stop" and value <= stop_at_or_below:
            return at
    return None


def peak(samples: Iterable[tuple[datetime, float | None]]) -> tuple[datetime, float] | None:
    """The largest sample and when it was taken; the earliest wins a tie."""
    best: tuple[datetime, float] | None = None
    for at, value in samples:
        if value is None:
            continue
        if best is None or value > best[1]:
            best = (at, value)
    return best


# ── The grid ─────────────────────────────────────────────────────────────────

GridState = Literal["connected", "disconnected", "partial", "unknown"]


@dataclass(frozen=True, slots=True)
class Breaker:
    """One breaker as the grid rule needs it: its contact, and whether it is heard."""

    closed: bool | None
    online: bool


@dataclass(frozen=True, slots=True)
class GridStatus:
    state: GridState | None
    breakers: int
    reporting: int
    closed: int
    open: int
    reason: str | None = None


def grid_status(breakers: Sequence[Breaker]) -> GridStatus:
    """Connected when every breaker that can be heard is closed.

    ⚠ Only breakers that are *online and have a value* vote. A breaker that
    has gone quiet still has its last contact state in the current-values
    cache, and reporting "connected" on the strength of a contact read an hour
    ago is the stale-figure error in its most dangerous form — so a silent one
    makes the state `unknown` (if nothing else is heard) or is simply counted
    as not reporting.

    `partial` is a real answer on a Plant with several feeders: one closed and
    one open is neither connected nor disconnected, and saying either would be
    choosing which feeder matters without knowing.
    """
    if not breakers:
        return GridStatus(None, 0, 0, 0, 0, "no breaker is registered at this Plant")
    heard = [b for b in breakers if b.online and b.closed is not None]
    closed = sum(1 for b in heard if b.closed)
    opened = len(heard) - closed
    if not heard:
        return GridStatus("unknown", len(breakers), 0, 0, 0, "no breaker is reporting")
    state: GridState
    if opened == 0:
        state = "connected"
    elif closed == 0:
        state = "disconnected"
    else:
        state = "partial"
    return GridStatus(state, len(breakers), len(heard), closed, opened)
