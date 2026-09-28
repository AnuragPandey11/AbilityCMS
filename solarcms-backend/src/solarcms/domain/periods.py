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

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, tzinfo

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


# ── Report periods ──────────────────────────────────────────────────────────
#
# The Reports screen offers presets the way the client's reference does —
# today, yesterday, the last 7 or 30 days, or a custom range of dates — and
# every one of them is a run of whole days on the Plant's calendar. "Last 7
# days" is today and the six days before it, so its first row is a full day and
# its last is the day in progress; a Report is never cut at a clock time the
# reader did not choose.

REPORT_PERIODS = ("today", "yesterday", "last_7_days", "last_30_days", "custom")

# The longest custom range, in days. A product limit rather than an assumption
# about the data: a year of days is 366 rows, and a per-day Report is read from
# the hourly tier (a daily bucket is cut at UTC midnight, not the Plant's), so
# the range bounds how many hourly rows one request reads.
MAX_REPORT_DAYS = 366


@dataclass(frozen=True, slots=True)
class ReportWindow:
    """A run of Plant-local days, and the UTC span that reads them.

    `end` is the local midnight after `last_day`, or `now` while that day is
    still in progress — nothing after `now` has been measured, and a span that
    ran on to midnight would divide by hours that have not happened.
    """

    period: str
    first_day: date
    last_day: date
    start: datetime
    end: datetime

    @property
    def days(self) -> list[date]:
        """Every local day in the window, first to last."""
        count = (self.last_day - self.first_day).days + 1
        return [self.first_day + timedelta(days=offset) for offset in range(count)]


def local_midnight(day: date, zone: tzinfo) -> datetime:
    """The UTC instant a Plant-local day begins."""
    return datetime(day.year, day.month, day.day, tzinfo=zone).astimezone(UTC)


def report_window(
    period: str, now: datetime, zone: tzinfo,
    first_day: date | None = None, last_day: date | None = None,
) -> ReportWindow:
    """The days `period` covers on the Plant's calendar.

    Raises ValueError with a sentence for the reader — a custom range with no
    dates, backwards, longer than `MAX_REPORT_DAYS`, or reaching past today.
    """
    if period not in REPORT_PERIODS:
        raise ValueError(f"unknown report period {period!r}")
    today = now.astimezone(zone).date()
    if period == "today":
        first, last = today, today
    elif period == "yesterday":
        first = last = today - timedelta(days=1)
    elif period == "last_7_days":
        first, last = today - timedelta(days=6), today
    elif period == "last_30_days":
        first, last = today - timedelta(days=29), today
    else:
        if first_day is None or last_day is None:
            raise ValueError("a custom period needs both a first and a last day")
        if last_day < first_day:
            raise ValueError("the last day is before the first")
        if last_day > today:
            # Nothing has been measured there, and a row for it would read as
            # a day the Plant made nothing.
            raise ValueError(f"the last day cannot be after today ({today.isoformat()})")
        if (last_day - first_day).days + 1 > MAX_REPORT_DAYS:
            raise ValueError(f"a custom period is at most {MAX_REPORT_DAYS} days")
        first, last = first_day, last_day
    start = local_midnight(first, zone)
    end = min(local_midnight(last + timedelta(days=1), zone), now.astimezone(UTC))
    return ReportWindow(period, first, last, start, end)
