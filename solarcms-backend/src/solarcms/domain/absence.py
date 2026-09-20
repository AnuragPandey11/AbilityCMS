"""Absence: what is *not* arriving, and what that costs. Pure — no I/O.

Every other alarm in this system is driven by a value arriving and being
compared against a threshold. Absence is the opposite case, and it is the one
that costs a Plant owner money:

* a Device that stops publishing may be a tripped inverter (generation being
  lost right now) or a dead datalogger (generation fine, history being lost) —
  and the two are different lines in an availability report, per tender §18;
* a topic that publishes and is registered to nothing is having its data
  **discarded** on every message, silently, for as long as nobody looks;
* a Plant that goes entirely quiet cannot be detected per-Device at all,
  because per-Device checks are driven by data that is no longer coming.

`domain/health_logic.py` already classifies one Device's silence and correlates
simultaneous silences by Collector. This module turns those judgements into the
set of Alarm conditions that *should* be open, and decides which observed topics
are live enough to be worth registering. The caller diffs that set against what
is open and writes the difference (Guardrail 9 — nothing here touches a
database).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal

from solarcms.domain.assumptions import (
    HEALTH_DEGRADED_MULTIPLIER,
    UNREGISTERED_LIVENESS_FLOOR_S,
)
from solarcms.domain.health_logic import CollectorCorrelation, CollectorKey

#: Rule codes this module plans for. They are `operator = 'special'` rows in
#: `alarm_rules` — conditions with no Tag to compare, evaluated on a timer by the
#: health sweep rather than off the reading stream.
RULE_COMM_LOST: Final = "COMM_LOST"
RULE_COLLECTOR_OFFLINE: Final = "COLLECTOR_OFFLINE"
RULE_UNREGISTERED_PUBLISHING: Final = "UNREGISTERED_DEVICE_PUBLISHING"
RULE_PLANT_SILENT: Final = "PLANT_SILENT"

#: Communication loss and equipment downtime are separate categories in the
#: tender, and availability is computed with the first excluded. Absence alone
#: never proves which it is, so everything here is classified `communication`:
#: claiming equipment downtime we cannot evidence would understate availability
#: and cost the owner against a performance guarantee.
CLASSIFICATION: Final = "communication"

TopicLiveness = Literal["live", "silent"]


@dataclass(frozen=True, slots=True)
class AbsenceCondition:
    """One absence that should currently have an Alarm open.

    `device_id` and `subject` are alternatives, not both. A Device going quiet
    is about a Device; a Collector, a Plant or an unregistered topic is about
    something that has no `devices` row, and `subject` names it so two of them
    can be told apart under one rule.
    """

    rule_code: str
    client_id: int
    plant_id: int | None
    device_id: int | None
    subject: str | None
    message: str
    #: How long this condition has demonstrably held, for the rule's own
    #: `duration_s` debounce. Derived from the data every sweep — the silence so
    #: far, or how long a topic has been publishing unregistered — rather than
    #: remembered between sweeps, so a restart cannot reset a debounce and a
    #: flapping link cannot open an Alarm by being down at the right moments.
    #: None means "cannot be dated", which never satisfies a non-zero debounce.
    held_for_s: float | None = None

    @property
    def key(self) -> tuple[str, int | None, str | None]:
        """What makes this condition the same one on the next sweep.

        Deduplication is ultimately the database's partial unique index; this is
        what lets the caller diff desired against open without writing first.
        """
        return (self.rule_code, self.device_id, self.subject)


@dataclass(frozen=True, slots=True)
class DeviceAbsenceInput:
    device_id: int
    client_id: int
    plant_id: int
    code: str
    comm_status: str
    collector: CollectorKey | None
    #: Seconds since this Device was last heard, for the rule's debounce.
    silent_for_s: float | None = None
    #: True while a maintenance window covers this Device. A planned outage must
    #: raise nothing and must not be recorded as downtime — otherwise routine
    #: work degrades the availability figure a performance guarantee is paid on.
    suppressed: bool = False


def plan_device_absence(
    devices: list[DeviceAbsenceInput],
    correlations: list[CollectorCorrelation],
    absorbed: set[int],
) -> list[AbsenceCondition]:
    """The COMM_LOST / COLLECTOR_OFFLINE conditions that should be open.

    ⚠ A Device absorbed into a Collector correlation gets **no** Alarm of its
    own. Seventeen Inverters behind one dead datalogger is one failure with one
    engineer to send; seventeen Alarms bury the cause and, worse, read as
    seventeen pieces of equipment having failed.
    """
    suppressed_ids = {d.device_id for d in devices if d.suppressed}
    by_id = {d.device_id: d for d in devices}
    conditions: list[AbsenceCondition] = []

    for correlation in correlations:
        members = [by_id[i] for i in correlation.silent_device_ids if i in by_id]
        # A Collector whose every silent member is under planned maintenance is
        # planned work, not a failure.
        if not members or all(m.suppressed for m in members):
            continue
        where = (
            f"enclosure {correlation.collector}" if correlation.is_enclosure
            else f"device {correlation.collector}"
        )
        conditions.append(AbsenceCondition(
            rule_code=RULE_COLLECTOR_OFFLINE,
            client_id=members[0].client_id,
            plant_id=members[0].plant_id,
            device_id=None,
            subject=str(correlation.collector),
            message=(
                f"{len(correlation.silent_device_ids)} Devices stopped reporting "
                f"together via {where}. Treated as communication loss, not "
                f"equipment downtime, until proven otherwise."
            ),
            # The shortest silence in the group: the enclosure has only
            # demonstrably been down as long as its most recently heard member.
            held_for_s=min(
                (m.silent_for_s for m in members if m.silent_for_s is not None),
                default=None,
            ),
        ))

    for device in devices:
        if device.comm_status not in ("offline", "degraded"):
            continue
        if device.device_id in absorbed or device.device_id in suppressed_ids:
            continue
        conditions.append(AbsenceCondition(
            rule_code=RULE_COMM_LOST,
            client_id=device.client_id,
            plant_id=device.plant_id,
            device_id=device.device_id,
            subject=None,
            message=f"{device.code} has stopped reporting ({device.comm_status}).",
            held_for_s=device.silent_for_s,
        ))

    return conditions


def classify_topic_liveness(
    last_seen_at: datetime | None,
    observed_interval_s: float | None,
    now: datetime,
    *,
    floor_s: int = UNREGISTERED_LIVENESS_FLOOR_S,
) -> TopicLiveness:
    """Is this topic still publishing, judged against its own cadence?

    A fixed clock cannot answer this. A Device on an 86 s cycle is late after
    three minutes; a daily total is fine after twenty hours. So the threshold is
    a multiple of the topic's *own* measured interval — the same multiple the
    health sweep applies to a registered Device, so "silent" means one thing in
    this codebase rather than two that drift.

    `floor_s` covers the topic seen once, which has no gap to measure and would
    otherwise be judged against nothing.
    """
    if last_seen_at is None:
        return "silent"
    threshold = float(floor_s)
    if observed_interval_s is not None and observed_interval_s > 0:
        threshold = max(threshold, observed_interval_s * HEALTH_DEGRADED_MULTIPLIER)
    return "silent" if (now - last_seen_at).total_seconds() > threshold else "live"


@dataclass(frozen=True, slots=True)
class ObservedTopicInput:
    topic: str
    plant_id: int | None
    client_id: int | None
    last_seen_at: datetime | None
    observed_interval_s: float | None
    registered: bool
    ignored: bool = False
    #: How long this topic has been publishing with nothing registered for it.
    #: Debounces the case that fixes itself — an engineer registering a Device a
    #: minute after the equipment first speaks.
    publishing_for_s: float | None = None


def plan_unregistered_publishing(
    topics: list[ObservedTopicInput], now: datetime
) -> list[AbsenceCondition]:
    """Topics publishing **right now** that no Device is registered for.

    This is the most expensive silent failure in the system: every message is
    quarantined rather than decoded, so the equipment exists, runs, and produces
    no history at all. It stays invisible until somebody opens a screen.

    Only `live` topics qualify. A topic that stopped two days ago is a retired
    shape, not equipment awaiting registration, and alarming on it would train
    the operator to ignore the alarm that matters.
    """
    conditions: list[AbsenceCondition] = []
    for topic in topics:
        if topic.registered or topic.ignored or topic.client_id is None:
            continue
        if classify_topic_liveness(
            topic.last_seen_at, topic.observed_interval_s, now
        ) != "live":
            continue
        conditions.append(AbsenceCondition(
            rule_code=RULE_UNREGISTERED_PUBLISHING,
            client_id=topic.client_id,
            plant_id=topic.plant_id,
            device_id=None,
            subject=topic.topic,
            message=(
                f"{topic.topic} is publishing but no Device is registered for it. "
                f"Its data is being quarantined, not recorded."
            ),
            held_for_s=topic.publishing_for_s,
        ))
    return conditions


def assess_plant_silence(
    device_intervals_s: list[int], messages_in_window: int, window_s: float
) -> bool:
    """Has this whole Plant gone quiet?

    Per-Device checks cannot see this. If a subscription filter matches nothing,
    or the broker is unreachable, then nothing is delivered — so nothing is
    quarantined, nothing is stale in a way anything looks at, and no per-Device
    rule fires, because every one of them is driven by data that is no longer
    arriving. Twenty-seven hours of that has happened here before.

    Judged against the *slowest* registered Device: a Plant whose least frequent
    publisher is hourly has said nothing wrong by being quiet for ten minutes.
    """
    if messages_in_window > 0 or not device_intervals_s:
        return False
    return window_s > max(device_intervals_s) * HEALTH_DEGRADED_MULTIPLIER


def in_maintenance(
    now: datetime, windows: list[tuple[datetime, datetime | None]]
) -> bool:
    """Is `now` inside any window? An open-ended window has not finished yet."""
    return any(
        start <= now and (end is None or now < end) for start, end in windows
    )


#: Below this, a figure computed over the period is reported as incomplete.
#: ⚠ ASSUMED — the client has not stated what coverage a reportable figure
#: requires, and a settlement-grade number will want more than a dashboard one.
COVERAGE_COMPLETE_RATIO: Final = 0.95


@dataclass(frozen=True, slots=True)
class Coverage:
    """How much of a period actually has data behind it.

    A figure computed over a period with a hole in it is not wrong in a way
    anybody can see: an average over fewer samples is still an average, and a
    total over a gap is simply smaller. So a gap reads as underperformance, or —
    worse, for availability — as nothing having happened.

    Reporting the coverage beside the figure is what makes the difference
    visible. It never corrects the number; correcting it would be inventing
    data. It says how much of the period the number actually saw.
    """

    expected_samples: int
    received_samples: int
    ratio: float | None
    missing_seconds: float
    excluded_seconds: float

    @property
    def complete(self) -> bool:
        return self.ratio is not None and self.ratio >= COVERAGE_COMPLETE_RATIO


def assess_coverage(
    expected_samples: int, received_samples: int, period_s: float,
    *, excluded_seconds: float = 0.0,
) -> Coverage:
    """Coverage of one period, and how much of it is unaccounted for.

    `excluded_seconds` is planned work: time deliberately kept out of the
    reckoning, which is not the same as time we simply have no data for. A
    maintenance window is an explained absence and must not count against the
    Plant; a gap is an unexplained one and must be visible.
    """
    if expected_samples <= 0:
        # Nothing was expected, so nothing is missing — and a ratio of 1.0 here
        # would claim complete coverage of a period with no Devices in it.
        return Coverage(0, received_samples, None, 0.0, excluded_seconds)

    ratio = min(1.0, received_samples / expected_samples)
    accounted = max(0.0, period_s - excluded_seconds)
    return Coverage(
        expected_samples=expected_samples,
        received_samples=received_samples,
        ratio=ratio,
        missing_seconds=max(0.0, accounted * (1.0 - ratio)),
        excluded_seconds=excluded_seconds,
    )


def diff_conditions(
    desired: list[AbsenceCondition],
    open_keys: set[tuple[str, int | None, str | None]],
) -> tuple[list[AbsenceCondition], set[tuple[str, int | None, str | None]]]:
    """(to open, to clear).

    An Alarm already open stays open and is not rewritten — a fault persisting
    six hours is one row, and re-opening it would both duplicate the record and
    re-notify whoever is already dealing with it.
    """
    desired_keys = {c.key for c in desired}
    to_open = [c for c in desired if c.key not in open_keys]
    to_clear = open_keys - desired_keys
    return to_open, to_clear
