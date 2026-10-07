"""Gather the facts `domain/data_issues.py` classifies, for one Plant.

Everything is read through the request's own session, so Row-Level Security
decides what is visible exactly as it does on every other screen: a Client
Admin sees their own Devices' messages (`mqtt_raw_v` rows carry their Client),
and only a platform administrator sees the quarantined topics nobody has
registered, which carry no Client at all (Guardrail 5).

── Where each fact comes from ──────────────────────────────────────────────
* Which keys a Device sends — its own recent messages in `mqtt_raw_v`, on
  every topic it is registered on (`registered_topics`, migration 0030), read
  through the same `normalise_payload` ingest uses, so the envelope's wrapper
  keys are never mistaken for the equipment's.
* Rejected values — `readings_v`, where ingest stores every value and flags
  the ones outside their range or unreadable (never discarded).
* Which PV inputs carry current — the 15-minute tier, so a screen opened at
  night still knows what was working at noon.
* Replayed backlogs — gaps on one topic shorter than its own interval allows.

⚠ Read-only. Nothing here writes, and nothing here talks to the broker.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import datetime
from itertools import pairwise
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.absence import classify_topic_liveness
from solarcms.domain.assumptions import (
    DATA_ISSUE_FLAGGED_WINDOW_S,
    DATA_ISSUE_INTERVAL_SAMPLE,
    DATA_ISSUE_PAYLOAD_MESSAGES,
    DATA_ISSUE_PAYLOAD_WINDOW_S,
    DATA_ISSUE_REPLAY_GAP_FRACTION,
    DATA_ISSUE_REPLAY_MIN_MESSAGES,
    DATA_ISSUE_REPLAY_WINDOW_S,
    DATA_ISSUE_STRING_WINDOW_S,
    QUALITY_GOOD,
    QUALITY_OUT_OF_RANGE,
    QUALITY_UNPARSEABLE,
)
from solarcms.domain.data_issues import (
    BindingFact,
    DeviceFact,
    PlantFacts,
    ReplayBurst,
    TagHealth,
    UnregisteredTopic,
)
from solarcms.domain.decoding import TopicPattern, normalise_payload, parse_topic

# The same look-back discovery uses, so a topic offered there is offered here.
UNREGISTERED_WINDOW = "interval '7 days'"


async def gather(
    session: AsyncSession, plant_id: int, *, now: datetime,
    can_see_unregistered: bool,
) -> PlantFacts | None:
    """Every fact about one Plant, or None when it is not visible to the caller."""
    plant = (await session.execute(text("""
        SELECT p.id, p.code, p.ac_capacity_kw, p.dc_capacity_kwp, c.code AS client_code
          FROM plants p JOIN clients c ON c.id = p.client_id
         WHERE p.id = :id
    """), {"id": plant_id})).first()
    if plant is None:
        return None

    device_rows = (await session.execute(text("""
        SELECT d.id, d.code, d.status, d.collector_code, d.source_address,
               d.expected_interval_s, d.string_count, d.rated_capacity_kw,
               dt.code AS type_code, dm.variant,
               COALESCE(h.comm_status, 'unknown') AS comm_status, h.last_seen_at
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt ON dt.id = dm.device_type_id
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id
    """), {"plant_id": plant_id})).all()
    device_ids = [row.id for row in device_rows]

    bindings: dict[int, list[BindingFact]] = defaultdict(list)
    topics: dict[str, int] = {}
    keys: dict[int, dict[str, Any]] = defaultdict(dict)
    messages: dict[int, int] = defaultdict(int)
    heard: dict[int, datetime] = {}
    primary_times: dict[int, list[datetime]] = defaultdict(list)
    health: dict[int, list[TagHealth]] = defaultdict(list)
    string_max: dict[int, dict[int, float]] = defaultdict(dict)

    if device_ids:
        for row in (await session.execute(text("""
            SELECT b.id, b.device_id, b.source_key, t.code AS tag_code, t.unit,
                   b.enabled, b.scale, b.value_offset,
                   COALESCE(b.valid_min, t.valid_min) AS valid_min,
                   COALESCE(b.valid_max, t.valid_max) AS valid_max
              FROM device_tag_bindings b JOIN tags t ON t.id = b.tag_id
             WHERE b.device_id = ANY(:ids)
             ORDER BY b.device_id, b.source_key
        """), {"ids": device_ids})).all():
            bindings[row.device_id].append(BindingFact(
                binding_id=row.id, source_key=row.source_key, tag_code=row.tag_code,
                unit=row.unit, enabled=row.enabled, scale=row.scale,
                value_offset=row.value_offset, valid_min=row.valid_min,
                valid_max=row.valid_max,
            ))

        topics = {
            row.topic: row.device_id for row in (await session.execute(text("""
                SELECT topic, device_id FROM registered_topics WHERE device_id = ANY(:ids)
            """), {"ids": device_ids})).all()
        }
        primary = {row.source_address: row.id for row in device_rows if row.source_address}

        # The newest messages on every registered topic, newest first. A lateral
        # LIMIT walks `ix_mqtt_raw_topic_time` once per topic rather than
        # sorting the Plant's whole window.
        if topics:
            for row in (await session.execute(text("""
                SELECT t.topic, m.time, m.payload
                  FROM unnest(CAST(:topics AS text[])) AS t(topic)
                  CROSS JOIN LATERAL (
                      SELECT r.time, r.payload FROM mqtt_raw_v r
                       WHERE r.topic = t.topic
                         AND r.time > now() - make_interval(
                                 secs => CAST(:window AS double precision))
                       ORDER BY r.time DESC
                       LIMIT :limit
                  ) m
                 ORDER BY m.time DESC
            """), {"topics": list(topics), "window": DATA_ISSUE_PAYLOAD_WINDOW_S,
                   "limit": DATA_ISSUE_PAYLOAD_MESSAGES})).all():
                device_id = topics[row.topic]
                messages[device_id] += 1
                heard[device_id] = max(heard.get(device_id, row.time), row.time)
                if primary.get(row.topic) == device_id:
                    primary_times[device_id].append(row.time)
                payload = row.payload if isinstance(row.payload, dict) else {}
                flat, _ = normalise_payload(payload)
                for key, value in flat.items():
                    # Newest first, so the first value seen is the latest.
                    keys[device_id].setdefault(key, value)

        # Judged against the range ingest judged them against: the binding's
        # own where it narrows the Tag's, else the Tag's.
        for row in (await session.execute(text("""
            SELECT r.device_id, t.code AS tag_code, count(*) AS total,
                   count(*) FILTER (WHERE r.quality = :oor) AS out_of_range,
                   count(*) FILTER (WHERE r.quality = :unp) AS unparseable,
                   (array_agg(r.quality ORDER BY r.time DESC))[1] AS latest_quality,
                   (array_agg(r.value ORDER BY r.time DESC))[1] AS latest_value,
                   (array_agg(r.quality ORDER BY r.time DESC))[1:10] AS recent_qualities,
                   min(r.value) FILTER (WHERE r.quality = :oor) AS flagged_min,
                   max(r.value) FILTER (WHERE r.quality = :oor) AS flagged_max,
                   COALESCE(min(b.valid_min), min(t.valid_min)) AS valid_min,
                   COALESCE(max(b.valid_max), max(t.valid_max)) AS valid_max
              FROM readings_v r
              JOIN tags t ON t.id = r.tag_id
              LEFT JOIN device_tag_bindings b
                     ON b.device_id = r.device_id AND b.tag_id = r.tag_id
             WHERE r.device_id = ANY(:ids)
               AND r.time > now() - make_interval(secs => CAST(:window AS double precision))
             GROUP BY r.device_id, t.code
            HAVING count(*) FILTER (WHERE r.quality <> :good) > 0
        """), {"ids": device_ids, "window": DATA_ISSUE_FLAGGED_WINDOW_S,
               "oor": QUALITY_OUT_OF_RANGE, "unp": QUALITY_UNPARSEABLE,
               "good": QUALITY_GOOD})).all():
            health[row.device_id].append(TagHealth(
                tag_code=row.tag_code, total=row.total,
                out_of_range=row.out_of_range, unparseable=row.unparseable,
                latest_quality=row.latest_quality, latest_value=row.latest_value,
                flagged_min=row.flagged_min, flagged_max=row.flagged_max,
                valid_min=row.valid_min, valid_max=row.valid_max,
                recent_rejected=sum(1 for q in (row.recent_qualities or []) if q != QUALITY_GOOD),
            ))

        string_ids = [r.id for r in device_rows if r.type_code in ("INVERTER", "SMB")]
        if string_ids:
            for row in (await session.execute(text("""
                SELECT a.device_id, t.code AS tag_code, max(a.max_value) AS peak
                  FROM agg_15m_v a JOIN tags t ON t.id = a.tag_id
                 WHERE a.device_id = ANY(:ids)
                   AND t.code ~ '^PV[0-9]+_CURRENT$'
                   AND a.bucket > now() - make_interval(
                           secs => CAST(:window AS double precision))
                   AND COALESCE(a.worst_quality, 0) = :good
                 GROUP BY a.device_id, t.code
            """), {"ids": string_ids, "window": DATA_ISSUE_STRING_WINDOW_S,
                   "good": QUALITY_GOOD})).all():
                if row.peak is not None:
                    index = int(row.tag_code[2:].split("_", 1)[0])
                    string_max[row.device_id][index] = float(row.peak)

    devices = []
    for row in device_rows:
        times = sorted(primary_times.get(row.id, []))
        gaps = [(b - a).total_seconds() for a, b in pairwise(times)]
        devices.append(DeviceFact(
            device_id=row.id, code=row.code, type_code=row.type_code,
            status=row.status, comm_status=row.comm_status,
            collector_code=row.collector_code, primary_topic=row.source_address,
            expected_interval_s=row.expected_interval_s,
            string_count=row.string_count,
            rated_capacity_kw=(float(row.rated_capacity_kw)
                               if row.rated_capacity_kw is not None else None),
            variant=row.variant,
            bindings=tuple(bindings.get(row.id, ())),
            recent_messages=messages.get(row.id, 0),
            recent_keys=keys.get(row.id, {}),
            last_heard=heard.get(row.id) or row.last_seen_at,
            measured_interval_s=statistics.median(gaps) if gaps else None,
            measured_gaps=len(gaps),
            tag_health=tuple(health.get(row.id, ())),
            string_current_max=string_max.get(row.id, {}),
        ))

    unregistered = (
        await _unregistered_topics(session, plant.client_code, plant.code, now)
        if can_see_unregistered else None
    )

    type_codes = frozenset(
        r.code for r in (await session.execute(text("SELECT code FROM device_types"))).all()
    )
    tag_codes = frozenset(
        r.code for r in (await session.execute(text("SELECT code FROM tags"))).all()
    )
    return PlantFacts(
        plant_id=plant.id, plant_code=plant.code,
        ac_capacity_kw=float(plant.ac_capacity_kw) if plant.ac_capacity_kw is not None else None,
        dc_capacity_kwp=(float(plant.dc_capacity_kwp)
                         if plant.dc_capacity_kwp is not None else None),
        devices=tuple(devices),
        unregistered=unregistered,
        replay_bursts=await _replay_bursts(session, plant_id),
        device_type_codes=type_codes,
        tag_codes=tag_codes,
    )


async def _patterns(session: AsyncSession) -> list[TopicPattern]:
    # Imported late, as `services/device_topics.py` does: the resolver module
    # pulls in the ingest worker's dependencies, which the API rarely needs.
    from solarcms.workers.resolver import load_topic_patterns

    return await load_topic_patterns(session)


async def _unregistered_topics(
    session: AsyncSession, client_code: str, plant_code: str, now: datetime,
) -> tuple[UnregisteredTopic, ...]:
    """Live topics naming this Plant that no Device is registered on.

    Quarantined rows only — an unregistered topic's messages always are — and
    never one already dismissed from discovery: dismissing is how a retired
    shape is put away, and it must stay away here too.
    """
    rows = (await session.execute(text(f"""
        SELECT m.topic, max(m.time) AS last_seen, count(*) AS messages,
               EXTRACT(EPOCH FROM (max(m.time) - min(m.time))) AS span_s
          FROM mqtt_raw_v m
          LEFT JOIN registered_topics rt ON rt.topic = m.topic
          LEFT JOIN discovery_ignored_topics i ON i.topic = m.topic
         WHERE m.quarantined AND rt.topic IS NULL AND i.topic IS NULL
           AND m.time > now() - {UNREGISTERED_WINDOW}
         GROUP BY m.topic
    """))).all()
    if not rows:
        return ()

    patterns = await _patterns(session)
    out: list[UnregisteredTopic] = []
    for row in rows:
        captured = parse_topic(row.topic, patterns)
        # Exact, case and all: the topic is the authority for origin, and
        # `kular_green` is not `KULAR_GREEN` (Guardrail 5).
        if captured is None or captured.get("client_code") != client_code \
                or captured.get("plant_code") != plant_code:
            continue
        device_code = captured.get("device_code")
        if not device_code:
            continue
        interval = (
            float(row.span_s) / (row.messages - 1)
            if row.messages > 1 and row.span_s else None
        )
        # A topic that stopped is a retired shape, not equipment to register
        # (Guardrail 15) — judged against its own cadence.
        if classify_topic_liveness(row.last_seen, interval, now) != "live":
            continue
        recent = (await session.execute(text("""
            SELECT time, payload FROM mqtt_raw_v WHERE topic = :topic
             ORDER BY time DESC LIMIT :limit
        """), {"topic": row.topic, "limit": DATA_ISSUE_INTERVAL_SAMPLE})).all()
        latest = recent[0].payload if recent else None
        flat, _ = normalise_payload(latest if isinstance(latest, dict) else {})
        # ⚠ The *median* of recent gaps is what a Device is registered with —
        # the mean over the week, which liveness uses above, is inflated by every
        # outage: WMS_WEST's came to 2,151 s for a station sending every 30.
        times = sorted(r.time for r in recent)
        gaps = [(b - a).total_seconds() for a, b in pairwise(times)]
        out.append(UnregisteredTopic(
            topic=row.topic, device_code=device_code,
            collector_code=captured.get("collector_code"),
            last_seen=row.last_seen, messages=row.messages,
            interval_s=statistics.median(gaps) if gaps else interval,
            keys=tuple(sorted(flat)),
        ))
    return tuple(out)


async def _replay_bursts(session: AsyncSession, plant_id: int) -> tuple[ReplayBurst, ...]:
    """Minutes in which this Plant's topics delivered faster than they can.

    A gap on one topic shorter than a fifth of its own interval is not a
    publisher speeding up: it is the broker emptying a queue it held for a
    persistent session while ingest was away. Grouped by the minute they
    arrived, because that is the minute whose readings are misplaced.
    """
    rows = (await session.execute(text("""
        WITH received AS (
            -- DISTINCT: one message written twice by ingest (the flush race
            -- fixed on 7 Oct 2026 — same time, same seq) is not two arrivals.
            SELECT DISTINCT r.topic, r.time, r.seq, d.expected_interval_s
              FROM mqtt_raw_v r
              JOIN registered_topics rt ON rt.topic = r.topic
              JOIN devices d ON d.id = rt.device_id
             WHERE d.plant_id = :plant_id
               AND r.time > now() - make_interval(secs => CAST(:window AS double precision))
        ), arrivals AS (
            SELECT topic, time, expected_interval_s,
                   time - lag(time) OVER (PARTITION BY topic ORDER BY time) AS gap
              FROM received
        )
        SELECT date_trunc('minute', time) AS minute,
               count(*) AS messages, count(DISTINCT topic) AS topics
          FROM arrivals
         -- CAST: from the integer column alone asyncpg infers :fraction as an
         -- integer, 0.2 becomes 0, and nothing is ever found.
         WHERE gap < make_interval(
                   secs => expected_interval_s * CAST(:fraction AS double precision))
         GROUP BY 1
        HAVING count(*) >= :minimum
         ORDER BY 1
    """), {"plant_id": plant_id, "window": DATA_ISSUE_REPLAY_WINDOW_S,
           "fraction": DATA_ISSUE_REPLAY_GAP_FRACTION,
           "minimum": DATA_ISSUE_REPLAY_MIN_MESSAGES})).all()
    return tuple(
        ReplayBurst(minute=row.minute, messages=row.messages, topics=row.topics)
        for row in rows
    )


async def unregistered_plants(
    session: AsyncSession, now: datetime,
) -> list[dict[str, Any]]:
    """Client and Plant codes publishing now that match no registered Plant.

    The platform-wide half of the screen, for a platform administrator only:
    nothing about these belongs to a Plant yet, so they cannot be listed under
    one. Onboarding registers them; dismissing their topics puts them away.
    """
    rows = (await session.execute(text(f"""
        SELECT m.topic, max(m.time) AS last_seen, count(*) AS messages,
               EXTRACT(EPOCH FROM (max(m.time) - min(m.time))) AS span_s
          FROM mqtt_raw_v m
          LEFT JOIN registered_topics rt ON rt.topic = m.topic
          LEFT JOIN discovery_ignored_topics i ON i.topic = m.topic
         WHERE m.quarantined AND rt.topic IS NULL AND i.topic IS NULL
           AND m.time > now() - {UNREGISTERED_WINDOW}
         GROUP BY m.topic
    """))).all()
    if not rows:
        return []
    registered = {
        (r.client_code, r.plant_code): r.plant_id
        for r in (await session.execute(text("""
            SELECT c.code AS client_code, p.code AS plant_code, p.id AS plant_id
              FROM plants p JOIN clients c ON c.id = p.client_id
        """))).all()
    }
    clients = {
        r.code for r in (await session.execute(text("SELECT code FROM clients"))).all()
    }
    patterns = await _patterns(session)
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        captured = parse_topic(row.topic, patterns)
        if captured is None:
            continue
        client_code = captured.get("client_code")
        plant_code = captured.get("plant_code")
        if not client_code or not plant_code or (client_code, plant_code) in registered:
            continue
        interval = (
            float(row.span_s) / (row.messages - 1)
            if row.messages > 1 and row.span_s else None
        )
        if classify_topic_liveness(row.last_seen, interval, now) != "live":
            continue
        entry = grouped.setdefault((client_code, plant_code), {
            "client_code": client_code, "plant_code": plant_code,
            "client_registered": client_code in clients,
            "topics": [], "last_seen": row.last_seen, "messages": 0,
        })
        entry["topics"].append(row.topic)
        entry["messages"] += row.messages
        entry["last_seen"] = max(entry["last_seen"], row.last_seen)
    out = sorted(grouped.values(), key=lambda e: (e["client_code"], e["plant_code"]))
    for entry in out:
        entry["topics"].sort()
    return out
