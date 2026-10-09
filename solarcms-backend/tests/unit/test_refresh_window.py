"""Which window of aggregates a back-fill may rebuild.

A refresh rebuilds the window for every Device from raw rows, and raw rows are
kept 30 days; rebuilding further back would delete every other Device's
aggregates there. Found 9 Oct 2026: back-filled rows were never aggregated.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solarcms.services.backfill import REFRESHABLE_DAYS, refresh_window

NOW = datetime(2026, 10, 9, 12, 30, tzinfo=UTC)


def test_whole_days_around_the_replayed_span() -> None:
    start, end = refresh_window(datetime(2026, 10, 7, 9, 15, tzinfo=UTC),
                                datetime(2026, 10, 7, 18, 0, tzinfo=UTC), NOW)
    assert (start, end) == (datetime(2026, 10, 7, tzinfo=UTC), datetime(2026, 10, 8, tzinfo=UTC))


def test_never_beyond_raw_retention() -> None:
    start, _end = refresh_window(NOW - timedelta(days=40), NOW - timedelta(days=1), NOW)
    assert start >= NOW - timedelta(days=REFRESHABLE_DAYS)


def test_a_span_entirely_older_than_retention_is_refused() -> None:
    with pytest.raises(ValueError, match="older than raw retention"):
        refresh_window(NOW - timedelta(days=45), NOW - timedelta(days=35), NOW)


def test_never_past_now() -> None:
    _start, end = refresh_window(NOW - timedelta(hours=2), NOW, NOW)
    assert end == NOW
