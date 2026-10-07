"""How a custom report is planned and summarised (domain/custom_reports.py)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solarcms.domain import custom_reports as c

NOW = datetime(2026, 10, 8, 12, tzinfo=UTC)
DAY = timedelta(days=1)


class TestPlan:
    def test_a_multiple_of_15_minutes_reads_the_15_minute_tier(self) -> None:
        for minutes in (15, 30, 60, 1440):
            assert c.plan(minutes, NOW - DAY, NOW, 4, NOW).tier == "agg_15m"

    def test_anything_else_reads_the_minute_tier(self) -> None:
        for minutes in (1, 5, 10, 20):
            assert c.plan(minutes, NOW - DAY, NOW, 4, NOW).tier == "agg_1m"

    def test_rows_and_cells(self) -> None:
        report = c.plan(60, NOW - DAY, NOW, 3, NOW)
        assert report.rows == 24
        assert report.cells == 72
        assert report.interval == timedelta(hours=1)

    def test_a_part_interval_still_makes_a_row(self) -> None:
        assert c.plan(60, NOW - timedelta(minutes=90), NOW, 1, NOW).rows == 2

    def test_refuses_too_many_cells_with_a_sentence(self) -> None:
        with pytest.raises(c.ReportTooLarge, match="longer interval"):
            c.plan(1, NOW - 30 * DAY, NOW, 10, NOW)

    def test_refuses_too_much_minute_data(self) -> None:
        # 20 rows of a day each, few cells, but a year of minute rows per column.
        with pytest.raises(c.ReportTooLarge, match="15 minutes or more"):
            c.plan(1440 - 1, NOW - 300 * DAY, NOW, 10, NOW)

    def test_refuses_beyond_retention(self) -> None:
        with pytest.raises(c.ReportTooLarge, match="kept for a year"):
            c.plan(1439, NOW - 400 * DAY, NOW, 1, NOW)

    def test_refuses_a_period_not_yet_started(self) -> None:
        with pytest.raises(c.ReportTooLarge):
            c.plan(15, NOW, NOW, 1, NOW)


class TestSummary:
    def test_auto_follows_the_reading(self) -> None:
        assert c.summary_for("avg", False, "auto") == "avg"
        assert c.summary_for("max", False, "auto") == "max"
        assert c.summary_for("last", False, "auto") == "last"
        assert c.summary_for("avg", True, "auto") == "last"

    def test_change_only_for_registers(self) -> None:
        assert c.summary_for("last", True, "change") == "change"
        assert c.summary_for("avg", False, "change") == "avg"

    def test_an_explicit_choice_is_kept(self) -> None:
        assert c.summary_for("avg", False, "max") == "max"
        assert c.summary_for("last", True, "min") == "min"


class TestChanges:
    def test_each_interval_advances_from_the_previous_last(self) -> None:
        assert c.changes([10.0, 15.0, 15.0, 22.0], [8.0, 11.0, 15.0, 16.0]) == [
            2.0, 5.0, 0.0, 7.0]

    def test_a_missing_interval_breaks_the_chain(self) -> None:
        assert c.changes([10.0, None, 20.0], [9.0, None, 18.0]) == [1.0, None, None]

    def test_a_backwards_step_is_undefined_never_negative(self) -> None:
        assert c.changes([100.0, 3.0, 5.0], [90.0, 1.0, 3.0]) == [10.0, None, 2.0]
