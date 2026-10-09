"""MQTT → decode → Redis + COPY batch. Runs as its own process.

    python -m solarcms.workers.ingest

**Never inside the API process** (I-7, Guardrail 3). Ingestion must survive API
deploys, and it holds the MQTT session — restarting it on every deploy would
drop messages or force redelivery storms. BACKEND_SPEC §1 calls this the one
architectural rule that is expensive to undo.

Pipeline (§6.3):

    receive → parse topic → resolve Device (cached) → per Reading:
        look up binding → scale/offset → classify quality → throttle
      → Redis current value → COPY buffer → alarm stream
    flush on 5000 rows or 2.0s, whichever first → COPY into readings + mqtt_raw

Two properties the design turns on:

* **Acknowledge only after commit.** QoS 1 messages are acknowledged by hand,
  in arrival order, once the batch holding them has committed
  (`workers/delivery.py`), so a crash or a database outage causes redelivery
  rather than loss. Until 8 Oct 2026 paho acknowledged on arrival and this line
  was not true. A database or Redis error is waited out, never fatal: the
  broker holds what is unacknowledged, which is the backpressure.
* **Unknown topic → quarantine, never infer.** Guardrail 5.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import signal
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import aiomqtt
import asyncpg

from solarcms.cache import live
from solarcms.cache.heartbeat import Heartbeat
from solarcms.config import Settings, get_settings
from solarcms.db.rls import INGEST_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.decoding import DecodedReading, TopicPattern, decode
from solarcms.logging import configure_logging, get_logger
from solarcms.workers.delivery import PendingAck, RedeliveryFilter, fingerprint
from solarcms.workers.resolver import ResolutionFailure, load_topic_patterns, resolve
from solarcms.workers.transient import is_transient, next_delay

log = get_logger("ingest")

#: Alarm-stream entries held while Redis is unreachable — about 80 minutes of
#: the client's fleet at ~20 Readings a second.
STREAM_BACKLOG_MAX = 100_000

READINGS_COLUMNS = ("time", "client_id", "device_id", "tag_id", "value", "quality",
                    "source_time")
MQTT_RAW_COLUMNS = ("time", "topic", "seq", "payload", "client_id", "device_id",
                    "quarantined", "reason")


@dataclass
class Batch:
    """Rows buffered between flushes, plus the acknowledgements they owe."""

    readings: list[tuple[Any, ...]] = field(default_factory=list)
    raw: list[tuple[Any, ...]] = field(default_factory=list)
    stream_entries: list[dict[str, Any]] = field(default_factory=list)
    # Every QoS 1 message since the last commit, in arrival order — including
    # those that wrote no row (all throttled, or a resend already buffered),
    # because PUBACKs must go in the order the messages came.
    acks: list[PendingAck] = field(default_factory=list)
    opened_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def clear(self) -> None:
        self.readings.clear()
        self.raw.clear()
        self.stream_entries.clear()
        self.acks.clear()
        self.opened_at = datetime.now(UTC)

    def take(self) -> Batch:
        """Hand over everything buffered and start empty, with no await between.

        ⚠ The only safe way to flush. `flush` used to copy the lists, await the
        COPY, and *then* clear — so a second flush started in that await (the
        2 s timer and the per-message check both call it) wrote the same rows
        again, and a message buffered in that await was cleared without ever
        being written. Measured on 7 Oct 2026: one raw row in five on
        KULAR_GREEN stored twice, same microsecond, same `seq`.
        """
        taken = Batch(
            readings=self.readings, raw=self.raw,
            stream_entries=self.stream_entries, acks=self.acks, opened_at=self.opened_at,
        )
        self.readings = []
        self.raw = []
        self.stream_entries = []
        self.acks = []
        self.opened_at = datetime.now(UTC)
        return taken

    def restore(self, taken: Batch) -> None:
        """Put a batch whose write failed back in front, to be retried in order."""
        self.readings[:0] = taken.readings
        self.raw[:0] = taken.raw
        self.stream_entries[:0] = taken.stream_entries
        self.acks[:0] = taken.acks
        self.opened_at = min(self.opened_at, taken.opened_at)

    def drop_acks_from(self, generation: int) -> list[PendingAck]:
        """Remove and return the acknowledgements a lost connection can no longer send."""
        lost = [a for a in self.acks if a.generation == generation]
        self.acks = [a for a in self.acks if a.generation != generation]
        return lost

    @property
    def is_empty(self) -> bool:
        return not self.readings and not self.raw and not self.acks

    def should_flush(self, settings: Settings, now: datetime) -> bool:
        if len(self.readings) >= settings.ingest_batch_max_rows:
            return True
        # Before the broker's in-flight limit, or it stops delivering until the
        # timer fires and throughput is capped at limit ÷ batch seconds.
        if len(self.acks) >= settings.ingest_max_unacked:
            return True
        age = (now - self.opened_at).total_seconds()
        return not self.is_empty and age >= settings.ingest_batch_max_seconds


class IngestWorker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.batch = Batch()
        # One flush writes at a time, so batches commit in the order they
        # were taken and a retry never races the next batch.
        self._flush_lock = asyncio.Lock()
        self.patterns: list[TopicPattern] = []
        self._pool: asyncpg.Pool | None = None
        self._stopping = asyncio.Event()
        self._seq = 0
        self.stats = {"received": 0, "stored": 0, "quarantined": 0, "throttled": 0,
                      "unmapped": 0, "suspect_counters": 0, "flushes": 0,
                      "acknowledged": 0, "resends_skipped": 0, "retries": 0}
        # The connection acknowledgements are sent on, and which one it is: a
        # message id is only meaningful on the connection that delivered it.
        self._mqtt: Any = None
        self._generation = 0
        self._redelivery = RedeliveryFilter(settings.ingest_redelivery_window_s)
        # Alarm-stream entries whose rows committed while Redis was away, sent
        # ahead of the next batch's. Bounded: past it, the oldest go — a backlog
        # that deep is no longer worth alarming on (the stream's own cap says so).
        self._stream_backlog: list[dict[str, Any]] = []
        # What the System Health page reads: alive, flushing, and whether the
        # broker is connected and delivering. The broker is the one thing only
        # this process can see — a subscription that matches nothing looks, from
        # everywhere else, exactly like every Plant going quiet.
        self.heartbeat = Heartbeat(
            "ingest",
            broker=f"{settings.mqtt_host}:{settings.mqtt_port}",
            topics=list(settings.mqtt_subscribe_topics),
            broker_connected=False, connected_at=None, broker_error=None,
            last_message_at=None, messages=0,
        )
        self._beat: asyncio.Task[None] | None = None

    # ── lifecycle ───────────────────────────────────────────────────────────

    async def start(self) -> None:
        # A dedicated asyncpg pool, not SQLAlchemy: Readings are written with
        # copy_records_to_table, roughly two orders of magnitude faster than
        # per-row INSERT (BACKEND_SPEC §2).
        self._pool = await asyncpg.create_pool(
            self.settings.asyncpg_dsn, min_size=1, max_size=4,
            # Every connection acts as the ingest role, which is exempted from the
            # policies on the tables it writes but holds no privilege elsewhere.
            server_settings={"role": INGEST_ROLE},
        )
        async with scoped_session(SecurityContext.platform(0), role=None) as session:
            self.patterns = await load_topic_patterns(session)
        log.info("ingest starting", patterns=[p.pattern for p in self.patterns],
                 broker=f"{self.settings.mqtt_host}:{self.settings.mqtt_port}",
                 topics=self.settings.mqtt_subscribe_topics)

    async def stop(self) -> None:
        self._stopping.set()
        await self.flush()
        if self._pool is not None:
            await self._pool.close()
        if self._beat is not None:
            # The heartbeat's last word, while Redis is still open to take it.
            await self._beat
        await live.close_redis()
        await dispose_engine()
        log.info("ingest stopped", **self.stats)

    # ── message handling ────────────────────────────────────────────────────

    async def handle(self, topic: str, payload_bytes: bytes) -> None:
        self.stats["received"] += 1
        now = datetime.now(UTC)
        self.heartbeat.extra["last_message_at"] = now
        self.heartbeat.extra["messages"] += 1
        self._seq = (self._seq + 1) % 1_000_000

        try:
            payload = json.loads(payload_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            await self._quarantine(topic, {}, now, f"undecodable payload: {exc}")
            return
        if not isinstance(payload, dict):
            await self._quarantine(topic, {}, now, "payload is not a JSON object")
            return

        async with scoped_session(SecurityContext.platform(0), role=None) as session:
            resolution = await resolve(session, topic, self.patterns)

        if isinstance(resolution, ResolutionFailure):
            # Never attributed to a Client by inference (Guardrail 5). An Alarm is
            # raised by the alarm worker off the quarantine row rather than here,
            # so ingestion stays a single-purpose path.
            await self._quarantine(topic, payload, now, resolution.reason)
            return

        # Derived Tags observe their own throttle, so their last-write times are
        # read alongside the bound ones.
        tag_ids = [b.tag_id for b in resolution.bindings.values()]
        tag_ids += [d.tag_id for d in resolution.derived]
        cumulative_ids = [b.tag_id for b in resolution.bindings.values() if b.cumulative]
        last_written = await live.read_throttle_state(resolution.device_id, tag_ids)
        last_counters = await live.read_counter_values(resolution.device_id, cumulative_ids)
        # Only fetched when this Device computes something. The client's broker
        # splits one instrument's signals across topics, so a formula's inputs
        # routinely arrive in different messages and the standing values are what
        # let it resolve at all — but most Devices derive nothing, and a Redis
        # round-trip per message for them would be pure cost.
        standing = (
            await self._standing_values(resolution) if resolution.derived else None
        )

        result = decode(
            topic, payload, resolution, now,
            source_time=None,  # this broker publishes none; see BROKER_OBSERVATIONS §2.2
            last_written=last_written,
            last_counter_value=last_counters,
            standing=standing,
        )

        self.stats["throttled"] += len(result.throttled_keys)
        self.stats["unmapped"] += len(result.unmapped_keys)
        self.stats["suspect_counters"] += len(result.suspect_counters)
        if result.suspect_counters:
            # A decrease is a rollover or a meter replacement — indistinguishable
            # in the data, opposite in meaning (OPEN-14). Logged, never corrected.
            log.warning("counter decreased", topic=topic,
                        device_id=resolution.device_id, keys=result.suspect_counters)
        if result.unmapped_keys:
            log.info("unbound source keys", topic=topic,
                     device_id=resolution.device_id, keys=result.unmapped_keys)
            # Surfaced, not just logged. This is what the commissioning screen
            # reads to say "this Device is sending three signals nobody has
            # mapped" — a fact that exists nowhere else, because an unmapped key
            # never becomes a Reading.
            await live.record_unmapped_keys(resolution.device_id, result.unmapped_keys)

        if result.quarantined:
            await self._quarantine(topic, payload, now, result.rejection or "rejected",
                                   client_id=resolution.client_id,
                                   device_id=resolution.device_id)
            return

        await self._accept(topic, payload, now, result.readings, resolution.client_id,
                           resolution.device_id)

    async def _standing_values(self, resolution: Any) -> dict[str, float]:
        """This Device's last known value per Tag code, for formula inputs.

        Read from the live hash rather than from `readings`: it is already there,
        it is keyed by Device, and querying a compressed hypertable per message
        to learn what a Device said thirty seconds ago would be indefensible.
        """
        by_id = {b.tag_id: b.tag_code for b in resolution.bindings.values()}
        current = await live.read_current_values(resolution.device_id)
        standing: dict[str, float] = {}
        for key, raw in current.items():
            if key.startswith("_"):
                continue
            try:
                code = by_id.get(int(key))
                if code is not None:
                    standing[code] = float(raw)
            except ValueError:
                continue
        return standing

    async def _accept(
        self, topic: str, payload: dict[str, Any], now: datetime,
        readings: list[DecodedReading], client_id: int, device_id: int,
    ) -> None:
        # Heard is not stored. This must precede the early return below: when
        # every Tag in the message is inside its throttle window there is nothing
        # to write, but the Device still spoke, and the health sweep's only
        # question is whether it did.
        await live.touch_device_seen(device_id, now)
        if not readings:
            return

        # Redis first, the buffer last, with nothing that can fail in between:
        # a message whose Redis writes fail is retried whole
        # (`_handle_with_retry`), and must not already be in the buffer. The
        # throttle state goes last of the writes, because once it is written a
        # retry would throttle these very readings away.
        written = {r.tag_id: r.value for r in readings}
        await live.write_current_values(device_id, written, now)
        await live.write_counter_values(
            device_id, {r.tag_id: r.value for r in readings}
        )
        await live.write_throttle_state(device_id, list(written), now)

        for reading in readings:
            self.batch.readings.append((
                reading.time, reading.client_id, reading.device_id, reading.tag_id,
                reading.value, reading.quality, reading.source_time,
            ))
        self.batch.raw.append((
            now, topic, self._seq, json.dumps(payload), client_id, device_id, False, None,
        ))

        # A nudge to open screens, which poll anyway: never worth failing a
        # message over.
        try:
            await live.publish_live(client_id, readings[0].plant_id, {
                "device_id": device_id,
                "values": {str(k): v for k, v in written.items()},
                "at": now.isoformat(),
            })
        except Exception as exc:
            log.debug("live update not published", device_id=device_id, error=str(exc))

        self.batch.stream_entries.extend({
            "device_id": r.device_id, "client_id": r.client_id, "plant_id": r.plant_id,
            "tag_id": r.tag_id, "tag_code": r.tag_code, "value": r.value,
            "quality": r.quality, "at": r.time.isoformat(),
        } for r in readings)

    async def _quarantine(
        self, topic: str, payload: dict[str, Any], now: datetime, reason: str,
        *, client_id: int | None = None, device_id: int | None = None,
    ) -> None:
        self.stats["quarantined"] += 1
        log.warning("quarantined", topic=topic, reason=reason)
        self.batch.raw.append((
            now, topic, self._seq, json.dumps(payload), client_id, device_id, True, reason,
        ))

    # ── flushing ────────────────────────────────────────────────────────────

    async def flush(self) -> None:
        """Write the buffer. Readings and raw go in ONE transaction.

        Together, deliberately: `mqtt_raw` is the only path back to correct
        history if a binding scale is later found wrong (MASTER §5.3), so a
        Reading that exists without its raw payload would be unrepairable.
        """
        async with self._flush_lock:
            if self.batch.is_empty or self._pool is None:
                return
            # Taken, not copied: rows buffered while this one writes belong to
            # the next flush, and nothing taken here can be written twice.
            taken = self.batch.take()
            readings, raw = taken.readings, taken.raw

            if readings or raw:
                try:
                    async with self._pool.acquire() as connection, connection.transaction():
                        if readings:
                            await connection.copy_records_to_table(
                                "readings", records=readings, columns=list(READINGS_COLUMNS)
                            )
                        if raw:
                            await connection.copy_records_to_table(
                                "mqtt_raw", records=raw, columns=list(MQTT_RAW_COLUMNS)
                            )
                except Exception as exc:
                    # Put back in front for the next attempt, and recorded before it
                    # propagates so the page says why nothing is being saved. The
                    # acknowledgements go back with the rows: unsent, so the broker
                    # still holds every one of these messages.
                    self.batch.restore(taken)
                    self.heartbeat.failed(exc)
                    raise
                self.heartbeat.wrote(f"{len(readings):,} readings, {len(raw):,} raw messages")

            # Committed: now, and only now, the broker may forget these messages.
            self._acknowledge(taken.acks)

            # Only after commit. The alarm worker must never see a Reading that
            # a rolled-back transaction means never happened.
            await self._publish_alarm_entries(taken.stream_entries)

            self.stats["stored"] += len(readings)
            self.stats["flushes"] += 1
            log.debug("flushed", readings=len(readings), raw=len(raw), acks=len(taken.acks))

    def _acknowledge(self, acks: list[PendingAck]) -> None:
        """PUBACK, in arrival order, every message whose batch has committed.

        A message from an earlier connection is skipped: its id means nothing on
        this one, and the broker resends it. If the connection is gone — it can
        drop while a flush is being retried — the rest cannot be acknowledged
        either, and their resends are expected: they are stored already, so
        they are acknowledged on arrival and not stored again (`_redelivery`).
        """
        mqtt = self._mqtt
        current = [a for a in acks if a.generation == self._generation]
        # Taken by a flush that was still writing when its connection dropped:
        # `_connection_lost` never saw them, so they are expected here instead.
        stale = [a for a in acks if a.generation != self._generation]
        if stale:
            self._redelivery.connection_lost(stale, time.monotonic())
        for index, pending in enumerate(current):
            sent = False
            if mqtt is not None:
                try:
                    sent = mqtt.ack(pending.mid, pending.qos) == 0  # MQTT_ERR_SUCCESS
                except Exception as exc:  # the socket went away between commit and ack
                    log.debug("acknowledgement not sent", mid=pending.mid, error=str(exc))
            if not sent:
                self._redelivery.connection_lost(current[index:], time.monotonic())
                return
            self.stats["acknowledged"] += 1

    async def _publish_alarm_entries(self, entries: list[dict[str, Any]]) -> None:
        """Hand committed Readings to the alarm worker, holding them while Redis is away.

        Never allowed to fail the flush: the rows are committed and acknowledged,
        and putting them back would write them twice.
        """
        pending = self._stream_backlog + entries if self._stream_backlog else entries
        if not pending:
            return
        try:
            await live.publish_to_alarm_stream(pending)
        except Exception as exc:
            self._stream_backlog = pending[-STREAM_BACKLOG_MAX:]
            self.heartbeat.failed(f"handing Readings to the alarm worker: {exc}")
            log.warning("alarm stream unavailable; holding entries",
                        held=len(self._stream_backlog),
                        dropped=len(pending) - len(self._stream_backlog), error=str(exc))
            return
        self._stream_backlog = []

    async def _flush_loop(self) -> None:
        """Time-based flush, so a trickle of messages is not held indefinitely.

        Each tick is ingest's unit of work for the heartbeat. ⚠ A failed flush
        used to end this task — an unobserved exception on a background task —
        after which a trickle sat unflushed until the next message happened to
        arrive. It is now logged, recorded and retried on the next tick; the
        batch is only cleared by a flush that committed, so nothing is lost.
        """
        while not self._stopping.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=self.settings.ingest_batch_max_seconds
                )
            try:
                if self.batch.should_flush(self.settings, datetime.now(UTC)):
                    await self.flush()
            except Exception as exc:
                log.error("flush failed, retrying next tick", error=str(exc))
                continue
            self.heartbeat.cycle()

    # ── main loop ───────────────────────────────────────────────────────────

    async def run(self) -> None:
        # Beating before `start()`, so a process that cannot even reach the
        # database is on the page as crashed rather than absent.
        self._beat = self.heartbeat.start(self._stopping)
        flusher: asyncio.Task[None] | None = None
        try:
            await self.start()
            flusher = asyncio.create_task(self._flush_loop())
            while not self._stopping.is_set():
                try:
                    await self._consume()
                except aiomqtt.MqttError as exc:
                    self.heartbeat.extra["broker_connected"] = False
                    self.heartbeat.extra["broker_error"] = str(exc)
                    self._connection_lost()
                    if self._stopping.is_set():
                        break
                    # Reconnect rather than exit: the broker going away is an
                    # expected condition, not a fault in this process.
                    log.warning("mqtt connection lost, reconnecting", error=str(exc))
                    await self.heartbeat.publish()
                    await asyncio.sleep(5)
        except Exception as exc:
            self.heartbeat.crashed(exc)
            raise
        finally:
            self.heartbeat.extra["broker_connected"] = False
            if flusher is not None:
                flusher.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await flusher
            await self.stop()

    def _connection_lost(self) -> None:
        """Settle what a dropped connection leaves behind.

        Buffered rows stay and will be written: a QoS 0 message is never sent
        again, so dropping it would lose it. The acknowledgements cannot be sent
        on another connection, so they go, and the broker's resends of those
        messages are expected and acknowledged without being stored twice.
        """
        self._mqtt = None
        lost = self.batch.drop_acks_from(self._generation)
        self._redelivery.connection_lost(lost, time.monotonic())
        if lost:
            log.info("connection lost with messages unacknowledged; expecting resends",
                     messages=len(lost))

    async def _handle_with_retry(self, topic: str, payload: bytes) -> None:
        """`handle`, waiting out the database or Redis rather than dying of it.

        A failure of the infrastructure is retried with backoff for as long as
        it lasts: nothing is acknowledged meanwhile, so the broker holds the
        messages, and System Health shows the worker failing. A failure that is
        this message's own — a payload that trips a bug — is not retried, which
        would stall every Plant behind one message: it is quarantined whole,
        with the reason, and replayable later like any quarantined message.
        """
        delay = 1.0
        while True:
            try:
                await self.handle(topic, payload)
                return
            except Exception as exc:
                if not is_transient(exc):
                    log.error("message could not be processed; quarantined",
                              topic=topic, error=repr(exc))
                    self.heartbeat.failed(exc)
                    await self._quarantine(
                        topic, {"_payload": payload.decode("utf-8", errors="replace")},
                        datetime.now(UTC), f"processing error: {type(exc).__name__}: {exc}",
                    )
                    return
                if self._stopping.is_set():
                    raise
                self.stats["retries"] += 1
                self.heartbeat.failed(exc)
                log.warning("message processing failed; retrying", topic=topic,
                            error=str(exc), retry_in_s=delay)
                await asyncio.sleep(delay)
                delay = next_delay(delay)

    async def _flush_with_retry(self) -> None:
        """Flush, and while the database refuses, keep the batch and wait.

        Blocking here is the point: no message is read, so none is acknowledged
        and nothing piles up in memory but what the broker's in-flight limit
        (and the occasional QoS 0 message) allows. It used to raise out of the
        message loop and end the process, taking the buffer with it.
        """
        delay = 1.0
        while True:
            try:
                await self.flush()
                return
            except Exception as exc:
                if self._stopping.is_set():
                    raise
                self.stats["retries"] += 1
                log.warning("flush failed; holding the batch and retrying",
                            error=str(exc), retry_in_s=delay,
                            buffered_rows=len(self.batch.readings))
                await asyncio.sleep(delay)
                delay = next_delay(delay)

    async def _until_stopped(self, client: aiomqtt.Client) -> AsyncIterator[aiomqtt.Message]:
        """The broker's messages, ending as soon as the worker is asked to stop.

        A plain `async for` only noticed a stop when the next message arrived,
        so on a quiet broker SIGTERM did nothing until the supervisor killed the
        process — skipping the final flush and acknowledgement. aiomqtt cancels
        its own queue read when the wait is cancelled, so nothing is consumed
        and dropped here.
        """
        messages = client.messages.__aiter__()
        stopped = asyncio.ensure_future(self._stopping.wait())
        try:
            while True:
                following = asyncio.ensure_future(messages.__anext__())
                done, _ = await asyncio.wait({following, stopped},
                                             return_when=asyncio.FIRST_COMPLETED)
                if following not in done:
                    following.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await following
                    return
                yield following.result()
        finally:
            stopped.cancel()

    async def _consume(self) -> None:
        settings = self.settings
        async with aiomqtt.Client(
            hostname=settings.mqtt_host,
            port=settings.mqtt_port,
            username=settings.mqtt_username,
            password=(settings.mqtt_password.get_secret_value()
                      if settings.mqtt_password else None),
            identifier=settings.mqtt_client_id,
            # A persistent session with a fixed identifier, so a restart replays
            # whatever the broker held while we were away (§6.1).
            clean_session=False,
            tls_params=aiomqtt.TLSParameters() if settings.mqtt_tls else None,
        ) as client:
            # Acknowledge by hand, after commit (`workers/delivery.py`). Set on
            # the paho client aiomqtt wraps — aiomqtt 2.3 does not expose it —
            # and before subscribing, so not one message is acknowledged early.
            paho = client._client
            paho.manual_ack_set(True)
            self._generation += 1
            self._mqtt = paho
            for topic in settings.mqtt_subscribe_topics:
                await client.subscribe(topic, qos=1)
            log.info("subscribed", topics=settings.mqtt_subscribe_topics)
            self.heartbeat.extra.update(
                broker_connected=True, connected_at=datetime.now(UTC), broker_error=None)
            await self.heartbeat.publish()
            async for message in self._until_stopped(client):
                # aiomqtt types payload as a union covering str/int/float for
                # publishes it originated; an inbound message is always bytes.
                raw = message.payload
                payload = bytes(raw if isinstance(raw, bytes | bytearray) else str(raw).encode())
                topic = str(message.topic)
                if message.qos > 0:
                    print_ = fingerprint(topic, payload)
                    if self._redelivery.is_resend(print_, time.monotonic()):
                        # Already buffered from the lost connection: acknowledged
                        # with the next commit, stored once.
                        self.stats["resends_skipped"] += 1
                    else:
                        await self._handle_with_retry(topic, payload)
                    self.batch.acks.append(
                        PendingAck(self._generation, message.mid, message.qos, print_))
                else:
                    await self._handle_with_retry(topic, payload)
                if self.batch.should_flush(settings, datetime.now(UTC)):
                    await self._flush_with_retry()
                if self._stopping.is_set():
                    break
            # Stopping: write and acknowledge while the connection is still up,
            # or everything committed now is resent on the next start.
            with contextlib.suppress(Exception):
                await self.flush()
            self._mqtt = None


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    worker = IngestWorker(settings)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        # Flush before exiting: buffered rows are already acknowledged upstream
        # only if committed, but discarding them costs a needless redelivery.
        loop.add_signal_handler(sig, lambda: worker._stopping.set())
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
