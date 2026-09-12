"""Every Redis key pattern in the system, in one place.

BACKEND_SPEC §7. Nothing durable is stored in Redis — a full flush must cost at
most one heartbeat cycle. Everything here is either a current value that the next
message replaces, a cache that expires, or a queue that is replayed.
"""

from __future__ import annotations

from typing import Final

# Current value per Device: hash of tag_id → value, plus `_ts`. 15 minutes, long
# enough to survive a brief publisher outage without serving a stale dashboard.
LIVE_DEVICE: Final = "live:device:{device_id}"
LIVE_DEVICE_TTL_S: Final = 900

# When a Device was last *heard*, as distinct from when a Reading was last
# *stored*. Throttling (`tags.min_interval_s`) can drop every Tag in a message,
# and a message that stores nothing must still count as the Device speaking —
# otherwise a Device publishing every 3 s on 300 s-throttled Tags is invisible
# for 57 of every 60 s and the health sweep records it as offline. Same TTL as
# the live hash: after a flush, one sweep falls back to `readings_v`.
SEEN_DEVICE: Final = "seen:device:{device_id}"
SEEN_DEVICE_TTL_S: Final = LIVE_DEVICE_TTL_S

# Plant and Portfolio rollups. Short TTL: these are recomputed cheaply and a stale
# KPI tile is worse than a missing one.
LIVE_PLANT: Final = "live:plant:{plant_id}"
LIVE_PORTFOLIO: Final = "live:portfolio:{client_id}"
LIVE_ROLLUP_TTL_S: Final = 30

# Topic → Device resolution. Invalidated explicitly whenever a Device or binding
# changes, so the TTL is a backstop rather than the mechanism.
RESOLVE_TOPIC: Final = "resolve:topic:{topic}"
RESOLVE_TOPIC_TTL_S: Final = 300

# Memoised range-query responses, keyed by a hash of the query.
ANALYTICS: Final = "cache:analytics:{digest}"
ANALYTICS_TTL_S: Final = 60

# Per (rule, device) debounce state for the alarm worker.
ALARM_STATE: Final = "alarm:state:{rule_id}:{device_id}"
ALARM_STATE_TTL_S: Final = 3600

# Last write time per (device, tag), for min_interval_s throttling. TTL slightly
# above the longest throttle window so an expired key means "write it".
THROTTLE: Final = "throttle:{device_id}:{tag_id}"
THROTTLE_TTL_S: Final = 600

# Last value of a cumulative counter per (device, tag), to detect a decrease.
COUNTER: Final = "counter:{device_id}:{tag_id}"
COUNTER_TTL_S: Final = 86400

# Live fan-out across API replicas. Not optional: with more than one API process,
# a WebSocket held by process A never sees a Reading received by the ingest
# worker without it.
WS_FANOUT: Final = "ws:fanout"

# The alarm worker's input. Capped so a stalled consumer cannot exhaust memory —
# alarms are latency-sensitive, and a backlog older than 100k entries is not
# worth evaluating.
STREAM_READINGS: Final = "stream:readings"
STREAM_MAXLEN: Final = 100_000


def live_device(device_id: int) -> str:
    return LIVE_DEVICE.format(device_id=device_id)


def seen_device(device_id: int) -> str:
    return SEEN_DEVICE.format(device_id=device_id)


def live_plant(plant_id: int) -> str:
    return LIVE_PLANT.format(plant_id=plant_id)


def live_portfolio(client_id: int) -> str:
    return LIVE_PORTFOLIO.format(client_id=client_id)


def resolve_topic(topic: str) -> str:
    return RESOLVE_TOPIC.format(topic=topic)


def alarm_state(rule_id: int, device_id: int) -> str:
    return ALARM_STATE.format(rule_id=rule_id, device_id=device_id)


def throttle(device_id: int, tag_id: int) -> str:
    return THROTTLE.format(device_id=device_id, tag_id=tag_id)


def counter(device_id: int, tag_id: int) -> str:
    return COUNTER.format(device_id=device_id, tag_id=tag_id)


def analytics(digest: str) -> str:
    return ANALYTICS.format(digest=digest)
