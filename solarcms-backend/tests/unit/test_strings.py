"""PV string verdicts — `domain/strings`."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain.strings import (
    STRING_STATES,
    StringReading,
    classify_strings,
    count_states,
    fresh,
    producing_median,
)

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
HOLD = timedelta(minutes=3)


def _strings(*currents: float | None) -> list[StringReading]:
    return [
        StringReading(n=index + 1, bound=True, current=value,
                      at=None if value is None else NOW - timedelta(minutes=1))
        for index, value in enumerate(currents)
    ]


def _states(readings: list[StringReading], *, generating: bool = True,
            known: bool = True) -> list[str]:
    verdicts, _ = classify_strings(
        readings, generating=generating, generating_known=known, now=NOW, hold=HOLD)
    return [verdict.state for verdict in verdicts]


# ── The five states ─────────────────────────────────────────────────────────

def test_a_string_well_below_its_neighbours_is_low() -> None:
    # Median of the producing strings is 8.0; 20% below is 6.4.
    assert _states(_strings(8.0, 8.1, 7.9, 6.3, 8.0)) == [
        "normal", "normal", "normal", "low", "normal"]


def test_just_inside_the_fraction_is_normal() -> None:
    assert _states(_strings(8.0, 8.0, 8.0, 6.5))[3] == "normal"


def test_no_current_while_generating_is_the_fault() -> None:
    assert _states(_strings(8.0, 0.0, 8.0)) == ["normal", "no_current", "normal"]


def test_no_current_at_night_is_idle_not_a_fault() -> None:
    assert _states(_strings(0.0, 0.0, 0.0), generating=False) == ["idle"] * 3


def test_an_unknown_operating_state_never_calls_zero_a_fault() -> None:
    verdicts, _ = classify_strings(
        _strings(0.0), generating=False, generating_known=False, now=NOW, hold=HOLD)
    assert verdicts[0].state == "idle"
    assert "not known" in verdicts[0].reason


def test_nothing_received_is_no_reading_never_zero() -> None:
    verdicts, _ = classify_strings(
        _strings(8.0, None), generating=True, generating_known=True, now=NOW, hold=HOLD)
    assert verdicts[1].state == "no_reading"
    assert verdicts[1].current is None


# ── Why a string has no reading, said precisely (Guardrail 26) ──────────────

def test_an_unbound_string_says_it_is_unbound() -> None:
    verdicts, _ = classify_strings(
        [StringReading(n=3, bound=False)], generating=True, generating_known=True,
        now=NOW, hold=HOLD)
    assert verdicts[0].state == "no_reading"
    assert "not bound" in verdicts[0].reason


def test_a_stale_value_is_not_judged() -> None:
    old = StringReading(n=1, bound=True, current=8.0, at=NOW - timedelta(minutes=20))
    verdicts, _ = classify_strings(
        [old], generating=True, generating_known=True, now=NOW, hold=HOLD)
    assert verdicts[0].state == "no_reading"
    assert verdicts[0].current is None
    assert "older" in verdicts[0].reason


def test_only_flagged_readings_are_named_as_such() -> None:
    verdicts, _ = classify_strings(
        [StringReading(n=1, bound=True, flagged=4)], generating=True,
        generating_known=True, now=NOW, hold=HOLD)
    assert verdicts[0].state == "no_reading"
    assert "flagged" in verdicts[0].reason


def test_freshness_counts_to_the_end_of_the_bucket() -> None:
    assert fresh(NOW - HOLD - timedelta(minutes=1), NOW, HOLD)
    assert not fresh(NOW - HOLD - timedelta(minutes=1, seconds=1), NOW, HOLD)
    assert not fresh(None, NOW, HOLD)


# ── The comparison ──────────────────────────────────────────────────────────

def test_the_median_ignores_dead_strings() -> None:
    # Over every string the median would be 0 and hide the low one; over the
    # producing strings it is 8.0, and 5.0 is plainly low against it.
    readings = _strings(0.0, 0.0, 0.0, 8.0, 8.0, 5.0)
    assert _states(readings) == [
        "no_current", "no_current", "no_current", "normal", "normal", "low"]
    assert producing_median([0.0, 0.0, 8.0, None, 6.0]) == 7.0
    assert producing_median([0.0, None]) is None


def test_weak_light_is_not_compared() -> None:
    # Median 1.0 A: a 40% gap is 0.4 A, which orientation alone produces.
    verdicts, reference = classify_strings(
        _strings(1.0, 1.0, 0.6), generating=True, generating_known=True,
        now=NOW, hold=HOLD)
    assert [v.state for v in verdicts] == ["normal"] * 3
    assert reference is None
    assert "too little light" in verdicts[2].reason


def test_nothing_is_compared_while_the_inverter_is_not_generating() -> None:
    verdicts, reference = classify_strings(
        _strings(8.0, 3.0), generating=False, generating_known=True, now=NOW, hold=HOLD)
    assert [v.state for v in verdicts] == ["normal", "normal"]
    assert reference is None


def test_the_reference_is_returned_only_when_used() -> None:
    _, reference = classify_strings(
        _strings(8.0, 8.0, 6.0), generating=True, generating_known=True,
        now=NOW, hold=HOLD)
    assert reference == 8.0


def test_counts_name_every_state() -> None:
    verdicts, _ = classify_strings(
        _strings(8.0, 0.0, None), generating=True, generating_known=True,
        now=NOW, hold=HOLD)
    counts = count_states(verdicts)
    assert set(counts) == set(STRING_STATES)
    assert counts == {"no_current": 1, "low": 0, "normal": 1, "idle": 0, "no_reading": 1}
