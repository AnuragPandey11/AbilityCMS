"""Writing absence Alarms. The I/O half of `domain/absence.py`.

The domain module decides which absence conditions *should* be open. This one
reads what is open, writes the difference, and notifies on the way in. Kept
apart because the deciding is the part worth testing without a database
(Guardrail 9), and the part most likely to be wrong.

⚠ Runs as `solarcms_scheduler`, which was granted INSERT on `alarms` only in
migration 0025. Before that it held a permissive policy and no grant — the
pairing that once left `comm_status` NULL fleet-wide for weeks while the sweep
logged "permission denied" and slept. If absence Alarms ever stop appearing,
check the grant before the logic.
"""

from __future__ import annotations

from datetime import UTC, datetime

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.absence import (
    CLASSIFICATION,
    RULE_COLLECTOR_OFFLINE,
    RULE_COMM_LOST,
    RULE_PLANT_SILENT,
    RULE_UNREGISTERED_PUBLISHING,
    AbsenceCondition,
    diff_conditions,
)
from solarcms.domain.alarm_logic import AlarmRuleSpec, RuleTarget, rules_for
from solarcms.services.notifications import notify_alarm_subscribers

log = structlog.get_logger("absence")

#: Every rule this module owns. Anything open under one of these codes and no
#: longer desired is cleared — which is what makes recovery automatic.
ABSENCE_RULE_CODES = (
    RULE_COMM_LOST,
    RULE_COLLECTOR_OFFLINE,
    RULE_UNREGISTERED_PUBLISHING,
    RULE_PLANT_SILENT,
)

AlarmKey = tuple[str, int | None, str | None]


async def _rules(session: AsyncSession) -> list[AlarmRuleSpec]:
    """Every enabled absence rule, platform default and Client-owned alike.

    Severity comes from the row, never from this module: a rule is
    configuration, and an operator who decides a silent Inverter is critical
    rather than medium changes a row, not a deployment. Which row applies to a
    given condition is `rules_for`, the same precedence the alarm worker uses —
    this used to read the platform default only, so a Client's own COMM_LOST
    was stored, listed, and silently never consulted.
    """
    rows = (await session.execute(text("""
        SELECT id, client_id, code, severity, duration_s, scope_type, scope_id
          FROM alarm_rules
         WHERE code = ANY(:codes) AND enabled
         ORDER BY id
    """), {"codes": list(ABSENCE_RULE_CODES)})).all()
    return [
        AlarmRuleSpec(
            rule_id=row.id, code=row.code, tag_id=None, operator="special",
            threshold=None, threshold_high=None, clear_threshold=None,
            duration_s=row.duration_s or 0, severity=row.severity,
            scope_type=row.scope_type, scope_id=row.scope_id, client_id=row.client_id,
        )
        for row in rows
    ]


async def _device_types(session: AsyncSession, device_ids: list[int]) -> dict[int, int]:
    """Device → Device Type, for rules scoped to a Type."""
    if not device_ids:
        return {}
    rows = (await session.execute(text("""
        SELECT d.id, dm.device_type_id
          FROM devices d JOIN device_models dm ON dm.id = d.device_model_id
         WHERE d.id = ANY(:ids)
    """), {"ids": device_ids})).all()
    return {row.id: row.device_type_id for row in rows}


def _winners(
    desired: list[AbsenceCondition], rules: list[AlarmRuleSpec], types: dict[int, int]
) -> dict[AlarmKey, AlarmRuleSpec]:
    """The rule in force for each condition. A condition no enabled rule
    reaches has no entry, and is not raised."""
    winners: dict[AlarmKey, AlarmRuleSpec] = {}
    for condition in desired:
        target = RuleTarget(
            client_id=condition.client_id, plant_id=condition.plant_id,
            device_id=condition.device_id,
            device_type_id=(types.get(condition.device_id)
                            if condition.device_id is not None else None),
        )
        chosen = rules_for([r for r in rules if r.code == condition.rule_code], target)
        if chosen:
            winners[condition.key] = chosen[0]
    return winners


async def _open_keys(session: AsyncSession, rule_ids: dict[int, str]) -> set[AlarmKey]:
    if not rule_ids:
        return set()
    rows = (await session.execute(text("""
        SELECT rule_id, device_id, subject FROM alarms
         WHERE rule_id = ANY(:rule_ids) AND state IN ('active','acknowledged')
    """), {"rule_ids": list(rule_ids)})).all()
    return {
        (rule_ids[row.rule_id], row.device_id, row.subject)
        for row in rows if row.rule_id in rule_ids
    }


async def reconcile(
    session: AsyncSession, desired: list[AbsenceCondition], now: datetime | None = None
) -> dict[str, int]:
    """Open what is newly absent, clear what has come back.

    Idempotent by construction: an Alarm already open is left exactly as it is,
    so a condition persisting for six hours stays one row and notifies once.
    """
    now = now or datetime.now(UTC)
    stats = {"opened": 0, "cleared": 0, "notified": 0}

    rules = await _rules(session)
    winners = _winners(desired, rules, await _device_types(
        session, sorted({c.device_id for c in desired if c.device_id is not None})))
    # A rule disabled in configuration is not merely skipped — anything already
    # open under it is left alone rather than force-cleared, because disabling a
    # rule is a statement about raising new Alarms, not about closing live ones.
    desired = [c for c in desired if c.key in winners]
    rule_ids = {rule.rule_id: rule.code for rule in rules}
    # Clearing is by code, across every enabled rule carrying it: an Alarm opened
    # under the platform default must still close after a Client adds its own
    # rule and the Client's becomes the one in force.
    ids_by_code: dict[str, list[int]] = {}
    for rule in rules:
        ids_by_code.setdefault(rule.code, []).append(rule.rule_id)

    open_keys = await _open_keys(session, rule_ids)
    to_open, to_clear = diff_conditions(desired, open_keys)

    # The rule's own debounce, applied to opening only. A condition that has not
    # held long enough is simply not opened yet — it is *not* treated as absent
    # for clearing purposes, or a rule with a debounce could never stay open.
    held_back = 0
    ready: list[AbsenceCondition] = []
    for condition in to_open:
        required = winners[condition.key].duration_s
        if required and (condition.held_for_s or 0) < required:
            held_back += 1
            continue
        ready.append(condition)
    if held_back:
        log.debug("absence conditions still within debounce", count=held_back)
    to_open = ready

    for condition in to_open:
        rule = winners[condition.key]
        # ON CONFLICT DO NOTHING against both partial unique indexes: the
        # Device-scoped one and the subject-scoped one added in 0025. A second
        # sweeper, or a restart mid-sweep, cannot duplicate an Alarm.
        await session.execute(text("""
            INSERT INTO alarms (client_id, rule_id, device_id, plant_id, subject,
                                state, severity, opened_at, message, classification)
            VALUES (:client_id, :rule_id, :device_id, :plant_id, :subject,
                    'active', :severity, :now, :message, :classification)
            ON CONFLICT DO NOTHING
        """), {
            "client_id": condition.client_id, "rule_id": rule.rule_id,
            "device_id": condition.device_id, "plant_id": condition.plant_id,
            "subject": condition.subject, "severity": rule.severity,
            "now": now, "message": condition.message,
            "classification": CLASSIFICATION,
        })
        stats["opened"] += 1
        log.warning("absence alarm opened", rule=condition.rule_code,
                    device_id=condition.device_id, subject=condition.subject,
                    severity=rule.severity)

        opened = (await session.execute(text("""
            SELECT id FROM alarms
             WHERE rule_id = :rule_id AND state = 'active'
               AND device_id IS NOT DISTINCT FROM :device_id
               AND subject IS NOT DISTINCT FROM :subject
        """), {"rule_id": rule.rule_id, "device_id": condition.device_id,
               "subject": condition.subject})).first()
        if opened is not None:
            stats["notified"] += await notify_alarm_subscribers(
                session, alarm_id=opened.id, client_id=condition.client_id,
                plant_id=condition.plant_id, severity=rule.severity,
                message=condition.message,
            )

    for rule_code, device_id, subject in sorted(to_clear, key=lambda k: str(k)):
        await session.execute(text("""
            UPDATE alarms SET state = 'resolved', resolved_at = :now
             WHERE rule_id = ANY(:rule_ids) AND state IN ('active','acknowledged')
               AND device_id IS NOT DISTINCT FROM :device_id
               AND subject IS NOT DISTINCT FROM :subject
        """), {"now": now, "rule_ids": ids_by_code[rule_code], "device_id": device_id,
               "subject": subject})
        stats["cleared"] += 1
        log.info("absence alarm cleared", rule=rule_code,
                 device_id=device_id, subject=subject)

    return stats
