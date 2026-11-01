"""The Revenue screen's rules (`domain/revenue.py`, ⚠ PROPOSED)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

from solarcms.domain.assumptions import (
    REVENUE_EXPORT_COUNTER_PRECEDENCE,
    REVENUE_SETTLEMENT_TYPE,
)
from solarcms.domain.revenue import (
    ESTIMATE,
    SETTLEMENT,
    LossRow,
    PowerSlot,
    basis,
    expected_energy,
    financial_year_label,
    financial_year_start,
    months_back,
    next_financial_year,
    rest_of_today_kwh,
    revenue,
    total_loss,
)


class TestFinancialYear:
    def test_april_to_march(self) -> None:
        assert financial_year_start(date(2026, 11, 1)) == date(2026, 4, 1)
        assert financial_year_start(date(2027, 3, 31)) == date(2026, 4, 1)
        assert financial_year_start(date(2027, 4, 1)) == date(2027, 4, 1)
        assert next_financial_year(date(2026, 4, 1)) == date(2027, 4, 1)

    def test_label(self) -> None:
        assert financial_year_label(date(2026, 4, 1)) == "FY 2026-27"
        assert financial_year_label(date(2099, 4, 1)) == "FY 2099-00"
        assert financial_year_label(date(2026, 1, 1)) == "FY 2026"

    def test_months_back_cross_a_year(self) -> None:
        months = months_back(date(2026, 2, 1), 4)
        assert months == [date(2025, 11, 1), date(2025, 12, 1), date(2026, 1, 1), date(2026, 2, 1)]


class TestBasis:
    def test_settlement_only_from_the_abt_meter(self) -> None:
        assert REVENUE_SETTLEMENT_TYPE == "ABT_METER"
        assert basis(["ABT_METER"]) == SETTLEMENT
        assert basis(["MFM"]) == ESTIMATE
        # ABT one month and MFM another is not settlement.
        assert basis(["ABT_METER", "MFM"]) == ESTIMATE
        assert basis([None]) is None
        assert basis([]) is None

    def test_export_never_falls_back_to_the_inverters(self) -> None:
        # Generation is not export.
        assert all(type_code != "INVERTER" for type_code, _ in REVENUE_EXPORT_COUNTER_PRECEDENCE)
        assert REVENUE_EXPORT_COUNTER_PRECEDENCE[0][0] == "ABT_METER"


class TestRevenue:
    def test_export_times_tariff(self) -> None:
        assert revenue(1000.0, 4.5).value == 4500.0

    def test_no_tariff_is_undefined_never_zero(self) -> None:
        money = revenue(1000.0, None)
        assert money.value is None and money.reason and "tariff" in money.reason

    def test_nothing_read_is_undefined_never_zero(self) -> None:
        assert revenue(None, 4.5).value is None
        # A real zero stays zero.
        assert revenue(0.0, 4.5).value == 0.0


T0 = datetime(2026, 11, 1, 6, 30, tzinfo=UTC)


def _slots(values: list[float | None]) -> list[PowerSlot]:
    return [PowerSlot(T0 + timedelta(minutes=15 * i), 15, v) for i, v in enumerate(values)]


class TestRestOfToday:
    def test_sums_the_slots_to_come(self) -> None:
        # Four slots of 100 kW from the start: 100 kWh.
        assert rest_of_today_kwh(_slots([100, 100, 100, 100]), T0) == 100.0

    def test_a_slot_under_way_counts_only_what_is_left(self) -> None:
        now = T0 + timedelta(minutes=7, seconds=30)
        assert rest_of_today_kwh(_slots([100, 100]), now) == 12.5 + 25.0

    def test_a_gap_to_come_makes_it_unknown(self) -> None:
        assert rest_of_today_kwh(_slots([100, None, 100]), T0) is None

    def test_a_gap_already_past_does_not(self) -> None:
        assert rest_of_today_kwh(_slots([None, 100]), T0 + timedelta(minutes=15)) == 25.0

    def test_after_the_last_slot_nothing_is_left(self) -> None:
        assert rest_of_today_kwh(_slots([100]), T0 + timedelta(hours=1)) == 0.0


class TestExpected:
    def test_so_far_plus_rest_plus_whole_days(self) -> None:
        assert expected_energy(500.0, 200.0, 1000.0, 3) == (3700.0, None)

    def test_today_needs_no_typical_day(self) -> None:
        assert expected_energy(500.0, 200.0, None, 0) == (700.0, None)

    def test_each_missing_piece_is_named(self) -> None:
        assert expected_energy(None, 200.0, 1000.0, 3)[0] is None
        value, reason = expected_energy(500.0, None, 1000.0, 3)
        assert value is None and reason and "rest of today" in reason
        value, reason = expected_energy(500.0, 200.0, None, 3)
        assert value is None and reason and "typical day" in reason


class TestLoss:
    def test_sums_every_inverter(self) -> None:
        rows = [LossRow("INV_1", 100.0, 1.0), LossRow("INV_2", 0.0, 0.0)]
        total = total_loss(rows, 4.0)
        assert (total.value, total.floor, total.missing) == (100.0, False, ())

    def test_a_stopped_inverter_without_a_figure_makes_it_a_floor(self) -> None:
        rows = [LossRow("INV_1", 100.0, 1.0), LossRow("INV_2", None, 2.0)]
        total = total_loss(rows, 4.0)
        assert total.value == 100.0 and total.floor and total.missing == ("INV_2",)

    def test_one_that_never_stopped_is_not_missing(self) -> None:
        total = total_loss([LossRow("INV_1", 50.0, 1.0), LossRow("INV_2", None, 0.0)], 4.0)
        assert not total.floor

    def test_no_tariff(self) -> None:
        total = total_loss([LossRow("INV_1", None, 1.0)], None)
        assert total.value is None and total.reason and "tariff" in total.reason
