"""Performance History's days and months (`services/performance_history.build_history`).

The screen's promise is that it is the Reports' arithmetic, not a second copy:
a month here *is* the Monthly Plant Report's row, a day's energy is the Daily
Plant Report's, and nothing measured is None, never 0.0.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from solarcms.domain.counters import CounterSample, DeviceSeries
from solarcms.domain.periods import report_window
from solarcms.domain.tiering import Tier
from solarcms.services.performance_history import build_history
from solarcms.services.report_tables import (
    PlantInfo,
    Stat,
    build_daily_plant,
    build_monthly_plant,
)

IST = ZoneInfo("Asia/Kolkata")
PLANT = PlantInfo(id=1, client_id=7, code="SF_NORTH", name="Sunfield North",
                  timezone="Asia/Kolkata", dc_kwp=1_200.0, ac_kw=1_000.0)
# 16:18 in Kolkata on 28 Sep 2026.
NOW = datetime(2026, 9, 28, 10, 48, tzinfo=UTC)
TIERS = {"counter_tier": Tier.AGG_1H, "stats_tier": Tier.AGG_15M}


def _local(day: int, hour: int, month: int = 9) -> datetime:
    return datetime(2026, month, day, hour, 0, tzinfo=IST).astimezone(UTC)


def _register(type_code: str, tag: str, readings: list[tuple[datetime, float]], *,
              device_id: int, code: str) -> DeviceSeries:
    return DeviceSeries(device_id=device_id, device_code=code, device_type_code=type_code,
                        tag_code=tag, samples=tuple(CounterSample(a, v) for a, v in readings))


def _meter(*days: tuple[int, float], month: int = 9) -> DeviceSeries:
    """An MFM export register climbing `kwh` over each local day's daylight."""
    readings: list[tuple[datetime, float]] = []
    total = 50_000.0
    for day, kwh in days:
        readings.append((_local(day, 6, month), total))
        total += kwh
        readings.append((_local(day, 18, month), total))
    return _register("MFM", "ENERGY_EXPORT_TOTAL", readings, device_id=10, code="MFM")


def _station(*days: tuple[int, float]) -> DeviceSeries:
    """A WMS daily GHI register: zero at dawn, `kwh_m2` by dusk, restarting each midnight."""
    readings: list[tuple[datetime, float]] = []
    for day, kwh_m2 in days:
        readings += [(_local(day, 6), 0.0), (_local(day, 18), kwh_m2)]
    return _register("WMS", "GHI_CUMULATIVE", readings, device_id=20, code="WMS")


def _history(window, series, stats=None):  # type: ignore[no-untyped-def]
    return build_history(PLANT, window, series, stats or {}, live=[], now=NOW, **TIERS)


class TestDays:
    WINDOW = report_window("custom", NOW, IST, date(2026, 9, 22), date(2026, 9, 28))

    def test_one_row_per_local_day_and_today_is_marked_as_running(self) -> None:
        body = _history(self.WINDOW, [_meter((24, 4_000.0))])
        assert [d["date"] for d in body["days"]] == [f"2026-09-{n}" for n in range(22, 29)]
        assert [d["in_progress"] for d in body["days"]] == [False] * 6 + [True]

    def test_a_day_with_nothing_to_read_is_none_never_zero(self) -> None:
        body = _history(self.WINDOW, [_meter((24, 4_000.0))])
        quiet = body["days"][0]
        assert quiet["energy_kwh"] is None
        assert quiet["specific_yield"] is None
        assert quiet["performance_ratio"] is None
        assert body["totals"]["days_with_energy"] == 1

    def test_a_days_energy_is_the_daily_plant_reports(self) -> None:
        series = [_meter((24, 4_000.0), (25, 5_000.0), (26, 3_250.5))]
        body = _history(self.WINDOW, series)
        daily = build_daily_plant(PLANT, self.WINDOW, series, {}, **TIERS)
        assert [d["energy_kwh"] for d in body["days"]] == [r["energy_kwh"] for r in daily.rows]

    def test_specific_yield_and_pr_per_day(self) -> None:
        # 4,800 kWh from 1,200 kWp is 4 kWh/kWp, over 5 kWh/m² of sun: PR 80%.
        body = _history(self.WINDOW, [_meter((24, 4_800.0)), _station((24, 5.0))])
        day = next(d for d in body["days"] if d["date"] == "2026-09-24")
        assert day["specific_yield"] == 4.0
        assert day["irradiation_kwh_m2"] == 5.0
        assert day["performance_ratio"] == 80.0
        assert day["performance_ratio_flagged"] is False

    def test_an_impossible_pr_is_kept_and_flagged_never_clamped(self) -> None:
        # 12,000 kWh from 1,200 kWp over 1 kWh/m²: PR 1,000% — the spans disagree.
        plant = PlantInfo(id=1, client_id=7, code="X", name="X", timezone="Asia/Kolkata",
                          dc_kwp=1_200.0, ac_kw=None)
        body = build_history(plant, self.WINDOW, [_meter((24, 1_200.0)), _station((24, 0.5))],
                             {}, live=[], now=NOW, **TIERS)
        day = next(d for d in body["days"] if d["date"] == "2026-09-24")
        assert day["performance_ratio"] is not None
        assert day["performance_ratio_flagged"] is (day["performance_ratio"] > 120.0)

    def test_peak_and_coverage_come_from_the_days_15_minute_buckets(self) -> None:
        stats = {("INVERTER", "AC_ACTIVE_POWER"): {
            date(2026, 9, 24): Stat(peak_sum=850.0, mean=300.0, highest=90.0, samples=48,
                                    buckets=48)}}
        body = _history(self.WINDOW, [_meter((24, 4_000.0))], stats)
        day = next(d for d in body["days"] if d["date"] == "2026-09-24")
        assert day["peak_power_kw"] == 850.0
        assert day["coverage"] == 50.0
        assert body["totals"]["peak_power_kw"] == 850.0

    def test_without_a_dc_capacity_there_is_no_yield_or_pr_and_it_says_so(self) -> None:
        plant = PlantInfo(id=1, client_id=7, code="X", name="X", timezone="Asia/Kolkata",
                          dc_kwp=None, ac_kw=None)
        body = build_history(plant, self.WINDOW, [_meter((24, 4_800.0)), _station((24, 5.0))],
                             {}, live=[], now=NOW, **TIERS)
        day = next(d for d in body["days"] if d["date"] == "2026-09-24")
        assert day["specific_yield"] is None
        assert day["performance_ratio"] is None
        assert any("No DC capacity is recorded" in note for note in body["notes"])


class TestMonthsAndTotals:
    WINDOW = report_window("custom", NOW, IST, date(2026, 8, 25), date(2026, 9, 27))

    def test_the_months_are_the_monthly_plant_reports_rows(self) -> None:
        series = [_meter((24, 4_800.0)), _station((24, 5.0))]
        body = _history(self.WINDOW, series)
        monthly = build_monthly_plant(PLANT, self.WINDOW, series, {}, live=[], **TIERS)
        assert [m["month"] for m in body["months"]] == ["2026-08", "2026-09"]
        # Rounded as the Report's own JSON rounds them (its column's digits + 2).
        for ours, theirs in zip(body["months"], monthly.rows, strict=True):
            assert ours["days"] == theirs["days"]
            for key in ("energy_kwh", "performance_ratio", "cuf", "specific_yield"):
                if theirs[key] is None:
                    assert ours[key] is None
                else:
                    assert ours[key] == pytest.approx(theirs[key], abs=1e-3)

    def test_the_periods_pr_is_pooled_not_a_mean_of_the_days(self) -> None:
        # Day one: 4,800 kWh over 5 kWh/m² (PR 80%). Day two: 600 kWh over 1 kWh/m²
        # (PR 50%). The mean of the days is 65%; pooled, 5,400 / 1,200 / 6 = 75%.
        series = [_meter((24, 4_800.0), (25, 600.0)), _station((24, 5.0), (25, 1.0))]
        window = report_window("custom", NOW, IST, date(2026, 9, 24), date(2026, 9, 25))
        body = _history(window, series)
        assert body["totals"]["performance_ratio"] == 75.0
        assert body["totals"]["energy_kwh"] == 5_400.0
        assert body["totals"]["specific_yield"] == 4.5

    def test_an_empty_period_has_no_figures_and_says_why(self) -> None:
        body = _history(self.WINDOW, [])
        assert body["totals"]["energy_kwh"] is None
        assert body["totals"]["performance_ratio"] is None
        assert body["totals"]["days_with_energy"] == 0
        assert all(d["energy_kwh"] is None for d in body["days"])
        assert body["notes"]

    def test_a_year_of_days_is_a_row_each(self) -> None:
        window = report_window("custom", NOW, IST, date(2025, 9, 28), date(2026, 9, 28))
        body = _history(window, [_meter((24, 1.0))])
        assert len(body["days"]) == 366
        assert len(body["months"]) == 13
        first = date.fromisoformat(body["days"][0]["date"])
        assert all(date.fromisoformat(d["date"]) == first + timedelta(days=i)
                   for i, d in enumerate(body["days"]))
