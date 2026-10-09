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

**An entry is acknowledged only once it has been handled** (8 Oct 2026). A
database or Redis failure is retried with backoff on the same entry, and the
rule's state moves on only after the Alarm it implies has been written — it
used to move first, so one failed write left the worker believing the Alarm
was open and it was never raised. An entry that fails for a reason of its own
is still skipped, loudly, so one bad entry cannot stall every Device. Entries
delivered before a crash and never acknowledged are handled first on start.

**It recovers from a Redis restart by itself**: a missing consumer group is
recreated rather than reported every two seconds for ever. **Rule edits take
effect within seconds**: the API bumps `alarm_rules:version` and the cached
rules are reloaded, and every `RULES_MAX_AGE_S` regardless. **Notifications
are queued, never sent here** (`services/notifications.py`): a slow mail
server used to hold up every other Device's Alarms.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal
import time
from datetime import UTC, datetime
from typing import Any

import redis.exceptions
import structlog
from sqlalchemy import text

from solarcms.cache import keys
from solarcms.cache.heartbeat import Heartbeat
from solarcms.cache.live import close_redis, get_redis, read_alarm_rules_version
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
from solarcms.services.notifications import queue_alarm_notifications
from solarcms.workers.transient import is_transient, next_delay

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

CONSUMER_GROUP = keys.STREAM_READINGS_GROUP
CONSUMER_NAME = "alarm-1"
BLOCK_MS = 2000
#: Cached rules are reloaded at least this often even if no edit was signalled
#: — the signal lives in Redis, and Redis can lose it.
RULES_MAX_AGE_S = 300.0
#: How often the worker checks whether the stream was trimmed past its position.
TRIM_CHECK_S = 60.0


def _stream_id(entry_id: str) -> tuple[int, int]:
    milliseconds, _, sequence = entry_id.partition("-")
    return int(milliseconds), int(sequence or 0)


def readings_were_trimmed(last_delivered: str | None, first_entry: str | None) -> bool:
    """True when the stream dropped entries this group never read.

    The stream is capped (`keys.STREAM_MAXLEN`), and the cap ignores consumer
    groups: a worker down long enough loses the oldest unread Readings without
    any error. A group that has never read ("0-0") has lost nothing it knew of.
    """
    if not last_delivered or not first_entry or last_delivered == "0-0":
        return False
    return _stream_id(last_delivered) < _stream_id(first_entry)


class AlarmWorker:
    def __init__(self) -> None:
        self._stopping = asyncio.Event()
        self._state: dict[tuple[int, int], RuleState] = {}
        self._rules_by_device: dict[int, list[AlarmRuleSpec]] = {}
        self._rules_loaded_at: dict[int, float] = {}
        self._rules_version: str | None = None
        self._next_trim_check = 0.0
        self.stats = {"consumed": 0, "opened": 0, "cleared": 0, "notified": 0,
                      "retries": 0, "skipped": 0, "rule_reloads": 0}
        # Alive, reading the stream, and — separately — whether an entry failed.
        # "entry failed" was logged for every raise for weeks and the worker
        # looked perfectly healthy throughout (CLAUDE.md); this is what the
        # System Health page reads to say so instead.
        self.heartbeat = Heartbeat("alarm")

    async def _rules_for(self, device_id: int) -> list[AlarmRuleSpec]:
        """Rules applying to one Device, most-specific-wins.

        Cached per Device, and reloaded when a rule edit is signalled
        (`_check_rule_version`) or the cache is `RULES_MAX_AGE_S` old. Loading
        also restores the state of Alarms
        already open on this Device — without it a restart left every open
        Alarm unclearable, because only an open state is ever tested for
        clearing.
        """
        loaded_at = self._rules_loaded_at.get(device_id)
        if (device_id in self._rules_by_device and loaded_at is not None
                and time.monotonic() - loaded_at < RULES_MAX_AGE_S):
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
                self._rules_loaded_at[device_id] = time.monotonic()
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
        self._rules_loaded_at[device_id] = time.monotonic()
        return specs

    async def _check_rule_version(self) -> None:
        """Drop every cached rule set when an edit has been signalled.

        Rule *state* is kept: it is keyed by rule id, and the reload restores
        the open Alarms from the database anyway. A Redis that cannot be read is
        no reason to stop evaluating; the age limit covers it.
        """
        try:
            version = await read_alarm_rules_version()
        except Exception:
            return
        if version == self._rules_version:
            return
        if self._rules_by_device:
            log.info("alarm rules changed; reloading", version=version,
                     devices=len(self._rules_by_device))
            self.stats["rule_reloads"] += 1
        self._rules_version = version
        self._rules_by_device.clear()
        self._rules_loaded_at.clear()

    async def _apply(
        self, action: Any, code: str, entry: dict[str, str], device_id: int, tag_id: int
    ) -> str | None:
        """Open or clear an Alarm; what was written, once it has committed."""
        client_id = int(entry["client_id"])
        written: str | None = None
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
                    return None

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
                    return None
                self.stats["opened"] += 1
                written = f"Alarm opened ({code})"
                log.info("alarm opened", rule_id=action.rule_id, device_id=device_id,
                         tag_id=tag_id, severity=action.severity, value=action.value)

                # Notify on raise (MASTER §6.4): queued in the same transaction —
                # a notification for an Alarm that rolled back would point at
                # nothing — and sent by the scheduler, so a slow mail server
                # never holds up the next Device's Alarm.
                sent = await queue_alarm_notifications(
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
                written = f"Alarm cleared ({code})"
                log.info("alarm cleared", rule_id=action.rule_id, code=code,
                         device_id=device_id)
        return written

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
            if action.action is not Action.NO_CHANGE:
                # Written first, and the state moved only once it is: if the
                # write fails, the entry is retried from the state before it and
                # decides the same thing again. Moved first, a failed raise left
                # the state "open" and the Alarm was never written at all.
                written = await self._apply(action, code_of[action.rule_id], entry,
                                            device_id, tag_id)
                if written:
                    self.heartbeat.wrote(written)
            self._state[(action.rule_id, device_id)] = action.next_state

    async def run(self) -> None:
        beat = self.heartbeat.start(self._stopping)
        try:
            await self._consume()
        except Exception as exc:
            self.heartbeat.crashed(exc)
            raise
        finally:
            self._stopping.set()
            # The heartbeat's last word, while Redis is still open to take it.
            await beat
            log.info("alarm worker stopped", **self.stats)
            await close_redis()
            await dispose_engine()

    async def _ensure_group(self) -> None:
        """Create the consumer group (and stream) if missing.

        From "0": after a Redis restart without its data, the stream holds only
        what ingest has added since, all of it unread. Where the group already
        exists this is a no-op.
        """
        try:
            await get_redis().xgroup_create(keys.STREAM_READINGS, CONSUMER_GROUP,
                                            id="0", mkstream=True)
            log.info("consumer group created", group=CONSUMER_GROUP)
        except redis.exceptions.ResponseError as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    async def _check_trimmed(self) -> None:
        """Say so when the stream's cap dropped Readings before they were evaluated."""
        now = time.monotonic()
        if now < self._next_trim_check:
            return
        self._next_trim_check = now + TRIM_CHECK_S
        try:
            client = get_redis()
            groups = await client.xinfo_groups(keys.STREAM_READINGS)
            stream = await client.xinfo_stream(keys.STREAM_READINGS)
        except Exception:
            return
        last = next((g.get("last-delivered-id") for g in groups
                     if g.get("name") == CONSUMER_GROUP), None)
        first = stream.get("first-entry")
        first_id = first[0] if first else None
        if readings_were_trimmed(last, first_id):
            message = ("Readings were dropped from the alarm stream before they were "
                       f"checked: this worker fell more than {keys.STREAM_MAXLEN:,} "
                       "Readings behind. Alarms that should have opened in that time "
                       "did not.")
            log.error("alarm stream trimmed past the worker", last_delivered=last,
                      first_entry=first_id)
            self.heartbeat.failed(message)

    async def _handle_with_retry(self, entry_id: str, fields: dict[str, str]) -> bool:
        """Handle one entry. False only when stopping mid-retry (leave it pending)."""
        delay = 1.0
        while True:
            try:
                await self.handle_entry(fields)
                return True
            except Exception as exc:
                if not is_transient(exc):
                    # This entry's own fault: retrying cannot help, and would
                    # stall alarming for every other Device.
                    log.error("entry failed; skipped", entry_id=entry_id, error=repr(exc))
                    self.heartbeat.failed(exc)
                    self.stats["skipped"] += 1
                    return True
                if self._stopping.is_set():
                    return False
                self.stats["retries"] += 1
                self.heartbeat.failed(exc)
                log.warning("entry failed; retrying", entry_id=entry_id,
                            error=str(exc), retry_in_s=delay)
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._stopping.wait(), timeout=delay)
                delay = next_delay(delay)

    async def _consume(self) -> None:
        while not self._stopping.is_set():
            try:
                await self._ensure_group()
                break
            except Exception as exc:
                log.warning("cannot reach the alarm stream yet", error=str(exc))
                self.heartbeat.failed(f"reaching the alarm stream: {exc}")
                await asyncio.sleep(2)
        log.info("alarm worker started", group=CONSUMER_GROUP)

        # "0" re-reads what was delivered to this consumer and never
        # acknowledged — a crash mid-entry — before anything new (">").
        cursor = "0"
        while not self._stopping.is_set():
            await self._check_rule_version()
            await self._check_trimmed()
            try:
                batches = await get_redis().xreadgroup(
                    CONSUMER_GROUP, CONSUMER_NAME,
                    {keys.STREAM_READINGS: cursor}, count=200,
                    block=None if cursor != ">" else BLOCK_MS,
                )
            except redis.exceptions.ResponseError as exc:
                if "NOGROUP" in str(exc):
                    # Redis restarted without its data. This used to fail every
                    # two seconds until somebody restarted the worker, and no
                    # Alarm was raised meanwhile.
                    log.warning("consumer group missing; recreating", error=str(exc))
                    self.heartbeat.failed(
                        "the alarm stream was reset (Redis restarted); recovered")
                    with contextlib.suppress(Exception):
                        await self._ensure_group()
                    cursor = "0"
                    continue
                log.warning("stream read failed", error=str(exc))
                self.heartbeat.failed(f"reading the stream: {exc}")
                await asyncio.sleep(2)
                continue
            except Exception as exc:
                log.warning("stream read failed", error=str(exc))
                self.heartbeat.failed(f"reading the stream: {exc}")
                await asyncio.sleep(2)
                continue

            entries = [entry for _stream, found in batches or [] for entry in found]
            if cursor != ">" and not entries:
                cursor = ">"  # the backlog of unacknowledged entries is done
                continue

            # One read of the stream is this worker's unit of work — an empty
            # read included, since a quiet Plant is not a stalled worker. It
            # counts as completed only if no entry in it was skipped.
            skipped_before = self.stats["skipped"]
            for entry_id, fields in entries:
                if fields and not await self._handle_with_retry(entry_id, fields):
                    return  # stopping: left pending, handled first next start
                # No fields: trimmed from the stream while still pending.
                try:
                    await get_redis().xack(keys.STREAM_READINGS, CONSUMER_GROUP, entry_id)
                except Exception as exc:
                    # Handled but not acknowledged: re-read on the next start,
                    # where re-raising is prevented by the open-Alarm check.
                    log.warning("acknowledgement failed", entry_id=entry_id, error=str(exc))
                if cursor != ">":
                    cursor = entry_id
            if self.stats["skipped"] == skipped_before:
                self.heartbeat.cycle()


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
