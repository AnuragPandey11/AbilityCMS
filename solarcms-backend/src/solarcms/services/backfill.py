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

from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache import live
from solarcms.config import get_settings
from solarcms.domain.decoding import decode, normalise_payload
from solarcms.services.device_topics import topics_of
from solarcms.workers.resolver import ResolutionFailure, load_topic_patterns, resolve

log = structlog.get_logger("backfill")


async def estimate(session: AsyncSession, device_id: int) -> dict[str, Any]:
    """What could be recovered for this Device. Read-only; safe in a request.

    Counts every topic the Device is registered on — an Inverter's PV-string
    topics (migration 0030) were quarantined exactly as its own was.
    """
    device = (await session.execute(text(
        "SELECT id, code, source_address FROM devices WHERE id = :id"
    ), {"id": device_id})).first()
    topics = await topics_of(session, device_id) if device is not None else []
    if device is None or not topics:
        return {"device_id": device_id, "recoverable_messages": 0,
                "earliest": None, "latest": None, "topic": None, "topics": []}

    row = (await session.execute(text("""
        SELECT count(*) AS messages, min(time) AS earliest, max(time) AS latest
          FROM mqtt_raw_v
         WHERE topic = ANY(:topics) AND quarantined
    """), {"topics": topics})).first()

    return {
        "device_id": device_id,
        "device_code": device.code,
        "topic": device.source_address,
        "topics": topics,
        "recoverable_messages": row.messages if row else 0,
        "earliest": row.earliest if row else None,
        "latest": row.latest if row else None,
    }


async def replay(
    session: AsyncSession, device_id: int, *, apply: bool = False,
    batch_size: int = 5000,
) -> dict[str, Any]:
    """Decode this Device's quarantined messages into Readings.

    Runs under the ingest role. Returns what it did, or would do. Every topic
    the Device is registered on is replayed, up to `batch_size` messages each.
    """
    stats: dict[str, Any] = {
        "device_id": device_id, "messages": 0, "readings": 0,
        "unparseable": 0, "skipped": 0, "applied": apply, "has_more": False,
    }

    device = (await session.execute(text(
        "SELECT id, code, source_address FROM devices WHERE id = :id"
    ), {"id": device_id})).first()
    topics = await topics_of(session, device_id) if device is not None else []
    if device is None or not topics:
        stats["error"] = "device not found, or has no topic"
        return stats

    patterns = await load_topic_patterns(session)
    for topic in topics:
        error = await _replay_topic(session, topic, patterns, stats,
                                    apply=apply, batch_size=batch_size)
        if error:
            stats["error"] = error
            return stats
    return stats


async def _replay_topic(
    session: AsyncSession, topic: str, patterns: Any, stats: dict[str, Any],
    *, apply: bool, batch_size: int,
) -> str | None:
    """Replay one topic's quarantined messages into `stats`. Returns an error."""
    # The resolver caches a miss for 300 s, and the miss is exactly what was
    # cached while this Device was unregistered.
    await live.invalidate_resolution(topic)
    resolution = await resolve(session, topic, patterns)
    if isinstance(resolution, ResolutionFailure):
        return f"topic {topic!r} still does not resolve: {resolution.reason}"
    if not resolution.bindings:
        # Registering a Device with no bindings and replaying into it would
        # report success having written nothing.
        return "Device has no Tag bindings; bind before backfilling"

    rows = (await session.execute(text("""
        SELECT time, seq, payload FROM mqtt_raw
         WHERE topic = :topic AND quarantined
         ORDER BY time
         LIMIT :limit
    """), {"topic": topic, "limit": batch_size})).all()

    readings_before = stats["readings"]
    for row in rows:
        stats["messages"] += 1
        # The span replayed, so the aggregate tiers can be refreshed over it
        # afterwards (`refresh_aggregates`): rows inserted into minutes already
        # materialised are otherwise never aggregated.
        stats["first_at"] = min(stats.get("first_at") or row.time, row.time)
        stats["last_at"] = max(stats.get("last_at") or row.time, row.time)
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

    if apply and stats["readings"] > readings_before:
        # Clearing the flag is what makes a re-run safe: these rows have now
        # produced Readings and must never be replayed a second time.
        await session.execute(text("""
            UPDATE mqtt_raw SET quarantined = false,
                                reason = 'backfilled after late registration'
             WHERE topic = :topic AND quarantined
               AND time <= :latest
        """), {"topic": topic, "latest": rows[-1].time})
        log.info("backfilled from quarantine", device_id=stats["device_id"],
                 topic=topic, readings=stats["readings"] - readings_before)

    stats["has_more"] = stats["has_more"] or len(rows) == batch_size
    return None


#: Raw readings are kept 30 days (`readings` retention). A refresh rebuilds a
#: window *for every Device* from raw rows, so over a window whose raw rows are
#: gone it would delete every other Device's aggregates there. One day of
#: margin below the retention, so a chunk about to be dropped is never relied on.
REFRESHABLE_DAYS = 29

TIERS_IN_ORDER = ("agg_1m", "agg_15m", "agg_1h", "agg_1d")
#: Each tier's bucket. TimescaleDB refuses a refresh window that covers no
#: whole bucket of the tier, so each is widened to its own boundaries (the
#: buckets are cut in UTC: an hour starts at :30 in Kolkata, a day at 05:30).
TIER_BUCKET = {"agg_1m": timedelta(minutes=1), "agg_15m": timedelta(minutes=15),
               "agg_1h": timedelta(hours=1), "agg_1d": timedelta(days=1)}
_EPOCH = datetime(2000, 1, 1, tzinfo=UTC)


def _floor(moment: datetime, size: timedelta) -> datetime:
    return moment - (moment - _EPOCH) % size


def _ceil(moment: datetime, size: timedelta) -> datetime:
    floored = _floor(moment, size)
    return floored if floored == moment else floored + size


def refresh_window(first: datetime, last: datetime, now: datetime) -> tuple[datetime, datetime]:
    """Whole UTC days covering [first, last], clipped to what can be rebuilt.

    Raises ValueError when nothing of the span lies within raw retention.
    """
    earliest = now - timedelta(days=REFRESHABLE_DAYS)
    start = max(first, earliest).replace(hour=0, minute=0, second=0, microsecond=0)
    if start < earliest:
        start += timedelta(days=1)
    end = (last + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    end = min(end, now)
    if start >= end:
        raise ValueError(
            f"the span {first:%Y-%m-%d} to {last:%Y-%m-%d} is older than raw retention "
            f"({REFRESHABLE_DAYS} days): its aggregates cannot be rebuilt without "
            f"losing every other Device's for the same days")
    return start, end


async def refresh_aggregates(start: datetime, end: datetime) -> list[str]:
    """Rebuild every aggregate tier over [start, end), finest first.

    Each tier reads the one below it, so the order matters. Run as the
    migration owner on a connection of its own: `CALL refresh_continuous_aggregate`
    cannot run inside a transaction, and only the owner may refresh.
    """
    settings = get_settings()
    done: list[str] = []
    connection = await asyncpg.connect(settings.asyncpg_dsn)
    try:
        for tier in TIERS_IN_ORDER:
            size = TIER_BUCKET[tier]
            tier_start, tier_end = _floor(start, size), _ceil(end, size)
            # Literals, not parameters: CALL takes no bound arguments here, and
            # the values are datetimes this module produced, never input.
            await connection.execute(
                f"CALL refresh_continuous_aggregate('{tier}', "
                f"'{tier_start.isoformat()}'::timestamptz, "
                f"'{tier_end.isoformat()}'::timestamptz)",
                timeout=3600)
            done.append(tier)
    finally:
        await connection.close()
    return done
