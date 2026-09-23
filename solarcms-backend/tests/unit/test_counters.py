"""Energy from cumulative registers: count the steps, refuse the impossible ones.

The cases are the ones this platform has actually produced. A simulator that
restarted its counters at random made a 240 kWp rooftop report 1.6 GWh "today"
(an `implausible_jump`); one of its counters stepped from 1,413,399 down to
1,205,544 (a `backwards` step); and a Plant with a settlement meter and a check
meter reported the difference between their two readings as generation.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain import assumptions as a
from solarcms.domain.counters import (
    CounterSample,
    DeviceSeries,
    bucket_steps,
    integrate_counter,
    plant_energy,
    plant_irradiation,
)

T0 = datetime(2026, 9, 22, 6, 0, tzinfo=UTC)


def _samples(*values: float, every_min: int = 2) -> tuple[CounterSample, ...]:
    return tuple(
        CounterSample(T0 + timedelta(minutes=every_min * i), v) for i, v in enumerate(values)
    )


def _series(code: str, type_code: str, tag: str, *values: float,
            rated: float | None = None, every_min: int = 2) -> DeviceSeries:
    return DeviceSeries(
        device_id=hash(code) % 10_000, device_code=code, device_type_code=type_code,
        tag_code=tag, samples=_samples(*values, every_min=every_min), rated_capacity_kw=rated)


class TestIntegrateCounter:
    def test_normal_steps_add_up(self) -> None:
        result = integrate_counter(_samples(100.0, 106.0, 112.5), max_rate_per_hour=300.0)
        assert result.total == 12.5
        assert result.anomalies == ()

    def test_a_backwards_step_is_refused_and_reported(self) -> None:
        result = integrate_counter(
            _samples(1_413_399.0, 1_205_544.0, 1_205_550.0), max_rate_per_hour=10_000.0,
            rollover_maximum=None)
        assert result.total == 6.0, "only the step after the reset counts"
        assert [x.kind for x in result.anomalies] == ["backwards"]
        assert result.anomalies[0].from_value == 1_413_399.0

    def test_a_jump_bigger_than_the_plant_could_make_is_refused(self) -> None:
        # WH2: 200 kW AC. At most 200 x 1.5 x 2/60 = 10 kWh in two minutes.
        result = integrate_counter(
            _samples(603_837.6, 1_413_399.6, 1_413_405.0), max_rate_per_hour=200.0 * 1.5)
        assert abs(result.total - 5.4) < 1e-6
        assert [x.kind for x in result.anomalies] == ["implausible_jump"]
        assert result.anomalies[0].limit == 10.0

    def test_without_a_capacity_only_backwards_steps_are_caught(self) -> None:
        result = integrate_counter(_samples(0.0, 1e6), max_rate_per_hour=None)
        assert result.total == 1e6
        assert result.anomalies == ()

    def test_a_stated_rollover_maximum_turns_a_wrap_into_generation(self) -> None:
        # OPEN-14: with the maximum known, 999,995 -> 3 is 8 kWh, not a reset.
        result = integrate_counter(
            _samples(999_995.0, 3.0), max_rate_per_hour=1_000.0, rollover_maximum=1_000_000.0)
        assert result.total == 8.0
        assert result.anomalies == ()

    def test_a_replaced_meter_still_fails_with_a_rollover_maximum(self) -> None:
        # A new meter starting at 12 after the old one read 400,000 is not a
        # wrap: (1,000,000 - 400,000) + 12 is far more than two minutes allow.
        result = integrate_counter(
            _samples(400_000.0, 12.0), max_rate_per_hour=1_000.0, rollover_maximum=1_000_000.0)
        assert result.total == 0.0
        assert [x.kind for x in result.anomalies] == ["implausible_jump"]

    def test_a_daily_register_counts_what_accrued_after_midnight(self) -> None:
        # 5.2 at 23:00, reset at midnight, 0.4 by 01:00: 0.1 + 0.4 in the window.
        samples = (
            CounterSample(T0, 5.1), CounterSample(T0 + timedelta(hours=1), 5.2),
            CounterSample(T0 + timedelta(hours=2), 0.4))
        result = integrate_counter(samples, max_rate_per_hour=1.5, resets_expected=True)
        assert abs(result.total - 0.5) < 1e-9
        assert result.anomalies == ()

    def test_one_reading_has_no_step(self) -> None:
        result = integrate_counter(_samples(42.0), max_rate_per_hour=1.0)
        assert result.total == 0.0 and result.samples == 1

    def test_readings_out_of_order_are_sorted_first(self) -> None:
        samples = tuple(reversed(_samples(10.0, 11.0, 12.0)))
        assert integrate_counter(samples, max_rate_per_hour=100.0).total == 2.0


class TestPlantEnergy:
    def test_two_meters_are_never_subtracted_from_each_other(self) -> None:
        # SF_NORTH: the ABT meter and the MFM sit on different numbers. "Highest
        # minus lowest" across both reported 56,602 kWh in four minutes.
        series = [
            _series("ABT_METER", "ABT_METER", "ENERGY_EXPORT_TOTAL", 1_470_930.0, 1_471_080.0),
            _series("MFM", "MFM", "ENERGY_EXPORT_TOTAL", 1_414_327.8, 1_414_478.0),
        ]
        result = plant_energy(
            series, a.PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=4_800.0)
        assert result.device_type_code == "ABT_METER"
        assert result.value == 150.0
        assert [d.series.device_code for d in result.devices] == ["ABT_METER"]

    def test_a_silent_settlement_meter_falls_back_and_says_so(self) -> None:
        series = [
            _series("ABT_METER", "ABT_METER", "ENERGY_EXPORT_TOTAL", 1_470_930.0),
            _series("MFM", "MFM", "ENERGY_EXPORT_TOTAL", 10.0, 20.0),
        ]
        result = plant_energy(
            series, a.PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=4_800.0)
        assert result.device_type_code == "MFM"
        assert result.passed_over[0].device_type_code == "ABT_METER"
        assert "fewer than two" in result.passed_over[0].reason

    def test_inverters_are_summed_only_when_no_meter_answers(self) -> None:
        series = [
            _series("INVERTER_1", "INVERTER", "ENERGY_TOTAL", 100.0, 103.0, rated=150.0),
            _series("INVERTER_2", "INVERTER", "ENERGY_TOTAL", 500.0, 504.0, rated=150.0),
        ]
        result = plant_energy(
            series, a.PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=450.0)
        assert result.device_type_code == "INVERTER"
        assert result.value == 7.0

    def test_an_inverter_is_judged_against_its_own_rating(self) -> None:
        # 150 kW x 1.5 x 2 min = 7.5 kWh at most; 20 kWh is impossible for it,
        # though well within the Plant's 450 kW.
        series = [_series("INVERTER_1", "INVERTER", "ENERGY_TOTAL", 0.0, 20.0, rated=150.0)]
        result = plant_energy(
            series, a.PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=450.0)
        assert result.value == 0.0
        assert [anomaly.kind for _s, anomaly in result.anomalies] == ["implausible_jump"]

    def test_nothing_to_read_is_undefined_not_zero(self) -> None:
        result = plant_energy([], a.PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=200.0)
        assert result.value is None
        assert result.undefined_reason
        assert len(result.passed_over) == len(a.PLANT_ENERGY_COUNTER_PRECEDENCE)

    def test_an_unknown_capacity_turns_the_jump_check_off_visibly(self) -> None:
        series = [_series("MFM", "MFM", "ENERGY_EXPORT_TOTAL", 0.0, 1e6)]
        result = plant_energy(
            series, a.PLANT_ENERGY_COUNTER_PRECEDENCE, plant_ac_capacity_kw=None)
        assert result.value == 1e6
        assert result.jump_check is False


class TestPlantIrradiation:
    def test_two_stations_are_averaged_not_summed(self) -> None:
        series = [
            _series("WMS_1", "WMS", "GHI_CUMULATIVE", 1.0, 1.02, every_min=5),
            _series("WMS_2", "WMS", "GHI_CUMULATIVE", 2.0, 2.04, every_min=5),
        ]
        result = plant_irradiation(series)
        assert result.value is not None and abs(result.value - 0.03) < 1e-9

    def test_a_register_climbing_faster_than_the_sun_is_refused(self) -> None:
        # 0.04 kWh/m2 in one minute is 2.4 kWh/m2 per hour: no sky does that.
        result = plant_irradiation([_series("WMS", "WMS", "GHI_CUMULATIVE", 2.0, 2.04,
                                            every_min=1)])
        assert result.value == 0.0
        assert [x.kind for x in result.stations[0].integral.anomalies] == ["implausible_jump"]

    def test_no_station_is_undefined(self) -> None:
        assert plant_irradiation([]).value is None


class TestBucketing:
    def test_steps_are_summed_under_the_callers_label(self) -> None:
        result = integrate_counter(_samples(0.0, 1.0, 3.0, 6.0, every_min=30),
                                   max_rate_per_hour=100.0)
        by_hour = bucket_steps(result.steps, lambda at: at.strftime("%H"))
        # Steps land at 06:30 (+1), 07:00 (+2) and 07:30 (+3).
        assert by_hour == {"06": 1.0, "07": 5.0}
