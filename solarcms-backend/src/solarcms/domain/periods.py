"""The span a KPI period covers, in the Plant's own calendar. Pure — no I/O.

"Today" at a Plant in Kolkata began at the Plant's midnight, which is 18:30 UTC
the day before — not twenty-four hours ago, and not at UTC midnight. The
periods used to be rolling (the last 24 hours, 30 days, 365 days, 3,650 days),
so at 08:00 "today's" PR was mostly yesterday's daylight, "month" was never the
month on the screen's own register tiles, and "lifetime" divided a two-day-old
Plant's CUF by ten years of capacity.

The zone is passed in rather than looked up: constructing a `ZoneInfo` reads
the tz database, which is I/O (Guardrail 9).
"""

from __future__ import annotations

from datetime import UTC, datetime, tzinfo

from solarcms.domain.assumptions import KPI_YEAR_START_MONTH

KPI_PERIODS = ("today", "month", "year", "lifetime")


def period_start(
    period: str, now: datetime, zone: tzinfo, first_reading: datetime | None,
) -> datetime | None:
    """Where `period` began, in UTC.

    Calendar periods begin at the Plant's local midnight — today's, the 1st of
    this month's, the first day of this year's (`KPI_YEAR_START_MONTH`).
    "Lifetime" begins at the Plant's first reading, and is None for a Plant
    that has never reported: it has no lifetime to speak of yet.
    """
    if period not in KPI_PERIODS:
        raise ValueError(f"unknown KPI period {period!r}")
    if period == "lifetime":
        return first_reading
    local = now.astimezone(zone)
    if period == "today":
        begins = datetime(local.year, local.month, local.day, tzinfo=zone)
    elif period == "month":
        begins = datetime(local.year, local.month, 1, tzinfo=zone)
    else:
        year = local.year if local.month >= KPI_YEAR_START_MONTH else local.year - 1
        begins = datetime(year, KPI_YEAR_START_MONTH, 1, tzinfo=zone)
    return begins.astimezone(UTC)


def measured_since(start: datetime | None, first_reading: datetime | None) -> datetime | None:
    """The later of the period's start and the Plant's first reading.

    This is the span the Plant could have been measured in, and it is what CUF
    divides by. A Plant first heard two days ago was not idle for the other
    twenty-eight days of the month — it did not exist to us, and charging those
    hours against it made a month's CUF read 0.24% beside a day's 8.3%.
    """
    if start is None or first_reading is None:
        return None
    return max(start, first_reading)
