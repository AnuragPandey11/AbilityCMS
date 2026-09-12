"""Device Types, Device Models and the Tag registry. Global, platform-owned."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.schemas.catalog import TagCreate

router = APIRouter(prefix="/catalog", tags=["catalog"])


@router.get("/device-types")
async def device_types(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text(
        "SELECT id, code, name, in_power_path, variant_set FROM device_types ORDER BY code"
    ))).all()
    return [dict(row._mapping) for row in rows]


@router.get("/device-models")
async def device_models(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT dm.id, dm.manufacturer, dm.model_code, dm.variant,
               dt.code AS device_type_code
          FROM device_models dm JOIN device_types dt ON dt.id = dm.device_type_id
         ORDER BY dm.manufacturer, dm.model_code
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.get("/device-models/{model_id}/tags")
async def device_model_tags(
    model_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    """The Tags a Model exposes — the client's signal schedule for that Type.

    A starting point for a Device's bindings, not their authority: the binding
    row is what decodes (MASTER §5.2), and two Devices of one Model may
    legitimately publish different keys for the same Tag.
    """
    exists = (await session.execute(
        text("SELECT 1 FROM device_models WHERE id = :id"), {"id": model_id})).first()
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device model not found")
    rows = (await session.execute(text("""
        SELECT t.id AS tag_id, t.code AS tag_code, t.name, t.unit, t.category,
               t.scale_default, t.valid_min, t.valid_max, mt.default_source_key
          FROM device_model_tags mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.device_model_id = :id
         ORDER BY t.category, t.code
    """), {"id": model_id})).all()
    return [dict(row._mapping) for row in rows]


@router.get("/tags")
async def tags(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    """The canonical metric registry. Adding a metric is an INSERT here (I-2)."""
    rows = (await session.execute(text("""
        SELECT id, code, name, unit, category, rollup_method, scale_default,
               valid_min, valid_max, min_interval_s, is_cumulative
          FROM tags ORDER BY category, code
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.post("/tags", status_code=status.HTTP_201_CREATED)
async def create_tag(
    body: TagCreate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Add a metric to the registry.

    This is I-2 in practice: a new metric is an INSERT here, never a column and
    never a migration, which is what makes F-12 (new Device Types) and F-14
    (config-driven dashboards) possible.

    The catalogue is global and platform-owned, so this is `system.admin` — one
    Client must not be able to redefine a metric every other Client reports.
    """
    duplicate = (await session.execute(
        text("SELECT id FROM tags WHERE code = :code"), {"code": body.code})).first()
    if duplicate is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"tag {body.code!r} already exists")

    # Guardrail 11, also a CHECK constraint: a status Tag is a Digital Input and
    # is alarmed on change of state, so throttling would discard a trip contact.
    min_interval = 0 if body.category == "status" else body.min_interval_s
    row = (await session.execute(text("""
        INSERT INTO tags (code, name, unit, category, rollup_method, scale_default,
                          valid_min, valid_max, min_interval_s, is_cumulative)
        VALUES (:code, :name, :unit, :category, :rollup, :scale, :vmin, :vmax,
                :interval, :cumulative)
        RETURNING id, code, name, unit, category, rollup_method, min_interval_s
    """), {
        "code": body.code, "name": body.name, "unit": body.unit,
        "category": body.category, "rollup": body.rollup_method,
        "scale": body.scale_default, "vmin": body.valid_min, "vmax": body.valid_max,
        "interval": min_interval, "cumulative": body.is_cumulative,
    })).first()
    assert row is not None
    # A catalogue change is platform-level: client_id is NULL, and the actor is
    # the Super Admin who made it.
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (NULL, :user_id, 'tag.create', 'tags', :id, CAST(:after AS jsonb))
    """), {"user_id": user.user_id, "id": row.id,
           "after": json.dumps({"code": body.code, "unit": body.unit,
                                "category": body.category})})
    return dict(row._mapping)
