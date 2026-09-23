"""Which aggregate tier serves a given time range. Pure — no I/O.

BACKEND_SPEC §9. Pick the **coarsest** tier that both covers the requested range
and still retains it. Coarsest, not finest: a year of 1-minute rows is 525,600
points per Tag, which no chart can draw and no browser should receive.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import StrEnum
from typing import Final, NamedTuple


class Tier(StrEnum):
    """Relation names. The `_v` barrier views are what the API actually reads —
    see migration 0008; the raw names here are resolved by the read path."""

    READINGS = "readings"
    AGG_1M = "agg_1m"
    AGG_15M = "agg_15m"
    AGG_1H = "agg_1h"
    AGG_1D = "agg_1d"


class TierSpec(NamedTuple):
    tier: Tier
    # Longest range this tier should be asked to serve.
    max_range: timedelta
    # How far back the tier still holds data — its retention (BACKEND_SPEC §5.3).
    retention: timedelta
    resolution: timedelta


# Ordered finest to coarsest. Retentions mirror migration 0005; if one changes,
# both must, which is why they are stated here rather than inferred.
TIERS: Final[tuple[TierSpec, ...]] = (
    TierSpec(Tier.READINGS, timedelta(hours=6), timedelta(days=30), timedelta(seconds=1)),
    TierSpec(Tier.AGG_1M, timedelta(days=2), timedelta(days=365), timedelta(minutes=1)),
    TierSpec(Tier.AGG_15M, timedelta(days=14), timedelta(days=3 * 365), timedelta(minutes=15)),
    TierSpec(Tier.AGG_1H, timedelta(days=365), timedelta(days=10 * 365), timedelta(hours=1)),
    TierSpec(Tier.AGG_1D, timedelta.max, timedelta(days=10 * 365), timedelta(days=1)),
)


def select_tier(
    start: datetime, end: datetime, now: datetime, *, finest: Tier = Tier.READINGS,
) -> Tier:
    """Coarsest tier that both covers the range and still retains it.

        range ≤ 6h  and within 30d → readings
        range ≤ 2d  and within 1y  → agg_1m
        range ≤ 14d and within 3y  → agg_15m
        range ≤ 1y                 → agg_1h
        otherwise                  → agg_1d

    Retention is checked against `start`, not `end`: a query for a six-hour window
    two months ago is short, but raw data for it was dropped at thirty days, so it
    must be served from an aggregate.

    `finest` is the finest tier the *reader* may use. The scheduler, which renders
    Reports, holds SELECT on `agg_1h_v` and `agg_1d_v` only (and Reports never
    read raw), so it passes `Tier.AGG_1H` and a one-day Report reads hourly rows
    instead of failing on a view it cannot see.
    """
    if end < start:
        start, end = end, start
    span = end - start
    age = now - start

    allowed = TIERS[[spec.tier for spec in TIERS].index(finest):]
    for spec in allowed:
        if span <= spec.max_range and age <= spec.retention:
            return spec.tier
    return Tier.AGG_1D


def value_column(rollup_method: str) -> str:
    """The aggregate column matching a Tag's rollup method.

    A continuous aggregate cannot branch on `tags.rollup_method`, so all of
    avg/min/max/last are stored and the read path selects — the mapping is data,
    not code. Averaging a cumulative energy counter is meaningless, which is what
    `last` exists for.
    """
    return {"avg": "avg_value", "last": "last_value", "max": "max_value"}.get(
        rollup_method, "avg_value"
    )


def estimated_points(start: datetime, end: datetime, tier: Tier) -> int:
    """Rows one Tag would return from `tier` over the range. Used to refuse a
    query that would return an unusable number of points before running it."""
    resolution = next(s.resolution for s in TIERS if s.tier == tier)
    if resolution <= timedelta(0):
        return 0
    return max(0, int((end - start) / resolution))
