"""What the broker sends that the platform cannot use or does not trust.

Every failure this module looks for has the same shape: nothing errors. A key
the equipment renamed decodes to nothing and the Tag simply stops; a topic
nobody registered is quarantined on every message; a string topic left
unattached throws away a whole Inverter's PV inputs; a value in the wrong unit
is stored *flagged* and the chart goes blank. Each one reads, on every other
screen, as quiet equipment. This turns each into a named row with the fix the
platform offers beside it — the Data Issues screen.

── Three kinds, by what ignoring them costs ────────────────────────────────
* ``data_lost`` — data is being thrown away on every message, and it does not
  come back: raw history is the only copy and it is kept for 90 days.
* ``data_wrong`` — data is kept but cannot be trusted as shown: rejected
  values, a recorded interval that makes a healthy Device read as late, and a
  burst of replayed messages stored at the time they *arrived*.
* ``setup`` — a screen cannot answer until a fact is entered: string counts,
  Inverter type and size, the Plant's capacity.

── What this module never does ─────────────────────────────────────────────
It never decides anything. A rename is *suggested* when exactly one new key
means the same Tag as exactly one key that stopped (the Type-aware alias
table, as commissioning uses), and a move when a silent Device's code reappears
on a live topic — both are confirmed by a person, because the topic is the
sole authority for origin (Guardrail 5) and a binding decides how every future
value is read. Nothing is inferred about meaning: a value outside its range is
reported with its range, never rescaled.

Pure (Guardrail 9): the service gathers facts, this classifies them.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from solarcms.domain.assumptions import (
    DATA_ISSUE_FLAGGED_SHARE,
    DATA_ISSUE_IDLE_ZERO_FRACTION,
    DATA_ISSUE_INTERVAL_FASTER,
    DATA_ISSUE_INTERVAL_MIN_GAPS,
    DATA_ISSUE_INTERVAL_SLOWER,
    DATA_ISSUE_STRING_CURRENT_A,
    QUALITY_GOOD,
    QUALITY_OUT_OF_RANGE,
    alias_for,
)
from solarcms.domain.commissioning import match_device_type, string_topic_owner

Category = Literal["data_lost", "data_wrong", "setup"]

CATEGORY_ORDER: Mapping[str, int] = {"data_lost": 0, "data_wrong": 1, "setup": 2}

# Device Types whose PV inputs arrive as `PVn_CURRENT` (OPEN-24).
STRING_DEVICE_TYPES = frozenset({"INVERTER", "SMB"})

_PV_CURRENT = re.compile(r"^PV(\d+)_CURRENT$")
# Any Tag of a PV input: its current, voltage or power.
_PV_INPUT = re.compile(r"^PV(\d+)_")
_DIGITS = re.compile(r"(\d+)")


# ── Facts, gathered by `services/data_issues.py` ────────────────────────────


@dataclass(frozen=True, slots=True)
class BindingFact:
    """One payload key → Tag mapping on one Device."""

    binding_id: int
    source_key: str
    tag_code: str
    unit: str | None
    enabled: bool
    scale: float
    value_offset: float
    valid_min: float | None
    valid_max: float | None


@dataclass(frozen=True, slots=True)
class TagHealth:
    """One Tag's recent values on one Device, where any were rejected.

    `flagged_min`/`flagged_max` span the *out-of-range* values only; an
    unreadable value has no number to report.
    """

    tag_code: str
    total: int
    out_of_range: int
    unparseable: int
    latest_quality: int = QUALITY_GOOD
    latest_value: float | None = None
    flagged_min: float | None = None
    flagged_max: float | None = None
    # The range the values were judged against: the binding's, else the Tag's.
    valid_min: float | None = None
    valid_max: float | None = None
    # How many of the last few values were rejected: what is happening *now*,
    # so a mapping fixed ten minutes ago is not still reported for an hour.
    recent_rejected: int = 0

    @property
    def latest_rejected(self) -> bool:
        return self.latest_quality != QUALITY_GOOD

    def accepted_now(self, low: float | None, high: float | None) -> bool:
        """Whether the *current* range admits values that were rejected.

        The range is read as it stands now, so values rejected under a range
        somebody has since widened — 40960 against an assumed 0-1000 status
        code — stop being an issue the moment the range is corrected.
        """
        if low is None or high is None:
            return False
        return (self.valid_min is None or low >= self.valid_min) and (
            self.valid_max is None or high <= self.valid_max
        )

    def idle_zero(self, low: float | None, high: float | None) -> bool:
        """Whether out-of-range values all sit at zero: equipment saying "nothing".

        Judged against the Tag's own range, so -1 W/m² is near zero for an
        irradiance (0 to 1500) and 0 Hz is, exactly, for a frequency (45 to 55).
        """
        if low is None or high is None:
            return False
        span = (
            abs(self.valid_max - self.valid_min)
            if self.valid_min is not None and self.valid_max is not None else 0.0
        )
        tolerance = span * DATA_ISSUE_IDLE_ZERO_FRACTION
        return -tolerance <= low and high <= tolerance


@dataclass(frozen=True, slots=True)
class DeviceFact:
    """Everything one registered Device is, and has recently sent."""

    device_id: int
    code: str
    type_code: str
    status: str
    comm_status: str
    collector_code: str | None
    primary_topic: str | None
    expected_interval_s: int
    string_count: int | None = None
    rated_capacity_kw: float | None = None
    variant: str | None = None
    bindings: tuple[BindingFact, ...] = ()
    # Messages read on all of its topics inside the payload window. Zero means
    # nothing can be said about its keys or its cadence.
    recent_messages: int = 0
    # Every key those messages carried, with its most recent value.
    recent_keys: Mapping[str, Any] = field(default_factory=dict)
    last_heard: datetime | None = None
    # Median gap on its primary topic, and how many gaps it was taken over.
    measured_interval_s: float | None = None
    measured_gaps: int = 0
    tag_health: tuple[TagHealth, ...] = ()
    # PV input number → the most current it carried in the string window.
    string_current_max: Mapping[int, float] = field(default_factory=dict)

    @property
    def publishes(self) -> bool:
        """A Device with no topic is synthetic (the Plant KPI panel) or unfinished."""
        return self.type_code != "PLANT_KPI"


@dataclass(frozen=True, slots=True)
class UnregisteredTopic:
    """A topic naming this Plant, publishing now, that no Device is registered on."""

    topic: str
    device_code: str
    collector_code: str | None
    last_seen: datetime
    messages: int
    interval_s: float | None
    keys: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class ReplayBurst:
    """Messages one topic cannot have sent live, grouped by the minute they arrived."""

    minute: datetime
    messages: int
    topics: int


@dataclass(frozen=True, slots=True)
class PlantFacts:
    plant_id: int
    plant_code: str
    ac_capacity_kw: float | None
    dc_capacity_kwp: float | None
    devices: tuple[DeviceFact, ...]
    # None when the caller cannot see them. An unregistered topic is quarantined
    # with no Client (Guardrail 5), so only a platform administrator can — and
    # "nothing unregistered" must never be claimed to someone who could not look.
    unregistered: tuple[UnregisteredTopic, ...] | None
    replay_bursts: tuple[ReplayBurst, ...] = ()
    device_type_codes: frozenset[str] = frozenset()
    tag_codes: frozenset[str] = frozenset()


# ── The answer ──────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class DataIssue:
    """One thing to fix, named for a person rather than for the schema.

    ``key`` is stable across requests for as long as the same thing is wrong, so
    a person can mark it known and it stays marked.
    """

    key: str
    kind: str
    category: Category
    title: str
    detail: str
    device_id: int | None = None
    device_code: str | None = None
    facts: Mapping[str, Any] = field(default_factory=dict)


def natural_key(code: str) -> tuple[Any, ...]:
    """INVERTER_2 before INVERTER_10, as a person counts."""
    return tuple(int(part) if part.isdigit() else part for part in _DIGITS.split(code))


def find_issues(plant: PlantFacts) -> list[DataIssue]:
    """Every issue on one Plant, most costly first."""
    devices = [d for d in plant.devices if d.status != "decommissioned"]
    issues: list[DataIssue] = []

    moved: set[int] = set()
    # Keys an unattached string topic carries, per owning Device: they stopped
    # arriving *because* the topic is not attached, which that one row says.
    detached_keys: dict[int, set[str]] = {}
    if plant.unregistered is not None:
        topic_issues = list(_topic_issues(plant, devices, moved))
        issues.extend(topic_issues)
        for issue in topic_issues:
            if issue.kind == "string_topic_unattached" and issue.device_id is not None:
                detached_keys.setdefault(issue.device_id, set()).update(issue.facts["keys"])

    publishing = [d for d in devices if d.publishes and d.status == "active"]
    plant_silent = bool(publishing) and all(d.recent_messages == 0 for d in publishing)
    if plant_silent:
        issues.append(DataIssue(
            key=f"plant_silent:{plant.plant_id}",
            kind="plant_silent", category="data_lost",
            title="Nothing is arriving from this Plant",
            detail=(
                f"None of its {len(publishing)} Devices has sent anything recently. "
                "If other Plants are arriving, the site's connection is down; if "
                "none are, check System Health."
            ),
            facts={"devices": len(publishing)},
        ))

    for device in devices:
        if not device.publishes:
            continue
        issues.extend(_device_issues(
            device, plant, plant_silent=plant_silent, moved=device.device_id in moved,
            detached_keys=detached_keys.get(device.device_id, set())))

    issues.extend(_plant_issues(plant))

    return sorted(issues, key=lambda i: (
        CATEGORY_ORDER[i.category],
        natural_key(i.device_code or ""),
        i.kind,
        i.key,
    ))


# ── Topics nobody registered ────────────────────────────────────────────────


def _topic_issues(
    plant: PlantFacts, devices: list[DeviceFact], moved: set[int]
) -> Iterable[DataIssue]:
    assert plant.unregistered is not None
    by_code = {d.code: d for d in devices}
    orphan_strings: dict[str, list[UnregisteredTopic]] = {}

    for topic in sorted(plant.unregistered, key=lambda t: natural_key(t.device_code)):
        owner_code = string_topic_owner(topic.device_code)
        if owner_code is not None:
            owner = by_code.get(owner_code)
            if owner is None:
                orphan_strings.setdefault(owner_code, []).append(topic)
                continue
            if owner.collector_code == topic.collector_code:
                yield DataIssue(
                    key=f"string_topic:{topic.topic}",
                    kind="string_topic_unattached", category="data_lost",
                    title=f"{owner.code}'s string readings arrive on a topic that is not attached",
                    detail=(
                        f"{topic.device_code} carries the PV string readings of "
                        f"{owner.code}. Until it is attached to {owner.code}, every "
                        "one of its messages is thrown away."
                    ),
                    device_id=owner.device_id, device_code=owner.code,
                    facts={**_topic_facts(topic), "owner_device_id": owner.device_id,
                           "owner_code": owner.code},
                )
                continue
            # The owner sits in another enclosure: the topic names a different
            # Collector, which only the topic may decide (Guardrail 13). Not a
            # string topic of *that* Device, so it falls through as unregistered.

        registered = by_code.get(topic.device_code)
        if (
            registered is not None
            and registered.primary_topic != topic.topic
            and registered.status == "active"
            and (registered.recent_messages == 0
                 or registered.comm_status in ("offline", "degraded"))
        ):
            moved.add(registered.device_id)
            yield DataIssue(
                key=f"topic_moved:{registered.device_id}:{topic.topic}",
                kind="topic_moved", category="data_lost",
                title=f"{registered.code} seems to have moved to a new topic",
                detail=(
                    f"{registered.code} stopped sending on its registered topic, and a "
                    "Device with the same name started sending on a new one. Moving "
                    "it keeps its history in one place; registering the new topic as "
                    "a separate Device would split it in two."
                ),
                device_id=registered.device_id, device_code=registered.code,
                facts={**_topic_facts(topic), "old_topic": registered.primary_topic},
            )
            continue

        suggested = match_device_type(topic.device_code, plant.device_type_codes)
        yield DataIssue(
            key=f"unregistered:{topic.topic}",
            kind="unregistered_topic", category="data_lost",
            title=f"{topic.device_code} is sending data but is not registered",
            detail=(
                "Every message from it is being thrown away. "
                + (
                    f"A Device called {topic.device_code} is already registered on "
                    "another topic and is still sending, so this one cannot take the "
                    "same name — check the equipment's settings, or dismiss the topic."
                    if registered is not None else
                    "Register it to start keeping its data."
                    if suggested is not None else
                    "No Device Type matches its name, so choose the closest when "
                    "registering; a new kind of equipment needs a developer."
                )
            ),
            device_code=topic.device_code,
            facts={**_topic_facts(topic), "suggested_type": suggested,
                   "code_taken": registered is not None},
        )

    for owner_code, topics in sorted(orphan_strings.items(), key=lambda kv: natural_key(kv[0])):
        suggested = match_device_type(owner_code, plant.device_type_codes)
        first = topics[0]
        yield DataIssue(
            key=f"unregistered_strings:{owner_code}:{first.collector_code or ''}",
            kind="unregistered_strings", category="data_lost",
            title=(f"String readings for {owner_code} are arriving, but {owner_code} "
                   "is not registered"),
            detail=(
                f"{len(topics)} topic(s) carry the PV string readings of {owner_code}, "
                "which publishes nothing else. Registering it keeps them, as one "
                "Device with every topic attached."
            ),
            device_code=owner_code,
            facts={
                "owner_code": owner_code,
                "suggested_type": suggested,
                "collector_code": first.collector_code,
                "topics": [_topic_facts(t) for t in topics],
            },
        )


def _topic_facts(topic: UnregisteredTopic) -> dict[str, Any]:
    return {
        "topic": topic.topic,
        "device_code": topic.device_code,
        "collector_code": topic.collector_code,
        "last_seen": topic.last_seen,
        "messages": topic.messages,
        "interval_s": round(topic.interval_s) if topic.interval_s else None,
        "keys": list(topic.keys),
    }


# ── One Device ──────────────────────────────────────────────────────────────


def _device_issues(
    device: DeviceFact, plant: PlantFacts, *, plant_silent: bool, moved: bool,
    detached_keys: set[str],
) -> Iterable[DataIssue]:
    if device.recent_messages == 0:
        # Silence is reported once, by the Plant, when everything is silent; and
        # not at all for a Device already reported as having moved.
        if not plant_silent and not moved and device.status == "active" \
                and device.primary_topic:
            yield DataIssue(
                key=f"device_silent:{device.device_id}",
                kind="device_silent", category="data_lost",
                title=f"{device.code} has stopped sending",
                detail=(
                    "Nothing has arrived from it recently while the rest of the "
                    "Plant is sending. Check the equipment and its network; if it "
                    "was replaced and now sends under another name, its new topic "
                    "appears here once a platform administrator can see it."
                ),
                device_id=device.device_id, device_code=device.code,
                facts={"last_heard": device.last_heard, "topic": device.primary_topic},
            )
    else:
        yield from _key_issues(device, plant, detached_keys)
        yield from _interval_issues(device)
    yield from _rejected_issues(device)
    yield from _string_issues(device, detached_keys)
    yield from _inverter_issues(device)


def _key_issues(
    device: DeviceFact, plant: PlantFacts, detached_keys: set[str],
) -> Iterable[DataIssue]:
    bound_keys = {b.source_key for b in device.bindings}
    unmapped = sorted((k for k in device.recent_keys if k not in bound_keys), key=natural_key)
    silent = [
        b for b in device.bindings
        if b.enabled and b.source_key not in device.recent_keys
        and b.source_key not in detached_keys
    ]
    by_tag = {b.tag_code: b for b in device.bindings}

    # A rename is one stopped key and one new key that the alias table reads as
    # the same Tag — and only when that pairing is unambiguous both ways.
    renamed_keys: set[str] = set()
    renamed_bindings: set[int] = set()
    for binding in silent:
        candidates = [
            k for k in unmapped
            if k not in renamed_keys and alias_for(k, device.type_code) == binding.tag_code
        ]
        if len(candidates) != 1:
            continue
        new_key = candidates[0]
        renamed_keys.add(new_key)
        renamed_bindings.add(binding.binding_id)
        yield DataIssue(
            key=f"key_renamed:{device.device_id}:{binding.source_key}:{new_key}",
            kind="key_renamed", category="data_lost",
            title=f"{device.code}: {binding.source_key} seems to have been renamed to {new_key}",
            detail=(
                f"{binding.source_key} stopped arriving and {new_key} started, and both "
                f"mean {binding.tag_code}. Renaming the mapping keeps the values "
                "flowing into the same place, with its scale and range unchanged."
            ),
            device_id=device.device_id, device_code=device.code,
            facts={**_binding_facts(binding), "new_key": new_key,
                   "sample": device.recent_keys.get(new_key)},
        )

    for key in unmapped:
        if key in renamed_keys:
            continue
        suggestion = alias_for(key, device.type_code)
        if suggestion is not None and plant.tag_codes and suggestion not in plant.tag_codes:
            suggestion = None
        taken = by_tag.get(suggestion) if suggestion else None
        yield DataIssue(
            key=f"unmapped:{device.device_id}:{key}",
            kind="unmapped_key", category="data_lost",
            title=f"{device.code} sends {key}, which is not mapped",
            detail=(
                f"Values of {key} are thrown away until it is mapped to a Tag."
                + (
                    f" It usually means {suggestion}"
                    + (f", which this Device already takes from {taken.source_key}."
                       if taken is not None else ".")
                    if suggestion else ""
                )
            ),
            device_id=device.device_id, device_code=device.code,
            facts={
                "source_key": key,
                "sample": device.recent_keys.get(key),
                "suggested_tag_code": suggestion,
                "suggested_taken_by": taken.source_key if taken is not None else None,
                "suggested_binding_id": taken.binding_id if taken is not None else None,
            },
        )

    # PV string inputs stop together — their whole topic is missing — so they
    # are one row per Device, never one per input.
    remaining = [b for b in silent if b.binding_id not in renamed_bindings]
    pv = [b for b in remaining if _PV_INPUT.match(b.tag_code)]
    if pv:
        inputs = sorted({int(m.group(1)) for b in pv if (m := _PV_INPUT.match(b.tag_code))})
        yield DataIssue(
            key=f"strings_silent:{device.device_id}",
            kind="strings_not_arriving", category="data_lost",
            title=f"{device.code}: string inputs {_ranges(inputs)} have stopped arriving",
            detail=(
                f"{len(pv)} mapped PV string reading(s) are missing from the Device's "
                "recent messages. String readings usually arrive on a topic of their "
                "own; "
                + (
                    "if that topic is not attached, the platform administrator can "
                    "attach it here or in Plants & Devices."
                    if plant.unregistered is None else
                    "no unattached string topic for it is publishing, so the "
                    "equipment has stopped sending them — or never had these inputs."
                )
            ),
            device_id=device.device_id, device_code=device.code,
            facts={
                "binding_ids": [b.binding_id for b in pv],
                "keys": [b.source_key for b in pv],
                "inputs": inputs,
            },
        )

    for binding in remaining:
        if binding in pv:
            continue
        yield DataIssue(
            key=f"binding_silent:{device.device_id}:{binding.source_key}",
            kind="binding_silent", category="data_lost",
            title=f"{device.code}: {binding.source_key} has stopped arriving",
            detail=(
                f"{binding.tag_code} is mapped to {binding.source_key}, but the "
                "Device's recent messages do not include it, so it has no new "
                "values. If the equipment renamed it, map the new name; if it no "
                "longer sends it, stop expecting it."
            ),
            device_id=device.device_id, device_code=device.code,
            facts=_binding_facts(binding),
        )


def _binding_facts(binding: BindingFact) -> dict[str, Any]:
    return {
        "binding_id": binding.binding_id,
        "source_key": binding.source_key,
        "tag_code": binding.tag_code,
        "unit": binding.unit,
        "scale": binding.scale,
        "value_offset": binding.value_offset,
        "valid_min": binding.valid_min,
        "valid_max": binding.valid_max,
        "enabled": binding.enabled,
    }


def _interval_issues(device: DeviceFact) -> Iterable[DataIssue]:
    measured = device.measured_interval_s
    expected = device.expected_interval_s
    if measured is None or measured <= 0 or expected <= 0 \
            or device.measured_gaps < DATA_ISSUE_INTERVAL_MIN_GAPS:
        return
    ratio = measured / expected
    rounded = max(1, round(measured))
    facts = {"expected_interval_s": expected, "measured_interval_s": rounded}
    if ratio > DATA_ISSUE_INTERVAL_SLOWER:
        yield DataIssue(
            key=f"interval:{device.device_id}",
            kind="interval_slower", category="data_wrong",
            title=f"{device.code} sends less often than recorded",
            detail=(
                f"It is recorded as sending every {expected} s but actually sends "
                f"every ~{rounded} s, so it is shown as late or degraded even "
                "when it is working."
            ),
            device_id=device.device_id, device_code=device.code, facts=facts,
        )
    elif ratio < DATA_ISSUE_INTERVAL_FASTER:
        yield DataIssue(
            key=f"interval:{device.device_id}",
            kind="interval_faster", category="data_wrong",
            title=f"{device.code} sends more often than recorded",
            detail=(
                f"It is recorded as sending every {expected} s but actually sends "
                f"every ~{rounded} s. If it stops, it takes longer than it should "
                "for that to be noticed."
            ),
            device_id=device.device_id, device_code=device.code, facts=facts,
        )


def _rejected_issues(device: DeviceFact) -> Iterable[DataIssue]:
    by_tag = {b.tag_code: b for b in device.bindings}
    for health in device.tag_health:
        if health.total == 0:
            continue
        # Out-of-range values that all sit at zero are equipment saying
        # "nothing" (an Inverter asleep, a pyranometer at night): not counted.
        out_of_range = (
            0 if health.idle_zero(health.flagged_min, health.flagged_max)
            or health.accepted_now(health.flagged_min, health.flagged_max)
            else health.out_of_range
        )
        rejected = out_of_range + health.unparseable
        if rejected == 0:
            continue
        latest_counts = health.latest_rejected and not (
            health.latest_quality == QUALITY_OUT_OF_RANGE
            and (health.idle_zero(health.latest_value, health.latest_value)
                 or health.accepted_now(health.latest_value, health.latest_value))
        )
        # Reported when it is happening now: the latest value rejected, or an
        # intermittent rejection among the last few that is a real share of the
        # hour. A rejection that stopped — a fixed scale — is not reported.
        if not latest_counts and (
            health.recent_rejected == 0 or rejected / health.total < DATA_ISSUE_FLAGGED_SHARE
        ):
            continue
        binding = by_tag.get(health.tag_code)
        empty = health.unparseable >= out_of_range
        facts: dict[str, Any] = {
            "tag_code": health.tag_code,
            "rejected": rejected,
            "total": health.total,
            "out_of_range": out_of_range,
            "unparseable": health.unparseable,
            "latest_rejected": latest_counts,
            "latest_value": health.latest_value,
            "flagged_min": health.flagged_min if out_of_range else None,
            "flagged_max": health.flagged_max if out_of_range else None,
            "valid_min": health.valid_min,
            "valid_max": health.valid_max,
            # A Tag with no binding is computed from others (`tags.formula`):
            # there is no mapping to correct, only its inputs.
            "derived": binding is None,
        }
        if binding is not None:
            facts.update(_binding_facts(binding))
        if empty:
            title = f"{device.code}: {health.tag_code} is arriving empty"
            detail = (
                f"{health.unparseable} of {health.total} recent values were empty or "
                "not a number. That is almost always the equipment or its "
                "datalogger, not the mapping — raise it with the client."
            )
        else:
            title = f"{device.code}: {health.tag_code} values are being rejected"
            detail = (
                f"{out_of_range} of {health.total} recent values were outside the "
                "allowed range, so they are kept but not shown. "
                + (
                    "It is calculated from other readings, so one of those is the cause."
                    if binding is None else
                    "A wrong unit or scale on the mapping causes this; so does a "
                    "fault in the equipment."
                )
            )
        yield DataIssue(
            key=f"rejected:{device.device_id}:{health.tag_code}",
            kind="values_rejected", category="data_wrong",
            title=title, detail=detail,
            device_id=device.device_id, device_code=device.code, facts=facts,
        )


def _string_issues(device: DeviceFact, detached_keys: set[str]) -> Iterable[DataIssue]:
    if device.type_code not in STRING_DEVICE_TYPES or device.recent_messages == 0:
        return
    # An input on a string topic not yet attached is still being *sent*; it is
    # the attaching that is missing, and that has a row of its own.
    sent = sorted(
        int(match.group(1))
        for b in device.bindings
        if b.enabled and (b.source_key in device.recent_keys or b.source_key in detached_keys)
        and (match := _PV_CURRENT.match(b.tag_code)) is not None
    )
    if not sent:
        return
    highest = sent[-1]
    working = [
        n for n in sent if device.string_current_max.get(n, 0.0) > DATA_ISSUE_STRING_CURRENT_A
    ]
    facts: dict[str, Any] = {
        "string_count": device.string_count,
        "inputs_sent": highest,
        "inputs_with_current": len(working),
    }
    if device.string_count is None:
        yield DataIssue(
            key=f"string_count_missing:{device.device_id}",
            kind="string_count_missing", category="setup",
            title=f"{device.code}: number of strings not set",
            detail=(
                f"It sends readings for {highest} PV string inputs, but String "
                "Analysis shows none of them until the number of strings is set."
            ),
            device_id=device.device_id, device_code=device.code, facts=facts,
        )
        return
    hidden = [n for n in working if n > device.string_count]
    if hidden:
        yield DataIssue(
            key=f"strings_hidden:{device.device_id}",
            kind="strings_hidden", category="data_wrong",
            title=f"{device.code}: {len(hidden)} working string(s) are not shown",
            detail=(
                f"Its string count is {device.string_count}, but input(s) "
                f"{_ranges(hidden)} above that carry current, so String Analysis "
                "leaves them out."
            ),
            device_id=device.device_id, device_code=device.code,
            facts={**facts, "hidden": hidden},
        )
    elif device.string_count > highest:
        yield DataIssue(
            key=f"string_count_high:{device.device_id}",
            kind="string_count_high", category="setup",
            title=f"{device.code}: string count is higher than what arrives",
            detail=(
                f"It is set to {device.string_count}, but only {highest} string "
                f"inputs arrive, so inputs above {highest} show no reading."
            ),
            device_id=device.device_id, device_code=device.code, facts=facts,
        )


def _inverter_issues(device: DeviceFact) -> Iterable[DataIssue]:
    if device.type_code != "INVERTER":
        return
    sends_strings = any(
        _PV_CURRENT.match(b.tag_code) and b.source_key in device.recent_keys
        for b in device.bindings
    )
    if device.variant is None:
        yield DataIssue(
            key=f"inverter_type:{device.device_id}",
            kind="inverter_type_missing", category="setup",
            title=f"{device.code}: inverter type not set",
            detail=(
                "Inverter Monitoring compares an Inverter only with others of the "
                "same type — string or central — so it cannot rank this one yet."
                + (" It reports PV string inputs of its own, which is how a string "
                   "inverter reports." if sends_strings else "")
            ),
            device_id=device.device_id, device_code=device.code,
            facts={"sends_strings": sends_strings},
        )
    if not device.rated_capacity_kw:
        yield DataIssue(
            key=f"inverter_capacity:{device.device_id}",
            kind="inverter_capacity_missing", category="setup",
            title=f"{device.code}: rated size not set",
            detail=(
                "Without its rated kW its output cannot be compared with other "
                "Inverters, and its specific yield cannot be calculated."
            ),
            device_id=device.device_id, device_code=device.code,
            facts={"rated_capacity_kw": device.rated_capacity_kw},
        )


def _plant_issues(plant: PlantFacts) -> Iterable[DataIssue]:
    if plant.dc_capacity_kwp is None or plant.ac_capacity_kw is None:
        missing = [
            name for name, value in (("DC capacity", plant.dc_capacity_kwp),
                                     ("AC capacity", plant.ac_capacity_kw))
            if value is None
        ]
        yield DataIssue(
            key=f"plant_capacity:{plant.plant_id}",
            kind="plant_capacity_missing", category="setup",
            title=f"{' and '.join(missing)} not set for this Plant",
            detail=(
                "Performance Ratio divides by the DC capacity (kWp) and CUF by the "
                "AC capacity (kW); without them both read as a dash."
            ),
            facts={"ac_capacity_kw": plant.ac_capacity_kw,
                   "dc_capacity_kwp": plant.dc_capacity_kwp},
        )
    if plant.replay_bursts:
        bursts = sorted(plant.replay_bursts, key=lambda b: b.minute)
        latest = bursts[-1]
        messages = sum(b.messages for b in bursts)
        # One row per Plant, keyed on the latest burst: acknowledging it covers
        # every burst so far, and the next one brings the row back.
        yield DataIssue(
            key=f"replay:{plant.plant_id}:{latest.minute.isoformat()}",
            kind="replay_burst", category="data_wrong",
            title=(
                f"Old messages arrived in a burst {len(bursts)} time(s) recently"
                if len(bursts) > 1 else
                f"{latest.messages} old messages arrived in one burst"
            ),
            detail=(
                f"{messages} messages arrived faster than the equipment sends them "
                "— a backlog released all at once, by the broker after a reconnect "
                "or by the site's datalogger after its own connection dropped. "
                "These messages carry no time of measurement, so they were stored "
                "at the moment they arrived: readings in those minutes may belong "
                "to an earlier time. Ask the client whether the datalogger can add "
                "a timestamp to each message."
            ),
            facts={
                "bursts": [{"minute": b.minute, "messages": b.messages,
                            "topics": b.topics} for b in bursts],
                "messages": messages,
                "latest": latest.minute,
            },
        )


def _ranges(numbers: list[int]) -> str:
    """[17, 18, 19, 22] → '17-19, 22'."""
    out: list[str] = []
    start = prev = numbers[0]
    for n in numbers[1:]:
        if n == prev + 1:
            prev = n
            continue
        out.append(f"{start}-{prev}" if prev != start else str(start))
        start = prev = n
    out.append(f"{start}-{prev}" if prev != start else str(start))
    return ", ".join(out)
