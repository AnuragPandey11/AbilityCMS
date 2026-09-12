"""Tier selection and rollup-column mapping. Pure — no database needed."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain.tiering import Tier, estimated_points, select_tier, value_column

NOW = datetime(2026, 9, 11, 12, tzinfo=UTC)


class TestTierSelection:
    def test_short_recent_range_uses_raw(self) -> None:
        now = datetime(2026, 9, 11, 12, tzinfo=UTC)
        assert select_tier(now - timedelta(hours=2), now, now) is Tier.READINGS

    def test_a_short_range_two_months_ago_cannot_use_raw(self) -> None:
        # Raw is dropped at 30 days, so age decides even when the span is small.
        now = datetime(2026, 9, 11, 12, tzinfo=UTC)
        start = now - timedelta(days=60)
        assert select_tier(start, start + timedelta(hours=2), now) is not Tier.READINGS

    def test_a_year_uses_the_daily_tier(self) -> None:
        now = datetime(2026, 9, 11, 12, tzinfo=UTC)
        assert select_tier(now - timedelta(days=400), now, now) is Tier.AGG_1D

    def test_rollup_method_maps_to_the_right_column(self) -> None:
        assert value_column("avg") == "avg_value"
        assert value_column("last") == "last_value"   # cumulative counters
        assert value_column("max") == "max_value"     # peaks

    def test_reversed_range_is_normalised(self) -> None:
        # A caller passing from/to backwards gets the same tier, not an error:
        # the range they described is unambiguous even when the order is not.
        assert select_tier(NOW, NOW - timedelta(hours=2), NOW) is Tier.READINGS

    def test_point_estimate_scales_with_the_tier(self) -> None:
        # Used to refuse a query that would return an unusable number of points
        # before it runs, rather than after.
        span_start, span_end = NOW - timedelta(days=1), NOW
        assert (estimated_points(span_start, span_end, Tier.AGG_1M)
                > estimated_points(span_start, span_end, Tier.AGG_1H))
        assert estimated_points(span_start, span_end, Tier.AGG_1D) == 1
