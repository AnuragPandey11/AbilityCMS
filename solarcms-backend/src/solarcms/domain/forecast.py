"""Forecasting a Plant's output from its own recent history.

⚠ PROPOSED (chosen by the user on 8 Oct 2026, over a weather service). No
weather forecast enters anything here, so these forecasts cannot foresee a
cloudy tomorrow, and every screen that shows one says so.

── The method, in one paragraph ────────────────────────────────────────────
A solar Plant's output has the shape of its day. From the last fortnight, two
curves are drawn for each 15-minute time of day: the **typical** day (the
median) and the **clear** day (a high quantile — the envelope). How bright it
is *now* is the ratio of the latest output to the envelope at this time of day;
a near-term forecast carries that ratio forward along the envelope, so a bright
afternoon falls away towards sunset at the rate the Plant's own clear days do,
and a dull one stays dull. The further ahead, the less that ratio is trusted:
its weight falls in a straight line to nothing over a few hours, the typical
day taking over. Tomorrow and the week ahead are the typical day — the best a
history alone can say. This is "smart persistence" against an empirical clear
sky: the standard first forecast for photovoltaics, with the Plant's own clear
days standing in for a clear-sky model nobody has the coordinates for.

── What it never does ──────────────────────────────────────────────────────
It never invents a value where the history has none (a time of day seen on
fewer than `FORECAST_MIN_DAYS` days is undefined, not zero), and never reads a
day cut short by an outage as a poor day (`register_day_totals`). It follows
the data where the data is negative — a meter's night-time import is what the
Current Power card shows at night, so it is what the forecast says too.

Pure (Guardrail 9): values in, values out.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from solarcms.domain.assumptions import (
    FORECAST_BAND_HIGH_QUANTILE,
    FORECAST_BAND_LOW_QUANTILE,
    FORECAST_CLEARNESS_BUCKETS,
    FORECAST_CLEARNESS_CAP,
    FORECAST_ENVELOPE_FLOOR_SHARE,
    FORECAST_ENVELOPE_QUANTILE,
    FORECAST_HISTORY_DAYS,
    FORECAST_MIN_DAYS,
    FORECAST_PERSISTENCE_HOURS,
    REGISTER_RESET_SHARE,
)

SLOT_MINUTES = 15
SLOTS_PER_DAY = 24 * 60 // SLOT_MINUTES

# One day's output, one value per 15-minute time of day; None where unknown.
DayValues = Sequence[float | None]


def quantile(values: Sequence[float], q: float) -> float:
    """The q-quantile by linear interpolation between closest ranks."""
    ordered = sorted(values)
    if not ordered:
        raise ValueError("quantile of nothing")
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


@dataclass(frozen=True, slots=True)
class Profile:
    """The Plant's day, at each 15-minute time of day, from recent history."""

    typical: tuple[float | None, ...]
    envelope: tuple[float | None, ...]
    low: tuple[float | None, ...]
    high: tuple[float | None, ...]
    days: int

    @property
    def peak(self) -> float:
        return max((v for v in self.envelope if v is not None), default=0.0)

    def floor(self) -> float:
        """Below this the envelope is dawn, dusk or night: no ratio is read against it."""
        return self.peak * FORECAST_ENVELOPE_FLOOR_SHARE


def build_profile(
    history: Mapping[date, DayValues], *, min_days: int = FORECAST_MIN_DAYS,
) -> Profile:
    """Typical, clear and band curves over the days given (each SLOTS_PER_DAY long)."""
    typical: list[float | None] = []
    envelope: list[float | None] = []
    low: list[float | None] = []
    high: list[float | None] = []
    for slot in range(SLOTS_PER_DAY):
        values = [
            value for day in history.values()
            if slot < len(day) and (value := day[slot]) is not None
        ]
        if len(values) < min_days:
            typical.append(None)
            envelope.append(None)
            low.append(None)
            high.append(None)
            continue
        typical.append(statistics.median(values))
        envelope.append(quantile(values, FORECAST_ENVELOPE_QUANTILE))
        low.append(quantile(values, FORECAST_BAND_LOW_QUANTILE))
        high.append(quantile(values, FORECAST_BAND_HIGH_QUANTILE))
    return Profile(
        typical=tuple(typical), envelope=tuple(envelope), low=tuple(low), high=tuple(high),
        days=len(history),
    )


def clearness(recent: Sequence[tuple[int, float]], profile: Profile) -> float | None:
    """How bright it is now: the latest output over the clear-day envelope.

    `recent` is (slot, value) for the latest completed buckets, oldest first.
    Undefined at dawn, dusk and night, where the envelope is too small to divide
    by — the typical day answers there instead.
    """
    floor = profile.floor()
    ratios = []
    for slot, value in recent[-FORECAST_CLEARNESS_BUCKETS:]:
        envelope = profile.envelope[slot % SLOTS_PER_DAY]
        if envelope is None or envelope <= floor or floor <= 0:
            continue
        ratios.append(max(0.0, value) / envelope)
    if not ratios:
        return None
    return min(sum(ratios) / len(ratios), FORECAST_CLEARNESS_CAP)


def forecast_at(
    profile: Profile, k: float | None, slot: int, hours_ahead: float, *, cap: float | None = None,
) -> float | None:
    """One time of day, `hours_ahead` from now, given how bright it is now (`k`)."""
    index = slot % SLOTS_PER_DAY
    typical = profile.typical[index]
    if typical is None:
        return None
    envelope = profile.envelope[index]
    if k is None or envelope is None:
        value = typical
    else:
        weight = max(0.0, 1.0 - hours_ahead / FORECAST_PERSISTENCE_HOURS)
        value = weight * k * envelope + (1.0 - weight) * typical
    return min(value, cap) if cap is not None and cap > 0 else value


def history_window(
    days: Mapping[date, DayValues], before: date, length: int = FORECAST_HISTORY_DAYS,
) -> dict[date, DayValues]:
    """The `length` days before `before` that hold any value — a profile's input."""
    chosen = sorted(
        (d for d, values in days.items() if d < before and any(v is not None for v in values)),
        reverse=True,
    )[:length]
    return {d: days[d] for d in chosen}


# One reading of a register that restarts each day: (slot, min, max) of a
# 15-minute bucket.
RegisterBucket = tuple[int, float, float]


def register_day_totals(
    days: Mapping[date, Sequence[RegisterBucket]], *, settled_slots: int,
) -> dict[date, float]:
    """One Device's complete days, each with its final total, from a daily register.

    A day counts only when the readings show its end: the register was seen to
    have risen, then stopped rising at least `settled_slots` before the day's
    last reading, and that last reading is no earlier in the day than the time
    this register usually stops rising — the median over the days that show
    it, so the rule comes from the Device's own history rather than a clock.
    A day whose readings stop at noon, or hold only the night, is left out:
    its total would read as a dull day, or as a day of nothing.

    A fall below `REGISTER_RESET_SHARE` of the day's highest value so far
    restarts the register (its own midnight may not be the Plant's), so the
    day's total is read after the last restart.
    """
    settled: dict[date, tuple[int, int, float]] = {}  # day -> (last_rise, last_slot, total)
    late_starts: dict[date, tuple[int, float]] = {}  # risen before the readings began
    for day, buckets in days.items():
        ordered = sorted(buckets)
        start = 0
        highest = ordered[0][2] if ordered else 0.0
        for i in range(1, len(ordered)):
            if ordered[i][2] < highest * REGISTER_RESET_SHARE:
                start = i
                highest = ordered[i][2]
            else:
                highest = max(highest, ordered[i][2])
        segment = ordered[start:]
        if not segment:
            continue
        total = max(high for _, _, high in segment)
        if total <= 0:
            continue
        last_rise: int | None = None
        for i, (slot, low, high) in enumerate(segment):
            if high > low or (i > 0 and high > segment[i - 1][2]):
                last_rise = slot
        last_slot = segment[-1][0]
        if last_rise is None:
            late_starts[day] = (segment[0][0], total)
        elif last_slot - last_rise >= settled_slots:
            settled[day] = (last_rise, last_slot, total)
    if not settled:
        return {}
    usual_end = statistics.median(rise for rise, _, _ in settled.values())
    totals = {day: total for day, (_, last, total) in settled.items() if last >= usual_end}
    totals.update({day: total for day, (first, total) in late_starts.items() if first >= usual_end})
    return totals


@dataclass(frozen=True, slots=True)
class DailyEstimate:
    """One day's energy: the typical of recent complete days, and their spread."""

    value: float
    low: float
    high: float
    days: int


def daily_energy(totals: Mapping[date, float], before: date) -> DailyEstimate | None:
    """The typical day's energy from the complete days before `before`."""
    recent = sorted((d for d in totals if d < before), reverse=True)[:FORECAST_HISTORY_DAYS]
    values = [totals[d] for d in recent]
    if len(values) < FORECAST_MIN_DAYS:
        return None
    return DailyEstimate(
        value=statistics.median(values),
        low=quantile(values, FORECAST_BAND_LOW_QUANTILE),
        high=quantile(values, FORECAST_BAND_HIGH_QUANTILE),
        days=len(values),
    )


@dataclass(frozen=True, slots=True)
class Accuracy:
    """How the method did against what happened, over daylight only."""

    horizon_minutes: int
    samples: int
    mae: float | None
    # As a share of the mean actual output over the same samples.
    relative: float | None


def backtest(
    days: Mapping[date, DayValues],
    checked: Sequence[date],
    horizon_slots: int,
    *,
    cap: float | None = None,
) -> tuple[Accuracy, list[tuple[date, int, float, float]]]:
    """What the method would have forecast `horizon_slots` ahead on past days.

    Each day's forecasts use only the fortnight *before* it and the output up to
    the moment of forecasting — exactly what was known then, so the comparison
    is fair. Night is left out: forecasting zero at midnight is easy, and
    counting it would flatter the method. Returns the accuracy and every
    (day, target slot, forecast, actual) pair.
    """
    pairs: list[tuple[date, int, float, float]] = []
    for day in checked:
        values = days.get(day)
        if not values:
            continue
        profile = build_profile(history_window(days, day))
        floor = profile.floor()
        if floor <= 0:
            continue
        for slot in range(FORECAST_CLEARNESS_BUCKETS - 1, SLOTS_PER_DAY - horizon_slots):
            target = slot + horizon_slots
            actual = values[target]
            envelope = profile.envelope[target]
            if actual is None or envelope is None or envelope <= floor:
                continue
            recent = [
                (s, v) for s in range(slot - FORECAST_CLEARNESS_BUCKETS + 1, slot + 1)
                if (v := values[s]) is not None
            ]
            if not recent:
                continue
            k = clearness(recent, profile)
            predicted = forecast_at(
                profile, k, target, horizon_slots * SLOT_MINUTES / 60, cap=cap)
            if predicted is None:
                continue
            pairs.append((day, target, predicted, actual))
    if not pairs:
        return Accuracy(horizon_slots * SLOT_MINUTES, 0, None, None), pairs
    mae = sum(abs(f - a) for _, _, f, a in pairs) / len(pairs)
    mean_actual = sum(a for _, _, _, a in pairs) / len(pairs)
    return (
        Accuracy(
            horizon_minutes=horizon_slots * SLOT_MINUTES,
            samples=len(pairs),
            mae=mae,
            relative=mae / mean_actual if mean_actual > 0 else None,
        ),
        pairs,
    )
