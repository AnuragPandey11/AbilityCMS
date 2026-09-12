"""Topic → Device resolution, cached in Redis.

Separated from the worker because it is the one part of ingestion that touches
the database on a hot path, and it is where Guardrail 5 lives: **the topic is the
sole authority for origin**. Nothing here reads the payload.

Resolution order:

1. **Exact match on `devices.source_address`.** MASTER §3.7 established that this
   column already *is* the data-source mapping, which is why
   `data_source_connections` was dropped. It covers both topic shapes with no
   parsing at all.
2. **Pattern match against the ingress registry**, then lookup by the captured
   codes. This is what lets the canonical contract and a legacy shape coexist as
   data rather than as branches in code (I-1).

A topic that resolves by neither is quarantined. It is never attributed to a
Client by inference: a wrong guess silently merges one Client's data into
another's history, and nothing downstream can detect it afterwards.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache import live
from solarcms.domain.decoding import DeviceResolution, TagBinding, TopicPattern, parse_topic

log = structlog.get_logger(__name__)


@dataclass(frozen=True, slots=True)
class ResolutionFailure:
    topic: str
    reason: str


async def load_topic_patterns(session: AsyncSession) -> list[TopicPattern]:
    rows = await session.execute(text(
        "SELECT pattern, priority FROM topic_patterns WHERE enabled ORDER BY priority"
    ))
    patterns: list[TopicPattern] = []
    for pattern, priority in rows:
        try:
            patterns.append(TopicPattern(pattern=pattern, priority=priority))
        except ValueError as exc:
            # A malformed row must not take the worker down, but it must be loud:
            # silently skipping it would quarantine every message it was meant to
            # match, with no obvious cause.
            log.error("ignoring malformed topic pattern", pattern=pattern, error=str(exc))
    return patterns


async def _load_bindings(session: AsyncSession, device_id: int) -> dict[str, TagBinding]:
    rows = await session.execute(text("""
        SELECT b.source_key, b.tag_id, t.code, b.scale, b.value_offset,
               b.valid_min, b.valid_max, t.min_interval_s, t.is_cumulative
          FROM device_tag_bindings b
          JOIN tags t ON t.id = b.tag_id
         WHERE b.device_id = :device_id AND b.enabled
    """), {"device_id": device_id})
    return {
        row.source_key: TagBinding(
            source_key=row.source_key,
            tag_id=row.tag_id,
            tag_code=row.code,
            scale=row.scale,
            offset=row.value_offset,
            # Bounds fall back to the Tag's own when the binding does not narrow
            # them; a per-Device override exists for instruments with a narrower
            # working range than the metric permits.
            valid_min=row.valid_min,
            valid_max=row.valid_max,
            min_interval_s=row.min_interval_s,
            cumulative=row.is_cumulative,
        )
        for row in rows
    }


async def _device_row(session: AsyncSession, topic: str, patterns: list[TopicPattern]):  # type: ignore[no-untyped-def]
    """Find the Device this topic belongs to, by address then by pattern."""
    exact = await session.execute(text("""
        SELECT d.id, d.client_id, d.plant_id, d.expected_interval_s
          FROM devices d
         WHERE d.source_address = :topic AND d.status <> 'decommissioned'
    """), {"topic": topic})
    row = exact.first()
    if row is not None:
        return row

    captured = parse_topic(topic, patterns)
    if captured is None:
        return None

    device_code = captured.get("device_code")
    plant_code = captured.get("plant_code")
    client_code = captured.get("client_code")
    if device_code is None or plant_code is None:
        # A legacy topic carries a category rather than a device_code, and the
        # category-to-Device mapping is `devices.source_address`, which the exact
        # match above already tried. Nothing further can be inferred.
        return None

    matched = await session.execute(text("""
        SELECT d.id, d.client_id, d.plant_id, d.expected_interval_s
          FROM devices d
          JOIN plants p  ON p.id = d.plant_id
          JOIN clients c ON c.id = p.client_id
         WHERE d.code = :device_code
           AND p.code = :plant_code
           AND (CAST(:client_code AS text) IS NULL OR c.code = :client_code)
           AND d.status <> 'decommissioned'
    """), {"device_code": device_code, "plant_code": plant_code,
           "client_code": client_code})
    return matched.first()


async def resolve(
    session: AsyncSession, topic: str, patterns: list[TopicPattern]
) -> DeviceResolution | ResolutionFailure:
    """Resolve a topic, using the Redis cache before touching Postgres."""
    cached = await live.read_resolution(topic)
    if cached is not None:
        if cached.get("miss"):
            return ResolutionFailure(topic, cached.get("reason", "unknown topic"))
        return DeviceResolution(
            device_id=cached["device_id"],
            client_id=cached["client_id"],
            plant_id=cached["plant_id"],
            expected_interval_s=cached["expected_interval_s"],
            bindings={
                key: TagBinding(**binding) for key, binding in cached["bindings"].items()
            },
        )

    row = await _device_row(session, topic, patterns)
    if row is None:
        reason = "no Device registered for this topic"
        # Negative results are cached too. Without this, an unregistered Device
        # publishing every 2.8s would hit Postgres on every message forever.
        await live.cache_resolution(topic, {"miss": True, "reason": reason})
        return ResolutionFailure(topic, reason)

    bindings = await _load_bindings(session, row.id)
    resolution = DeviceResolution(
        device_id=row.id,
        client_id=row.client_id,
        plant_id=row.plant_id,
        expected_interval_s=row.expected_interval_s,
        bindings=bindings,
    )
    await live.cache_resolution(topic, {
        "device_id": row.id,
        "client_id": row.client_id,
        "plant_id": row.plant_id,
        "expected_interval_s": row.expected_interval_s,
        # asdict, not vars: TagBinding uses slots and has no __dict__.
        "bindings": {k: asdict(v) for k, v in bindings.items()},
    })
    return resolution
