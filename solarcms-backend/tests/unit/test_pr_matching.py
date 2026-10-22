"""PR from the periods both sides measured, over sunlight the output allows.

Pure `domain/` tests, each one a day the platform has actually had: an outage
that kept the meters' energy and lost the stations' afternoon
(SPINNING_AND_GENERAL_MILLS, 264.3%, 21 Oct 2026), a station sending noise for
zero (OASIS_2MW, 1.02E+42%), a station dying beside a working one.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import pytest

from solarcms.domain.counters import CounterSample, DeviceSeries, plant_energy
from solarcms.domain.irradiation import (
    IrradianceBucket,
    LiveIrradiance,
    integrate_irradiance,
    plant_irradiation,
)
from solarcms.domain.pr_matching import (
    MatchSeries,
    PlantPr,
    match_periods,
    plant_pr,
    summarise,
    summarise_by_label,
)

DAY = datetime(2026, 10, 21, tzinfo=UTC)
MINUTE = timedelta(minutes=1)
DC_KWP = 1_000.0
PRECEDENCE = (("MFM", "ENERGY_EXPORT_TOTAL"),)


def _at(hour: float) -> datetime:
    return DAY + timedelta(hours=hour)


def _sun(minute_of_day: int) -> float:
    """A clear day's irradiance, W/m²: 0 at 06:00 and 18:00, 1,000 at noon."""
    hour = minute_of_day / 60.0
    if not 6.0 <= hour <= 18.0:
        return 0.0
    return 1_000.0 * (1.0 - ((hour - 12.0) / 6.0) ** 2)


def _meter(pr: float, minutes: list[int], code: str = "MFM", device_id: int = 1,
           dc: float = DC_KWP) -> DeviceSeries:
    """An export register on a Plant running at `pr`, read at `minutes`."""
    total = 0.0
    samples = []
    previous = None
    for minute in sorted(minutes):
        if previous is not None:
            total += sum(_sun(m) / 1000.0 * dc * pr / 60.0 for m in range(previous, minute))
        samples.append(CounterSample(DAY + minute * MINUTE, 50_000.0 + total))
        previous = minute
    return DeviceSeries(device_id, code, "MFM", "ENERGY_EXPORT_TOTAL", tuple(samples))


def _live(minutes: list[int], code: str = "WMS", device_id: int = 20,
          scale: float = 1.0) -> LiveIrradiance:
    """A station's live GHI, one 1-minute bucket per minute in `minutes`."""
    buckets = [IrradianceBucket(DAY + m * MINUTE, _sun(m) * scale) for m in minutes]
    return LiveIrradiance(device_id, code, integrate_irradiance(buckets, MINUTE, _at(24)))


def _register(minutes: list[int], code: str = "WMS", device_id: int = 20) -> DeviceSeries:
    """A station's daily GHI register (kWh/m²), read at `minutes`."""
    samples = [
        CounterSample(DAY + m * MINUTE, sum(_sun(x) / 1000.0 / 60.0 for x in range(m)))
        for m in sorted(minutes)
    ]
    return DeviceSeries(device_id, code, "WMS", "GHI_CUMULATIVE", tuple(samples))


ALL_DAY = list(range(0, 24 * 60 + 1))


def _meter_days(pr: float, minutes: list[int]) -> DeviceSeries:
    """An export register over several days (`_sun` repeats daily)."""
    heard = set(minutes)
    total, samples = 50_000.0, []
    for minute in range(max(minutes) + 1):
        if minute in heard:
            samples.append(CounterSample(DAY + minute * MINUTE, total))
        total += _sun(minute % 1440) / 1000.0 * DC_KWP * pr / 60.0
    return DeviceSeries(1, "MFM", "MFM", "ENERGY_EXPORT_TOTAL", tuple(samples))


def _register_days(minutes: list[int]) -> DeviceSeries:
    """A daily GHI register, restarting at each midnight, over several days."""
    heard = set(minutes)
    accrued, samples = 0.0, []
    for minute in range(max(minutes) + 1):
        if minute % 1440 == 0:
            accrued = 0.0
        if minute in heard:
            samples.append(CounterSample(DAY + minute * MINUTE, accrued))
        accrued += _sun(minute % 1440) / 1000.0 / 60.0
    return DeviceSeries(20, "WMS", "WMS", "GHI_CUMULATIVE", tuple(samples))


def _pr(meters: Sequence[DeviceSeries], registers: Sequence[DeviceSeries] = (),
        live: Sequence[LiveIrradiance] = (), dc: float = DC_KWP) -> PlantPr:
    energy = plant_energy(meters, PRECEDENCE, plant_ac_capacity_kw=None)
    return plant_pr(energy, plant_irradiation(list(registers), list(live)), dc)


class TestAnOrdinaryDay:
    def test_a_whole_day_counts_whole_and_reads_its_own_pr(self) -> None:
        result = _pr([_meter(0.8, ALL_DAY)], live=[_live(ALL_DAY)])
        assert result.result.value == pytest.approx(0.8, rel=1e-6)
        assert result.basis is not None
        assert result.basis.energy_share == pytest.approx(1.0)
        assert result.basis.left_out == ()

    def test_readings_86_seconds_apart_are_shared_across_periods_not_lost(self) -> None:
        # The client's Devices publish every ~86 s: a step crosses most
        # period boundaries, and is shared by time rather than merging the day.
        every_86s = sorted({(s // 60) for s in range(0, 24 * 3600 + 1, 86)})
        result = _pr([_meter(0.8, every_86s)], live=[_live(ALL_DAY)])
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None and result.basis.left_out == ()

    def test_a_low_pr_is_kept_low(self) -> None:
        # A Plant making little under a bright sky is what PR is for.
        result = _pr([_meter(0.3, ALL_DAY)], live=[_live(ALL_DAY)])
        assert result.result.value == pytest.approx(0.3, rel=1e-6)

    def test_a_flat_sensor_on_a_tilted_array_is_not_a_fault(self) -> None:
        # KULAR_GREEN reads 100.5% for a day on its horizontal sensor; shown as 100%.
        result = _pr([_meter(1.4, ALL_DAY)], live=[_live(ALL_DAY)])
        assert result.result.value == pytest.approx(1.0)
        assert result.basis is not None and result.basis.stations_set_aside == ()


class TestAnOutage:
    def test_a_hole_in_the_sunlight_leaves_its_energy_out_too(self) -> None:
        # SPINNING_AND_GENERAL_MILLS, 21 Oct 2026: the meter's register stepped
        # from 11:30 to 20:00; the live GHI had nothing in between.
        heard = [m for m in ALL_DAY if not 11.5 * 60 < m < 20 * 60]
        result = _pr([_meter(0.8, heard)], live=[_live(heard)])
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        basis = result.basis
        assert basis is not None
        assert basis.energy_share is not None and basis.energy_share < 0.6
        [run] = basis.left_out
        assert run.reason == "no_sunlight"
        assert (run.start, run.end) == (_at(11.5), _at(20))
        assert run.energy_kwh > 0

    def test_without_matching_the_same_day_read_far_above_100(self) -> None:
        # What the dial showed: the whole day's energy over the morning's sun.
        heard = [m for m in ALL_DAY if not 11.5 * 60 < m < 20 * 60]
        energy = plant_energy([_meter(0.8, heard)], PRECEDENCE, plant_ac_capacity_kw=None)
        sun = plant_irradiation([], [_live(heard)])
        assert energy.value is not None and sun.value is not None
        assert energy.value / DC_KWP / sun.value > 1.5

    def test_registers_on_both_sides_stepping_across_a_hole_count_as_one_block(self) -> None:
        # Both totals are known across the gap, only not how they were spread.
        heard = [m for m in ALL_DAY if not 11.5 * 60 < m < 20 * 60]
        result = _pr([_meter(0.8, heard)], registers=[_register(heard)])
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None and result.basis.left_out == ()

    def test_a_hole_in_the_energy_leaves_its_sunlight_out(self) -> None:
        # The register jumped by 10,000 kWh across an hour without readings:
        # the step is refused, so that hour's energy is not known.
        heard = [m for m in ALL_DAY if not 9 * 60 < m < 10 * 60]
        meter = _meter(0.8, heard)
        jumped = DeviceSeries(
            meter.device_id, meter.device_code, meter.device_type_code, meter.tag_code,
            tuple(CounterSample(s.at, s.value + (10_000.0 if s.at >= _at(10) else 0.0))
                  for s in meter.samples))
        energy = plant_energy([jumped], PRECEDENCE, plant_ac_capacity_kw=DC_KWP)
        assert len(energy.anomalies) == 1
        result = plant_pr(energy, plant_irradiation([], [_live(ALL_DAY)]), DC_KWP)
        # Before, the hour's sun stayed in and its energy did not: PR read low.
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None
        [run] = result.basis.left_out
        assert run.reason == "no_energy"
        assert (run.start, run.end) == (_at(9), _at(10))


class TestEnergyNoSkyCouldGive:
    def test_a_counter_jump_is_left_out_as_energy_and_no_station_is_blamed(self) -> None:
        # KULAR_GREEN, 1 Oct 2026: 97 MWh in 26 minutes on a 5.6 MWp Plant.
        meter = _meter(0.8, ALL_DAY)
        jumped = DeviceSeries(
            meter.device_id, meter.device_code, meter.device_type_code, meter.tag_code,
            tuple(CounterSample(s.at, s.value + (97_000.0 if s.at >= _at(16.1) else 0.0))
                  for s in meter.samples))
        # No AC capacity on record, so the counter's own jump check is off.
        result = _pr([jumped], live=[_live(ALL_DAY)])
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None
        assert [run.reason for run in result.basis.left_out] == ["energy_too_high"]
        assert result.basis.stations_set_aside == ()


class TestARegisterReadOnceAnHour:
    def test_a_glitch_costs_its_own_half_hour_not_the_afternoon(self) -> None:
        # KULAR_GREEN, 9 Oct 2026: the GHI register read 61 and 65 minutes
        # apart, then jumped +0.57 kWh/m² in five minutes (refused).
        minutes = [*range(0, 721), 781, 846, 852, *range(857, 1441)]
        register = _register(minutes)
        glitched = DeviceSeries(
            register.device_id, register.device_code, register.device_type_code,
            register.tag_code,
            tuple(CounterSample(s.at, s.value + (0.57 if s.at >= DAY + 857 * MINUTE else 0.0))
                  for s in register.samples))
        result = _pr([_meter(0.8, ALL_DAY)], registers=[glitched])
        assert result.result.value == pytest.approx(0.8, rel=2e-2)
        assert result.basis is not None
        [run] = result.basis.left_out
        assert run.reason == "no_sunlight"
        assert run.end - run.start <= timedelta(minutes=30)


class TestStationsThatAreNotMeasuring:
    def test_noise_for_zero_all_day_gives_no_pr_and_says_why(self) -> None:
        # OASIS_2MW: GHI 9.75E-42 while the Inverters made 4,240 kWh.
        result = _pr([_meter(0.8, ALL_DAY)], live=[_live(ALL_DAY, scale=1e-44)])
        assert result.result.value is None
        assert result.result.undefined_reason == (
            "the weather station read no sunlight while the Plant was generating")
        assert result.basis is not None
        [station] = result.basis.stations_set_aside
        assert station.device_code == "WMS"
        assert station.reads_dark

    def test_a_station_reading_a_third_of_the_sun_is_not_called_dead(self) -> None:
        # Indistinguishable, from the data, from a DC capacity on record a
        # third of the real array: the reason names both.
        result = _pr([_meter(0.8, ALL_DAY)], live=[_live(ALL_DAY, scale=0.3)])
        assert result.result.value is None
        assert result.result.undefined_reason is not None
        assert "DC capacity" in result.result.undefined_reason
        assert result.basis is not None
        assert not result.basis.stations_set_aside[0].reads_dark

    def test_a_station_dying_beside_a_working_one_is_set_aside_not_averaged(self) -> None:
        dead_after_noon = LiveIrradiance(21, "WMS_WEST", integrate_irradiance(
            [IrradianceBucket(DAY + m * MINUTE, _sun(m) if m < 12 * 60 else 0.0)
             for m in ALL_DAY], MINUTE, _at(24)))
        result = _pr([_meter(0.8, ALL_DAY)], live=[_live(ALL_DAY), dead_after_noon])
        # Averaged with the dead station's zero, the afternoon read 160%.
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None
        [station] = result.basis.stations_set_aside
        assert station.device_code == "WMS_WEST"
        assert station.first >= _at(12)

    def test_a_station_down_for_an_hour_does_not_halve_that_hours_sun(self) -> None:
        gap = [m for m in ALL_DAY if not 10 * 60 < m <= 11 * 60]
        result = _pr([_meter(0.8, ALL_DAY)],
                     live=[_live(ALL_DAY), _live(gap, code="WMS_WEST", device_id=21)])
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None and result.basis.left_out == ()

    def test_without_a_dc_capacity_nothing_is_judged_and_pr_is_undefined(self) -> None:
        result = _pr([_meter(0.8, ALL_DAY)], live=[_live(ALL_DAY, scale=1e-44)], dc=0.0)
        assert result.result.value is None
        assert result.result.undefined_reason == "dc_capacity_kwp is zero or unknown"


class TestWhoIsOwed:
    def test_an_inverter_first_heard_at_noon_leaves_the_morning_out(self) -> None:
        # PR divides by the whole Plant's DC: a morning without INVERTER_2 is a
        # morning the Plant's energy is short. Counted, it read 70.7% for 80%.
        early = _meter(0.8, ALL_DAY, code="INVERTER_1", device_id=1, dc=500.0)
        late = _meter(0.8, [m for m in ALL_DAY if m >= 12 * 60], code="INVERTER_2",
                      device_id=2, dc=500.0)
        energy = plant_energy([early, late], PRECEDENCE, plant_ac_capacity_kw=None)
        result = plant_pr(energy, plant_irradiation([], [_live(ALL_DAY)]), DC_KWP)
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None
        [run] = result.basis.left_out
        assert run.reason == "no_energy" and run.missing == ("INVERTER_2",)
        assert run.end == _at(12)

    def test_an_inverter_silent_from_two_never_back_leaves_the_afternoon_out(self) -> None:
        one = _meter(0.8, ALL_DAY, code="INVERTER_1", device_id=1, dc=500.0)
        two = _meter(0.8, [m for m in ALL_DAY if m <= 14 * 60], code="INVERTER_2",
                     device_id=2, dc=500.0)
        result = _pr([one, two], live=[_live(ALL_DAY)])
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        periods = match_periods(
            [MatchSeries(1, "INVERTER_1", plant_energy([one], PRECEDENCE,
                                                        plant_ac_capacity_kw=None).devices[0].integral)],
            [MatchSeries(20, "WMS", _live(ALL_DAY).integral)], dc_capacity_kwp=DC_KWP)
        assert all(period.counted for period in periods)

    def test_an_inverter_silent_for_an_afternoon_is_known_across_it_as_a_whole(self) -> None:
        one = _meter(0.8, ALL_DAY, code="INVERTER_1", device_id=1, dc=500.0)
        two = _meter(0.8, [m for m in ALL_DAY if not 13 * 60 < m < 16 * 60],
                     code="INVERTER_2", device_id=2, dc=500.0)
        # INVERTER_2's register stepped across its silence, so its energy is
        # known as a whole and the three hours are one block — still counted.
        result = _pr([one, two], live=[_live(ALL_DAY)])
        assert result.result.value == pytest.approx(0.8, rel=1e-3)


class TestAcrossMidnight:
    def test_a_daily_register_restarting_inside_an_outage_is_not_counted_as_known(self) -> None:
        # Both registers silent 15:00 to 10:00 the next morning. The meter's
        # step is the whole span; the station's, after its midnight restart,
        # is only the morning — so the block is not known, and is left out.
        two_days = list(range(0, 2 * 1440 + 1))
        heard = [m for m in two_days if not 15 * 60 < m < 1440 + 10 * 60]
        energy = plant_energy([_meter_days(0.8, heard)], PRECEDENCE, plant_ac_capacity_kw=None)
        result = plant_pr(energy, plant_irradiation([_register_days(heard)], []), DC_KWP)
        assert result.result.value == pytest.approx(0.8, rel=1e-3)
        assert result.basis is not None
        [run] = result.basis.left_out
        assert run.reason == "no_sunlight"
        assert (run.start, run.end) == (_at(15), _at(34))


class TestTheWindowsEdge:
    def test_the_period_still_in_progress_is_not_reported_missing(self) -> None:
        now = 10 * 60 + 7
        result = _pr([_meter(0.8, list(range(0, now - 2)))],
                     live=[_live(list(range(0, now)))])
        assert result.basis is not None and result.basis.left_out == ()
        assert result.result.value == pytest.approx(0.8, rel=1e-3)


class TestByLabel:
    def test_each_day_is_matched_on_its_own(self) -> None:
        meter = _meter(0.8, ALL_DAY)
        live = _live([m for m in ALL_DAY if not 11.5 * 60 < m < 20 * 60])
        energy = plant_energy([meter], PRECEDENCE, plant_ac_capacity_kw=None)
        periods = match_periods(
            [MatchSeries(1, "MFM", energy.devices[0].integral)],
            [MatchSeries(20, "WMS", live.integral)], dc_capacity_kwp=DC_KWP)
        by_hour = summarise_by_label(periods, lambda at: f"{at:%H}")
        # The meter read every minute: each afternoon hour stands alone, its
        # energy left out for want of sunlight.
        assert by_hour["12"].energy_kwh == 0.0
        assert [run.reason for run in by_hour["12"].left_out] == ["no_sunlight"]
        assert by_hour["10"].energy_kwh / DC_KWP / by_hour["10"].sunlight_kwh_m2 == (
            pytest.approx(0.8, rel=1e-3))
        whole = summarise(periods)
        assert whole.energy_kwh == pytest.approx(
            sum(basis.energy_kwh for basis in by_hour.values()), rel=1e-6)
