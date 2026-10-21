"""A Plant's sunlight from its weather stations, and which of them to believe.

The case that prompted it is VARDHMAN_GROUP's SPINNING_AND_GENERAL_MILLS (15 Oct
2026): two stations whose daily total (`AGHI`) reads 0 all day while their live
`GHI` reads ~95 W/m² — the Plant showed "No irradiation in period" and no PR.
And the case it would have become: one station repaired, the other not, and a
mean of the two halving the Plant's sun and doubling its PR.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain.counters import CounterSample, DeviceSeries
from solarcms.domain.dashboard_spec import DEFAULT_SLOTS
from solarcms.domain.irradiation import (
    IrradianceBucket,
    LiveIrradiance,
    StationValues,
    choose_source,
    integrate_irradiance,
    irradiation_by_label,
    irradiation_notes,
    live_hold,
    not_measuring,
    plant_irradiation,
)
from solarcms.domain.slots import DeviceFacts, PlantFacts, resolve_slot

DAY1 = datetime(2026, 10, 14, 0, 30, tzinfo=UTC)  # 06:00 in Kolkata
DAY2 = DAY1 + timedelta(days=1)
HOUR = timedelta(hours=1)
LATE = datetime(2026, 10, 20, tzinfo=UTC)


def _register(code: str, *points: tuple[datetime, float], device_id: int) -> DeviceSeries:
    """A station's daily register (kWh/m²) — `GHI_CUMULATIVE`."""
    return DeviceSeries(
        device_id=device_id, device_code=code, device_type_code="WMS",
        tag_code="GHI_CUMULATIVE",
        samples=tuple(CounterSample(at, value) for at, value in points))


def _flat_register(code: str, day: datetime, value: float, *, device_id: int) -> DeviceSeries:
    """A register that sat at `value` from 06:00 to 18:00 — stuck."""
    return _register(code, (day, value), (day + 12 * HOUR, value), device_id=device_id)


def _live(code: str, day: datetime, w_per_m2: float, hours: int = 12, *,
          device_id: int) -> LiveIrradiance:
    """A station's live GHI at a constant `w_per_m2` for `hours` hourly buckets."""
    buckets = [IrradianceBucket(day + i * HOUR, w_per_m2) for i in range(hours)]
    return LiveIrradiance(device_id, code, integrate_irradiance(buckets, HOUR, LATE))


class TestIntegrateIrradiance:
    def test_each_bucket_is_its_mean_times_its_span(self) -> None:
        # 600 W/m² for an hour is 0.6 kWh/m²; 300 for an hour is 0.3.
        result = integrate_irradiance(
            [IrradianceBucket(DAY1, 600.0), IrradianceBucket(DAY1 + HOUR, 300.0)], HOUR, LATE)
        assert abs(result.total - 0.9) < 1e-9
        # One step per bucket, at its end, accrued since its start — so a
        # per-day split attributes it exactly as it does a register's step.
        assert [(s.since, s.at) for s in result.steps] == [
            (DAY1, DAY1 + HOUR), (DAY1 + HOUR, DAY1 + 2 * HOUR)]

    def test_a_missing_flagged_or_negative_bucket_adds_nothing(self) -> None:
        result = integrate_irradiance([
            IrradianceBucket(DAY1, 500.0),
            IrradianceBucket(DAY1 + HOUR, 900.0, good=False),   # flagged: not data
            IrradianceBucket(DAY1 + 2 * HOUR, None),            # nothing to average
            IrradianceBucket(DAY1 + 3 * HOUR, -2.0),            # a dark offset
            # DAY1 + 4h: no bucket at all — a gap stays a gap (Guardrail 18).
            IrradianceBucket(DAY1 + 5 * HOUR, 500.0),
        ], HOUR, LATE)
        assert abs(result.total - 1.0) < 1e-9

    def test_a_reading_is_held_across_the_stations_own_spacing(self) -> None:
        # GHI stored once a minute from a station sending every 86 s leaves
        # minutes empty by design; they were not dark.
        minute = timedelta(minutes=1)
        buckets = [IrradianceBucket(DAY1 + m * minute, 600.0) for m in (0, 2, 3, 5)]
        held = integrate_irradiance(buckets, minute, LATE, hold=2 * minute)
        assert abs(held.total - 0.6 * 6 / 60) < 1e-9
        assert held.steps[0].at == DAY1 + 2 * minute
        unheld = integrate_irradiance(buckets, minute, LATE)
        assert abs(unheld.total - 0.6 * 4 / 60) < 1e-9

    def test_a_gap_wider_than_the_hold_stays_a_gap(self) -> None:
        minute = timedelta(minutes=1)
        result = integrate_irradiance(
            [IrradianceBucket(DAY1, 600.0), IrradianceBucket(DAY1 + 10 * minute, 600.0)],
            minute, LATE, hold=2 * minute)
        assert abs(result.total - 0.6 * 2 / 60) < 1e-9

    def test_nothing_is_held_into_a_flagged_bucket(self) -> None:
        # SPINNING_AND_GENERAL_MILLS' stations send 6,550 at night: flagged,
        # not data, so the reading before it is not carried into it either.
        minute = timedelta(minutes=1)
        result = integrate_irradiance(
            [IrradianceBucket(DAY1, 600.0),
             IrradianceBucket(DAY1 + 2 * minute, 65_509.0, good=False)],
            minute, LATE, hold=2 * minute)
        assert abs(result.total - 0.6 / 60) < 1e-9

    def test_the_hold_covers_a_stations_own_spacing_and_never_a_missing_bucket(self) -> None:
        minute = timedelta(minutes=1)
        every_minute = [DAY1 + m * minute for m in range(60)]
        # GHI kept once a minute from a station sending every 86 s: one empty
        # minute now and then is by design.
        assert live_hold(every_minute, minute, 86.0) == timedelta(seconds=112)
        # Stored every five minutes (before 14 Oct 2026): four empty minutes.
        every_five = [DAY1 + m * minute for m in range(0, 60, 5)]
        assert live_hold(every_five, minute, 60.0) == timedelta(minutes=9)
        # Hourly buckets of a station sending every minute: a missing hour is
        # an hour nobody measured, never held.
        hourly = [DAY1 + h * HOUR for h in (0, 1, 2, 4, 5)]
        assert live_hold(hourly, HOUR, 60.0) == timedelta(0)

    def test_the_bucket_still_filling_spans_only_up_to_now(self) -> None:
        now = DAY1 + timedelta(minutes=15)
        result = integrate_irradiance([IrradianceBucket(DAY1, 800.0)], HOUR, now)
        assert abs(result.total - 0.2) < 1e-9


class TestChooseSource:
    def test_a_working_register_wins_over_the_live_sensor(self) -> None:
        # Both are the same sensor; the register is the station's own figure.
        assert choose_source(5.0, 5.4) == (5.0, "register")

    def test_a_register_stuck_at_zero_gives_way_to_the_live_sensor(self) -> None:
        assert choose_source(0.0, 1.14) == (1.14, "live_ghi")

    def test_at_dawn_neither_is_judged(self) -> None:
        # 0.00 beside 0.05 kWh/m² is a register one update behind, not a fault.
        assert choose_source(0.0, 0.05) == (0.0, "register")

    def test_a_station_with_only_one_uses_it(self) -> None:
        assert choose_source(None, 1.2) == (1.2, "live_ghi")
        assert choose_source(4.0, None) == (4.0, "register")
        assert choose_source(None, None) == (None, None)


class TestPlantIrradiation:
    def test_two_stations_are_averaged_not_summed(self) -> None:
        result = plant_irradiation([
            _register("WMS_1", (DAY1, 1.0), (DAY1 + 6 * HOUR, 4.0), device_id=1),
            _register("WMS_2", (DAY1, 2.0), (DAY1 + 6 * HOUR, 5.2), device_id=2),
        ])
        assert result.value is not None and abs(result.value - 3.1) < 1e-9
        assert result.from_live is False

    def test_a_register_climbing_faster_than_the_sun_is_refused(self) -> None:
        # 0.04 kWh/m² in one minute is 2.4 kWh/m² per hour: no sky does that.
        result = plant_irradiation([_register(
            "WMS", (DAY1, 2.0), (DAY1 + timedelta(minutes=1), 2.04), device_id=1)])
        assert result.value == 0.0
        register = result.stations[0].register
        assert register is not None
        assert [x.kind for x in register.anomalies] == ["implausible_jump"]

    def test_no_station_is_undefined(self) -> None:
        result = plant_irradiation([])
        assert result.value is None and result.undefined_reason is not None

    def test_two_stuck_registers_are_answered_by_their_live_sensors(self) -> None:
        # VARDHMAN_GROUP: AGHI 0 all day on both, GHI ~95 W/m².
        result = plant_irradiation(
            [_flat_register("WMS", DAY1, 0.0, device_id=1),
             _flat_register("WMS_WEST", DAY1, 0.0, device_id=2)],
            [_live("WMS", DAY1, 95.0, device_id=1), _live("WMS_WEST", DAY1, 96.0, device_id=2)])
        assert result.value is not None
        assert abs(result.value - (1.14 + 1.152) / 2) < 1e-9
        assert result.from_live is True
        assert [s.source for s in result.stations] == ["live_ghi", "live_ghi"]
        assert result.spread is None, "1% apart is two sensors agreeing"

    def test_a_station_reading_no_sun_beside_one_that_does_is_left_out(self) -> None:
        # One station repaired, one not: a mean of the two would halve the sun
        # and double the PR, and look entirely plausible doing it.
        result = plant_irradiation(
            [_register("WMS", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0), device_id=1),
             _flat_register("WMS_WEST", DAY1, 0.0, device_id=2)],
            [_live("WMS_WEST", DAY1, 0.0, device_id=2)])
        assert result.value == 5.0
        dead = next(s for s in result.stations if s.device_code == "WMS_WEST")
        assert not dead.used and dead.excluded_reason is not None
        assert "WMS read 5.00" in dead.excluded_reason
        assert [s.device_code for s in result.used] == ["WMS"]

    def test_a_station_with_no_register_bound_answers_from_its_live_sensor(self) -> None:
        result = plant_irradiation([], [_live("WMS", DAY1, 500.0, device_id=1)])
        assert result.value is not None and abs(result.value - 6.0) < 1e-9
        assert result.from_live is True

    def test_a_live_sensor_with_nothing_good_is_not_a_station(self) -> None:
        nothing = LiveIrradiance(1, "WMS", integrate_irradiance(
            [IrradianceBucket(DAY1, 900.0, good=False)], HOUR, LATE))
        assert plant_irradiation([], [nothing]).value is None

    def test_working_stations_that_disagree_are_flagged_never_resolved(self) -> None:
        result = plant_irradiation([
            _register("WMS", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0), device_id=1),
            _register("WMS_WEST", (DAY1, 0.0), (DAY1 + 12 * HOUR, 6.0), device_id=2),
        ])
        assert result.value == 5.5, "the mean is still used"
        assert result.spread is not None and abs(result.spread - 1.0 / 5.5) < 1e-9

    def test_stations_within_ten_percent_are_not_flagged(self) -> None:
        result = plant_irradiation([
            _register("WMS", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0), device_id=1),
            _register("WMS_WEST", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.3), device_id=2),
        ])
        assert result.spread is None


class TestByLabel:
    @staticmethod
    def _day(at: datetime) -> str:
        return at.date().isoformat()

    def test_a_register_that_stuck_on_one_day_gives_way_on_that_day_alone(self) -> None:
        register = _register(
            "WMS",
            (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0),          # the 14th: working
            (DAY2, 0.0), (DAY2 + 12 * HOUR, 0.0),          # the 15th: stuck at 0
            device_id=1)
        live = LiveIrradiance(1, "WMS", integrate_irradiance(
            [IrradianceBucket(DAY1 + i * HOUR, 400.0) for i in range(12)]
            + [IrradianceBucket(DAY2 + i * HOUR, 350.0) for i in range(12)], HOUR, LATE))
        by_day = irradiation_by_label(plant_irradiation([register], [live]), self._day)
        assert by_day["2026-10-14"] == 5.0, "its own register, where it worked"
        assert abs(by_day["2026-10-15"] - 4.2) < 1e-9, "its live GHI, where it did not"

    def test_a_station_dark_on_one_day_is_left_out_of_that_day_only(self) -> None:
        a = _register("WMS", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0),
                      (DAY2, 0.0), (DAY2 + 12 * HOUR, 4.0), device_id=1)
        b = _register("WMS_WEST", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.2),
                      (DAY2, 0.0), (DAY2 + 12 * HOUR, 0.0), device_id=2)
        by_day = irradiation_by_label(plant_irradiation([a, b]), self._day)
        assert abs(by_day["2026-10-14"] - 5.1) < 1e-9
        assert by_day["2026-10-15"] == 4.0, "WMS alone, not WMS halved"


class TestNotMeasuring:
    def test_a_working_tilted_sensor_is_left_alone(self) -> None:
        # Morning light on a tilted sensor reads well under horizontal, from the
        # diffuse sky alone — low, not dead.
        assert not_measuring([StationValues(1, "WMS", {"GHI": 300.0, "GTI": 120.0})]) == ()

    def test_temperatures_are_not_sun_readings(self) -> None:
        assert not_measuring([StationValues(1, "WMS", {
            "GHI": 650.0, "AMBIENT_TEMPERATURE": 0.0})]) == ()

    def test_a_dead_tilted_sensor_beside_a_live_horizontal_one(self) -> None:
        # Both VARDHMAN_GROUP stations send GTI 0 beside GHI ~95.
        withheld = not_measuring([
            StationValues(1, "WMS", {"GHI": 95.2, "GTI": 0.0, "MODULE_TEMPERATURE": 28.8}),
            StationValues(2, "WMS_WEST", {"GHI": 96.4, "GTI": 0.0}),
        ])
        assert sorted((w.device_code, w.tag_code) for w in withheld) == [
            ("WMS", "GTI"), ("WMS_WEST", "GTI")]
        assert "GHI at WMS_WEST reads 96" in withheld[0].reason

    def test_nothing_is_judged_at_night(self) -> None:
        assert not_measuring([StationValues(1, "WMS", {"GHI": 12.0, "GTI": 0.0})]) == ()

    def test_one_stations_sensor_dark_beside_anothers(self) -> None:
        withheld = not_measuring([
            StationValues(1, "WMS", {"GHI": 610.0}),
            StationValues(2, "WMS_WEST", {"GHI": 0.0}),
        ])
        assert [(w.device_code, w.tag_code) for w in withheld] == [("WMS_WEST", "GHI")]

    def test_a_daily_total_is_judged_only_against_other_stations(self) -> None:
        # At dawn a register reads 0.00 while the live sensor reads 60 W/m²:
        # a station alone is never judged on its total.
        assert not_measuring([
            StationValues(1, "WMS", {"GHI": 60.0, "GHI_CUMULATIVE": 0.0})]) == ()
        withheld = not_measuring([
            StationValues(1, "WMS", {"GHI_CUMULATIVE": 3.2}),
            StationValues(2, "WMS_WEST", {"GHI_CUMULATIVE": 0.0}),
        ])
        assert [(w.device_code, w.tag_code) for w in withheld] == [
            ("WMS_WEST", "GHI_CUMULATIVE")]

    def test_two_stuck_totals_are_left_as_they_are(self) -> None:
        # Nothing to judge them against at a moment; the period's figure is
        # where their live sensors stand in (`plant_irradiation`).
        assert not_measuring([
            StationValues(1, "WMS", {"GHI_CUMULATIVE": 0.0}),
            StationValues(2, "WMS_WEST", {"GHI_CUMULATIVE": 0.0}),
        ]) == ()

    def test_a_total_one_update_behind_at_dawn_is_not_dead(self) -> None:
        assert not_measuring([
            StationValues(1, "WMS", {"GHI_CUMULATIVE": 0.01}),
            StationValues(2, "WMS_WEST", {"GHI_CUMULATIVE": 0.0}),
        ]) == ()


class TestNotes:
    def test_a_report_says_where_its_sunlight_came_from(self) -> None:
        live = plant_irradiation(
            [_flat_register("WMS", DAY1, 0.0, device_id=1)],
            [_live("WMS", DAY1, 95.0, device_id=1)])
        notes = irradiation_notes(live, "SPINNING_AND_GENERAL_MILLS")
        assert len(notes) == 1
        assert notes[0].startswith("SPINNING_AND_GENERAL_MILLS: irradiation for WMS")
        assert "live GHI" in notes[0]

    def test_a_station_left_out_and_a_disagreement_are_each_named(self) -> None:
        left_out = plant_irradiation([
            _register("WMS", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0), device_id=1),
            _flat_register("WMS_WEST", DAY1, 0.0, device_id=2)])
        assert irradiation_notes(left_out) == [
            "WMS_WEST is left out of the irradiation: it read 0.00 kWh/m² while WMS read "
            "5.00 — not measuring."]
        apart = plant_irradiation([
            _register("WMS", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0), device_id=1),
            _register("WMS_WEST", (DAY1, 0.0), (DAY1 + 12 * HOUR, 6.0), device_id=2)])
        assert "differ by 18%" in irradiation_notes(apart)[0]

    def test_nothing_to_say_when_every_station_gave_its_own_total(self) -> None:
        plain = plant_irradiation([
            _register("WMS", (DAY1, 0.0), (DAY1 + 12 * HOUR, 5.0), device_id=1)])
        assert irradiation_notes(plain) == []


# ── The Irradiance tile (19 Oct 2026): both stations send GTI 0 beside GHI
# 653 and 658 W/m², and the tile, which prefers GTI, read 0 at noon.

IRRADIANCE = next(spec for spec in DEFAULT_SLOTS if spec.code == "env.irradiance")


def _facts(*stations: StationValues) -> PlantFacts:
    """The facts `services/dashboard.gather` builds: withheld values popped."""
    withheld = not_measuring(stations)
    held = {(w.device_id, w.tag_code) for w in withheld}
    return PlantFacts(
        plant_id=1,
        devices=tuple(
            DeviceFacts(
                device_id=s.device_id, code=s.device_code, device_type_code="WMS",
                bound_tag_codes=frozenset(s.values),
                values={tag: value for tag, value in s.values.items()
                        if (s.device_id, tag) not in held},
                online=True,
            )
            for s in stations
        ),
        withheld=withheld,
    )


class TestIrradianceTile:
    def test_a_dead_gti_falls_back_to_ghi_and_says_so(self) -> None:
        resolved = resolve_slot(IRRADIANCE, _facts(
            StationValues(1, "WMS", {"GHI": 653.0, "GTI": 0.0}),
            StationValues(2, "WMS_WEST", {"GHI": 658.1, "GTI": 0.0}),
        ))
        assert resolved.value is not None and abs(resolved.value - 655.55) < 1e-9
        assert resolved.source is not None
        assert resolved.source.tag_code == "GHI"
        assert resolved.source.degraded is True

    def test_a_working_gti_is_still_preferred(self) -> None:
        resolved = resolve_slot(IRRADIANCE, _facts(
            StationValues(1, "WMS", {"GHI": 650.0, "GTI": 720.0})))
        assert resolved.value == 720.0
        assert resolved.source is not None
        assert resolved.source.tag_code == "GTI"
        assert resolved.source.degraded is False

    def test_at_night_a_zero_gti_is_an_honest_zero(self) -> None:
        resolved = resolve_slot(IRRADIANCE, _facts(
            StationValues(1, "WMS", {"GHI": 0.0, "GTI": 0.0})))
        assert resolved.value == 0.0
        assert resolved.source is not None
        assert resolved.source.tag_code == "GTI"

    def test_one_dead_gti_of_two_no_longer_halves_the_average(self) -> None:
        resolved = resolve_slot(IRRADIANCE, _facts(
            StationValues(1, "WMS", {"GHI": 650.0, "GTI": 700.0}),
            StationValues(2, "WMS_WEST", {"GHI": 655.0, "GTI": 0.0}),
        ))
        assert resolved.value == 700.0
        assert resolved.source is not None
        assert resolved.source.tag_code == "GTI"
        assert resolved.source.device_count == 1
