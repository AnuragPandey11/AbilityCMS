"""Grid, Plant and Inverter availability: one lost minute is blamed once. Plain values only."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime

import pytest

from solarcms.domain.availability import (
    Buckets,
    Controller,
    Inverter,
    Level,
    Meter,
    PlantMinutes,
    Tally,
    figures,
    fold,
    worst_inverter,
)
from solarcms.domain.sun import solar_elevation_deg

N = 600  # a ten-hour day, all of it daylight unless a test says otherwise


def series(device_id: int, value: Callable[[int], float | None], *,
           n: int = N, flagged: Callable[[int], bool] = lambda t: False,
           hold: int = 0) -> Buckets:
    """One bucket per minute where `value` gives one; None is a minute with nothing."""
    minutes, values, flags = [], [], []
    for t in range(n):
        v = value(t)
        if v is None:
            continue
        minutes.append(t)
        values.append(v)
        flags.append(flagged(t))
    return Buckets(device_id=device_id, hold_minutes=hold, minutes=minutes,
                   low=values, high=values, mean=values, flagged=flags)


def sunny(n: int = N) -> Buckets:
    return series(900, lambda t: 600.0, n=n)


def meter(frequency: Callable[[int], float | None], *,
          flagged: Callable[[int], bool] = lambda t: False) -> Meter:
    return Meter(device_id=800, frequency=series(800, frequency, flagged=flagged),
                 frequency_zero=0.1)


def inverters(count: int, power: Callable[[int, int], float | None]) -> list[Inverter]:
    return [Inverter(device_id=k, power=series(k, lambda t, k=k: power(k, t)))
            for k in range(1, count + 1)]


def as_percent(value: float | None) -> float | None:
    return None if value is None else round(100 * value, 1)


class TestTheWorkedExample:
    """The day the mockup showed: grid out an hour, a Plant-wide stop of 30
    minutes, INVERTER_7 down three hours — every Device reporting throughout."""

    def day(self) -> Tally:
        grid_out = range(120, 180)
        plant_stop = range(300, 330)

        def power(k: int, t: int) -> float:
            if t in grid_out or t in plant_stop:
                return 0.0
            if k == 7 and 400 <= t < 580:
                return 0.0
            return 120.0

        return fold(PlantMinutes(
            minutes=N, stations=[sunny()],
            # A meter that stays powered sends 0 Hz through the outage, which
            # its range refuses: stored flagged, and still the grid absent.
            meters=[meter(lambda t: 0.0 if t in grid_out else 50.0,
                          flagged=lambda t: t in grid_out)],
            inverters=inverters(17, power),
        ))

    def test_each_loss_is_blamed_on_one_level(self) -> None:
        tally = self.day()
        grid, plant, inverter, basis = figures(
            tally, has_meter=True, weights={k: 100.0 for k in range(1, 18)})
        assert as_percent(grid.value) == 90.0
        assert as_percent(plant.value) == 94.4
        assert as_percent(inverter.value) == 97.9
        assert basis == "capacity"

    def test_the_minutes_behind_it(self) -> None:
        tally = self.day()
        assert tally.daylight == 600
        assert tally.grid == Level(judged=600, down=60, no_data=0)
        assert tally.plant == Level(judged=540, down=30, no_data=0)
        assert tally.inverters[7] == Level(judged=510, down=180, no_data=0)
        assert tally.inverters[1] == Level(judged=510, down=0, no_data=0)
        assert worst_inverter(tally) == (7, 180)


class TestGrid:
    def test_a_frequency_outside_the_band_is_the_grid_unavailable(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()],
            meters=[meter(lambda t: 46.0 if t < 30 else 50.0)],
            inverters=inverters(2, lambda k, t: 50.0),
        ))
        assert tally.grid == Level(judged=600, down=30, no_data=0)

    def test_a_flagged_reading_that_is_not_zero_is_no_data(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()],
            meters=[meter(lambda t: 6553.5 if t < 30 else 50.0, flagged=lambda t: t < 30)],
            inverters=inverters(2, lambda k, t: 50.0),
        ))
        assert tally.grid == Level(judged=570, down=0, no_data=30)

    def test_float_noise_for_zero_is_absent(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()],
            meters=[meter(lambda t: 1.5e-17 if t < 10 else 50.0)],
            inverters=inverters(2, lambda k, t: 50.0),
        ))
        assert tally.grid.down == 10

    def test_a_silent_meter_is_no_data_and_the_plant_is_still_judged(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()],
            meters=[meter(lambda t: None if t < 60 else 50.0)],
            inverters=inverters(2, lambda k, t: 50.0),
        ))
        assert tally.grid == Level(judged=540, down=0, no_data=60)
        assert tally.plant.judged == 600
        assert tally.plant_without_grid == 60

    def test_a_plant_with_no_grid_meter_has_no_grid_figure(self) -> None:
        tally = fold(PlantMinutes(minutes=N, stations=[sunny()],
                                  inverters=inverters(2, lambda k, t: 50.0)))
        grid, plant, _, _ = figures(tally, has_meter=False, weights={1: None, 2: None})
        assert grid.value is None
        assert grid.reason is not None and "no grid meter" in grid.reason
        assert plant.value == 1.0
        assert tally.plant_without_grid == 600


class TestPlant:
    def test_an_open_breaker_with_the_grid_there_is_the_plants(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            breakers=[series(700, lambda t: 0.0 if 200 <= t < 260 else 1.0)],
            inverters=inverters(2, lambda k, t: 0.0 if 200 <= t < 260 else 50.0),
        ))
        assert tally.plant == Level(judged=600, down=60, no_data=0)
        assert tally.unattributed == 0

    def test_an_open_breaker_with_no_grid_reading_is_nobodys(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()],
            meters=[meter(lambda t: 0.0 if 200 <= t < 260 else 50.0)],
            breakers=[series(700, lambda t: 0.0 if 200 <= t < 260 else 1.0)],
            inverters=inverters(2, lambda k, t: 0.0 if 200 <= t < 260 else 50.0),
        ))
        assert tally.unattributed == 60
        assert tally.grid == Level(judged=540, down=0, no_data=0)
        assert tally.plant == Level(judged=540, down=0, no_data=0)

    def test_a_slow_dawn_is_not_a_stop(self) -> None:
        # Daylight is reached eight minutes before any Inverter wakes.
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            inverters=inverters(3, lambda k, t: 0.0 if t < 8 else 50.0),
        ))
        assert tally.plant == Level(judged=600, down=0, no_data=0)

    def test_curtailment_to_zero_is_neither_available_nor_down(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            controllers=[Controller(
                600,
                enable=series(600, lambda t: 1.0 if t < 120 else 0.0),
                setpoint=series(600, lambda t: 0.0),
            )],
            inverters=inverters(2, lambda k, t: 0.0 if t < 120 else 50.0),
        ))
        assert tally.curtailed == 120
        assert tally.plant == Level(judged=480, down=0, no_data=0)

    def test_a_setpoint_of_zero_without_control_is_not_curtailment(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            controllers=[Controller(600, enable=series(600, lambda t: 0.0),
                                    setpoint=series(600, lambda t: 0.0))],
            inverters=inverters(2, lambda k, t: 50.0),
        ))
        assert tally.curtailed == 0

    def test_planned_work_is_set_aside(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            inverters=inverters(2, lambda k, t: 0.0 if t < 90 else 50.0),
            planned=[(0, 90)],
        ))
        assert tally.planned == 90
        assert tally.plant == Level(judged=510, down=0, no_data=0)

    def test_nothing_heard_from_any_inverter_is_no_data(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            inverters=inverters(2, lambda k, t: None if t < 45 else 50.0),
        ))
        assert tally.plant == Level(judged=555, down=0, no_data=45)


class TestInverter:
    def test_a_lone_inverter_has_no_inverter_figure(self) -> None:
        tally = fold(PlantMinutes(minutes=N, stations=[sunny()],
                                  meters=[meter(lambda t: 50.0)],
                                  inverters=inverters(1, lambda k, t: 50.0)))
        _, _, inverter, _ = figures(tally, has_meter=True, weights={1: 100.0})
        assert inverter.value is None

    def test_weighted_by_capacity_where_every_size_is_recorded(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            # The small one is down half the day.
            inverters=inverters(2, lambda k, t: 0.0 if k == 2 and t < 300 else 50.0),
        ))
        _, _, by_size, basis = figures(tally, has_meter=True, weights={1: 300.0, 2: 100.0})
        assert basis == "capacity"
        assert by_size.value == pytest.approx((300 * 600 + 100 * 300) / (400 * 600))
        _, _, by_count, basis = figures(tally, has_meter=True, weights={1: 300.0, 2: None})
        assert basis == "count"
        assert by_count.value == pytest.approx(900 / 1200)

    def test_a_short_stop_is_not_counted(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[sunny()], meters=[meter(lambda t: 50.0)],
            inverters=inverters(2, lambda k, t: 0.0 if k == 2 and 100 <= t < 105 else 50.0),
        ))
        assert tally.inverters[2].down == 0
        assert worst_inverter(tally) is None


class TestDaylight:
    def test_night_is_not_counted(self) -> None:
        tally = fold(PlantMinutes(
            minutes=N, stations=[series(900, lambda t: 0.0 if t < 200 else 600.0)],
            meters=[meter(lambda t: 50.0)],
            inverters=inverters(2, lambda k, t: 0.0 if t < 200 else 50.0),
        ))
        assert tally.daylight == 400
        assert tally.plant == Level(judged=400, down=0, no_data=0)

    def test_before_dawn_every_figure_is_undefined_never_100(self) -> None:
        tally = fold(PlantMinutes(
            minutes=300, stations=[series(900, lambda t: 0.0, n=300)],
            meters=[meter(lambda t: 50.0)],
            inverters=inverters(2, lambda k, t: 0.0),
        ))
        grid, plant, inverter, _ = figures(tally, has_meter=True, weights={1: 1.0, 2: 1.0})
        assert (grid.value, plant.value, inverter.value) == (None, None, None)

    def test_a_dead_station_gives_way_to_the_suns_position(self) -> None:
        # GHI stuck at 0 all day while the sun is up: not measuring.
        tally = fold(PlantMinutes(
            minutes=N, stations=[series(900, lambda t: 0.0)],
            sun_elevation=[40.0] * N, meters=[meter(lambda t: 50.0)],
            inverters=inverters(2, lambda k, t: 50.0),
        ))
        assert tally.daylight == 600

    def test_with_no_station_and_no_location_nothing_is_judged(self) -> None:
        tally = fold(PlantMinutes(minutes=N, meters=[meter(lambda t: 50.0)],
                                  inverters=inverters(2, lambda k, t: 50.0)))
        assert tally.no_sun == 600
        _, plant, _, _ = figures(tally, has_meter=True, weights={1: 1.0, 2: 1.0})
        assert plant.value is None
        assert plant.reason is not None and "location" in plant.reason


def test_tallies_add_into_a_ratio_of_minutes_never_a_mean_of_days() -> None:
    a = Tally(daylight=600, grid=Level(600, 60, 0), plant=Level(540, 0, 0),
              inverters={1: Level(540, 0, 0), 2: Level(540, 54, 0)})
    b = Tally(daylight=60, grid=Level(60, 0, 0), plant=Level(60, 0, 0),
              inverters={1: Level(60, 0, 0), 2: Level(60, 0, 0)})
    total = a + b
    assert total.grid == Level(660, 60, 0)
    assert Tally.from_json(total.to_json()) == total
    grid, _, _, _ = figures(total, has_meter=True, weights={1: 1.0, 2: 1.0})
    assert grid.value == pytest.approx(600 / 660)


def test_the_suns_position_at_noon_in_ludhiana() -> None:
    # 30.9° N, 75.85° E; solar noon there is about 06:45 UTC in early November.
    noon = solar_elevation_deg(30.9, 75.85, datetime(2026, 11, 1, 6, 45, tzinfo=UTC))
    midnight = solar_elevation_deg(30.9, 75.85, datetime(2026, 11, 1, 18, 45, tzinfo=UTC))
    assert 43 < noon < 46
    assert midnight < -40
