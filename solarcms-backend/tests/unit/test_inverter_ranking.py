"""The Inverter ranking's downtime rule (`domain/inverter_ranking.fold`).

Each case is a Plant drawn minute by minute: the rule's whole job is to tell a
machine that stood still while its neighbours ran from a sky that went dark.
"""

from __future__ import annotations

import pytest

from solarcms.domain.inverter_ranking import InverterMinutes, InverterTime
from solarcms.domain.inverter_ranking import fold as fold_all


def fold(*args, **kwargs) -> dict[int, InverterTime]:  # type: ignore[no-untyped-def]
    return fold_all(*args, **kwargs).inverters


def inverter(
    device_id: int, output: list[float | None], *, kwp: float | None = 100.0,
    hold: int = 0, planned: list[tuple[int, int]] | None = None,
) -> InverterMinutes:
    """One Inverter from a per-minute list of kW; None is a minute with no reading."""
    minutes = [t for t, value in enumerate(output) if value is not None]
    values = [float(value) for value in output if value is not None]
    return InverterMinutes(
        device_id=device_id, dc_kwp=kwp, hold_minutes=hold, minutes=minutes,
        mean_kw=values, peak_kw=values, planned=planned or [])


def test_a_stop_while_the_others_run_is_downtime_and_costs_their_rate() -> None:
    day = 120
    running = [50.0] * day
    stopped = [50.0] * 40 + [0.0] * 30 + [50.0] * 50
    result = fold([inverter(1, running), inverter(2, running), inverter(3, stopped)], day)

    down = result[3]
    assert down.downtime_minutes == 30
    assert down.judged_minutes == day
    assert down.availability == pytest.approx(90 / 120)
    # Neighbours made 50 kW from 100 kWp = 0.5 kW per kWp; this one has 100 kWp,
    # so each down minute lost 50 kW for a minute.
    assert down.lost_kwh == pytest.approx(50.0 * 30 / 60)
    assert [(s.start, s.end) for s in down.stops] == [(40, 70)]
    assert result[1].availability == 1.0
    assert result[1].lost_kwh == 0.0


def test_lost_energy_scales_with_the_stopped_inverter_own_size() -> None:
    running = [60.0] * 20
    stopped = [0.0] * 20
    result = fold([
        inverter(1, running, kwp=120.0), inverter(2, running, kwp=120.0),
        inverter(3, stopped, kwp=240.0),
    ], 20, min_stop_minutes=10)
    # 0.5 kW per kWp times 240 kWp = 120 kW for 20 minutes.
    assert result[3].lost_kwh == pytest.approx(40.0)


def test_night_judges_nobody() -> None:
    dark = [0.0] * 60
    result = fold([inverter(1, dark), inverter(2, dark)], 60)
    assert result[1].judged_minutes == 0
    assert result[1].downtime_minutes == 0
    assert result[1].availability is None
    assert "not generating" in (result[1].availability_reason or "")


def test_a_short_stop_is_available_not_down() -> None:
    running = [40.0] * 60
    blip = [40.0] * 20 + [0.0] * 5 + [40.0] * 35
    result = fold([inverter(1, running), inverter(2, running), inverter(3, blip)], 60,
                  min_stop_minutes=10)
    assert result[3].downtime_minutes == 0
    assert result[3].short_stop_minutes == 5
    assert result[3].availability == 1.0
    assert result[3].lost_kwh == 0.0
    assert result[3].stops == ()


def test_silence_is_no_data_never_downtime() -> None:
    running = [40.0] * 60
    silent: list[float | None] = [40.0] * 10 + [None] * 40 + [40.0] * 10
    result = fold([inverter(1, running), inverter(2, running), inverter(3, silent)], 60)
    assert result[3].no_data_minutes == 40
    assert result[3].downtime_minutes == 0
    # Judged over the 20 minutes it was heard, all of them producing.
    assert result[3].availability == 1.0


def test_a_value_holds_between_readings() -> None:
    every_third: list[float | None] = [40.0 if t % 3 == 0 else None for t in range(60)]
    running = [40.0] * 60
    result = fold([inverter(1, running), inverter(2, every_third, hold=2)], 60)
    assert result[2].no_data_minutes == 0
    assert result[2].producing_minutes == 60


def test_a_lone_inverter_has_nothing_to_compare_with() -> None:
    result = fold([inverter(1, [0.0] * 30)], 30)
    assert result[1].availability is None
    assert "only Inverter" in (result[1].availability_reason or "")
    assert result[1].lost_kwh is None


def test_dawn_is_not_a_fault_until_most_neighbours_are_up() -> None:
    # Of three others, only one is up: the sky, not this machine, is the question.
    early = [30.0] * 30
    asleep = [0.0] * 30
    result = fold([inverter(1, early), inverter(2, asleep), inverter(3, asleep),
                   inverter(4, asleep)], 30)
    assert result[4].judged_minutes == 0
    assert result[4].downtime_minutes == 0


def test_planned_work_is_neither_available_nor_down() -> None:
    running = [40.0] * 60
    serviced = [40.0] * 10 + [0.0] * 40 + [40.0] * 10
    result = fold([inverter(1, running), inverter(2, running),
                   inverter(3, serviced, planned=[(10, 50)])], 60)
    assert result[3].planned_minutes == 40
    assert result[3].downtime_minutes == 0
    assert result[3].availability == 1.0


def test_an_unsized_inverter_that_stopped_has_no_loss_figure() -> None:
    running = [40.0] * 30
    stopped = [0.0] * 30
    result = fold([inverter(1, running), inverter(2, running),
                   inverter(3, stopped, kwp=None)], 30, min_stop_minutes=10)
    assert result[3].downtime_minutes == 30
    assert result[3].lost_kwh is None
    assert result[3].lost_reason == "no DC size is recorded for this Inverter"


def test_an_unsized_inverter_that_never_stopped_lost_nothing() -> None:
    running = [40.0] * 30
    result = fold([inverter(1, running), inverter(2, running, kwp=None)], 30)
    assert result[2].lost_kwh == 0.0


def test_unsized_neighbours_leave_the_loss_undefined() -> None:
    running = [40.0] * 30
    result = fold([inverter(1, running, kwp=None), inverter(2, running, kwp=None),
                   inverter(3, [0.0] * 30)], 30, min_stop_minutes=10)
    assert result[3].lost_kwh is None
    assert result[3].lost_reason == "no generating neighbour has a DC size recorded"


def test_a_stop_still_running_at_the_end_is_marked_ongoing() -> None:
    running = [40.0] * 30
    stopping = [40.0] * 10 + [0.0] * 20
    result = fold([inverter(1, running), inverter(2, running), inverter(3, stopping)], 30)
    (stop,) = result[3].stops
    assert stop.ongoing is True
    assert (stop.start, stop.end) == (10, 30)


def test_a_value_held_from_before_the_window_counts_inside_it() -> None:
    # A reading one minute before the window (index -1) still holds at minute 0.
    held = InverterMinutes(device_id=2, dc_kwp=100.0, hold_minutes=2, minutes=[-1, 2],
                           mean_kw=[40.0, 40.0], peak_kw=[40.0, 40.0])
    result = fold([inverter(1, [40.0] * 3), held], 3)
    assert result[2].no_data_minutes == 0
    assert result[2].producing_minutes == 3


def test_coverage_counts_what_was_heard_and_generating() -> None:
    gap: list[float | None] = [0.0] * 10 + [None] * 20 + [40.0] * 30
    folded = fold_all([inverter(1, gap), inverter(2, gap)], 60)
    assert folded.minutes == 60
    assert folded.heard_minutes == 40
    assert folded.generating_minutes == 30
