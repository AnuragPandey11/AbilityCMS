"""Alarm evaluation. Consumes the Redis stream, never the database.

    python -m solarcms.workers.alarm

BACKEND_SPEC §10.1. Reading `readings` would tie alarm latency to the ingest
batch window; the stream decouples them, which is the entire reason it exists.

One Alarm Rule breaching continuously on one Device produces exactly **one**
Alarm. That is enforced twice — here, by holding per-(rule, device) state, and in
the database by the partial unique index on (rule_id, device_id) WHERE state IN
('active','acknowledged'). The index is the authority; this is the optimisation.
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
from solarcms.db.rls import INGEST_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.alarm_logic import (
    Action,
    AlarmRuleSpec,
    RuleState,
    evaluate,
    resolve_rules,
)
from solarcms.logging import configure_logging
from solarcms.services.notifications import notify_alarm_subscribers

log = structlog.get_logger("alarm")

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
        than pretended otherwise.
        """
        if device_id in self._rules_by_device:
            return self._rules_by_device[device_id]

        async with scoped_session(SecurityContext.platform(0), role=None) as session:
            rows = (await session.execute(text("""
                SELECT r.id, r.code, r.tag_id, r.operator, r.threshold, r.threshold_high,
                       r.clear_threshold, r.duration_s, r.severity, r.scope_type,
                       r.scope_id, r.classification
                  FROM alarm_rules r
                  JOIN devices d ON d.id = :device_id
                  JOIN device_models dm ON dm.id = d.device_model_id
                 WHERE r.enabled
                   AND (r.client_id IS NULL OR r.client_id = d.client_id)
                   AND (
                        r.scope_type = 'global'
                     OR (r.scope_type = 'client'      AND r.scope_id = d.client_id)
                     OR (r.scope_type = 'plant'       AND r.scope_id = d.plant_id)
                     OR (r.scope_type = 'device'      AND r.scope_id = d.id)
                     OR (r.scope_type = 'device_type' AND r.scope_id = dm.device_type_id)
                   )
            """), {"device_id": device_id})).all()

        specs = resolve_rules([
            AlarmRuleSpec(
                rule_id=r.id, code=r.code, tag_id=r.tag_id, operator=r.operator,
                threshold=r.threshold, threshold_high=r.threshold_high,
                clear_threshold=r.clear_threshold, duration_s=r.duration_s,
                severity=r.severity, scope_type=r.scope_type, scope_id=r.scope_id,
                classification=r.classification,
            ) for r in rows
        ])
        self._rules_by_device[device_id] = specs
        return specs

    async def _apply(
        self, action: Any, entry: dict[str, str], device_id: int, tag_id: int
    ) -> None:
        client_id = int(entry["client_id"])
        plant_id = int(entry["plant_id"])
        now = datetime.now(UTC)

        async with scoped_session(SecurityContext.platform(0), role=INGEST_ROLE) as s:
            if action.action is Action.OPEN:
                # ON CONFLICT DO NOTHING against the partial unique index: if an
                # Alarm is already open for this (rule, device) the insert is a
                # no-op, so a worker restart cannot duplicate one.
                await s.execute(text("""
                    INSERT INTO alarms (client_id, rule_id, device_id, plant_id, state,
                                        severity, opened_at, trigger_value, message,
                                        classification)
                    VALUES (:client_id, :rule_id, :device_id, :plant_id, 'active',
                            :severity, :opened_at, :value, :message, :classification)
                    ON CONFLICT DO NOTHING
                """), {
                    "client_id": client_id, "rule_id": action.rule_id,
                    "device_id": device_id, "plant_id": plant_id,
                    "severity": action.severity, "opened_at": now,
                    "value": action.value, "message": action.message,
                    "classification": action.classification,
                })
                self.stats["opened"] += 1
                log.info("alarm opened", rule_id=action.rule_id, device_id=device_id,
                         tag_id=tag_id, severity=action.severity, value=action.value)

                # Notify on raise (MASTER §6.4), in the same transaction: a
                # notification recorded against an Alarm that rolled back would
                # point at nothing.
                opened = (await s.execute(text("""
                    SELECT id FROM alarms
                     WHERE rule_id = :rule_id AND device_id = :device_id
                       AND state = 'active'
                """), {"rule_id": action.rule_id, "device_id": device_id})).first()
                if opened is not None:
                    sent = await notify_alarm_subscribers(
                        s, alarm_id=opened.id, client_id=client_id, plant_id=plant_id,
                        severity=action.severity, message=action.message,
                    )
                    self.stats["notified"] += sent
            elif action.action is Action.CLEAR:
                await s.execute(text("""
                    UPDATE alarms SET state = 'resolved', resolved_at = :now
                     WHERE rule_id = :rule_id AND device_id = :device_id
                       AND state IN ('active', 'acknowledged')
                """), {"now": now, "rule_id": action.rule_id, "device_id": device_id})
                self.stats["cleared"] += 1
                log.info("alarm cleared", rule_id=action.rule_id, device_id=device_id)

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
        for action in evaluate(value, quality, rules, state, now):
            self._state[(action.rule_id, device_id)] = action.next_state
            if action.action is not Action.NO_CHANGE:
                await self._apply(action, entry, device_id, tag_id)

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
