"""KPI periods are calendar periods in the Plant's own zone. Pure — no database.

They used to be rolling: "today" was the last 24 hours, so at 08:00 in Kolkata
it was mostly yesterday's daylight, and "lifetime" was the last ten years, so a
two-day-old Plant's CUF was divided by ten years of capacity.
"""

from __future__ import annotations

from datetime import UTC, datetime
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
