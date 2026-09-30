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
from datetime import UTC, date, datetime, time, timedelta, tzinfo

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


@dataclass(frozen=True, slots=True)
class ComparisonWindow:
    """The previous period, cut at the point the current one has reached.

    `end` is the same wall-clock distance into the previous period as `now` is
    into the current one: yesterday up to this time of day, last month up to
    this day and time. `measured_since` is the later of `start` and the Plant's
    first reading, which is what CUF's hours count from, as for the current
    period.
    """

    start: datetime
    end: datetime
    measured_since: datetime


def previous_window(
    period: str, now: datetime, zone: tzinfo, first_reading: datetime | None,
) -> ComparisonWindow | None:
    """The span a KPI is compared against: the previous period, to the same point.

    ⚠ Never the previous period *whole*. At 09:00 today's CUF counts nine hours
    of which three were daylight, and yesterday's full-day CUF counts all of
    yesterday's sun — so against the whole of yesterday every morning reads as
    a collapse. Cut at the same time of day, the two spans hold the same share
    of night and can be compared.

    Wall-clock, not elapsed seconds, so "the same hour" survives a DST change.
    A previous month shorter than the current one ends at its own last day
    rather than running into the current month (31 March compares against the
    whole of February).

    None for lifetime, which has no previous period, and for a Plant that had
    not reported before the window ended: there is nothing to compare with.
    """
    if period not in KPI_PERIODS:
        raise ValueError(f"unknown KPI period {period!r}")
    if period == "lifetime" or first_reading is None:
        return None
    current = period_start(period, now, zone, first_reading)
    if current is None:
        return None
    begins = current.astimezone(zone).replace(tzinfo=None)
    local_now = now.astimezone(zone).replace(tzinfo=None)
    if period == "today":
        previous = begins - timedelta(days=1)
    elif period == "month":
        previous = (begins - timedelta(days=1)).replace(day=1)
    else:
        previous = begins.replace(year=begins.year - 1)
    end_local = min(previous + (local_now - begins), begins)
    start = previous.replace(tzinfo=zone).astimezone(UTC)
    end = end_local.replace(tzinfo=zone).astimezone(UTC)
    since = max(start, first_reading)
    if since >= end:
        return None
    return ComparisonWindow(start, end, since)


# ── Report periods ──────────────────────────────────────────────────────────
#
# The Reports screen offers presets the way the client's reference does —
# today, yesterday, the last 7 or 30 days, or a custom range — and every preset
# is a run of whole days on the Plant's calendar. "Last 7 days" is today and
# the six days before it, so its first row is a full day and its last is the
# day in progress; a Report is never cut at a clock time the reader did not
# choose. A custom range may be: it names a first and last day and, if the
# reader wants, a time on each, on the Plant's own clock.
#
# The start time is the first moment in the Report and the end time the moment
# it stops, so 06:00 to 18:00 is twelve hours and reads the 15-minute slots
# exactly. 23:59, the latest a clock input can show, is the end of its day, and
# 00:00 at the end is the end of the day before: otherwise every whole day typed
# by hand would be a minute short of the same day chosen as Yesterday, or carry
# a row for a day the period never entered.

REPORT_PERIODS = ("today", "yesterday", "last_7_days", "last_30_days", "custom")

# The longest custom range, in days. A product limit rather than an assumption
# about the data: a year of days is 366 rows, and a per-day Report is read from
# the hourly tier (a daily bucket is cut at UTC midnight, not the Plant's), so
# the range bounds how many hourly rows one request reads.
MAX_REPORT_DAYS = 366


@dataclass(frozen=True, slots=True)
class ReportWindow:
    """A run of Plant-local days, and the UTC span that reads them.

    `end` is the local midnight after `last_day` — or `to_time` on it — or
    `now` while that is still to come: nothing after `now` has been measured,
    and a span that ran on to midnight would divide by hours that have not
    happened.

    `from_time` and `to_time` are the reader's own clock times, and None where
    that end is a whole day's edge — so a range of whole days, however it was
    asked for, is told apart from one cut inside a day.
    """

    period: str
    first_day: date
    last_day: date
    start: datetime
    end: datetime
    from_time: time | None = None
    to_time: time | None = None

    @property
    def days(self) -> list[date]:
        """Every local day in the window, first to last."""
        count = (self.last_day - self.first_day).days + 1
        return [self.first_day + timedelta(days=offset) for offset in range(count)]

    @property
    def timed(self) -> bool:
        """Whether either end falls inside a day rather than on its edge."""
        return self.from_time is not None or self.to_time is not None


def local_midnight(day: date, zone: tzinfo) -> datetime:
    """The UTC instant a Plant-local day begins."""
    return datetime(day.year, day.month, day.day, tzinfo=zone).astimezone(UTC)


def _local_instant(day: date, at: time, zone: tzinfo) -> datetime:
    return datetime.combine(day, at, tzinfo=zone).astimezone(UTC)


_MIDNIGHT = time(0, 0)
# The latest a clock input can show. "To 23:59" means to the end of the day.
_LAST_MINUTE = time(23, 59)


def report_window(
    period: str, now: datetime, zone: tzinfo,
    first_day: date | None = None, last_day: date | None = None,
    from_time: time | None = None, to_time: time | None = None,
) -> ReportWindow:
    """The days `period` covers on the Plant's calendar.

    A custom range may start at `from_time` on its first day and stop at
    `to_time` on its last, both the Plant's wall clock; either omitted is that
    day's edge. The presets ignore them, as they ignore the dates.

    Raises ValueError with a sentence for the reader — a custom range with no
    dates, backwards, longer than `MAX_REPORT_DAYS`, reaching past today, or
    starting after now.
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
    if period != "custom":
        from_time = to_time = None
    # A clock time names its minute; seconds would only make two requests for
    # the same Report differ. A time on a day's edge is stored as the edge.
    if from_time is not None:
        from_time = from_time.replace(second=0, microsecond=0, tzinfo=None)
        if from_time == _MIDNIGHT:
            from_time = None
    if to_time is not None:
        to_time = to_time.replace(second=0, microsecond=0, tzinfo=None)
        if to_time == _LAST_MINUTE:
            to_time = None
        elif to_time == _MIDNIGHT:
            last, to_time = last - timedelta(days=1), None
    start = (local_midnight(first, zone) if from_time is None
             else _local_instant(first, from_time, zone))
    stop = (local_midnight(last + timedelta(days=1), zone) if to_time is None
            else _local_instant(last, to_time, zone))
    if stop <= start:
        raise ValueError("the end is not after the start")
    if start >= now:
        raise ValueError(
            f"the period cannot start after now ({now.astimezone(zone):%H:%M} today)")
    end = min(stop, now.astimezone(UTC))
    return ReportWindow(period, first, last, start, end, from_time, to_time)
