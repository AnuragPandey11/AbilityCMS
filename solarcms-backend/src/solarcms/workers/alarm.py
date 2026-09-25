"""Alarm evaluation. Consumes the Redis stream, never the database.

    python -m solarcms.workers.alarm

BACKEND_SPEC §10.1. Reading `readings` would tie alarm latency to the ingest
batch window; the stream decouples them, which is the entire reason it exists.

One fault on one Device produces exactly **one** Alarm — one per rule *code*
per Device, whichever rule with that code raised it. Rule ids are not enough:
when a Client's rule replaces the platform default, the fault is the same and so
is its Alarm. Held three ways: per-(rule, device) state here, restored from the
open Alarms whenever a Device's rules are loaded (so a restart forgets nothing);
a check for an open Alarm under the same code before raising one; and the
partial unique index on (rule_id, device_id) WHERE state IN
('active','acknowledged'), which is the last line for a single rule.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal
from datetime import UTC, datetime
from typing import Any

import structlog
from sqlalchemy import text

from solarcms.cache import keys
from solarcms.cache.live import close_redis, get_redis
from solarcms.config import get_settings
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.alarm_logic import (
    Action,
    AlarmRuleSpec,
    RuleState,
    RuleTarget,
    evaluate,
    restored_state,
    rules_for,
)
from solarcms.logging import configure_logging
from solarcms.services.notifications import notify_alarm_subscribers

log = structlog.get_logger("alarm")

#: The role every Alarm write runs as — the same one the health sweep raises
#: absence Alarms under. This worker used to write as `solarcms_ingest`, which
#: holds INSERT on `alarms` but nothing on `notification_subscriptions`: every
#: raise read the subscriptions in the same transaction, failed "permission
#: denied", and rolled the Alarm back with it. Logged as "entry failed", the
#: entry acknowledged, nothing written — measured 25 Sep 2026, zero threshold
#: or Digital Input Alarms in the table's history against 370 absence Alarms.
#: The scheduler already holds exactly what raising and notifying need (0015,
#: 0025), and ingest is kept away from `users` by design.
ALARM_WRITER = SCHEDULER_ROLE

CONSUMER_GROUP = "alarm-workers"
CONSUMER_NAME = "alarm-1"
BLOCK_MS = 2000


class AlarmWorker:
    def __init__(self) -> None:
        self._stopping = asyncio.Event()
        self._state: dict[tuple[int, int], RuleState] = {}
        self._rules_by_device: dict[int, list[AlarmRuleSpec]] = {}
        self.stats = {"consumed": 0, "opened": 0, "cleared": 0, "notified": 0}

    async def _rules_for(self, device_id: int) -> list[AlarmRuleSpec]:
        """Rules applying to one Device, most-specific-wins.

        Cached per Device for the worker's lifetime. A rule change requires a
        restart, which is acceptable for now and noted as a limitation rather
        than pretended otherwise. Loading also restores the state of Alarms
        already open on this Device — without it a restart left every open
        Alarm unclearable, because only an open state is ever tested for
        clearing.
        """
        if device_id in self._rules_by_device:
            return self._rules_by_device[device_id]

        async with scoped_session(SecurityContext.platform(0), role=None) as session:
            device = (await session.execute(text("""
                SELECT d.client_id, d.plant_id, dm.device_type_id
                  FROM devices d
                  LEFT JOIN device_models dm ON dm.id = d.device_model_id
                 WHERE d.id = :device_id
            """), {"device_id": device_id})).first()
            if device is None:
                self._rules_by_device[device_id] = []
                return []
            # Scope matching is `applies_to`, not SQL: the health sweep resolves
            # the same rules for Device-less subjects, and two copies of "which
            # rules reach this" would drift.
            rows = (await session.execute(text("""
                SELECT id, client_id, code, tag_id, operator, threshold, threshold_high,
                       clear_threshold, duration_s, severity, scope_type, scope_id,
                       classification
                  FROM alarm_rules
                 WHERE enabled AND (client_id IS NULL OR client_id = :client_id)
                 ORDER BY id
            """), {"client_id": device.client_id})).all()

        specs = rules_for(
            [
                AlarmRuleSpec(
                    rule_id=r.id, code=r.code, tag_id=r.tag_id, operator=r.operator,
                    threshold=r.threshold, threshold_high=r.threshold_high,
                    clear_threshold=r.clear_threshold, duration_s=r.duration_s,
                    severity=r.severity, scope_type=r.scope_type, scope_id=r.scope_id,
                    classification=r.classification, client_id=r.client_id,
                ) for r in rows
            ],
            RuleTarget(client_id=device.client_id, plant_id=device.plant_id,
                       device_id=device_id, device_type_id=device.device_type_id),
        )
        async with scoped_session(SecurityContext.platform(0), role=ALARM_WRITER) as s:
            open_rows = (await s.execute(text("""
                SELECT r.code, min(a.opened_at) AS opened_at
                  FROM alarms a JOIN alarm_rules r ON r.id = a.rule_id
                 WHERE a.device_id = :device_id
                   AND a.state IN ('active', 'acknowledged')
                   AND r.operator <> 'special'
                 GROUP BY r.code
            """), {"device_id": device_id})).all()
        restored = restored_state(specs, {row.code: row.opened_at for row in open_rows})
        for rule_id, rule_state in restored.items():
            self._state[(rule_id, device_id)] = rule_state
        if restored:
            log.info("open alarms restored", device_id=device_id, count=len(restored))

        self._rules_by_device[device_id] = specs
        return specs

    async def _apply(
        self, action: Any, code: str, entry: dict[str, str], device_id: int, tag_id: int
    ) -> None:
        client_id = int(entry["client_id"])
        plant_id = int(entry["plant_id"])
        now = datetime.now(UTC)

        async with scoped_session(SecurityContext.platform(0), role=ALARM_WRITER) as s:
            if action.action is Action.OPEN:
                # One Alarm per (code, Device). The unique index is per rule id,
                # so it cannot see an Alarm the platform default raised before a
                # Client's rule with the same code took over; this can. `special`
                # codes belong to the health sweep and are never touched here.
                already = (await s.execute(text("""
                    SELECT a.id FROM alarms a JOIN alarm_rules r ON r.id = a.rule_id
                     WHERE a.device_id = :device_id AND r.code = :code
                       AND r.operator <> 'special'
                       AND a.state IN ('active', 'acknowledged')
                     LIMIT 1
                """), {"device_id": device_id, "code": code})).first()
                if already is not None:
                    log.info("alarm already open under this code", code=code,
                             alarm_id=already.id, device_id=device_id)
                    return

                # ON CONFLICT DO NOTHING against the partial unique index, and
                # RETURNING so that only a row this call wrote is notified —
                # re-notifying an Alarm already open is the duplicate page the
                # deduplication exists to prevent.
                opened = (await s.execute(text("""
                    INSERT INTO alarms (client_id, rule_id, device_id, plant_id, state,
                                        severity, opened_at, trigger_value, message,
                                        classification)
                    VALUES (:client_id, :rule_id, :device_id, :plant_id, 'active',
                            :severity, :opened_at, :value, :message, :classification)
                    ON CONFLICT DO NOTHING
                    RETURNING id
                """), {
                    "client_id": client_id, "rule_id": action.rule_id,
                    "device_id": device_id, "plant_id": plant_id,
                    "severity": action.severity, "opened_at": now,
                    "value": action.value, "message": action.message,
                    "classification": action.classification,
                })).first()
                if opened is None:
                    return
                self.stats["opened"] += 1
                log.info("alarm opened", rule_id=action.rule_id, device_id=device_id,
                         tag_id=tag_id, severity=action.severity, value=action.value)

                # Notify on raise (MASTER §6.4), in the same transaction: a
                # notification recorded against an Alarm that rolled back would
                # point at nothing.
                sent = await notify_alarm_subscribers(
                    s, alarm_id=opened.id, client_id=client_id, plant_id=plant_id,
                    severity=action.severity, message=action.message,
                )
                self.stats["notified"] += sent
            elif action.action is Action.CLEAR:
                # By code, not rule id: an Alarm raised under the platform default
                # must close when the Client's rule that replaced it sees the
                # fault clear, or it stays active for ever.
                await s.execute(text("""
                    UPDATE alarms SET state = 'resolved', resolved_at = :now
                     WHERE device_id = :device_id
                       AND state IN ('active', 'acknowledged')
                       AND rule_id IN (SELECT id FROM alarm_rules
                                        WHERE code = :code AND operator <> 'special')
                """), {"now": now, "device_id": device_id, "code": code})
                self.stats["cleared"] += 1
                log.info("alarm cleared", rule_id=action.rule_id, code=code,
                         device_id=device_id)

    async def handle_entry(self, entry: dict[str, str]) -> None:
        self.stats["consumed"] += 1
        device_id = int(entry["device_id"])
        tag_id = int(entry["tag_id"])
        value = float(entry["value"])
        quality = int(entry["quality"])
        now = datetime.fromisoformat(entry["at"])

        rules = [r for r in await self._rules_for(device_id) if r.tag_id == tag_id]
        if not rules:
            return

        state = {r.rule_id: self._state.get((r.rule_id, device_id), RuleState())
                 for r in rules}
        code_of = {r.rule_id: r.code for r in rules}
        for action in evaluate(value, quality, rules, state, now):
            self._state[(action.rule_id, device_id)] = action.next_state
            if action.action is not Action.NO_CHANGE:
                await self._apply(action, code_of[action.rule_id], entry, device_id,
                                  tag_id)

    async def run(self) -> None:
        redis = get_redis()
        with contextlib.suppress(Exception):
            # Idempotent: the group may already exist from a previous run.
            await redis.xgroup_create(keys.STREAM_READINGS, CONSUMER_GROUP,
                                      id="0", mkstream=True)
        log.info("alarm worker started", group=CONSUMER_GROUP)

        while not self._stopping.is_set():
            try:
                batches = await redis.xreadgroup(
                    CONSUMER_GROUP, CONSUMER_NAME,
                    {keys.STREAM_READINGS: ">"}, count=200, block=BLOCK_MS,
                )
            except Exception as exc:
                log.warning("stream read failed", error=str(exc))
                await asyncio.sleep(2)
                continue

            for _stream, entries in batches or []:
                for entry_id, fields in entries:
                    try:
                        await self.handle_entry(fields)
                    except Exception as exc:
                        # One malformed entry must not stall alarming for every
                        # other Device. Acknowledged so it is not redelivered
                        # forever, and logged loudly.
                        log.error("entry failed", entry_id=entry_id, error=str(exc))
                    await redis.xack(keys.STREAM_READINGS, CONSUMER_GROUP, entry_id)

        log.info("alarm worker stopped", **self.stats)
        await close_redis()
        await dispose_engine()


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    worker = AlarmWorker()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, worker._stopping.set)
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
