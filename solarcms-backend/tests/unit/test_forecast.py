"""The forecast method (domain/forecast.py): history only, never an invented value."""

from __future__ import annotations

import math
from datetime import date, timedelta

import pytest

from solarcms.domain import forecast as f
from solarcms.domain.assumptions import FORECAST_CLEARNESS_CAP, FORECAST_PERSISTENCE_HOURS

DAY0 = date(2026, 10, 1)


def bell(peak: float) -> list[float | None]:
    """A clear day: zero at night, a half-sine from 06:00 to 18:00 peaking at noon."""
    values: list[float | None] = []
    for slot in range(f.SLOTS_PER_DAY):
        hour = slot * f.SLOT_MINUTES / 60
        values.append(peak * math.sin(math.pi * (hour - 6) / 12) if 6 <= hour <= 18 else 0.0)
    return values


def days(peaks: list[float]) -> dict[date, list[float | None]]:
    return {DAY0 + timedelta(days=i): bell(p) for i, p in enumerate(peaks)}


NOON = 12 * 4


class TestQuantile:
    def test_interpolates_between_ranks(self) -> None:
        assert f.quantile([0.0, 10.0], 0.5) == 5.0
        assert f.quantile([3.0, 1.0, 2.0], 0.5) == 2.0
        assert f.quantile([1.0, 2.0, 3.0, 4.0, 5.0], 0.9) == pytest.approx(4.6)

    def test_refuses_nothing(self) -> None:
        with pytest.raises(ValueError):
            f.quantile([], 0.5)


class TestProfile:
    def test_typical_is_the_median_and_envelope_a_high_quantile(self) -> None:
        profile = f.build_profile(days([100, 200, 300, 400, 500]))
        assert profile.typical[NOON] == pytest.approx(300)
        assert profile.envelope[NOON] == pytest.approx(460)
        assert profile.low[NOON] <= profile.typical[NOON] <= profile.high[NOON]  # type: ignore[operator]
        assert profile.days == 5

    def test_a_time_of_day_seen_too_rarely_is_undefined_not_zero(self) -> None:
        history = days([100, 200])
        profile = f.build_profile(history, min_days=3)
        assert profile.typical[NOON] is None
        assert profile.envelope[NOON] is None

    def test_gaps_in_a_day_are_skipped(self) -> None:
        history = days([100, 200, 300, 400])
        history[DAY0][NOON] = None
        profile = f.build_profile(history, min_days=3)
        assert profile.typical[NOON] == pytest.approx(300)

    def test_history_window_takes_the_latest_days_before(self) -> None:
        history = days([1, 2, 3, 4, 5])
        history[DAY0 + timedelta(days=3)] = [None] * f.SLOTS_PER_DAY
        window = f.history_window(history, DAY0 + timedelta(days=4), length=2)
        assert sorted(window) == [DAY0 + timedelta(days=1), DAY0 + timedelta(days=2)]


class TestClearness:
    profile = f.build_profile(days([400] * 10))

    def test_a_dull_moment_reads_below_one(self) -> None:
        assert f.clearness([(NOON - 1, 200.0), (NOON, 200.0)], self.profile) == pytest.approx(
            0.5, abs=0.01)

    def test_undefined_at_night(self) -> None:
        assert f.clearness([(2, 0.0), (3, 0.0)], self.profile) is None

    def test_capped(self) -> None:
        assert f.clearness([(NOON, 4000.0)], self.profile) == FORECAST_CLEARNESS_CAP

    def test_undefined_with_no_history(self) -> None:
        empty = f.build_profile({})
        assert f.clearness([(NOON, 100.0)], empty) is None


class TestForecastAt:
    profile = f.build_profile(days([400] * 10))

    def test_carries_brightness_now_and_falls_back_to_typical_later(self) -> None:
        near = f.forecast_at(self.profile, 0.5, NOON, 0.25)
        far = f.forecast_at(self.profile, 0.5, NOON, FORECAST_PERSISTENCE_HOURS)
        assert near is not None and far is not None
        assert near < far
        assert far == pytest.approx(400)

    def test_without_a_ratio_is_the_typical_day(self) -> None:
        assert f.forecast_at(self.profile, None, NOON, 0.0) == pytest.approx(400)

    def test_never_above_the_cap(self) -> None:
        assert f.forecast_at(self.profile, 1.2, NOON, 0.0, cap=300.0) == 300.0

    def test_follows_a_meter_importing_at_night(self) -> None:
        history = {DAY0 + timedelta(days=i): [-5.7] * f.SLOTS_PER_DAY for i in range(4)}
        assert f.forecast_at(f.build_profile(history), None, 2, 0.25) == pytest.approx(-5.7)

    def test_undefined_where_history_is(self) -> None:
        thin = f.build_profile(days([400]), min_days=3)
        assert f.forecast_at(thin, 1.0, NOON, 0.0) is None


class TestDailyEnergy:
    def test_median_of_recent_complete_days(self) -> None:
        totals = {DAY0 + timedelta(days=i): float(v) for i, v in enumerate([10, 20, 30, 40])}
        estimate = f.daily_energy(totals, DAY0 + timedelta(days=4))
        assert estimate is not None
        assert estimate.value == 25.0
        assert estimate.low <= estimate.value <= estimate.high
        assert estimate.days == 4

    def test_too_few_days_is_no_estimate(self) -> None:
        assert f.daily_energy({DAY0: 10.0, DAY0 + timedelta(days=1): 12.0},
                              DAY0 + timedelta(days=5)) is None

    def test_only_days_before(self) -> None:
        totals = {DAY0 + timedelta(days=i): float(i) for i in range(6)}
        estimate = f.daily_energy(totals, DAY0 + timedelta(days=3))
        assert estimate is not None and estimate.days == 3


class TestBacktest:
    def test_a_steady_plant_is_forecast_almost_exactly(self) -> None:
        history = days([400] * 20)
        checked = [DAY0 + timedelta(days=i) for i in range(15, 20)]
        accuracy, pairs = f.backtest(history, checked, horizon_slots=1)
        assert accuracy.samples == len(pairs) > 0
        assert accuracy.mae is not None and accuracy.mae < 1.0
        assert accuracy.horizon_minutes == 15

    def test_uses_only_what_was_known_before(self) -> None:
        # A first day with no earlier history cannot be checked at all.
        history = days([400] * 3)
        accuracy, pairs = f.backtest(history, [DAY0], horizon_slots=4)
        assert pairs == []
        assert accuracy.mae is None and accuracy.samples == 0

    def test_night_is_never_scored(self) -> None:
        history = days([400] * 20)
        _, pairs = f.backtest(history, [DAY0 + timedelta(days=19)], horizon_slots=1)
        assert all(6 * 4 <= slot <= 18 * 4 for _, slot, _, _ in pairs)


def register_day(start: int, end: int, last: int, total: float = 100.0) -> list[f.RegisterBucket]:
    """A register read from slot `start` to `last`, rising evenly until `end`."""
    out: list[f.RegisterBucket] = []
    for slot in range(start, last + 1):
        lo = total * max(0, min(slot, end) - start) / max(1, end - start)
        hi = total * max(0, min(slot + 1, end) - start) / max(1, end - start)
        out.append((slot, lo, hi if slot < end else lo))
    return out


class TestRegisterDayTotals:
    EVENING = 18 * 4

    def test_a_day_seen_to_its_end_counts(self) -> None:
        totals = f.register_day_totals(
            {DAY0: register_day(24, self.EVENING, 95)}, settled_slots=4)
        assert totals == {DAY0: pytest.approx(100.0)}

    def test_a_day_cut_short_is_left_out(self) -> None:
        full = {DAY0 + timedelta(days=i): register_day(24, self.EVENING, 95) for i in range(3)}
        # Readings stop at 13:00 after an hour of no rise: settled, but early.
        full[DAY0 + timedelta(days=3)] = register_day(24, 48, 52, total=40.0)
        totals = f.register_day_totals(full, settled_slots=4)
        assert DAY0 + timedelta(days=3) not in totals
        assert len(totals) == 3

    def test_a_day_of_night_readings_is_not_a_day_of_nothing(self) -> None:
        days = {DAY0: register_day(24, self.EVENING, 95),
                DAY0 + timedelta(days=1): [(0, 0.0, 0.0), (1, 0.0, 0.0), (8, 0.0, 0.0)]}
        assert list(f.register_day_totals(days, settled_slots=4)) == [DAY0]

    def test_still_rising_at_the_last_reading_is_left_out(self) -> None:
        assert f.register_day_totals({DAY0: register_day(24, 60, 60)}, settled_slots=4) == {}

    def test_readings_that_begin_after_generation_carry_the_total(self) -> None:
        days = {DAY0 + timedelta(days=i): register_day(24, self.EVENING, 95) for i in range(3)}
        days[DAY0 + timedelta(days=3)] = [(80, 90.0, 90.0), (90, 90.0, 90.0)]
        totals = f.register_day_totals(days, settled_slots=4)
        assert totals[DAY0 + timedelta(days=3)] == 90.0

    def test_a_restart_inside_the_day_belongs_to_the_day_after_it(self) -> None:
        carried = [(0, 120.0, 120.0), (10, 120.0, 120.0)]
        days = {DAY0: carried + register_day(24, self.EVENING, 95)}
        assert f.register_day_totals(days, settled_slots=4)[DAY0] == pytest.approx(100.0)

    def test_a_small_dip_is_not_a_restart(self) -> None:
        # One Inverter of a summed figure going quiet late in the day.
        day = register_day(24, self.EVENING, 95)
        dipped = [(slot, lo * 0.94, hi * 0.94) if slot > 80 else (slot, lo, hi)
                  for slot, lo, hi in day]
        assert f.register_day_totals({DAY0: dipped}, settled_slots=4)[DAY0] == pytest.approx(100.0)
