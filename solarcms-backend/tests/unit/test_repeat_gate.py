"""A line true of every message is logged once per window, with the count held back."""

from __future__ import annotations

from solarcms.logging import RepeatGate


def test_the_first_passes_and_repeats_inside_the_window_are_held() -> None:
    gate = RepeatGate(60)
    assert gate.allow("t", now=0) == 0
    assert gate.allow("t", now=10) is None
    assert gate.allow("t", now=59) is None
    # The next one through carries how many were held back.
    assert gate.allow("t", now=60) == 2
    assert gate.allow("t", now=61) is None


def test_keys_are_independent() -> None:
    gate = RepeatGate(60)
    assert gate.allow("a", now=0) == 0
    assert gate.allow("b", now=1) == 0
    assert gate.allow("a", now=2) is None


def test_it_stays_bounded_by_forgetting_the_oldest() -> None:
    gate = RepeatGate(60, max_keys=2)
    gate.allow("a", now=0)
    gate.allow("b", now=0)
    gate.allow("c", now=0)
    # "a" was forgotten, so it is allowed again early rather than growing for ever.
    assert gate.allow("a", now=1) == 0
    assert gate.allow("c", now=1) is None
