"""Running, start, stop, peak and the grid — `domain/operating`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain.operating import (
    Breaker,
    grid_status,
    held_series,
    operating_day,
    peak,
    transition,
)

T0 = datetime(2026, 9, 24, 0, 0, tzinfo=UTC)


def _minutes(*values: float | None) -> list[tuple[datetime, float | None]]:
    return [(T0 + timedelta(minutes=index), value) for index, value in enumerate(values)]


# ── The rule ────────────────────────────────────────────────────────────────

def test_start_is_strictly_above_the_threshold() -> None:
    assert transition(False, 0.5) is None
    assert transition(False, 0.51) == "start"


def test_stop_is_at_or_below_zero_and_only_once_running() -> None:
    assert transition(True, 0.0) == "stop"
    assert transition(True, 0.2) is None
    assert transition(False, 0.0) is None


# ── A day ───────────────────────────────────────────────────────────────────

def test_a_plain_day_starts_at_the_first_crossing_and_stops_at_zero() -> None:
    day = operating_day(_minutes(0.0, 0.3, 1.2, 800.0, 40.0, 0.0, 0.0))
    assert day.start == T0 + timedelta(minutes=2)
    assert day.stop == T0 + timedelta(minutes=5)
    assert not day.running


def test_dawn_hovering_between_the_thresholds_neither_starts_nor_stops() -> None:
    day = operating_day(_minutes(0.0, 0.3, 0.4, 0.2))
    assert day.start is None and day.stop is None and not day.running


def test_still_running_has_no_stop() -> None:
    day = operating_day(_minutes(0.0, 2.0, 900.0))
    assert day.running and day.stop is None


def test_a_restart_takes_the_stop_back_and_keeps_the_first_start() -> None:
    day = operating_day(_minutes(0.0, 5.0, 0.0, 0.0, 6.0, 700.0))
    assert day.start == T0 + timedelta(minutes=1)
    assert day.stop is None
    assert day.running


def test_the_last_fall_of_the_day_is_the_stop() -> None:
    day = operating_day(_minutes(5.0, 0.0, 6.0, 0.0))
    assert day.stop == T0 + timedelta(minutes=3)


def test_silence_is_not_a_stop() -> None:
    day = operating_day(_minutes(0.0, 5.0, None, None))
    assert day.running
    assert day.stop is None
    assert day.last_sample == T0 + timedelta(minutes=1)


def test_each_transition_knows_the_sample_before_it() -> None:
    day = operating_day(_minutes(0.0, 1.0, 0.0))
    assert day.start_after == T0
    assert day.stop_after == T0 + timedelta(minutes=1)


def test_a_plant_first_heard_generating_has_nothing_before_its_start() -> None:
    # The first reading of the day is already above the threshold: when it
    # actually started is unknown, and `start_after` says so by being None.
    day = operating_day(_minutes(None, 900.0, 950.0))
    assert day.start == T0 + timedelta(minutes=1)
    assert day.start_after is None


def test_a_day_with_no_samples_says_nothing() -> None:
    day = operating_day([])
    assert day.start is None and day.stop is None and day.last_sample is None


# ── Peak ────────────────────────────────────────────────────────────────────

def test_peak_is_the_largest_and_the_earliest_wins_a_tie() -> None:
    assert peak(_minutes(1.0, 9.0, None, 9.0, 3.0)) == (T0 + timedelta(minutes=1), 9.0)


def test_peak_of_nothing_is_none() -> None:
    assert peak(_minutes(None, None)) is None


# ── The grid ────────────────────────────────────────────────────────────────

def test_no_breaker_means_no_grid_status_rather_than_connected() -> None:
    status = grid_status([])
    assert status.state is None
    assert status.reason is not None


def test_every_heard_breaker_closed_is_connected() -> None:
    status = grid_status([Breaker(True, True), Breaker(True, True)])
    assert status.state == "connected"
    assert (status.breakers, status.reporting, status.closed, status.open) == (2, 2, 2, 0)


def test_every_heard_breaker_open_is_disconnected() -> None:
    assert grid_status([Breaker(False, True)]).state == "disconnected"


def test_one_open_feeder_of_two_is_partial_not_a_guess() -> None:
    assert grid_status([Breaker(True, True), Breaker(False, True)]).state == "partial"


def test_a_silent_breaker_does_not_vote_on_its_stale_contact() -> None:
    status = grid_status([Breaker(True, False)])
    assert status.state == "unknown"
    assert status.reporting == 0

    mixed = grid_status([Breaker(True, True), Breaker(False, False)])
    assert mixed.state == "connected"
    assert mixed.reporting == 1 and mixed.breakers == 2


# ── Holding a Device's value between its own readings ──────────────────────

def test_a_sum_holds_each_device_between_its_own_readings() -> None:
    # Device 2 reports every other minute. Summed per bucket it would halve
    # the total in every minute it is absent from.
    rows = [
        (T0, 1, 10.0), (T0, 2, 10.0),
        (T0 + timedelta(minutes=1), 1, 10.0),
        (T0 + timedelta(minutes=2), 1, 10.0), (T0 + timedelta(minutes=2), 2, 10.0),
    ]
    hold = {1: timedelta(minutes=3), 2: timedelta(minutes=3)}
    assert [value for _, value in held_series(rows, hold, "sum")] == [20.0, 20.0, 20.0]


def test_a_hold_expires_rather_than_carrying_a_dead_device_forever() -> None:
    rows = [(T0, 1, 10.0), (T0, 2, 10.0), (T0 + timedelta(minutes=5), 1, 10.0)]
    hold = {1: timedelta(minutes=2), 2: timedelta(minutes=2)}
    assert [value for _, value in held_series(rows, hold, "sum")] == [20.0, 10.0]
