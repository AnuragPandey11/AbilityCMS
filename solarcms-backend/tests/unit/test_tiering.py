"""Tier selection and rollup-column mapping. Pure — no database needed."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain.tiering import (
    Tier,
    bucket_start,
    estimated_points,
    select_tier,
    value_column,
)

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


class TestFinestTier:
    def test_a_reader_that_may_not_see_fine_tiers_gets_the_finest_it_may(self) -> None:
        # The scheduler may read agg_1h_v and agg_1d_v only. A one-day Report
        # would otherwise be sent to agg_1m_v and fail on permissions.
        from datetime import UTC, datetime, timedelta

        from solarcms.domain.tiering import Tier, select_tier

        now = datetime(2026, 9, 23, tzinfo=UTC)
        assert select_tier(now - timedelta(days=1), now, now) == Tier.AGG_1M
        assert select_tier(now - timedelta(days=1), now, now, finest=Tier.AGG_1H) == Tier.AGG_1H
        assert select_tier(
            now - timedelta(days=800), now, now, finest=Tier.AGG_1H) == Tier.AGG_1D


class TestBucketStart:
    """The aggregates bucket in UTC, so a floor lands on their boundaries."""

    AT = datetime(2026, 9, 21, 16, 26, 41, tzinfo=UTC)

    def test_minute(self) -> None:
        assert bucket_start(self.AT, Tier.AGG_1M) == datetime(2026, 9, 21, 16, 26, tzinfo=UTC)

    def test_hour(self) -> None:
        assert bucket_start(self.AT, Tier.AGG_1H) == datetime(2026, 9, 21, 16, tzinfo=UTC)

    def test_day_is_utc_midnight_not_the_plants(self) -> None:
        assert bucket_start(self.AT, Tier.AGG_1D) == datetime(2026, 9, 21, tzinfo=UTC)

    def test_a_boundary_is_its_own_bucket(self) -> None:
        on = datetime(2026, 9, 21, 16, tzinfo=UTC)
        assert bucket_start(on, Tier.AGG_15M) == on
