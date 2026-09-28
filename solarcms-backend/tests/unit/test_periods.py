"""KPI periods are calendar periods in the Plant's own zone. Pure — no database.

They used to be rolling: "today" was the last 24 hours, so at 08:00 in Kolkata
it was mostly yesterday's daylight, and "lifetime" was the last ten years, so a
two-day-old Plant's CUF was divided by ten years of capacity.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

import pytest

from solarcms.domain import periods
from solarcms.domain.periods import measured_since, period_start

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
