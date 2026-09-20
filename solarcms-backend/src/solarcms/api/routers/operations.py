"""Operational triage: planned work, topic migrations, recoverable history.

Three things an operator needs that no existing screen could answer, all of them
about the gap between what the equipment is doing and what the registry believes:

* **Maintenance windows** — so planned work does not raise Alarms and is not
  counted as downtime against an availability figure a guarantee is paid on.
* **Topic migrations** — when an integrator renames a topic, a registered Device
  goes silent *and* an unregistered topic appears, same instrument, same
  signals. Presented separately those are an outage and a new device; presented
  together they are one rename and a one-click fix.
* **Recoverable history** — how much a late-registered Device could get back out
  of quarantine.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.domain.absence import classify_topic_liveness
from solarcms.domain.decoding import TopicPattern, parse_topic
from solarcms.services.backfill import estimate

router = APIRouter(prefix="/operations", tags=["operations"])

#: How close in time a silence and an appearance must be to read as one rename.
#: Generous: an integrator reconfiguring a gateway does not switch atomically,
#: and the cost of proposing a wrong match is a rejected suggestion, while the
#: cost of missing one is a truck roll.
MIGRATION_WINDOW = "interval '6 hours'"


class MaintenanceWindowIn(BaseModel):
    plant_id: int
    device_id: int | None = None
    starts_at: datetime | None = None
    ends_at: datetime | None = None
    reason: str = Field(min_length=1, max_length=1000)


@router.get("/maintenance")
async def list_maintenance(
    session: SessionDep, plant_id: int | None = None,
    _: CurrentUser = Depends(require_permission("plant.manage")),
) -> list[dict[str, Any]]:
    """Windows, open ones first — an open-ended window suppresses indefinitely."""
    rows = (await session.execute(text("""
        SELECT w.id, w.plant_id, w.device_id, d.code AS device_code,
               w.starts_at, w.ends_at, w.reason, w.created_at,
               (w.starts_at <= now() AND (w.ends_at IS NULL OR w.ends_at > now()))
                   AS active
          FROM maintenance_windows w
          LEFT JOIN devices d ON d.id = w.device_id
         WHERE (CAST(:plant_id AS bigint) IS NULL OR w.plant_id = :plant_id)
         ORDER BY (w.ends_at IS NULL) DESC, w.starts_at DESC
    """), {"plant_id": plant_id})).all()
    return [dict(r._mapping) for r in rows]


@router.post("/maintenance", status_code=status.HTTP_201_CREATED)
async def open_maintenance(
    body: MaintenanceWindowIn, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Declare planned work.

    While it is open, nothing it covers raises an absence Alarm. `device_id`
    NULL covers the whole Plant — a grid outage or a shutdown, not one machine.
    `starts_at` defaults to now, because the usual case is work starting.
    """
    plant = (await session.execute(text(
        "SELECT id, client_id FROM plants WHERE id = :id"
    ), {"id": body.plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such Plant")

    row = (await session.execute(text("""
        INSERT INTO maintenance_windows (client_id, plant_id, device_id, starts_at,
                                         ends_at, reason, created_by)
        VALUES (:client_id, :plant_id, :device_id,
                coalesce(CAST(:starts_at AS timestamptz), now()),
                CAST(:ends_at AS timestamptz), :reason, :user_id)
        RETURNING id, plant_id, device_id, starts_at, ends_at, reason
    """), {
        "client_id": plant.client_id, "plant_id": body.plant_id,
        "device_id": body.device_id, "starts_at": body.starts_at,
        "ends_at": body.ends_at, "reason": body.reason, "user_id": user.user_id,
    })).first()
    if row is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "could not open that window")

    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :user_id, 'maintenance.open', 'maintenance_window',
                :entity_id, CAST(:after AS jsonb))
    """), {
        "client_id": plant.client_id, "user_id": user.user_id, "entity_id": row.id,
        "after": json.dumps({
            "plant_id": body.plant_id, "device_id": body.device_id,
            "reason": body.reason,
        }, default=str),
    })
    return dict(row._mapping)


@router.post("/maintenance/{window_id}/close")
async def close_maintenance(
    window_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """End an open window now. Suppression stops; the record of it does not."""
    row = (await session.execute(text("""
        UPDATE maintenance_windows SET ends_at = now()
         WHERE id = :id AND ends_at IS NULL
        RETURNING id, plant_id, device_id, starts_at, ends_at, reason
    """), {"id": window_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND,
                            "no such open maintenance window")
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :user_id, 'maintenance.close', 'maintenance_window',
                :entity_id, CAST(:after AS jsonb))
    """), {
        "client_id": user.client_id, "user_id": user.user_id, "entity_id": window_id,
        "after": json.dumps({"ended": True}),
    })
    return dict(row._mapping)


@router.get("/plants/{plant_id}/topic-migrations")
async def topic_migrations(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("plant.manage")),
) -> list[dict[str, Any]]:
    """Registered Devices that went quiet as an unregistered topic appeared.

    ⚠ This is a **suggestion**, never an action. The topic is the sole authority
    for origin (Guardrail 5), and re-pointing a Device rewrites where its history
    comes from — so a human confirms it. What this removes is the part that
    wastes money: without it, a rename shows up as an equipment outage on one
    screen and a new device on another, with nothing connecting them, and
    somebody drives to site.

    Matched on Device code *and* payload keys. The code alone would pair `MFM`
    inside the MCR with `MFM` outside it, which are two instruments.
    """
    devices = (await session.execute(text("""
        SELECT d.id, d.code, d.source_address, h.comm_status, h.last_seen_at
          FROM devices d
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id AND d.status = 'active'
           AND d.source_address IS NOT NULL
           AND h.comm_status IN ('offline', 'degraded')
    """), {"plant_id": plant_id})).all()
    if not devices:
        return []

    candidates = (await session.execute(text(f"""
        SELECT m.topic, max(m.time) AS last_seen, count(*) AS messages,
               EXTRACT(EPOCH FROM (max(m.time) - min(m.time))) AS span_s
          FROM mqtt_raw_v m
          LEFT JOIN devices d ON d.source_address = m.topic
         WHERE d.id IS NULL AND m.time > now() - {MIGRATION_WINDOW}
         GROUP BY m.topic
    """))).all()
    if not candidates:
        return []

    pattern_rows = (await session.execute(text(
        "SELECT pattern, priority FROM topic_patterns WHERE enabled ORDER BY priority"
    ))).all()
    patterns: list[TopicPattern] = []
    for row in pattern_rows:
        try:
            patterns.append(TopicPattern(pattern=row.pattern, priority=row.priority))
        except ValueError:
            continue

    now = datetime.now(UTC)
    suggestions: list[dict[str, Any]] = []
    for device in devices:
        for candidate in candidates:
            captured = parse_topic(candidate.topic, patterns)
            if captured is None or captured.get("device_code") != device.code:
                continue
            interval = (
                candidate.span_s / (candidate.messages - 1)
                if candidate.messages > 1 and candidate.span_s else None
            )
            # A dead topic cannot be where a Device moved *to*.
            if classify_topic_liveness(candidate.last_seen, interval, now) != "live":
                continue
            suggestions.append({
                "device_id": device.id,
                "device_code": device.code,
                "comm_status": device.comm_status,
                "old_topic": device.source_address,
                "last_seen_at": device.last_seen_at,
                "new_topic": candidate.topic,
                "new_topic_last_seen": candidate.last_seen,
                "new_topic_messages": candidate.messages,
                "confidence": "device code and Plant match; confirm the payload "
                              "keys before re-pointing",
            })
    return suggestions


@router.get("/devices/{device_id}/recoverable")
async def recoverable_history(
    device_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """How much history this Device could get back out of quarantine.

    ⚠ Read-only, and deliberately. Writing Readings needs privilege on
    `readings` that the API role does not hold and must not (0008/0010), so the
    replay itself is a CLI command: `solarcms backfill-device --device-id N`.
    """
    return await estimate(session, device_id)
