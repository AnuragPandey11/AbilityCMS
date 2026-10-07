"""What each status code means at a Plant, as the client says (migration 0032).

Every screen used to show an Inverter's status code *as sent*, because nobody
had said what its values mean. The client says so here, per Plant: the same
number means different things on different makes, and a Plant's Inverters are
one make. Read by everyone who can see the Plant (`dashboard.view`), so the
meaning appears wherever the code does; written by `config.modify`.

`observed` lists the codes the Plant's equipment has actually sent this week —
so the client labels what arrives rather than typing a datasheet from memory —
including values flagged against an assumed range: a code is a label, and
40960 is as much a code as 512.
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.schemas.reports import StatusCodeIn

router = APIRouter(tags=["status-codes"])

CODE_UNIT = "code"


@router.get("/plants/{plant_id}/status-codes")
async def list_status_codes(
    plant_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    plant = (await session.execute(
        text("SELECT id FROM plants WHERE id = :id"), {"id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    codes = (await session.execute(text("""
        SELECT s.id, dt.code AS device_type_code, t.code AS tag_code, t.name AS tag_name,
               s.code, s.label,
               s.kind, s.note, s.updated_at, u.email AS updated_by
          FROM device_status_codes s
          JOIN device_types dt ON dt.id = s.device_type_id
          JOIN tags t ON t.id = s.tag_id
          LEFT JOIN users u ON u.id = s.updated_by
         WHERE s.plant_id = :plant_id
         ORDER BY dt.code, t.code, s.code
    """), {"plant_id": plant_id})).all()

    code_tags = (await session.execute(
        text("SELECT id FROM tags WHERE unit = :unit"), {"unit": CODE_UNIT})).scalars().all()
    devices = (await session.execute(text("""
        SELECT d.id, dt.code AS type_code FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt ON dt.id = dm.device_type_id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
    """), {"plant_id": plant_id})).all()
    observed: list[dict[str, Any]] = []
    if code_tags and devices:
        type_of = {d.id: d.type_code for d in devices}
        rows = (await session.execute(text("""
            SELECT r.device_id, t.code AS tag_code, t.name AS tag_name,
                   CAST(r.value AS bigint) AS code, max(r.time) AS last_seen
              FROM readings_v r JOIN tags t ON t.id = r.tag_id
             WHERE r.device_id = ANY(:devices) AND r.tag_id = ANY(:tags)
               AND r.time > now() - interval '7 days'
               AND r.value IS NOT NULL AND r.value = trunc(r.value)
             GROUP BY r.device_id, t.code, t.name, CAST(r.value AS bigint)
        """), {"devices": list(type_of), "tags": list(code_tags)})).all()
        grouped: dict[tuple[str, str, int], dict[str, Any]] = {}
        for row in rows:
            key = (type_of[row.device_id], row.tag_code, int(row.code))
            entry = grouped.setdefault(key, {
                "device_type_code": key[0], "tag_code": row.tag_code,
                "tag_name": row.tag_name, "code": key[2], "devices": 0,
                "last_seen": row.last_seen,
            })
            entry["devices"] += 1
            entry["last_seen"] = max(entry["last_seen"], row.last_seen)
        # The payload key each reading arrives as (`STS`), which is how the
        # client knows it — from the bindings, never assumed.
        keys: dict[tuple[str, str], set[str]] = defaultdict(set)
        for row in (await session.execute(text("""
            SELECT b.device_id, t.code AS tag_code, b.source_key
              FROM device_tag_bindings b JOIN tags t ON t.id = b.tag_id
             WHERE b.device_id = ANY(:devices) AND b.tag_id = ANY(:tags) AND b.enabled
        """), {"devices": list(type_of), "tags": list(code_tags)})).all():
            keys[(type_of[row.device_id], row.tag_code)].add(row.source_key)
        for entry in grouped.values():
            group_key = (entry["device_type_code"], entry["tag_code"])
            entry["source_keys"] = sorted(keys.get(group_key, ()))
        observed = sorted(grouped.values(),
                          key=lambda e: (e["device_type_code"], e["tag_code"], e["code"]))
    return {
        "plant_id": plant_id,
        "codes": [dict(row._mapping) for row in codes],
        "observed": observed,
        "can_edit": "config.modify" in user.permissions,
    }


@router.put("/plants/{plant_id}/status-codes")
async def set_status_code(
    plant_id: int, body: StatusCodeIn, session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Say what one code means at this Plant. Saying it again replaces it."""
    plant = (await session.execute(
        text("SELECT client_id FROM plants WHERE id = :id"), {"id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    device_type = (await session.execute(
        text("SELECT id FROM device_types WHERE code = :code"),
        {"code": body.device_type_code})).scalar()
    tag = (await session.execute(
        text("SELECT id, unit FROM tags WHERE code = :code"), {"code": body.tag_code})).first()
    if device_type is None or tag is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "There is no such Device Type or reading.")
    if tag.unit != CODE_UNIT:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            f"{body.tag_code} is a measurement, not a status code.")
    row = (await session.execute(text("""
        INSERT INTO device_status_codes (client_id, plant_id, device_type_id, tag_id, code,
                                         label, kind, note, updated_by)
        VALUES (:client_id, :plant_id, :device_type, :tag, :code, :label, :kind, :note, :user)
        ON CONFLICT (plant_id, device_type_id, tag_id, code) DO UPDATE
            SET label = EXCLUDED.label, kind = EXCLUDED.kind, note = EXCLUDED.note,
                updated_by = EXCLUDED.updated_by, updated_at = now()
        RETURNING id
    """), {"client_id": plant.client_id, "plant_id": plant_id, "device_type": device_type,
           "tag": tag.id, "code": body.code, "label": body.label.strip(), "kind": body.kind,
           "note": (body.note or "").strip() or None, "user": user.user_id})).scalar_one()
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :user_id, 'status_code.set', 'device_status_codes', :id,
                CAST(:after AS jsonb))
    """), {"client_id": plant.client_id, "user_id": user.user_id, "id": row,
           "after": json.dumps({**body.model_dump(), "plant_id": plant_id})})
    return {"id": row, **body.model_dump()}


@router.delete("/plants/{plant_id}/status-codes/{code_id}",
               status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def delete_status_code(
    plant_id: int, code_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> Response:
    """Forget what a code means; it is shown as sent again."""
    row = (await session.execute(text("""
        DELETE FROM device_status_codes WHERE id = :id AND plant_id = :plant_id
        RETURNING client_id, code, label, kind
    """), {"id": code_id, "plant_id": plant_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such status code")
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, before)
        VALUES (:client_id, :user_id, 'status_code.delete', 'device_status_codes', :id,
                CAST(:before AS jsonb))
    """), {"client_id": row.client_id, "user_id": user.user_id, "id": code_id,
           "before": json.dumps({"code": row.code, "label": row.label, "kind": row.kind,
                                 "plant_id": plant_id})})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
