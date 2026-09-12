"""Threshold, debounce and hysteresis evaluation. Pure — no I/O.

BACKEND_SPEC §10.1. The alarm worker consumes the ingest stream and never queries
`readings`, so alarm latency is independent of write batching. This module holds
the decision; the worker holds the state and the writes.

One Alarm Rule breaching continuously on one Device produces exactly **one**
Alarm, not one per Reading. That is enforced twice: here, by returning NO_CHANGE
while an Alarm is already open, and in the database by the partial unique index
on (rule_id, device_id) WHERE state IN ('active','acknowledged').
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from enum import StrEnum
from typing import Literal

Severity = Literal["critical", "high", "medium", "low"]
SEVERITY_ORDER: dict[str, int] = {"low": 0, "medium": 1, "high": 2, "critical": 3}


class Action(StrEnum):
    OPEN = "open"
    CLEAR = "clear"
    NO_CHANGE = "no_change"


@dataclass(frozen=True, slots=True)
class AlarmRuleSpec:
    """An evaluable rule. `operator='special'` rules are not handled here — they
    need sibling comparison or silence detection, which are not per-Reading
    decisions (see `health_logic` and the worker's comparative pass)."""

    rule_id: int
    code: str
    tag_id: int | None
    # gt | lt | outside | inside | eq | is_true | is_false | special
    #
    # is_true / is_false carry no threshold. They exist because the client's VCB
    # and Transformer publish nothing but Digital Input contacts — there is no
    # analogue value to compare, and expressing "the Buchholz relay tripped" as
    # `eq 1.0` invites someone to give it a range that means nothing
    # (docs/TAG_CATALOGUE.md §5.2).
    operator: str
    threshold: float | None
    threshold_high: float | None
    clear_threshold: float | None
    duration_s: int
    severity: Severity
    scope_type: str = "global"
    scope_id: int | None = None
    classification: str | None = None


@dataclass(frozen=True, slots=True)
class RuleState:
    """Per (rule, device) evaluation state, held in Redis by the worker.

    `first_breach_at` is the debounce clock. `is_open` mirrors the database so a
    restart does not re-raise an Alarm that is already active.
    """

    first_breach_at: datetime | None = None
    is_open: bool = False


# RuleState is frozen, so one shared instance is safe to reuse as a default.
IDLE_STATE: RuleState = RuleState()


@dataclass(frozen=True, slots=True)
class AlarmAction:
    rule_id: int
    action: Action
    severity: Severity
    value: float
    message: str
    classification: str | None = None
    # The state the worker should persist after acting on this decision.
    next_state: RuleState = field(default=IDLE_STATE)


SCOPE_SPECIFICITY: dict[str, int] = {
    "device": 0, "plant": 1, "device_type": 2, "client": 3, "global": 4
}


def resolve_rules(rules: list[AlarmRuleSpec]) -> list[AlarmRuleSpec]:
    """Most-specific-wins per rule code: device → plant → device_type → client →
    global. A rule with a global scope is a platform default, inherited until
    something more specific overrides it — so a Client tuning one threshold does
    not have to restate the whole catalogue.
    """
    best: dict[str, AlarmRuleSpec] = {}
    for rule in rules:
        incumbent = best.get(rule.code)
        if incumbent is None or (
            SCOPE_SPECIFICITY.get(rule.scope_type, 9)
            < SCOPE_SPECIFICITY.get(incumbent.scope_type, 9)
        ):
            best[rule.code] = rule
    return sorted(best.values(), key=lambda r: r.code)


def is_breaching(rule: AlarmRuleSpec, value: float) -> bool:
    """Whether `value` breaches `rule` right now, ignoring debounce."""
    match rule.operator:
        case "gt":
            return rule.threshold is not None and value > rule.threshold
        case "lt":
            return rule.threshold is not None and value < rule.threshold
        case "outside":
            return (
                rule.threshold is not None
                and rule.threshold_high is not None
                and (value < rule.threshold or value > rule.threshold_high)
            )
        case "inside":
            return (
                rule.threshold is not None
                and rule.threshold_high is not None
                and rule.threshold <= value <= rule.threshold_high
            )
        case "eq":
            return rule.threshold is not None and value == rule.threshold
        case "is_true":
            # A contact is closed. Compared against 0.5 rather than == 1.0 so a
            # field encoding of 1/0, true/false, or a scaled 100 all read alike.
            return value >= 0.5
        case "is_false":
            return value < 0.5
        case _:
            return False


def has_cleared(rule: AlarmRuleSpec, value: float) -> bool:
    """Whether an open Alarm should clear.

    Hysteresis: clear at `clear_threshold` when set, otherwise at `threshold`.
    Without it, a value hovering on a threshold opens and closes an Alarm
    repeatedly and buries the operator in notifications for one condition.
    """
    # A Digital Input has no hysteresis band: the contact is either closed or it
    # is not. Chattering is handled by debounce, not by a clear threshold.
    if rule.operator in ("is_true", "is_false"):
        return not is_breaching(rule, value)

    if rule.clear_threshold is None:
        return not is_breaching(rule, value)

    match rule.operator:
        case "gt":
            return value <= rule.clear_threshold
        case "lt":
            return value >= rule.clear_threshold
        case _:
            # For range operators a single clear_threshold is ambiguous, so fall
            # back to the plain inverse rather than guessing which bound it means.
            return not is_breaching(rule, value)


def evaluate(
    value: float,
    quality: int,
    rules: list[AlarmRuleSpec],
    state: dict[int, RuleState],
    now: datetime,
) -> list[AlarmAction]:
    """Decide OPEN / CLEAR / NO_CHANGE per rule. Pure.

    Unparseable and out-of-range Readings are deliberately **not** evaluated: a
    sensor returning 3.29151E-41 would breach every threshold at once and bury
    the real fault under a hundred spurious Alarms. The bad value is still stored
    and flagged, and the frozen/quality checks in `health_logic` are what surface
    it.
    """
    actions: list[AlarmAction] = []
    for rule in rules:
        if rule.operator == "special":
            continue  # not a per-Reading decision
        current = state.get(rule.rule_id, RuleState())

        if quality != 0:
            actions.append(
                AlarmAction(rule.rule_id, Action.NO_CHANGE, rule.severity, value,
                            "skipped: reading not good quality", rule.classification,
                            current)
            )
            continue

        if current.is_open:
            if has_cleared(rule, value):
                actions.append(
                    AlarmAction(
                        rule.rule_id, Action.CLEAR, rule.severity, value,
                        f"{rule.code} cleared at {value:g}", rule.classification,
                        RuleState(first_breach_at=None, is_open=False),
                    )
                )
            else:
                actions.append(
                    AlarmAction(rule.rule_id, Action.NO_CHANGE, rule.severity, value,
                                "still breaching", rule.classification, current)
                )
            continue

        if not is_breaching(rule, value):
            # Reset the debounce clock: a breach must be *continuous* for
            # duration_s, not merely cumulative across an intermittent fault.
            actions.append(
                AlarmAction(rule.rule_id, Action.NO_CHANGE, rule.severity, value,
                            "not breaching", rule.classification, RuleState())
            )
            continue

        started = current.first_breach_at or now
        held_for = (now - started).total_seconds()
        if held_for >= rule.duration_s:
            actions.append(
                AlarmAction(
                    rule.rule_id, Action.OPEN, rule.severity, value,
                    f"{rule.code} breached at {value:g} "
                    f"(held {held_for:.0f}s, debounce {rule.duration_s}s)",
                    rule.classification,
                    RuleState(first_breach_at=started, is_open=True),
                )
            )
        else:
            actions.append(
                AlarmAction(
                    rule.rule_id, Action.NO_CHANGE, rule.severity, value,
                    f"debouncing ({held_for:.0f}/{rule.duration_s}s)",
                    rule.classification,
                    replace(current, first_breach_at=started),
                )
            )
    return actions


def should_escalate(severity: str, min_severity: str) -> bool:
    """Escalation is gated by severity: a Low Alarm never escalates."""
    return SEVERITY_ORDER.get(severity, -1) >= SEVERITY_ORDER.get(min_severity, 99)


def underperforming_devices(
    power_by_device: dict[int, float], irradiance_w_m2: float,
    *, fraction: float, min_irradiance: float,
) -> list[int]:
    """Devices more than `fraction` below the median of their peers.

    This is the valuable comparison a fixed threshold cannot make: a Device merely
    doing worse than its neighbours is within every absolute limit. Gated on
    irradiance because at low light every Inverter looks bad.

    The caller must pass only **same-variant siblings** — ranking a string
    Inverter against a central one is meaningless (OPEN-13). Note this cannot run
    at all while the client publishes Plant-level totals rather than per-Device
    Readings (docs/BROKER_OBSERVATIONS.md §2.1).
    """
    if irradiance_w_m2 < min_irradiance or len(power_by_device) < 3:
        # Below three peers a "median" is one device's opinion, not a baseline.
        return []
    values = sorted(power_by_device.values())
    mid = len(values) // 2
    median = values[mid] if len(values) % 2 else (values[mid - 1] + values[mid]) / 2
    if median <= 0:
        return []
    limit = median * (1.0 - fraction)
    return sorted(d for d, p in power_by_device.items() if p < limit)
