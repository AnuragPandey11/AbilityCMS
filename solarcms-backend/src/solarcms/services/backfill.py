"""Recover history from quarantine after a Device is registered late.

When equipment publishes before anybody registers it, every message is
quarantined: stored whole in `mqtt_raw`, decoded into nothing. Registering the
Device fixes the future and does nothing for the past, so a machine that ran for
five days unregistered has five days of generation that no report will ever
show. That gap is permanent once raw retention passes.

It does not have to be. The payloads are intact and raw history is kept 90 days,
so the messages can be decoded now with exactly the pipeline that would have
decoded them then.

── Only quarantined rows, and that is what makes it safe ────────────────────
`readings` has no unique constraint — it is a hypertable, and an FK or unique
index checked on every inserted row is precisely what the ingest path cannot
afford. So re-running this must not be able to double-count.

It cannot, because it replays **only rows marked `quarantined`**. A quarantined
message is by definition one that produced no Reading, and each is cleared as it
is replayed. A message that decoded normally is never touched.

── Why this is not an API endpoint ──────────────────────────────────────────
⚠ The API role holds *no privilege at all* on `readings` (migrations 0008/0010)
— it reads through `readings_v` and would fail here, which is the design
working. Writing Readings is the ingest role's job. So the estimate is safe to
serve from a request and the replay is not: `estimate()` reads the barrier view,
`replay()` runs from the CLI under the ingest role.
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache import live
from solarcms.domain.decoding import decode, normalise_payload
from solarcms.workers.resolver import ResolutionFailure, load_topic_patterns, resolve

log = structlog.get_logger("backfill")


async def estimate(session: AsyncSession, device_id: int) -> dict[str, Any]:
    """What could be recovered for this Device. Read-only; safe in a request."""
    device = (await session.execute(text(
        "SELECT id, code, source_address FROM devices WHERE id = :id"
    ), {"id": device_id})).first()
    if device is None or not device.source_address:
        return {"device_id": device_id, "recoverable_messages": 0,
                "earliest": None, "latest": None, "topic": None}

    row = (await session.execute(text("""
        SELECT count(*) AS messages, min(time) AS earliest, max(time) AS latest
          FROM mqtt_raw_v
         WHERE topic = :topic AND quarantined
    """), {"topic": device.source_address})).first()

    return {
        "device_id": device_id,
        "device_code": device.code,
        "topic": device.source_address,
        "recoverable_messages": row.messages if row else 0,
        "earliest": row.earliest if row else None,
        "latest": row.latest if row else None,
    }


async def replay(
    session: AsyncSession, device_id: int, *, apply: bool = False,
    batch_size: int = 5000,
) -> dict[str, Any]:
    """Decode this Device's quarantined messages into Readings.

    Runs under the ingest role. Returns what it did, or would do.
    """
    stats: dict[str, Any] = {
        "device_id": device_id, "messages": 0, "readings": 0,
        "unparseable": 0, "skipped": 0, "applied": apply,
    }

    device = (await session.execute(text(
        "SELECT id, code, source_address FROM devices WHERE id = :id"
    ), {"id": device_id})).first()
    if device is None or not device.source_address:
        stats["error"] = "device not found, or has no topic"
        return stats

    topic = device.source_address
    # The resolver caches a miss for 300 s, and the miss is exactly what was
    # cached while this Device was unregistered.
    await live.invalidate_resolution(topic)
    patterns = await load_topic_patterns(session)
    resolution = await resolve(session, topic, patterns)
    if isinstance(resolution, ResolutionFailure):
        stats["error"] = f"topic still does not resolve: {resolution.reason}"
        return stats
    if not resolution.bindings:
        # Registering a Device with no bindings and replaying into it would
        # report success having written nothing.
        stats["error"] = "Device has no Tag bindings; bind before backfilling"
        return stats

    rows = (await session.execute(text("""
        SELECT time, seq, payload FROM mqtt_raw
         WHERE topic = :topic AND quarantined
         ORDER BY time
         LIMIT :limit
    """), {"topic": topic, "limit": batch_size})).all()

    for row in rows:
        stats["messages"] += 1
        payload = row.payload if isinstance(row.payload, dict) else {}
        _flat, payload_timestamp = normalise_payload(payload)
        # ⚠ `now` is the message's own receipt time, never the clock. Replaying
        # a week of history stamped "today" would compress it into one instant
        # and make every figure over that period wrong.
        result = decode(
            topic, payload, resolution, row.time,
            source_time=None if payload_timestamp is None else row.time,
            last_written=None, last_counter_value=None,
        )
        if result.rejection:
            stats["unparseable"] += 1
            continue
        if not result.readings:
            stats["skipped"] += 1
            continue
        stats["readings"] += len(result.readings)

        if not apply:
            continue
        for reading in result.readings:
            await session.execute(text("""
                INSERT INTO readings (time, client_id, device_id, tag_id, value,
                                      quality, source_time)
                VALUES (:time, :client_id, :device_id, :tag_id, :value,
                        :quality, :source_time)
            """), {
                "time": reading.time, "client_id": reading.client_id,
                "device_id": reading.device_id, "tag_id": reading.tag_id,
                "value": reading.value, "quality": reading.quality,
                "source_time": reading.source_time,
            })

    if apply and stats["readings"]:
        # Clearing the flag is what makes a re-run safe: these rows have now
        # produced Readings and must never be replayed a second time.
        await session.execute(text("""
            UPDATE mqtt_raw SET quarantined = false,
                                reason = 'backfilled after late registration'
             WHERE topic = :topic AND quarantined
               AND time <= :latest
        """), {"topic": topic, "latest": rows[-1].time})
        log.info("backfilled from quarantine", device_id=device_id,
                 topic=topic, **{k: v for k, v in stats.items() if k != "device_id"})

    stats["has_more"] = len(rows) == batch_size
    return stats
