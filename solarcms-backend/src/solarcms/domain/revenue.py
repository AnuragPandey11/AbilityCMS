"""Revenue: exported energy times the Plant's tariff, and what it is expected to be.

Pure — no I/O (Guardrail 9). `services/revenue.py` reads the registers, the
forecast and the Inverter ranking and hands the numbers here. ⚠ Every rule is
PROPOSED (the user's choices of 1 Nov 2026):

* **Revenue** is export times tariff. Export comes from the ABT Meter where the
  Plant has one, else the MFM — and a figure from the MFM is an *estimate*,
  never settlement (I-11 keeps Financial Reports on the ABT Meter alone).
* **Expected** is the revenue so far plus the forecast of what is left of the
  period times tariff: the rest of today from the Plant's own forecast power curve,
  and each whole day after today at its typical day's energy
  (`services/forecast.py`, the Plant's last 14 days). It cannot foresee a
  cloudy month, and says so.
* **Loss** is the Inverter ranking's: rated AC kW times hours down times tariff, a
  ceiling (`domain/inverter_ranking`).

A missing input yields None with a reason, never 0.0: "earned nothing" and
"nothing to read" mean opposite things.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from solarcms.domain.assumptions import REVENUE_SETTLEMENT_TYPE, REVENUE_YEAR_START_MONTH

SETTLEMENT = "settlement"
ESTIMATE = "estimate"


def financial_year_start(day: date, start_month: int = REVENUE_YEAR_START_MONTH) -> date:
    """The first day of the financial year `day` falls in."""
    year = day.year if day.month >= start_month else day.year - 1
    return date(year, start_month, 1)


def next_financial_year(start: date) -> date:
    return date(start.year + 1, start.month, 1)


def financial_year_label(start: date) -> str:
    """'FY 2026-27' for the year that begins in April 2026; 'FY 2026' for a
    calendar year."""
    if start.month == 1:
        return f"FY {start.year}"
    return f"FY {start.year}-{(start.year + 1) % 100:02d}"


def month_start(day: date) -> date:
    return day.replace(day=1)


def next_month(start: date) -> date:
    return date(start.year + 1, 1, 1) if start.month == 12 else date(start.year, start.month + 1, 1)


def months_back(start: date, count: int) -> list[date]:
    """`count` month starts ending with `start`, oldest first."""
    months = [start]
    while len(months) < count:
        first = months[0]
        months.insert(0, date(first.year - 1, 12, 1) if first.month == 1
                      else date(first.year, first.month - 1, 1))
    return months


def basis(type_codes: Sequence[str | None]) -> str | None:
    """Settlement only when every answer came from the settlement meter."""
    answered = [code for code in type_codes if code is not None]
    if not answered:
        return None
    return SETTLEMENT if all(code == REVENUE_SETTLEMENT_TYPE for code in answered) else ESTIMATE


@dataclass(frozen=True, slots=True)
class Money:
    value: float | None
    reason: str | None = None


def revenue(energy_kwh: float | None, tariff: float | None, *, what: str = "export") -> Money:
    if tariff is None:
        return Money(None, "no tariff is recorded for this Plant")
    if energy_kwh is None:
        return Money(None, f"no meter reported its {what} register twice in the period")
    return Money(energy_kwh * tariff)


@dataclass(frozen=True, slots=True)
class PowerSlot:
    """One slot of the forecast power curve: where it starts, its length, kW."""

    at: datetime
    minutes: int
    forecast_kw: float | None


def rest_of_today_kwh(slots: Sequence[PowerSlot], now: datetime) -> float | None:
    """The forecast energy from `now` to the end of the day, kWh.

    A slot already under way counts only for the part still to come. A slot
    still to come with no forecast makes the whole figure unknown — summing
    the rest would read low and plausible.
    """
    total = 0.0
    counted = False
    for slot in slots:
        end = slot.at + timedelta(minutes=slot.minutes)
        if end <= now:
            continue
        if slot.forecast_kw is None:
            return None
        start = max(slot.at, now)
        total += max(0.0, slot.forecast_kw) * (end - start).total_seconds() / 3600.0
        counted = True
    return total if counted else 0.0


def expected_energy(
    so_far_kwh: float | None,
    rest_of_today: float | None,
    typical_day_kwh: float | None,
    days_after_today: int,
) -> tuple[float | None, str | None]:
    """The period's expected export: what is in, the rest of today, and each
    whole day left at the typical day. None with the missing piece's reason."""
    if so_far_kwh is None:
        return None, "nothing has been read for the period so far"
    if rest_of_today is None:
        return None, "the forecast has no curve for the rest of today"
    if days_after_today > 0 and typical_day_kwh is None:
        return None, "the forecast has no typical day to carry over the days still to come"
    return so_far_kwh + rest_of_today + (typical_day_kwh or 0.0) * days_after_today, None


@dataclass(frozen=True, slots=True)
class LossRow:
    """One Inverter's loss in the ranking: ₹, or why there is none."""

    code: str
    loss_inr: float | None
    downtime_hours: float | None


@dataclass(frozen=True, slots=True)
class LossTotal:
    value: float | None
    # True when an Inverter that was down has no figure, so the total is a floor.
    floor: bool
    missing: tuple[str, ...]
    reason: str | None = None


def total_loss(rows: Sequence[LossRow], tariff: float | None) -> LossTotal:
    """Every Inverter's loss summed — a floor where one that stopped has none."""
    if tariff is None:
        return LossTotal(None, False, (), "no tariff is recorded for this Plant")
    if not rows:
        return LossTotal(None, False, (), "no Inverter is registered at this Plant")
    counted = [row.loss_inr for row in rows if row.loss_inr is not None]
    missing = tuple(
        row.code for row in rows
        if row.loss_inr is None and (row.downtime_hours is None or row.downtime_hours > 0)
    )
    if not counted:
        return LossTotal(None, bool(missing), missing,
                         "no Inverter's loss could be worked out — record each one's AC rating")
    return LossTotal(sum(counted), bool(missing), missing)
