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

* **Acknowledge only after commit.** With QoS 1 a crash then causes redelivery
  rather than loss, which is why the batch window is 2 seconds and not 2 minutes.
* **Unknown topic → quarantine, never infer.** Guardrail 5.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import signal
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import aiomqtt
import asyncpg

from solarcms.cache import live
from solarcms.config import Settings, get_settings
from solarcms.db.rls import INGEST_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.decoding import DecodedReading, TopicPattern, decode
from solarcms.logging import configure_logging, get_logger
from solarcms.workers.resolver import ResolutionFailure, load_topic_patterns, resolve

log = get_logger("ingest")

READINGS_COLUMNS = ("time", "client_id", "device_id", "tag_id", "value", "quality",
                    "source_time")
MQTT_RAW_COLUMNS = ("time", "topic", "seq", "payload", "client_id", "device_id",
                    "quarantined", "reason")


@dataclass
class Batch:
    """Rows buffered between flushes, plus the ack callbacks they belong to."""

    readings: list[tuple[Any, ...]] = field(default_factory=list)
    raw: list[tuple[Any, ...]] = field(default_factory=list)
    stream_entries: list[dict[str, Any]] = field(default_factory=list)
    opened_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    def clear(self) -> None:
        self.readings.clear()
        self.raw.clear()
        self.stream_entries.clear()
        self.opened_at = datetime.now(UTC)

    @property
    def is_empty(self) -> bool:
        return not self.readings and not self.raw

    def should_flush(self, settings: Settings, now: datetime) -> bool:
        if len(self.readings) >= settings.ingest_batch_max_rows:
            return True
        age = (now - self.opened_at).total_seconds()
        return not self.is_empty and age >= settings.ingest_batch_max_seconds


class IngestWorker:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.batch = Batch()
        self.patterns: list[TopicPattern] = []
        self._pool: asyncpg.Pool | None = None
        self._stopping = asyncio.Event()
        self._seq = 0
        self.stats = {"received": 0, "stored": 0, "quarantined": 0, "throttled": 0,
                      "unmapped": 0, "suspect_counters": 0, "flushes": 0}

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
        await live.close_redis()
        await dispose_engine()
        log.info("ingest stopped", **self.stats)

    # ── message handling ────────────────────────────────────────────────────

    async def handle(self, topic: str, payload_bytes: bytes) -> None:
        self.stats["received"] += 1
        now = datetime.now(UTC)
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
        for reading in readings:
            self.batch.readings.append((
                reading.time, reading.client_id, reading.device_id, reading.tag_id,
                reading.value, reading.quality, reading.source_time,
            ))
        self.batch.raw.append((
            now, topic, self._seq, json.dumps(payload), client_id, device_id, False, None,
        ))

        written = {r.tag_id: r.value for r in readings}
        await live.write_current_values(device_id, written, now)
        await live.write_throttle_state(device_id, list(written), now)
        await live.write_counter_values(
            device_id, {r.tag_id: r.value for r in readings}
        )
        await live.publish_live(client_id, readings[0].plant_id, {
            "device_id": device_id,
            "values": {str(k): v for k, v in written.items()},
            "at": now.isoformat(),
        })

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
        if self.batch.is_empty or self._pool is None:
            return
        readings = list(self.batch.readings)
        raw = list(self.batch.raw)
        stream_entries = list(self.batch.stream_entries)

        async with self._pool.acquire() as connection, connection.transaction():
            if readings:
                await connection.copy_records_to_table(
                    "readings", records=readings, columns=list(READINGS_COLUMNS)
                )
            if raw:
                await connection.copy_records_to_table(
                    "mqtt_raw", records=raw, columns=list(MQTT_RAW_COLUMNS)
                )

        # Only after commit. The alarm worker must never see a Reading that a
        # rolled-back transaction means never happened.
        await live.publish_to_alarm_stream(stream_entries)

        self.stats["stored"] += len(readings)
        self.stats["flushes"] += 1
        log.debug("flushed", readings=len(readings), raw=len(raw))
        self.batch.clear()

    async def _flush_loop(self) -> None:
        """Time-based flush, so a trickle of messages is not held indefinitely."""
        while not self._stopping.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(
                    self._stopping.wait(), timeout=self.settings.ingest_batch_max_seconds
                )
            if self.batch.should_flush(self.settings, datetime.now(UTC)):
                await self.flush()

    # ── main loop ───────────────────────────────────────────────────────────

    async def run(self) -> None:
        await self.start()
        flusher = asyncio.create_task(self._flush_loop())
        try:
            while not self._stopping.is_set():
                try:
                    await self._consume()
                except aiomqtt.MqttError as exc:
                    if self._stopping.is_set():
                        break
                    # Reconnect rather than exit: the broker going away is an
                    # expected condition, not a fault in this process.
                    log.warning("mqtt connection lost, reconnecting", error=str(exc))
                    await asyncio.sleep(5)
        finally:
            flusher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await flusher
            await self.stop()

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
            for topic in settings.mqtt_subscribe_topics:
                await client.subscribe(topic, qos=1)
            log.info("subscribed", topics=settings.mqtt_subscribe_topics)
            async for message in client.messages:
                # aiomqtt types payload as a union covering str/int/float for
                # publishes it originated; an inbound message is always bytes.
                raw = message.payload
                payload = raw if isinstance(raw, bytes | bytearray) else str(raw).encode()
                await self.handle(str(message.topic), bytes(payload))
                if self.batch.should_flush(settings, datetime.now(UTC)):
                    await self.flush()
                if self._stopping.is_set():
                    break


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
