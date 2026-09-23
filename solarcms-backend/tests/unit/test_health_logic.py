"""Correlating simultaneous silences into one cause.

This is the half of the health sweep that decides whether an operator is told
"the MCR link is down" or "twenty Inverters have failed". It is also where a
communication failure becomes generation downtime if it is got wrong, and
availability figures are what performance guarantees are paid against — so the
distinction is worth a test even though the grouping itself is four lines.

⚠ Since migration 0022 a Collector is usually a *name* — an enclosure, not a
Device — while a genuine datalogger relaying another Device is still a Device.
Both shapes go through the same function, which is what these fix in place.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain.health_logic import (
    HealthAssessment,
    correlate_collector_failures,
    uptime_seconds_from_events,
)


def silent(device_id: int, status: str = "offline") -> HealthAssessment:
    return HealthAssessment(
        device_id=device_id, comm_status=status,  # type: ignore[arg-type]
        frozen_tag_count=0, completeness_24h=0.0, silent_for_s=600.0,
    )


def healthy(device_id: int) -> HealthAssessment:
    return HealthAssessment(
        device_id=device_id, comm_status="online", frozen_tag_count=0,
        completeness_24h=1.0, silent_for_s=0.0,
    )


def test_an_enclosure_going_quiet_is_one_alarm_not_three() -> None:
    # Three Devices in the MCR, silent together. One cause, one Alarm — and the
    # three are absorbed so the caller does not also raise one each.
    correlations, absorbed = correlate_collector_failures(
        [silent(1), silent(2), silent(3)],
        {1: "MCR", 2: "MCR", 3: "MCR"},
    )
    assert len(correlations) == 1
    assert correlations[0].collector == "MCR"
    assert correlations[0].silent_device_ids == [1, 2, 3]
    assert correlations[0].is_enclosure
    assert absorbed == {1, 2, 3}


def test_a_transmitting_device_is_still_a_valid_grouping() -> None:
    # A real datalogger relaying two Inverters. Not an enclosure — the Alarm
    # should name a Device, because that is what an engineer goes to replace.
    correlations, _ = correlate_collector_failures(
        [silent(2), silent(3)], {2: 99, 3: 99},
    )
    assert correlations[0].collector == 99
    assert not correlations[0].is_enclosure


def test_one_silent_device_in_a_collector_is_its_own_failure() -> None:
    # The room is fine — everything else in it is reporting. Grouping here
    # would blame the collector for one broken machine.
    correlations, absorbed = correlate_collector_failures(
        [silent(1), healthy(2), healthy(3)],
        {1: "MCR", 2: "MCR", 3: "MCR"},
    )
    assert correlations == []
    assert absorbed == set()


def test_a_device_in_no_collector_is_never_grouped() -> None:
    # It publishes directly, so its silence is its own and there is nothing to
    # share the blame with.
    correlations, absorbed = correlate_collector_failures(
        [silent(1), silent(2)], {1: None, 2: None},
    )
    assert correlations == []
    assert absorbed == set()


def test_enclosures_and_dataloggers_can_be_mixed_in_one_fleet() -> None:
    # The realistic case, and the one that used to raise: `sorted()` over a set
    # holding both ints and strs is a TypeError, and a fleet where some Devices
    # sit in a named room while others report through a logger produces exactly
    # that mix.
    correlations, absorbed = correlate_collector_failures(
        [silent(1), silent(2), silent(3), silent(4)],
        {1: "MCR", 2: "MCR", 3: 99, 4: 99},
    )
    assert {c.collector for c in correlations} == {"MCR", 99}
    assert absorbed == {1, 2, 3, 4}


def test_degraded_counts_as_silent_for_correlation() -> None:
    # Degraded is "late past its expected interval". A collector link that is
    # dropping packets rather than dead produces a room full of these, and it
    # is the same one failure.
    correlations, _ = correlate_collector_failures(
        [silent(1, "degraded"), silent(2, "degraded")], {1: "ICR", 2: "ICR"},
    )
    assert len(correlations) == 1


def test_a_device_named_as_its_own_collector_is_not_grouped() -> None:
    # Data that should not exist, but a self-reference would otherwise make a
    # Device one member of its own group and read as a shared cause.
    correlations, _ = correlate_collector_failures(
        [silent(1), silent(2)], {1: 1, 2: 1},
    )
    assert correlations == []


# ── Availability over a period, from recorded transitions ──────────────────
#
# The KPI endpoint used to take the share of Devices online *now* and call it
# the period's availability, so it read 100% under "lifetime" for any Plant
# that happened to be healthy when asked.

T0 = datetime(2026, 9, 23, 0, 0, tzinfo=UTC)


def at(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


def test_offline_time_inside_the_period_is_not_uptime() -> None:
    events = [(at(-60), "online"), (at(30), "offline"), (at(40), "online")]
    uptime, excluded = uptime_seconds_from_events(events, at(0), at(60))
    assert (uptime, excluded) == (50 * 60, 0.0)


def test_the_status_carried_into_the_period_counts_from_its_start() -> None:
    # Offline since before the period began: the whole first stretch is down.
    events = [(at(-600), "offline"), (at(20), "online")]
    uptime, _ = uptime_seconds_from_events(events, at(0), at(60))
    assert uptime == 40 * 60


def test_never_seen_time_is_excluded_not_counted_as_down() -> None:
    events = [(at(-1), "unknown"), (at(15), "online")]
    uptime, excluded = uptime_seconds_from_events(events, at(0), at(60))
    assert (uptime, excluded) == (45 * 60, 15 * 60)


def test_transitions_after_the_period_are_ignored() -> None:
    events = [(at(-1), "online"), (at(90), "offline")]
    assert uptime_seconds_from_events(events, at(0), at(60)) == (60 * 60, 0.0)
