"""Current values, rollups, pub/sub fan-out, and the alarm stream."""

from __future__ import annotations

import json
from collections.abc import Awaitable
from datetime import UTC, datetime
from typing import Any, cast

import redis.asyncio as aioredis

from solarcms.cache import keys
from solarcms.config import get_settings

_client: aioredis.Redis | None = None


def get_redis() -> aioredis.Redis:
    global _client
    if _client is None:
        # redis-py ships `from_url` unannotated; the ignore is scoped to this one
        # call rather than relaxing strictness for the module.
        _client = aioredis.from_url(  # type: ignore[no-untyped-call]
            str(get_settings().redis_url), decode_responses=True
        )
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
    _client = None


async def write_current_values(
    device_id: int, values: dict[int, float], at: datetime
) -> None:
    """Replace a Device's current values. One pipeline per message, not per Tag."""
    if not values:
        return
    redis = get_redis()
    async with redis.pipeline(transaction=False) as pipe:
        mapping: dict[str, str] = {str(k): repr(v) for k, v in values.items()}
        mapping["_ts"] = at.isoformat()
        pipe.hset(keys.live_device(device_id), mapping=mapping)
        pipe.expire(keys.live_device(device_id), keys.LIVE_DEVICE_TTL_S)
        await pipe.execute()


async def clear_current_values(device_id: int, tag_ids: list[int]) -> None:
    """Drop specific Tags from a Device's current values.

    Used at the Plant's day boundary: today's peak power and start time must
    *stop standing* once they have been copied to the YESTERDAY family, or
    tomorrow's peak is compared against yesterday's and never beats it.
    """
    if not tag_ids:
        return
    # Cast for the same reason `read_current_values` does: redis-py types this as
    # possibly-sync depending on the client flavour, and this client is async.
    await cast(
        "Awaitable[int]",
        get_redis().hdel(keys.live_device(device_id), *[str(t) for t in tag_ids]),
    )


async def record_unmapped_keys(device_id: int, source_keys: list[str]) -> None:
    """Remember payload keys nothing is bound to, for the commissioning screen.

    A published-but-unbound key is not an error — a Device may report more than
    has been mapped — but it *is* the signal that commissioning is unfinished,
    and it is invisible everywhere else: an unmapped key never becomes a Reading,
    so no query over `readings` can ever reveal one. Kept for a day, so the list
    reflects what the Device is sending now rather than what it once sent.
    """
    if not source_keys:
        return
    redis = get_redis()
    async with redis.pipeline(transaction=False) as pipe:
        pipe.sadd(keys.unmapped_keys(device_id), *source_keys)
        pipe.expire(keys.unmapped_keys(device_id), keys.UNMAPPED_KEYS_TTL_S)
        await pipe.execute()


async def read_unmapped_keys(device_id: int) -> list[str]:
    result: set[str] = await cast(
        "Awaitable[set[str]]", get_redis().smembers(keys.unmapped_keys(device_id))
    )
    return sorted(result)


async def clear_unmapped_keys(device_id: int) -> None:
    await get_redis().delete(keys.unmapped_keys(device_id))


async def remove_unmapped_keys(device_id: int, source_keys: list[str]) -> None:
    """Forget only the keys that have just been bound, keeping the rest listed."""
    if source_keys:
        await cast(
            "Awaitable[int]",
            get_redis().srem(keys.unmapped_keys(device_id), *source_keys),
        )


async def touch_device_seen(device_id: int, at: datetime) -> None:
    """Record that a Device spoke, whether or not anything was stored.

    Called for every accepted message *before* throttling decides what to keep.
    This is the liveness signal the health sweep reads; `readings` cannot serve
    that role because throttling legitimately stores nothing from most messages.
    """
    await get_redis().set(
        keys.seen_device(device_id), at.isoformat(), ex=keys.SEEN_DEVICE_TTL_S
    )


async def read_device_seen(device_ids: list[int]) -> dict[int, datetime | None]:
    """Last-heard time per Device, `None` where the key is absent or expired."""
    if not device_ids:
        return {}
    raw = await cast(
        "Awaitable[list[str | None]]",
        get_redis().mget([keys.seen_device(d) for d in device_ids]),
    )
    return {
        device_id: (datetime.fromisoformat(value) if value else None)
        for device_id, value in zip(device_ids, raw, strict=True)
    }


async def read_kpi_day(device_id: int) -> dict[str, str]:
    """The Plant KPI Device's figures for its day, by Tag code, plus `_boundary`."""
    result: dict[str, str] = await cast(
        "Awaitable[dict[str, str]]", get_redis().hgetall(keys.plant_kpi_day(device_id))
    )
    return result


async def write_kpi_day(device_id: int, values: dict[str, str]) -> None:
    """Replace the day's figures whole: what is not in `values` no longer stands."""
    key = keys.plant_kpi_day(device_id)
    async with get_redis().pipeline(transaction=True) as pipe:
        pipe.delete(key)
        pipe.hset(key, mapping=values)
        pipe.expire(key, keys.PLANT_KPI_DAY_TTL_S)
        await pipe.execute()


async def read_current_values(device_id: int) -> dict[str, str]:
    # redis-py types hgetall as possibly-sync depending on the client flavour;
    # this client is always async, so the cast is the narrowing, not a guess.
    result: dict[str, str] = await cast(
        "Awaitable[dict[str, str]]", get_redis().hgetall(keys.live_device(device_id))
    )
    return result


async def read_throttle_state(
    device_id: int, tag_ids: list[int]
) -> dict[int, datetime]:
    """Last write time per Tag, for min_interval_s throttling.

    Read in bulk rather than per Tag: a Device publishing 17 signals would
    otherwise cost 17 round trips per message, at ~2.8 s intervals, forever.
    """
    if not tag_ids:
        return {}
    redis = get_redis()
    raw = await redis.mget([keys.throttle(device_id, t) for t in tag_ids])
    out: dict[int, datetime] = {}
    for tag_id, value in zip(tag_ids, raw, strict=True):
        if value:
            out[tag_id] = datetime.fromisoformat(value)
    return out


async def write_throttle_state(
    device_id: int, tag_ids: list[int], at: datetime
) -> None:
    if not tag_ids:
        return
    redis = get_redis()
    stamp = at.isoformat()
    async with redis.pipeline(transaction=False) as pipe:
        for tag_id in tag_ids:
            pipe.set(keys.throttle(device_id, tag_id), stamp, ex=keys.THROTTLE_TTL_S)
        await pipe.execute()


async def read_counter_values(device_id: int, tag_ids: list[int]) -> dict[int, float]:
    """Last seen value of each cumulative counter, to detect a decrease."""
    if not tag_ids:
        return {}
    raw = await get_redis().mget([keys.counter(device_id, t) for t in tag_ids])
    return {
        tag_id: float(value)
        for tag_id, value in zip(tag_ids, raw, strict=True)
        if value is not None
    }


async def write_counter_values(device_id: int, values: dict[int, float]) -> None:
    if not values:
        return
    redis = get_redis()
    async with redis.pipeline(transaction=False) as pipe:
        for tag_id, value in values.items():
            pipe.set(keys.counter(device_id, tag_id), repr(value), ex=keys.COUNTER_TTL_S)
        await pipe.execute()


async def cache_resolution(topic: str, payload: dict[str, Any]) -> None:
    await get_redis().set(
        keys.resolve_topic(topic), json.dumps(payload), ex=keys.RESOLVE_TOPIC_TTL_S
    )


async def read_resolution(topic: str) -> dict[str, Any] | None:
    raw = await get_redis().get(keys.resolve_topic(topic))
    return json.loads(raw) if raw else None


async def invalidate_resolution(topic: str) -> None:
    """Called when a Device or binding changes. The TTL is only a backstop.

    Also announced, because ingest keeps resolutions in its own memory too
    (docs/CAPACITY_AND_DEPLOYMENT.md §4.5) and must drop its copy now, not when
    the memory entry ages out.
    """
    redis = get_redis()
    await redis.delete(keys.resolve_topic(topic))
    await redis.publish(keys.RESOLVE_INVALIDATE, topic)


async def announce_all_resolutions_invalid() -> None:
    """Tell ingest to drop every resolution it holds in memory."""
    await get_redis().publish(keys.RESOLVE_INVALIDATE, keys.RESOLVE_INVALIDATE_ALL)


async def write_message_state(
    *,
    device_id: int,
    client_id: int,
    plant_id: int,
    at: datetime,
    current: dict[int, float],
    counters: dict[int, float],
    throttled_now: list[int],
    unmapped: list[str],
) -> None:
    """Everything one accepted message writes to Redis, in a single round trip.

    It used to be five or six separate calls per message — current values,
    counters, throttle stamps, unmapped keys, the live frame — each a network
    round trip, which is what capped ingest at ~31 messages/s across
    availability zones (docs/CAPACITY_AND_DEPLOYMENT.md §4.5, §10.3). The
    keys and values are exactly what the separate calls wrote. Raises on a
    connection failure, so the caller retries the whole message.
    """
    async with get_redis().pipeline(transaction=False) as pipe:
        if current:
            mapping: dict[str, str] = {str(k): repr(v) for k, v in current.items()}
            mapping["_ts"] = at.isoformat()
            pipe.hset(keys.live_device(device_id), mapping=mapping)
            pipe.expire(keys.live_device(device_id), keys.LIVE_DEVICE_TTL_S)
        for tag_id, value in counters.items():
            pipe.set(keys.counter(device_id, tag_id), repr(value), ex=keys.COUNTER_TTL_S)
        stamp = at.isoformat()
        for tag_id in throttled_now:
            pipe.set(keys.throttle(device_id, tag_id), stamp, ex=keys.THROTTLE_TTL_S)
        if unmapped:
            pipe.sadd(keys.unmapped_keys(device_id), *unmapped)
            pipe.expire(keys.unmapped_keys(device_id), keys.UNMAPPED_KEYS_TTL_S)
        if current:
            pipe.publish(keys.WS_FANOUT, json.dumps({
                "client_id": client_id, "plant_id": plant_id, "device_id": device_id,
                "values": {str(k): v for k, v in current.items()}, "at": stamp,
            }))
        await pipe.execute()


async def touch_devices_seen(seen: dict[int, datetime]) -> None:
    """`touch_device_seen` for many Devices in one round trip."""
    if not seen:
        return
    async with get_redis().pipeline(transaction=False) as pipe:
        for device_id, at in seen.items():
            pipe.set(keys.seen_device(device_id), at.isoformat(), ex=keys.SEEN_DEVICE_TTL_S)
        await pipe.execute()


async def publish_to_alarm_stream(entries: list[dict[str, Any]]) -> None:
    """Hand decoded Readings to the alarm worker.

    A stream, not a list: the alarm worker must be able to restart and resume
    from where it stopped rather than losing whatever was in flight. Capped at
    STREAM_MAXLEN because a backlog that deep is no longer worth evaluating —
    alarm latency is the whole point of not reading from the database.
    """
    if not entries:
        return
    redis = get_redis()
    async with redis.pipeline(transaction=False) as pipe:
        for entry in entries:
            pipe.xadd(
                keys.STREAM_READINGS,
                {k: str(v) for k, v in entry.items()},
                maxlen=keys.STREAM_MAXLEN,
                approximate=True,
            )
        await pipe.execute()


async def bump_alarm_rules_version() -> None:
    """Tell the alarm worker its cached rules are out of date."""
    await get_redis().incr(keys.ALARM_RULES_VERSION)


async def read_alarm_rules_version() -> str | None:
    return cast(str | None, await get_redis().get(keys.ALARM_RULES_VERSION))


async def publish_live(client_id: int, plant_id: int, payload: dict[str, Any]) -> None:
    """Fan out to WebSocket holders on other API processes.

    The message carries client_id and plant_id so the receiving process can route
    it to the right room. Broadcasting to every socket is prohibited (I-8), and
    the room key is what enforces it on the receiving side.
    """
    await get_redis().publish(
        keys.WS_FANOUT,
        json.dumps({"client_id": client_id, "plant_id": plant_id, **payload}),
    )


async def write_plant_rollup(plant_id: int, values: dict[str, Any]) -> None:
    redis = get_redis()
    async with redis.pipeline(transaction=False) as pipe:
        pipe.hset(keys.live_plant(plant_id),
                  mapping={k: str(v) for k, v in values.items()})
        pipe.expire(keys.live_plant(plant_id), keys.LIVE_ROLLUP_TTL_S)
        await pipe.execute()


def utcnow() -> datetime:
    return datetime.now(UTC)
