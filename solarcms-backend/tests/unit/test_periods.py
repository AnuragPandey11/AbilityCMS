"""KPI periods are calendar periods in the Plant's own zone. Pure — no database.

They used to be rolling: "today" was the last 24 hours, so at 08:00 in Kolkata
it was mostly yesterday's daylight, and "lifetime" was the last ten years, so a
two-day-old Plant's CUF was divided by ten years of capacity.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

import pytest

from solarcms.domain import periods
from solarcms.domain.periods import measured_since, period_start, previous_window

KOLKATA = ZoneInfo("Asia/Kolkata")
DUBAI = ZoneInfo("Asia/Dubai")
LONDON = ZoneInfo("Europe/London")

# 08:00 in Kolkata on 23 Sep 2026.
MORNING = datetime(2026, 9, 23, 2, 30, tzinfo=UTC)


class TestToday:
    def test_begins_at_the_plants_midnight_not_24_hours_ago(self) -> None:
        # Kolkata's midnight is 18:30 UTC the day before.
        assert period_start("today", MORNING, KOLKATA, None) == datetime(
            2026, 9, 22, 18, 30, tzinfo=UTC)

    def test_follows_the_plants_zone_not_utc(self) -> None:
        assert period_start("today", MORNING, DUBAI, None) == datetime(
            2026, 9, 22, 20, 0, tzinfo=UTC)

    def test_a_minute_after_local_midnight_is_a_new_day(self) -> None:
        just_after = datetime(2026, 9, 22, 18, 31, tzinfo=UTC)
        assert period_start("today", just_after, KOLKATA, None) == datetime(
            2026, 9, 22, 18, 30, tzinfo=UTC)

    def test_uses_the_offset_in_force_on_the_day(self) -> None:
        # London in September is on BST, so its midnight is 23:00 UTC.
        noon = datetime(2026, 9, 23, 11, 0, tzinfo=UTC)
        assert period_start("today", noon, LONDON, None) == datetime(
            2026, 9, 22, 23, 0, tzinfo=UTC)


class TestMonthAndYear:
    def test_month_begins_on_the_first_at_local_midnight(self) -> None:
        assert period_start("month", MORNING, KOLKATA, None) == datetime(
            2026, 8, 31, 18, 30, tzinfo=UTC)

    def test_on_the_first_the_month_is_that_day(self) -> None:
        first = datetime(2026, 9, 30, 19, 0, tzinfo=UTC)  # 00:30 on 1 Oct, Kolkata
        assert period_start("month", first, KOLKATA, None) == datetime(
            2026, 9, 30, 18, 30, tzinfo=UTC)

    def test_year_is_the_calendar_year(self) -> None:
        assert period_start("year", MORNING, KOLKATA, None) == datetime(
            2025, 12, 31, 18, 30, tzinfo=UTC)

    def test_a_financial_year_is_one_constant_away(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(periods, "KPI_YEAR_START_MONTH", 4)
        february = datetime(2026, 2, 10, 6, 0, tzinfo=UTC)
        assert period_start("year", february, KOLKATA, None) == datetime(
            2025, 3, 31, 18, 30, tzinfo=UTC)
        assert period_start("year", MORNING, KOLKATA, None) == datetime(
            2026, 3, 31, 18, 30, tzinfo=UTC)


class TestLifetime:
    def test_begins_at_the_first_reading(self) -> None:
        first = datetime(2026, 9, 21, 16, 26, tzinfo=UTC)
        assert period_start("lifetime", MORNING, KOLKATA, first) == first

    def test_a_plant_that_never_reported_has_no_lifetime(self) -> None:
        assert period_start("lifetime", MORNING, KOLKATA, None) is None


def test_an_unknown_period_is_refused() -> None:
    with pytest.raises(ValueError):
        period_start("week", MORNING, KOLKATA, None)


class TestMeasuredSince:
    def test_a_plant_younger_than_the_period_is_measured_from_its_first_reading(self) -> None:
        # The fleet that read 0.24% CUF for the month beside 8.3% for the day.
        start = datetime(2026, 8, 31, 18, 30, tzinfo=UTC)
        first = datetime(2026, 9, 21, 16, 26, tzinfo=UTC)
        assert measured_since(start, first) == first

    def test_an_older_plant_is_measured_from_the_period_start(self) -> None:
        start = datetime(2026, 8, 31, 18, 30, tzinfo=UTC)
        first = datetime(2025, 1, 1, tzinfo=UTC)
        assert measured_since(start, first) == start

    def test_a_plant_that_never_reported_was_never_measured(self) -> None:
        assert measured_since(MORNING, None) is None


class TestPreviousWindow:
    """What a KPI is compared against: the previous period, cut at the same point."""

    OLD = datetime(2025, 1, 1, tzinfo=UTC)

    def test_today_compares_with_yesterday_up_to_the_same_time_of_day(self) -> None:
        # 08:00 in Kolkata on 23 Sep: yesterday from its midnight to 08:00.
        window = previous_window("today", MORNING, KOLKATA, self.OLD)
        assert window is not None
        assert window.start == datetime(2026, 9, 21, 18, 30, tzinfo=UTC)
        assert window.end == datetime(2026, 9, 22, 2, 30, tzinfo=UTC)
        assert window.measured_since == window.start

    def test_the_same_hour_survives_a_dst_change(self) -> None:
        # 10:00 BST on 30 Mar 2026, the day after the clocks went forward.
        # Yesterday's 10:00 was already BST too, but its midnight was GMT.
        now = datetime(2026, 3, 30, 9, 0, tzinfo=UTC)
        window = previous_window("today", now, LONDON, self.OLD)
        assert window is not None
        assert window.start == datetime(2026, 3, 29, 0, 0, tzinfo=UTC)
        assert window.end == datetime(2026, 3, 29, 9, 0, tzinfo=UTC)

    def test_month_compares_with_last_month_to_the_same_day_and_time(self) -> None:
        window = previous_window("month", MORNING, KOLKATA, self.OLD)
        assert window is not None
        assert window.start == datetime(2026, 7, 31, 18, 30, tzinfo=UTC)
        assert window.end == datetime(2026, 8, 23, 2, 30, tzinfo=UTC)

    def test_a_shorter_previous_month_ends_at_its_own_last_day(self) -> None:
        # 10:00 on 31 Mar compares against the whole of February, never 3 Mar.
        now = datetime(2026, 3, 31, 4, 30, tzinfo=UTC)
        window = previous_window("month", now, KOLKATA, self.OLD)
        assert window is not None
        assert window.start == datetime(2026, 1, 31, 18, 30, tzinfo=UTC)
        assert window.end == datetime(2026, 2, 28, 18, 30, tzinfo=UTC)

    def test_year_compares_with_last_year_to_the_same_date(self) -> None:
        window = previous_window("year", MORNING, KOLKATA, self.OLD)
        assert window is not None
        assert window.start == datetime(2024, 12, 31, 18, 30, tzinfo=UTC)
        assert window.end == datetime(2025, 9, 23, 2, 30, tzinfo=UTC)

    def test_lifetime_has_nothing_before_it(self) -> None:
        assert previous_window("lifetime", MORNING, KOLKATA, self.OLD) is None

    def test_a_plant_first_heard_today_has_no_yesterday(self) -> None:
        first = datetime(2026, 9, 22, 20, 0, tzinfo=UTC)
        assert previous_window("today", MORNING, KOLKATA, first) is None

    def test_a_plant_that_never_reported_has_no_comparison(self) -> None:
        assert previous_window("today", MORNING, KOLKATA, None) is None

    def test_a_plant_first_heard_inside_the_window_is_measured_from_then(self) -> None:
        # First heard at 05:30 yesterday: CUF's hours count from there.
        first = datetime(2026, 9, 22, 0, 0, tzinfo=UTC)
        window = previous_window("today", MORNING, KOLKATA, first)
        assert window is not None
        assert window.measured_since == first

    def test_an_unknown_period_is_refused(self) -> None:
        with pytest.raises(ValueError):
            previous_window("week", MORNING, KOLKATA, self.OLD)


class TestReportWindow:
    """The Reports screen's presets are runs of whole days on the Plant's calendar."""

    # 16:18 in Kolkata on 28 Sep 2026.
    NOW = datetime(2026, 9, 28, 10, 48, tzinfo=UTC)

    def test_today_runs_from_the_plants_midnight_to_now(self) -> None:
        window = periods.report_window("today", self.NOW, KOLKATA)
        assert window.first_day == window.last_day == date(2026, 9, 28)
        assert window.start == datetime(2026, 9, 27, 18, 30, tzinfo=UTC)
        # Not midnight tonight: nothing after now has been measured.
        assert window.end == self.NOW

    def test_yesterday_is_one_whole_local_day(self) -> None:
        window = periods.report_window("yesterday", self.NOW, KOLKATA)
        assert window.days == [date(2026, 9, 27)]
        assert window.start == datetime(2026, 9, 26, 18, 30, tzinfo=UTC)
        assert window.end == datetime(2026, 9, 27, 18, 30, tzinfo=UTC)

    def test_last_7_days_is_today_and_the_six_before(self) -> None:
        window = periods.report_window("last_7_days", self.NOW, KOLKATA)
        assert len(window.days) == 7
        assert window.first_day == date(2026, 9, 22)
        assert window.last_day == date(2026, 9, 28)

    def test_last_30_days(self) -> None:
        window = periods.report_window("last_30_days", self.NOW, KOLKATA)
        assert len(window.days) == 30
        assert window.first_day == date(2026, 8, 30)

    def test_the_day_is_the_plants_not_utcs(self) -> None:
        # 00:30 on 29 Sep in Kolkata is still the 28th in UTC.
        just_after = datetime(2026, 9, 28, 19, 0, tzinfo=UTC)
        assert periods.report_window("today", just_after, KOLKATA).first_day == date(2026, 9, 29)

    def test_custom_is_inclusive_of_both_days(self) -> None:
        window = periods.report_window(
            "custom", self.NOW, KOLKATA, date(2026, 9, 1), date(2026, 9, 3))
        assert window.days == [date(2026, 9, 1), date(2026, 9, 2), date(2026, 9, 3)]
        assert window.end == datetime(2026, 9, 3, 18, 30, tzinfo=UTC)

    def test_custom_ending_today_stops_at_now(self) -> None:
        window = periods.report_window(
            "custom", self.NOW, KOLKATA, date(2026, 9, 27), date(2026, 9, 28))
        assert window.end == self.NOW

    @pytest.mark.parametrize(("first", "last", "message"), [
        (None, date(2026, 9, 3), "needs both"),
        (date(2026, 9, 3), date(2026, 9, 1), "before the first"),
        (date(2026, 9, 1), date(2026, 9, 29), "after today"),
        (date(2025, 1, 1), date(2026, 9, 1), "at most"),
    ])
    def test_custom_refuses_with_a_sentence(
        self, first: date | None, last: date | None, message: str,
    ) -> None:
        with pytest.raises(ValueError, match=message):
            periods.report_window("custom", self.NOW, KOLKATA, first, last)

    def test_an_unknown_preset_is_refused(self) -> None:
        with pytest.raises(ValueError):
            periods.report_window("fortnight", self.NOW, KOLKATA)


class TestReportWindowTimes:
    """A custom range may start and stop at a clock time on the Plant's clock."""

    NOW = TestReportWindow.NOW

    def _custom(
        self, first: date, last: date, begins: time | None, ends: time | None,
    ) -> periods.ReportWindow:
        return periods.report_window("custom", self.NOW, KOLKATA, first, last, begins, ends)

    def test_runs_from_the_start_time_and_stops_at_the_end_time(self) -> None:
        window = self._custom(date(2026, 9, 22), date(2026, 9, 24), time(6, 0), time(18, 0))
        # 06:00 in Kolkata is 00:30 UTC; the period stops at 18:00, not a minute after.
        assert window.start == datetime(2026, 9, 22, 0, 30, tzinfo=UTC)
        assert window.end == datetime(2026, 9, 24, 12, 30, tzinfo=UTC)
        assert window.days == [date(2026, 9, 22), date(2026, 9, 23), date(2026, 9, 24)]
        assert (window.from_time, window.to_time) == (time(6, 0), time(18, 0))
        assert window.timed

    def test_00_00_to_23_59_is_the_same_whole_days_as_no_times(self) -> None:
        # The default a reader sees; a minute short would read differently
        # from the same day chosen as Yesterday.
        timed = self._custom(date(2026, 9, 27), date(2026, 9, 27), time(0, 0), time(23, 59))
        untimed = periods.report_window(
            "custom", self.NOW, KOLKATA, date(2026, 9, 27), date(2026, 9, 27))
        assert timed == untimed
        assert not timed.timed

    def test_stopping_at_midnight_ends_the_day_before(self) -> None:
        window = self._custom(date(2026, 9, 22), date(2026, 9, 24), time(6, 0), time(0, 0))
        # No row for the 24th, which the period never entered.
        assert window.last_day == date(2026, 9, 23)
        assert window.end == datetime(2026, 9, 23, 18, 30, tzinfo=UTC)
        assert window.to_time is None

    def test_an_end_later_today_stops_at_now(self) -> None:
        window = self._custom(date(2026, 9, 28), date(2026, 9, 28), time(6, 0), time(20, 0))
        assert window.end == self.NOW

    def test_seconds_are_dropped(self) -> None:
        window = self._custom(date(2026, 9, 24), date(2026, 9, 24),
                              time(6, 0, 30), time(18, 0, 59))
        assert (window.from_time, window.to_time) == (time(6, 0), time(18, 0))

    def test_the_presets_ignore_times(self) -> None:
        window = periods.report_window("yesterday", self.NOW, KOLKATA, None, None,
                                       time(6, 0), time(18, 0))
        assert not window.timed
        assert window.start == datetime(2026, 9, 26, 18, 30, tzinfo=UTC)

    @pytest.mark.parametrize(("first", "last", "begins", "ends", "message"), [
        (date(2026, 9, 24), date(2026, 9, 24), time(18, 0), time(6, 0), "not after the start"),
        (date(2026, 9, 24), date(2026, 9, 24), time(6, 0), time(6, 0), "not after the start"),
        (date(2026, 9, 24), date(2026, 9, 24), time(6, 0), time(0, 0), "not after the start"),
        # 16:18 now; a period cannot open on a minute that has not happened.
        (date(2026, 9, 28), date(2026, 9, 28), time(17, 0), None, r"after now \(16:18"),
    ])
    def test_refuses_with_a_sentence(
        self, first: date, last: date, begins: time | None, ends: time | None, message: str,
    ) -> None:
        with pytest.raises(ValueError, match=message):
            self._custom(first, last, begins, ends)
