"""How a custom report is read: which tier serves it, and how each column is summarised.

A custom report is any Devices' readings at any interval the client picks.
Two rules keep it honest and cheap:

* **The interval is built from a tier that divides it.** A multiple of 15
  minutes reads the 15-minute tier, anything else the 1-minute tier — never the
  hourly or daily tier, whose buckets are cut on UTC hours and UTC midnight and
  so start at :30 and 05:30 on a Kolkata clock (CLAUDE.md, the Reports note).
  Every interval therefore starts on the Plant's own clock.
* **A report too big to read is refused with the reason, before anything is
  read** — the number of cells, and the rows the database would have to visit —
  so the reader is told to choose a longer interval or fewer readings rather
  than left waiting on a request that times out.

Each column is summarised the way its reading is meant to be (`auto`): a
register at its last value, a reading whose roll-up is the maximum at its
maximum, everything else as the mean. "Change" is how far a register advanced
in each interval — energy per interval from a lifetime or daily counter — and
applies to registers only; a non-register column keeps its own summary and the
report says so.

Pure (Guardrail 9).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

# A report has at most this many cells (rows by columns): beyond it a table is
# not something a person reads, and an Excel file of it is not something a
# laptop opens quickly.
MAX_CELLS = 200_000
# ...and the database visits at most this many aggregate rows to make one.
MAX_SOURCE_ROWS = 2_000_000
# How long each tier keeps its rows (CLAUDE.md, "Retention is a tier cascade").
TIER_RETENTION = {"agg_1m": timedelta(days=365), "agg_15m": timedelta(days=3 * 365)}
TIER_MINUTES = {"agg_1m": 1, "agg_15m": 15}

Summary = str  # "avg" | "min" | "max" | "last" | "change"


class ReportTooLarge(ValueError):
    """A plan the server refuses, with a sentence the reader can act on."""


@dataclass(frozen=True, slots=True)
class ReportPlan:
    tier: str
    interval: timedelta
    rows: int
    cells: int


def plan(
    interval_minutes: int, start: datetime, end: datetime, columns: int, now: datetime,
) -> ReportPlan:
    """The tier and the size of a report, or `ReportTooLarge` saying why not."""
    if end <= start:
        raise ReportTooLarge("The period has not started yet, so there is nothing to report.")
    tier = "agg_15m" if interval_minutes % 15 == 0 else "agg_1m"
    interval = timedelta(minutes=interval_minutes)
    span = end - start
    rows = math.ceil(span / interval)
    cells = rows * columns
    if cells > MAX_CELLS:
        raise ReportTooLarge(
            f"That is {rows:,} rows by {columns} column{'s' if columns != 1 else ''} — more "
            "than one report can hold "
            f"({MAX_CELLS:,} values). Choose a longer interval, a shorter period, "
            "or fewer readings."
        )
    source_rows = columns * span / timedelta(minutes=TIER_MINUTES[tier])
    if source_rows > MAX_SOURCE_ROWS:
        raise ReportTooLarge(
            f"At {interval_minutes}-minute intervals this period needs minute-by-minute "
            "data for every column. Choose an interval of 15 minutes or more, or a shorter period."
        )
    if start < now - TIER_RETENTION[tier]:
        raise ReportTooLarge(
            "Minute-by-minute readings are kept for a year. For a period that reaches "
            "further back, choose an interval of 15 minutes or more."
            if tier == "agg_1m" else
            "15-minute readings are kept for three years; this period reaches further back."
        )
    return ReportPlan(tier=tier, interval=interval, rows=rows, cells=cells)


def summary_for(rollup_method: str, is_cumulative: bool, aggregation: str) -> Summary:
    """How one column is summarised per interval, given the reader's choice."""
    register = is_cumulative or rollup_method == "last"
    if aggregation == "change":
        return "change" if is_cumulative else _auto(rollup_method, register)
    if aggregation == "auto":
        return _auto(rollup_method, register)
    return aggregation


def _auto(rollup_method: str, register: bool) -> Summary:
    if register:
        return "last"
    if rollup_method in ("max", "min"):
        return rollup_method
    return "avg"


def changes(lasts: Sequence[float | None], firsts: Sequence[float | None]) -> list[float | None]:
    """How far a register advanced in each interval.

    From the previous interval's last reading to this one's; for the first
    interval, from its own first reading. A backwards step (a rollover, a reset
    or a replaced meter — OPEN-14) is never counted as negative energy: it is
    left undefined. A missing interval breaks the chain rather than lumping the
    gap's advance into the next interval.
    """
    out: list[float | None] = []
    previous: float | None = None
    for index, last in enumerate(lasts):
        start = previous if index > 0 else firsts[index] if index < len(firsts) else None
        if last is None or start is None:
            out.append(None)
        else:
            step = last - start
            out.append(step if step >= 0 else None)
        previous = last
    return out


LABELS = {
    "avg": "average", "min": "lowest reading", "max": "highest reading",
    "last": "last reading", "change": "change over each interval",
}
