"""Every topic a Device is registered on — its primary and its extras.

A Device's primary topic is `devices.source_address`; since migration 0030 it
may also own extra topics in `device_topics` (an Inverter whose PV strings are
published on `INVERTER_1_STRING16`). Ingest caches each topic's resolution, with
the Device's bindings, separately — so anything that changes a Device or its
bindings must clear *every* one of its topics, or the extras go on decoding
against the old mapping for five minutes while the primary does not.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache.live import invalidate_resolution


async def topics_of(session: AsyncSession, device_id: int) -> list[str]:
    """The Device's topics, primary first. Empty for a Device with none."""
    rows = (await session.execute(text("""
        SELECT topic FROM registered_topics
         WHERE device_id = :device_id
         ORDER BY is_primary DESC, topic
    """), {"device_id": device_id})).all()
    return [row.topic for row in rows]


async def extra_topics_by_device(
    session: AsyncSession, device_ids: Iterable[int]
) -> dict[int, list[str]]:
    """Extra topics per Device, for listing beside the primary."""
    ids = list(device_ids)
    if not ids:
        return {}
    rows = (await session.execute(text("""
        SELECT device_id, topic FROM device_topics
         WHERE device_id = ANY(:ids)
         ORDER BY topic
    """), {"ids": ids})).all()
    out: dict[int, list[str]] = {}
    for row in rows:
        out.setdefault(row.device_id, []).append(row.topic)
    return out


async def topic_owner(session: AsyncSession, topic: str) -> Any:
    """The Device registered on this topic, primary or extra, or None.

    Returns `(device_id, code, is_primary)`. The primary wins if a topic were
    ever both — which the API and CLI refuse, since no constraint can.
    """
    return (await session.execute(text("""
        SELECT rt.device_id, d.code, rt.is_primary
          FROM registered_topics rt JOIN devices d ON d.id = rt.device_id
         WHERE rt.topic = :topic
         ORDER BY rt.is_primary DESC
         LIMIT 1
    """), {"topic": topic})).first()


class TopicRefused(ValueError):
    """An extra topic that may not be attached, with the reason in words."""


async def attach_topic(
    session: AsyncSession, device_id: int, topic: str, *, note: str | None = None,
) -> tuple[int | None, bool]:
    """Register `topic` as one of this Device's extra topics.

    Returns `(row id, created)`; attaching a topic the Device already has is a
    no-op, so a re-run of commissioning changes nothing. Refuses — never
    guesses — when the topic:

    * matches no topic pattern, or names another Plant or Client than the
      Device's own (a topic decides origin, and this one says somewhere else);
    * names another Collector than the Device sits in (Guardrail 13: the topic
      is the only thing that decides which enclosure a Device is in, and two
      topics of one Device cannot disagree about it);
    * is already registered to any Device, as its primary or as an extra;
    * would attach to a Plant KPI panel, which publishes nothing.
    """
    from solarcms.domain.decoding import collector_in_topic, parse_topic
    from solarcms.workers.resolver import load_topic_patterns

    topic = topic.strip()
    if not topic:
        raise TopicRefused("a topic cannot be blank")
    device = (await session.execute(text("""
        SELECT d.id, d.code, d.client_id, d.collector_code,
               p.code AS plant_code, c.code AS client_code, dt.code AS type_code
          FROM devices d
          JOIN plants p ON p.id = d.plant_id
          JOIN clients c ON c.id = p.client_id
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt ON dt.id = dm.device_type_id
         WHERE d.id = :id
    """), {"id": device_id})).first()
    if device is None:
        raise TopicRefused(f"there is no Device {device_id}")
    if device.type_code == "PLANT_KPI":
        raise TopicRefused(f"{device.code} is a Plant KPI panel: its figures are "
                           f"computed, and nothing publishes to it")

    owner = await topic_owner(session, topic)
    if owner is not None:
        if owner.device_id == device_id:
            return None, False
        raise TopicRefused(f"{topic!r} is already registered to {owner.code}; "
                           f"two Devices cannot share a topic")

    patterns = await load_topic_patterns(session)
    captured = parse_topic(topic, patterns)
    if captured is None:
        raise TopicRefused(f"{topic!r} matches no topic pattern, so nothing could "
                           f"be attributed from it")
    if captured.get("plant_code") != device.plant_code or (
        captured.get("client_code") is not None
        and captured.get("client_code") != device.client_code
    ):
        raise TopicRefused(
            f"{topic!r} is for {captured.get('client_code')}/"
            f"{captured.get('plant_code')}, but {device.code} is at "
            f"{device.client_code}/{device.plant_code}")
    _known, collector = collector_in_topic(topic, patterns)
    if collector != device.collector_code:
        here = f"collector {device.collector_code}" if device.collector_code else "no collector"
        there = f"collector {collector}" if collector else "no collector"
        raise TopicRefused(f"{topic!r} publishes from {there}, but {device.code} is in "
                           f"{here}; a Device's topics cannot disagree about where it is")

    row_id = (await session.execute(text("""
        INSERT INTO device_topics (client_id, device_id, topic, note)
        VALUES (:client_id, :device_id, :topic, :note)
        RETURNING id
    """), {"client_id": device.client_id, "device_id": device_id,
           "topic": topic, "note": note})).scalar_one()
    return int(row_id), True


async def invalidate_device(
    session: AsyncSession, device_id: int, *also: str | None
) -> list[str]:
    """Clear ingest's cached resolution for every topic of this Device.

    `also` names topics the Device no longer has — a primary just changed, a
    Device just deleted — whose cached resolution still points at it. Returns
    the topics cleared.
    """
    topics = {*await topics_of(session, device_id), *(t for t in also if t)}
    for topic in topics:
        await invalidate_resolution(topic)
    return sorted(topics)
