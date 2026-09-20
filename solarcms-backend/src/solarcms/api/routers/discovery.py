"""What the broker is publishing, as an onboarding aid.

Onboarding used to begin with a blank form: somebody typed a Client code, a
Plant code, then a Device code and a topic, and hoped each matched what the
engineers on site had configured. A single character wrong anywhere produced a
Device that looked correctly registered and silently decoded nothing — the
failure mode MASTER §5.1 warns about, arrived at through a typo.

But the topics are already here. The engineers publish before we onboard, which
means the Client codes, the Plant codes, the Collector names, the Device codes
**and the payload keys** are all observable facts before anyone fills in a form.
This router exposes them so onboarding becomes *confirming what is arriving*
rather than *guessing what will arrive*.

── Where the data comes from, and why not from MQTT ────────────────────────
Everything here reads `mqtt_raw_v`. The API never opens a broker connection:
Guardrail 3 forbids running ingestion inside the API process, and a second
subscriber would also compete for the same messages. Ingest already records
every message it receives — including, crucially, ones it could not attribute,
which are quarantined *with their payload intact*. An unregistered Device is
therefore not invisible; it is sitting in `mqtt_raw` waiting to be recognised.

The consequence worth stating: this shows what ingest has **received**, not what
the broker holds. If ingest is stopped or cannot reach the broker, discovery
goes quiet too — and that is honest, because in that state we genuinely do not
know what is being published.

── Why Super Admin only ────────────────────────────────────────────────────
A quarantined topic has `client_id = NULL`, deliberately: attributing it to a
Client by reading the topic is exactly the inference Guardrail 5 forbids at
ingest. `mqtt_raw_v` therefore shows those rows to a platform administrator and
to nobody else, so every endpoint here requires `system.admin`. That is not a
limitation of this module — it is the isolation model refusing to guess, and
onboarding a Client is a platform action anyway.

⚠ Nothing here writes. Discovery proposes; registration is a separate,
deliberate act through `POST /clients`, `POST /plants` and `POST /devices`.
"""

from __future__ import annotations

import json
import statistics
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.domain.absence import classify_topic_liveness
from solarcms.domain.assumptions import TAG_SPECS, alias_for
from solarcms.domain.decoding import TopicPattern, normalise_payload, parse_topic

router = APIRouter(prefix="/discovery", tags=["discovery"])

# How far back a topic still counts as "being published". Generous on purpose:
# a Plant commissioned on Friday should still be discoverable on Monday, and the
# alternative — showing nothing — reads as "the broker is silent" when the truth
# is "nobody looked recently".
DISCOVERY_WINDOW = "interval '7 days'"


async def _patterns(session: Any) -> list[TopicPattern]:
    """The ingress registry, so topics are split the same way ingest splits them.

    Loaded rather than assumed: a deployment that has registered a different
    shape must discover through that shape too, and a parser written here would
    be a second definition of the contract, free to drift from the real one.
    """
    rows = (await session.execute(text(
        "SELECT pattern, priority FROM topic_patterns WHERE enabled ORDER BY priority"
    ))).all()
    out: list[TopicPattern] = []
    for row in rows:
        try:
            out.append(TopicPattern(pattern=row.pattern, priority=row.priority))
        except ValueError:
            # A malformed row must not take discovery down; it is already
            # logged loudly by the resolver that loads it for real work.
            continue
    return out


@router.get("/clients")
async def discover_clients(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> list[dict[str, Any]]:
    """Client codes seen on the broker, and whether each is registered yet.

    The first screen of onboarding: rather than asking "what is this Client
    called?", it shows the codes that are actually arriving and asks which one
    is being onboarded. A code already registered is marked so, so the same
    Client is never created twice under a slightly different spelling.
    """
    rows = (await session.execute(text(f"""
        SELECT topic, max(time) AS last_seen, count(*) AS messages
          FROM mqtt_raw_v
         WHERE time > now() - {DISCOVERY_WINDOW}
         GROUP BY topic
    """))).all()

    patterns = await _patterns(session)
    grouped: dict[str, dict[str, Any]] = {}
    for row in rows:
        captured = parse_topic(row.topic, patterns)
        if captured is None:
            continue
        code = captured.get("client_code")
        if not code:
            continue
        entry = grouped.setdefault(code, {
            "client_code": code, "plant_codes": set(), "topics": 0,
            "messages": 0, "last_seen": row.last_seen,
        })
        entry["topics"] += 1
        entry["messages"] += row.messages
        entry["last_seen"] = max(entry["last_seen"], row.last_seen)
        plant = captured.get("plant_code")
        if plant:
            entry["plant_codes"].add(plant)

    known = {
        r.code: r.id for r in (await session.execute(
            text("SELECT id, code FROM clients"))).all()
    }
    return [
        {
            **entry,
            "plant_codes": sorted(entry["plant_codes"]),
            # The whole point of showing it: a code already registered must not
            # be offered as something to create.
            "registered_client_id": known.get(entry["client_code"]),
        }
        for entry in sorted(grouped.values(), key=lambda e: e["client_code"])
    ]


@router.get("/plants")
async def discover_plants(
    session: SessionDep,
    client_code: str = Query(..., description="Client code exactly as the topic spells it"),
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> list[dict[str, Any]]:
    """Plants under one Client code, with the Collectors and Devices inside each.

    The shape returned mirrors the topic itself — Plant, then Collector, then
    Device — because that is the structure the engineers configured and the one
    the operator is checking their work against.
    """
    rows = (await session.execute(text(f"""
        SELECT m.topic, max(m.time) AS last_seen, count(*) AS messages,
               bool_or(m.quarantined) AS ever_quarantined,
               EXTRACT(EPOCH FROM (max(m.time) - min(m.time))) AS span_s,
               bool_or(i.topic IS NOT NULL) AS ignored
          FROM mqtt_raw_v m
          LEFT JOIN discovery_ignored_topics i ON i.topic = m.topic
         WHERE m.time > now() - {DISCOVERY_WINDOW}
         GROUP BY m.topic
    """))).all()
    now = datetime.now(UTC)

    patterns = await _patterns(session)
    plants: dict[str, dict[str, Any]] = {}
    for row in rows:
        captured = parse_topic(row.topic, patterns)
        if captured is None or captured.get("client_code") != client_code:
            continue
        plant_code = captured.get("plant_code")
        device_code = captured.get("device_code")
        if not plant_code or not device_code:
            continue
        plant = plants.setdefault(plant_code, {
            "plant_code": plant_code, "devices": [], "last_seen": row.last_seen,
        })
        plant["last_seen"] = max(plant["last_seen"], row.last_seen)
        # Mean gap over the window. Enough to tell "every 86 s" from "nothing
        # for two days", which is all liveness has to decide.
        interval = (
            row.span_s / (row.messages - 1)
            if row.messages > 1 and row.span_s else None
        )
        plant["devices"].append({
            "device_code": device_code,
            # None is a real answer, not missing data: the five-segment shape
            # says this Device sits in no enclosure (migration 0022).
            "collector_code": captured.get("collector_code"),
            "topic": row.topic,
            "messages": row.messages,
            "last_seen": row.last_seen,
            "ever_quarantined": row.ever_quarantined,
            "interval_s": round(interval) if interval else None,
            # ⚠ The distinction the whole screen turns on. A topic that stopped
            # two days ago is a retired shape, not equipment awaiting
            # registration — and registering one produces a Device that never
            # reports, indistinguishable from broken equipment.
            "status": classify_topic_liveness(row.last_seen, interval, now),
            "ignored": bool(row.ignored),
        })

    registered_plants = {
        (r.client_code, r.plant_code): r.plant_id
        for r in (await session.execute(text("""
            SELECT c.code AS client_code, p.code AS plant_code, p.id AS plant_id
              FROM plants p JOIN clients c ON c.id = p.client_id
        """))).all()
    }
    registered_devices = {
        r.source_address: r.id for r in (await session.execute(text(
            "SELECT id, source_address FROM devices WHERE source_address IS NOT NULL"
        ))).all()
    }

    out: list[dict[str, Any]] = []
    for plant in sorted(plants.values(), key=lambda p: p["plant_code"]):
        for device in plant["devices"]:
            device["registered_device_id"] = registered_devices.get(device["topic"])
        plant["devices"].sort(
            key=lambda d: (d["collector_code"] or "", d["device_code"])
        )
        collectors = sorted({
            d["collector_code"] for d in plant["devices"] if d["collector_code"]
        })
        out.append({
            **plant,
            "collectors": collectors,
            "device_count": len(plant["devices"]),
            # ⚠ Counts only what is *publishing now* and registered to nothing.
            # Counting every unregistered topic in the seven-day window turned
            # this badge into "+20 new" on a Plant where all twenty were dead
            # shapes — a to-do list of corpses, which buries the one that costs
            # money and trains the operator to ignore the badge.
            "unregistered_count": sum(
                1 for d in plant["devices"]
                if d["registered_device_id"] is None
                and d["status"] == "live" and not d["ignored"]
            ),
            "silent_unregistered_count": sum(
                1 for d in plant["devices"]
                if d["registered_device_id"] is None and d["status"] == "silent"
            ),
            "registered_plant_id": registered_plants.get((client_code, plant["plant_code"])),
        })
    return out


@router.get("/topic")
async def discover_topic(
    session: SessionDep,
    topic: str = Query(..., description="The exact topic, case-sensitive"),
    device_type_code: str | None = Query(
        None, description="Sharpens the Tag suggestions; the same key means "
                          "different things on different equipment."),
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """One topic in full: its latest payload, its keys, and what they map to.

    This is what turns "register a Device" from a form into a confirmation. The
    payload is returned verbatim for display, and separately reduced to the flat
    `{key: value}` form ingest would decode — because the two published shapes
    (the canonical envelope and the flat body) look very different on screen and
    only one of them is what actually gets bound.

    ⚠ `suggested_tag_code` is a **suggestion**, and Device Type decides it. `VRY`
    is 11.037 from an MFM on an 11 kV feeder and 799.9 from an Inverter on an
    800 V bus; resolving it without the Type would store "799.9 kV" and two of
    the three phases would pass the range check while doing it. The binding the
    operator confirms is the authority, never this.
    """
    rows = (await session.execute(text(f"""
        SELECT time, payload, quarantined, reason
          FROM mqtt_raw_v
         WHERE topic = :topic AND time > now() - {DISCOVERY_WINDOW}
         ORDER BY time DESC LIMIT 200
    """), {"topic": topic})).all()

    if not rows:
        return {
            "topic": topic, "seen": False, "messages": 0,
            "last_payload": None, "keys": [], "interval_s": None,
        }

    latest = rows[0]
    payload = latest.payload if isinstance(latest.payload, dict) else {}

    # Whether a Device is registered for this topic *now*.
    #
    # ⚠ Not the same question as `latest.quarantined`, and conflating the two
    # is actively misleading. That flag records what happened to one message at
    # the moment it arrived; a topic quarantined all last week and registered
    # this morning still has quarantined history, and reporting it as "no
    # Device registered" tells the operator to fix something already fixed.
    registered_device_id = (await session.execute(text(
        "SELECT id FROM devices WHERE source_address = :topic"
    ), {"topic": topic})).scalar()
    flat, payload_timestamp = normalise_payload(payload)

    keys = []
    for key, value in flat.items():
        suggested = alias_for(key, device_type_code)
        keys.append({
            "source_key": key,
            "sample_value": value,
            "suggested_tag_code": suggested if suggested in TAG_SPECS else None,
            # A key we cannot place is the most useful thing on this screen: it
            # is a signal the Device really sends that would otherwise be
            # silently discarded, and no query over `readings` can reveal one.
            "unmapped": suggested not in TAG_SPECS,
        })
    keys.sort(key=lambda k: (k["unmapped"], k["source_key"]))

    # Median, not mean: one outage between two messages would otherwise make a
    # Device publishing every three seconds look like it publishes hourly.
    gaps = [
        (rows[i].time - rows[i + 1].time).total_seconds()
        for i in range(len(rows) - 1)
    ]
    interval = round(statistics.median(gaps)) if gaps else None

    return {
        "topic": topic,
        "seen": True,
        "messages": len(rows),
        "first_seen": rows[-1].time,
        "last_seen": latest.time,
        # What ingest would decode, and what the publisher actually sent. Both,
        # because the envelope's wrapper keys are not signals and showing only
        # the raw body makes that impossible to tell.
        "last_payload": payload,
        "flat_payload": flat,
        "payload_timestamp": payload_timestamp,
        "registered_device_id": registered_device_id,
        # Only meaningful while nothing is registered for the topic — see above.
        "quarantined": latest.quarantined and registered_device_id is None,
        "reason": latest.reason if registered_device_id is None else None,
        "keys": keys,
        "unmapped_count": sum(1 for k in keys if k["unmapped"]),
        # Measured, never assumed: health thresholds multiply this column, and a
        # Device registered at the 60 s default while publishing every 3 s can
        # sit silent for ten minutes and still read as healthy.
        "interval_s": interval,
    }


class IgnoreTopicIn(BaseModel):
    """Dismiss a topic from discovery."""

    topic: str = Field(min_length=1, max_length=1024)
    reason: str | None = Field(default=None, max_length=1000)


@router.get("/ignored")
async def list_ignored_topics(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> list[dict[str, Any]]:
    """Topics somebody has put away, so they can be put back."""
    rows = (await session.execute(text("""
        SELECT id, topic, reason, created_at FROM discovery_ignored_topics
         ORDER BY created_at DESC
    """))).all()
    return [
        {"id": r.id, "topic": r.topic, "reason": r.reason, "created_at": r.created_at}
        for r in rows
    ]


@router.post("/ignored", status_code=status.HTTP_201_CREATED)
async def ignore_topic(
    body: IgnoreTopicIn, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Stop offering a topic as something to register.

    Raw history is kept 90 days and discovery looks back 7, so a shape the
    client has migrated away from keeps presenting itself as equipment for a
    week after it died. Dismissing is reversible and records who and why —
    it hides the topic, and deletes nothing.

    ⚠ A dismissed topic that starts publishing again is still dismissed. That
    is deliberate: the alternative is a topic nobody can put away for good. The
    list is visible and short, and un-ignoring is one call.
    """
    row = (await session.execute(text("""
        INSERT INTO discovery_ignored_topics (client_id, topic, reason, created_by)
        VALUES (
            (SELECT p.client_id FROM devices d JOIN plants p ON p.id = d.plant_id
              WHERE d.source_address = :topic LIMIT 1),
            :topic, :reason, :user_id
        )
        ON CONFLICT (topic) DO UPDATE SET reason = EXCLUDED.reason
        RETURNING id, topic, reason, created_at
    """), {"topic": body.topic, "reason": body.reason, "user_id": user.user_id})).first()
    if row is None:  # DO UPDATE always returns; defensive only for the type
        raise HTTPException(status.HTTP_409_CONFLICT, "could not dismiss that topic")
    # Same transaction as the change: an audit row written separately can
    # succeed while the change rolls back, and the trail then lies.
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :user_id, 'discovery.topic.ignore', 'discovery_ignored_topic',
                :entity_id, CAST(:after AS jsonb))
    """), {
        "client_id": user.client_id, "user_id": user.user_id, "entity_id": row.id,
        "after": json.dumps({"topic": body.topic, "reason": body.reason}),
    })
    return {"id": row.id, "topic": row.topic, "reason": row.reason,
            "created_at": row.created_at}


@router.delete("/ignored/{ignored_id}", status_code=status.HTTP_204_NO_CONTENT,
               response_class=Response)
async def unignore_topic(
    ignored_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> Response:
    """Put a dismissed topic back into discovery."""
    before = (await session.execute(text(
        "SELECT topic, reason FROM discovery_ignored_topics WHERE id = :id"
    ), {"id": ignored_id})).first()
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such dismissed topic")
    await session.execute(
        text("DELETE FROM discovery_ignored_topics WHERE id = :id"), {"id": ignored_id}
    )
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, before)
        VALUES (:client_id, :user_id, 'discovery.topic.unignore',
                'discovery_ignored_topic', :entity_id, CAST(:before AS jsonb))
    """), {
        "client_id": user.client_id, "user_id": user.user_id, "entity_id": ignored_id,
        "before": json.dumps({"topic": before.topic, "reason": before.reason}),
    })
    return Response(status_code=status.HTTP_204_NO_CONTENT)
