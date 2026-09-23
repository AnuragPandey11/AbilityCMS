"""Alarms and Alarm Rules."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.schemas.alarming import AlarmRuleWrite

router = APIRouter(tags=["alarms"])


@router.get("/alarms")
async def list_alarms(
    session: SessionDep,
    state: str | None = Query(None, pattern="^(active|acknowledged|resolved)$"),
    severity: str | None = Query(None, pattern="^(critical|high|medium|low)$"),
    plant_id: int | None = None,
    client_id: int | None = None,
    since: datetime | None = None,
    limit: int = Query(100, ge=1, le=500),
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    # `client_id` is how a platform administrator narrows to one Client, in SQL
    # rather than in the browser, where it would filter the `limit` rows that
    # happened to come back. RLS still decides visibility; this only narrows.
    rows = (await session.execute(text("""
        SELECT a.id, a.state, a.severity, a.opened_at, a.acknowledged_at, a.resolved_at,
               a.message, a.trigger_value, a.classification, a.escalation_level,
               a.device_id, a.plant_id, d.code AS device_code, r.code AS rule_code
          FROM alarms a
          JOIN alarm_rules r ON r.id = a.rule_id
          LEFT JOIN devices d ON d.id = a.device_id
         WHERE (CAST(:state AS text) IS NULL OR a.state = :state)
           AND (CAST(:severity AS text) IS NULL OR a.severity = :severity)
           AND (CAST(:plant_id AS bigint) IS NULL OR a.plant_id = :plant_id)
           AND (CAST(:client_id AS bigint) IS NULL OR a.client_id = :client_id)
           AND (CAST(:since AS timestamptz) IS NULL OR a.opened_at >= :since)
         ORDER BY a.opened_at DESC LIMIT :limit
    """), {"state": state, "severity": severity, "plant_id": plant_id,
           "client_id": client_id, "since": since, "limit": limit})).all()
    return [dict(row._mapping) for row in rows]


@router.post("/alarms/{alarm_id}/acknowledge")
async def acknowledge(
    alarm_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("alarm.acknowledge")),
) -> dict[str, Any]:
    row = (await session.execute(text("""
        UPDATE alarms
           SET state = 'acknowledged', acknowledged_at = now(), acknowledged_by = :user_id
         WHERE id = :alarm_id AND state = 'active'
        RETURNING id, state, acknowledged_at, client_id
    """), {"alarm_id": alarm_id, "user_id": user.user_id})).first()
    if row is None:
        # Either it does not exist, is not visible, or is not active. All three are
        # the same answer to this caller.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no active alarm with that id")

    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id)
        VALUES (:client_id, :user_id, 'alarm.acknowledge', 'alarms', :alarm_id)
    """), {"client_id": row.client_id, "user_id": user.user_id, "alarm_id": alarm_id})
    return {"id": row.id, "state": row.state, "acknowledged_at": row.acknowledged_at}


@router.get("/alarm-rules")
async def list_rules(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("config.modify")),
) -> list[dict[str, Any]]:
    """Rules visible to this Client: its own, plus the platform defaults.

    A rule with client_id NULL is a platform default inherited by every Client,
    so it deliberately appears here even though it is not the Client's row.
    """
    rows = (await session.execute(text("""
        SELECT r.id, r.client_id, r.code, r.name, r.scope_type, r.scope_id,
               r.operator, r.threshold, r.threshold_high, r.clear_threshold,
               r.duration_s, r.severity, r.enabled, t.code AS tag_code,
               dt.code AS device_type_code
          FROM alarm_rules r
          LEFT JOIN tags t ON t.id = r.tag_id
          LEFT JOIN device_types dt
                 ON dt.id = r.scope_id AND r.scope_type = 'device_type'
         WHERE r.client_id IS NULL OR r.client_id = app_client_id()
         ORDER BY r.code
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.post("/alarm-rules", status_code=status.HTTP_201_CREATED)
async def create_alarm_rule(
    body: AlarmRuleWrite, session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Create a Client-owned Alarm Rule.

    Always written with the caller's `client_id`, never NULL: a NULL-Client rule
    is a platform default inherited by every Client, and one Client must not be
    able to create or edit one. To tune a default, a Client adds a more specific
    rule and scope resolution prefers it (BACKEND_SPEC §10.1).
    """
    tag_id = None
    if body.tag_code:
        tag_id = (await session.execute(
            text("SELECT id FROM tags WHERE code = :code"),
            {"code": body.tag_code})).scalar()
        if tag_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"unknown Tag {body.tag_code!r}")

    try:
        row = (await session.execute(text("""
            INSERT INTO alarm_rules (client_id, code, name, scope_type, scope_id, tag_id,
                                     operator, threshold, threshold_high,
                                     clear_threshold, duration_s, severity,
                                     classification, enabled)
            VALUES (app_client_id(), :code, :name, :scope_type, :scope_id, :tag_id,
                    :operator, :threshold, :threshold_high, :clear_threshold,
                    :duration_s, :severity, :classification, :enabled)
            RETURNING id, code, name, operator, severity, duration_s, enabled
        """), {
            "code": body.code, "name": body.name, "scope_type": body.scope_type,
            "scope_id": body.scope_id, "tag_id": tag_id, "operator": body.operator,
            "threshold": body.threshold, "threshold_high": body.threshold_high,
            "clear_threshold": body.clear_threshold, "duration_s": body.duration_s,
            "severity": body.severity, "classification": body.classification,
            "enabled": body.enabled,
        })).first()
    except IntegrityError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "a rule with that code and scope already exists") from exc
    assert row is not None
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id)
        VALUES (app_client_id(), :user_id, 'alarm_rule.create', 'alarm_rules', :id)
    """), {"user_id": user.user_id, "id": row.id})
    return dict(row._mapping)


@router.patch("/alarm-rules/{rule_id}")
async def update_alarm_rule(
    rule_id: int, body: AlarmRuleWrite, session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Update a Client-owned rule.

    A platform default is invisible to this UPDATE: the write policies from
    migration 0012 scope writes to `client_id = app_client_id()`, so a NULL-Client
    row simply does not match and the caller gets a 404 rather than silently
    editing every Client's inherited rule.
    """
    tag_id = None
    if body.tag_code:
        tag_id = (await session.execute(
            text("SELECT id FROM tags WHERE code = :code"),
            {"code": body.tag_code})).scalar()

    row = (await session.execute(text("""
        UPDATE alarm_rules
           SET name = :name, operator = :operator, threshold = :threshold,
               threshold_high = :threshold_high, clear_threshold = :clear_threshold,
               duration_s = :duration_s, severity = :severity, enabled = :enabled,
               tag_id = coalesce(:tag_id, tag_id)
         WHERE id = :id
        RETURNING id, code, name, operator, severity, duration_s, enabled
    """), {
        "id": rule_id, "name": body.name, "operator": body.operator,
        "threshold": body.threshold, "threshold_high": body.threshold_high,
        "clear_threshold": body.clear_threshold, "duration_s": body.duration_s,
        "severity": body.severity, "enabled": body.enabled, "tag_id": tag_id,
    })).first()
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "no editable rule with that id; platform defaults are read-only",
        )
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id)
        VALUES (app_client_id(), :user_id, 'alarm_rule.update', 'alarm_rules', :id)
    """), {"user_id": user.user_id, "id": rule_id})
    return dict(row._mapping)
