"""Staleness, frozen values, completeness, and Collector correlation. Pure.

BACKEND_SPEC §10.2. A Device that stops transmitting generates no message and
therefore triggers nothing — the periodic sweep is the only mechanism that
detects a silent Device (MASTER §6.3).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Literal

from solarcms.domain.assumptions import (
    HEALTH_DEGRADED_MULTIPLIER,
    HEALTH_OFFLINE_MULTIPLIER,
)

CommStatus = Literal["online", "degraded", "offline", "unknown"]


@dataclass(frozen=True, slots=True)
class DeviceHealthInput:
    device_id: int
    plant_id: int
    client_id: int
    expected_interval_s: int
    last_seen_at: datetime | None
    # Per Tag: how many consecutive Readings carried an identical value. The
    # worker accumulates this; the threshold is applied here.
    consecutive_unchanged: dict[int, int] = field(default_factory=dict)
    readings_last_24h: int = 0
    reports_via_device_id: int | None = None


@dataclass(frozen=True, slots=True)
class HealthAssessment:
    device_id: int
    comm_status: CommStatus
    frozen_tag_count: int
    completeness_24h: float | None
    silent_for_s: float | None


def assess(
    device: DeviceHealthInput, now: datetime, *, frozen_threshold: int
) -> HealthAssessment:
    """Classify one Device's health.

    Multipliers are applied to `devices.expected_interval_s`, never to the assumed
    60 s default: the client's broker publishes every ~2.78 s, so a Device whose
    column still held the placeholder would be judged against an interval 21x too
    long and could sit silent for minutes while reading as healthy.
    """
    if device.last_seen_at is None:
        # Never seen is not offline: a Device registered during commissioning has
        # simply not started yet, and alarming on it would cry wolf at every
        # onboarding.
        status: CommStatus = "unknown"
        silent_for = None
    else:
        silent_for = (now - device.last_seen_at).total_seconds()
        interval = max(device.expected_interval_s, 1)
        if silent_for > interval * HEALTH_OFFLINE_MULTIPLIER:
            status = "offline"
        elif silent_for > interval * HEALTH_DEGRADED_MULTIPLIER:
            status = "degraded"
        else:
            status = "online"

    frozen = sum(1 for count in device.consecutive_unchanged.values()
                 if count >= frozen_threshold)

    completeness = None
    if device.expected_interval_s > 0:
        expected = timedelta(days=1).total_seconds() / device.expected_interval_s
        if expected > 0:
            # Capped at 1.0: a Device publishing faster than its declared interval
            # is not "120% complete", it is mis-registered.
            completeness = min(1.0, device.readings_last_24h / expected)

    return HealthAssessment(device.device_id, status, frozen, completeness, silent_for)


#: What a Device shares with the others that fail alongside it. Either the id
#: of the Device that transmits it (`reports_via_device_id` — a real datalogger,
#: registered as a Device) or the name of the enclosure it sits in
#: (`collector_code` — an MCR, an ICR; not a Device at all, migration 0022).
#:
#: One type, because the grouping logic is identical and the *question* is
#: identical: did these go quiet together for one reason. Only the label
#: differs, and it travels with the correlation so the Alarm can say which.
CollectorKey = int | str


@dataclass(frozen=True, slots=True)
class CollectorCorrelation:
    """One Collector's simultaneous silence, to be raised as a single Alarm."""

    collector: CollectorKey
    silent_device_ids: list[int]
    classification: str = "communication"

    @property
    def is_enclosure(self) -> bool:
        """True when the shared cause is a named enclosure, not a Device.

        Worth distinguishing in the Alarm text: "the MCR has gone quiet" and
        "DATALOGGER-03 has gone quiet" send an engineer to different places.
        """
        return isinstance(self.collector, str)


def correlate_collector_failures(
    assessments: list[HealthAssessment],
    collector_of: dict[int, CollectorKey | None],
    *, minimum_devices: int = 2,
) -> tuple[list[CollectorCorrelation], set[int]]:
    """Group simultaneous silences by Collector.

    Returns the correlations and the set of Device ids they absorb, so the caller
    raises **one** Collector Alarm instead of one per Device.

    This is the reason the communication grouping exists at all (MASTER §3.4).
    Without it, a failed Collector produces an Alarm per silent Device with no
    indication they share a cause, and — worse — records a communication failure
    as generation downtime, corrupting the availability figures that performance
    guarantees are calculated from. Tender §18 lists Communication Loss and
    Equipment Downtime as separate categories; the distinction is unbuildable
    otherwise.

    `collector_of` accepts either form of the grouping. Since migration 0022 a
    Collector is usually a *name* rather than a Device — an MCR is a room, and
    the twenty Inverters in it go silent together when its link drops exactly as
    they did when the room was (wrongly) registered as a Device. The caller
    supplies whichever it has; a Device with both is grouped by the transmitting
    Device, which is the more specific claim.
    """
    silent_by_collector: dict[CollectorKey, list[int]] = {}
    for assessment in assessments:
        if assessment.comm_status not in ("offline", "degraded"):
            continue
        collector = collector_of.get(assessment.device_id)
        # A Device that is its own Collector publishes directly; its silence is
        # its own fault and must not be grouped.
        if collector is None or collector == assessment.device_id:
            continue
        silent_by_collector.setdefault(collector, []).append(assessment.device_id)

    correlations: list[CollectorCorrelation] = []
    absorbed: set[int] = set()
    # Sorted by the key's text, not the key: `sorted()` over a mix of ints and
    # strs raises, and a fleet where some Devices report via a datalogger and
    # others sit in a named room produces exactly that mix.
    for collector in sorted(silent_by_collector, key=str):
        devices = silent_by_collector[collector]
        if len(devices) >= minimum_devices:
            correlations.append(CollectorCorrelation(collector, sorted(devices)))
            absorbed.update(devices)
    return correlations, absorbed


def uptime_seconds_from_events(
    events: list[tuple[datetime, str]],
    period_start: datetime,
    period_end: datetime,
    *, initial_status: str = "unknown",
) -> tuple[float, float]:
    """Time-weighted (uptime, excluded) over a period, from health transitions.

    Availability is computed from transitions, never from current state: a Device
    online now says nothing about the six hours it was offline this morning.

    `excluded` accumulates time attributed to communication loss, which tender §18
    requires be kept out of equipment downtime. `events` must be sorted by time
    and may begin before `period_start`.
    """
    if period_end <= period_start:
        return 0.0, 0.0

    status = initial_status
    for at, to_status in events:
        if at <= period_start:
            status = to_status
        else:
            break

    uptime = 0.0
    excluded = 0.0
    cursor = period_start

    for at, to_status in events:
        if at <= period_start or at >= period_end:
            continue
        span = (at - cursor).total_seconds()
        if status == "online":
            uptime += span
        elif status == "unknown":
            # Never-seen time is neither up nor down; counting it as downtime
            # would penalise a Plant for the days before it was commissioned.
            excluded += span
        cursor = at
        status = to_status

    span = (period_end - cursor).total_seconds()
    if status == "online":
        uptime += span
    elif status == "unknown":
        excluded += span

    return uptime, excluded
