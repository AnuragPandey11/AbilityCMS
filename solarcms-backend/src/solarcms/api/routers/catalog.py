"""Device Types, Device Models and the Tag registry. Global, platform-owned."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.schemas.catalog import (
    DeviceModelCreate,
    ModelTagsReplace,
    TagCreate,
    TagUpdate,
)

router = APIRouter(prefix="/catalog", tags=["catalog"])


async def _audit(
    session: Any, user: CurrentUser, action: str, entity_type: str, entity_id: int,
    after: dict[str, Any],
) -> None:
    """A catalogue change is platform-level: client_id NULL, actor recorded."""
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (NULL, :user_id, :action, :entity_type, :entity_id, CAST(:after AS jsonb))
    """), {"user_id": user.user_id, "action": action, "entity_type": entity_type,
           "entity_id": entity_id, "after": json.dumps(after, default=str)})


@router.get("/device-types")
async def device_types(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text(
        "SELECT id, code, name, in_power_path, variant_set FROM device_types ORDER BY code"
    ))).all()
    return [dict(row._mapping) for row in rows]


@router.get("/device-table-columns")
async def device_table_columns(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, list[dict[str, Any]]]:
    """Which Tags form the columns of a per-Device summary table, by Device Type.

    The curated subset, not everything a Device publishes: an Inverter is bound
    to eighty Tags once its PV strings are counted, and a table eighty columns
    wide answers nothing. Which seven matter is configuration
    (`device_table_columns`), so changing them is an UPDATE and never a release.

    Keyed by Device Type and never by Device or Plant (Guardrail 2).
    """
    rows = (await session.execute(text("""
        SELECT dt.code AS device_type_code, t.id AS tag_id, t.code AS tag_code,
               t.name, t.unit, t.category, c.position
          FROM device_table_columns c
          JOIN device_types dt ON dt.id = c.device_type_id
          JOIN tags t          ON t.id  = c.tag_id
         ORDER BY dt.code, c.position
    """))).all()
    out: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        out.setdefault(row.device_type_code, []).append({
            "tag_id": row.tag_id, "tag_code": row.tag_code, "name": row.name,
            # The unit comes from the registry, never from the Tag's name: the
            # client's own sheet mixes kWh and MWh inside one Device (T-5).
            "unit": row.unit, "category": row.category, "position": row.position,
        })
    return out


@router.get("/device-models")
async def device_models(
    session: SessionDep,
    device_type_code: str | None = Query(
        None, description="Filter to one Device Type, e.g. INVERTER."),
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    """Models, with enough detail to choose one without a second request.

    `signal_count` and `repeat_max` are what the onboarding form needs to say
    "Reference String Inverter — 23 signals plus up to 28 PV strings", which is
    the difference between a meaningful choice and a list of codes.
    """
    rows = (await session.execute(text("""
        SELECT dm.id, dm.manufacturer, dm.model_code, dm.variant,
               dm.rated_capacity_kw, dt.code AS device_type_code,
               dt.name AS device_type_name, dt.in_power_path,
               count(mt.tag_id) FILTER (WHERE mt.repeat_index IS NULL)
                   AS signal_count,
               COALESCE(max(mt.repeat_index), 0) AS repeat_max,
               count(mt.tag_id) FILTER (WHERE t.formula IS NOT NULL)
                   AS derived_count
          FROM device_models dm
          JOIN device_types dt ON dt.id = dm.device_type_id
          LEFT JOIN device_model_tags mt ON mt.device_model_id = dm.id
          LEFT JOIN tags t ON t.id = mt.tag_id
         WHERE CAST(:type_code AS text) IS NULL OR dt.code = :type_code
         GROUP BY dm.id, dt.code, dt.name, dt.in_power_path
         ORDER BY dt.code, dm.manufacturer, dm.model_code
    """), {"type_code": device_type_code})).all()
    return [dict(row._mapping) for row in rows]


@router.get("/device-models/{model_id}/tags")
async def device_model_tags(
    model_id: int, session: SessionDep,
    string_count: int | None = Query(
        None, ge=0,
        description="Show only the first N of each repeating group, as a Device "
                    "with that many strings would bind."),
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    """The Tags a Model exposes — the client's signal schedule for that Type.

    A starting point for a Device's bindings, not their authority: the binding
    row is what decodes (MASTER §5.2), and two Devices of one Model may
    legitimately publish different keys for the same Tag.

    Ordered by the sheet's own order, not alphabetically: eighty PV-string rows
    sorted by code are unreadable to the engineer commissioning the Device, and
    they are the person this list is for. `formula` marks the rows nothing
    publishes — they are computed, and no source key will ever arrive for them.
    """
    exists = (await session.execute(
        text("SELECT 1 FROM device_models WHERE id = :id"), {"id": model_id})).first()
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device model not found")
    rows = (await session.execute(text("""
        SELECT t.id AS tag_id, t.code AS tag_code, t.name, t.unit, t.category,
               t.scale_default, t.valid_min, t.valid_max, t.rollup_method,
               t.is_cumulative, t.min_interval_s, t.formula, t.derived_scope,
               mt.default_source_key, mt.repeat_index, mt.sort_order
          FROM device_model_tags mt JOIN tags t ON t.id = mt.tag_id
         WHERE mt.device_model_id = :id
           AND (mt.repeat_index IS NULL
                OR CAST(:string_count AS int) IS NULL
                OR mt.repeat_index <= :string_count)
         ORDER BY mt.sort_order, t.code
    """), {"id": model_id, "string_count": string_count})).all()
    return [dict(row._mapping) for row in rows]


@router.post("/device-models", status_code=status.HTTP_201_CREATED)
async def create_device_model(
    body: DeviceModelCreate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Add a Model to the catalogue — a real make and model, or a variant.

    The catalogue is global and platform-owned, so this is `system.admin`: one
    Client must not be able to redefine a Model that another Client's Devices are
    registered against.

    Its signal list is set separately, by PUT to this Model's `/tags`, because a
    Model is often created first and populated once its datasheet arrives.
    """
    type_id = (await session.execute(
        text("SELECT id FROM device_types WHERE code = :code"),
        {"code": body.device_type_code})).scalar()
    if type_id is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            f"unknown Device Type {body.device_type_code!r}")
    duplicate = (await session.execute(text("""
        SELECT id FROM device_models
         WHERE manufacturer = :manufacturer AND model_code = :model_code
    """), {"manufacturer": body.manufacturer, "model_code": body.model_code})).first()
    if duplicate is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{body.manufacturer} {body.model_code} is already in the catalogue")

    row = (await session.execute(text("""
        INSERT INTO device_models (device_type_id, manufacturer, model_code, variant,
                                   rated_capacity_kw)
        VALUES (:type_id, :manufacturer, :model_code, :variant, :capacity)
        RETURNING id, manufacturer, model_code, variant, rated_capacity_kw
    """), {"type_id": type_id, "manufacturer": body.manufacturer,
           "model_code": body.model_code, "variant": body.variant,
           "capacity": body.rated_capacity_kw})).first()
    assert row is not None
    await _audit(session, user, "device_model.create", "device_models", row.id,
                 {"manufacturer": body.manufacturer, "model_code": body.model_code,
                  "device_type": body.device_type_code})
    return dict(row._mapping)


@router.put("/device-models/{model_id}/tags")
async def replace_device_model_tags(
    model_id: int, body: ModelTagsReplace, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Set a Model's signal schedule, replacing what is there.

    Replaced rather than merged, for the same reason the seed replaces it: a
    signal the client withdraws must disappear, and a merge leaves it behind as a
    Tag that will never report — indistinguishable, on every screen, from a
    sensor that has failed.

    A repeating group is expressed by giving each member a `repeat_index`. The
    *Model* declares that up to 28 PV strings exist; how many a given unit
    actually has is `devices.string_count`, because that is a fact about the unit.
    """
    exists = (await session.execute(
        text("SELECT 1 FROM device_models WHERE id = :id"), {"id": model_id})).first()
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device model not found")

    codes = [entry.tag_code for entry in body.tags]
    known = {
        row.code: row.id for row in (await session.execute(text(
            "SELECT id, code FROM tags WHERE code = ANY(:codes)"
        ), {"codes": codes})).all()
    }
    missing = sorted(set(codes) - set(known))
    if missing:
        # Rejected rather than skipped: a Model silently missing half its signals
        # is a Device that decodes half its payload, discovered weeks later.
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"unknown Tag codes: {missing}. Create them under /catalog/tags first.")

    await session.execute(
        text("DELETE FROM device_model_tags WHERE device_model_id = :id"),
        {"id": model_id})
    for order, entry in enumerate(body.tags):
        await session.execute(text("""
            INSERT INTO device_model_tags (device_model_id, tag_id,
                                           default_source_key, repeat_index, sort_order)
            VALUES (:model_id, :tag_id, :source_key, :repeat_index, :sort_order)
        """), {"model_id": model_id, "tag_id": known[entry.tag_code],
               "source_key": entry.default_source_key,
               "repeat_index": entry.repeat_index,
               "sort_order": entry.sort_order if entry.sort_order is not None else order})

    await _audit(session, user, "device_model.tags", "device_models", model_id,
                 {"tag_count": len(body.tags)})
    return {"model_id": model_id, "tags": len(body.tags)}


@router.get("/tags")
async def tags(
    session: SessionDep,
    category: str | None = Query(None),
    derived: bool | None = Query(
        None, description="true: only calculated Tags. false: only published ones."),
    search: str | None = Query(None, description="Substring of the code or name."),
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    """The canonical metric registry. Adding a metric is an INSERT here (I-2).

    Filterable because it is no longer short: the client's third revision brings
    the registry past two hundred rows, most of them the PV-string and
    annunciator repeating groups, and an unfiltered list is not usable in a
    picker.
    """
    rows = (await session.execute(text("""
        SELECT id, code, name, unit, category, rollup_method, scale_default,
               valid_min, valid_max, min_interval_s, is_cumulative,
               formula, derived_scope
          FROM tags
         WHERE (CAST(:category AS text) IS NULL OR category = :category)
           AND (CAST(:derived AS boolean) IS NULL
                OR (formula IS NOT NULL) = CAST(:derived AS boolean))
           AND (CAST(:search AS text) IS NULL
                OR code ILIKE '%' || :search || '%'
                OR name ILIKE '%' || :search || '%')
         ORDER BY category, code
    """), {"category": category, "derived": derived, "search": search})).all()
    return [dict(row._mapping) for row in rows]


@router.patch("/tags/{tag_id}")
async def update_tag(
    tag_id: int, body: TagUpdate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Edit a metric: its unit, its bounds, its scale, or its formula.

    This route is how OPEN-15 closes without a release. Units and scaling are the
    largest block of assumptions in the system — `domain/assumptions.py` exists
    entirely so that replacing them is a single edit — and this is the same edit
    made by a Super Admin at runtime, against a live registry, one row at a time.

    ⚠ It does not retrospectively change stored Readings. A scale corrected today
    applies from today; history decoded under the old one is repaired by replaying
    `mqtt_raw`, which is the only path back to correct history (MASTER §5.3).
    """
    before = (await session.execute(text("""
        SELECT code, unit, scale_default, formula, derived_scope, category
          FROM tags WHERE id = :id
    """), {"id": tag_id})).first()
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "tag not found")

    # Guardrail 11, also a CHECK constraint: a status Tag is a Digital Input,
    # alarmed on change of state, so throttling would discard a trip contact that
    # opened and re-closed inside the window.
    category = body.category or before.category
    min_interval = 0 if category == "status" else body.min_interval_s

    row = (await session.execute(text("""
        UPDATE tags
           SET name = coalesce(:name, name),
               unit = coalesce(:unit, unit),
               category = coalesce(:category, category),
               rollup_method = coalesce(:rollup, rollup_method),
               scale_default = coalesce(:scale, scale_default),
               valid_min = coalesce(:vmin, valid_min),
               valid_max = coalesce(:vmax, valid_max),
               min_interval_s = coalesce(:interval, min_interval_s),
               is_cumulative = coalesce(:cumulative, is_cumulative),
               formula = CASE WHEN :clear_formula THEN NULL
                              ELSE coalesce(:formula, formula) END,
               derived_scope = CASE WHEN :clear_formula THEN NULL
                                    ELSE coalesce(:scope, derived_scope) END
         WHERE id = :id
        RETURNING id, code, name, unit, category, rollup_method, scale_default,
                  valid_min, valid_max, min_interval_s, is_cumulative,
                  formula, derived_scope
    """), {
        "id": tag_id, "name": body.name, "unit": body.unit, "category": body.category,
        "rollup": body.rollup_method, "scale": body.scale_default,
        "vmin": body.valid_min, "vmax": body.valid_max, "interval": min_interval,
        "cumulative": body.is_cumulative, "formula": body.formula,
        "scope": body.derived_scope, "clear_formula": body.clear_formula,
    })).first()
    assert row is not None

    await _audit(session, user, "tag.update", "tags", tag_id,
                 {"before": dict(before._mapping), "after": dict(row._mapping)})
    return dict(row._mapping)


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
                          valid_min, valid_max, min_interval_s, is_cumulative,
                          formula, derived_scope)
        VALUES (:code, :name, :unit, :category, :rollup, :scale, :vmin, :vmax,
                :interval, :cumulative, :formula, :scope)
        RETURNING id, code, name, unit, category, rollup_method, min_interval_s,
                  formula, derived_scope
    """), {
        "code": body.code, "name": body.name, "unit": body.unit,
        "category": body.category, "rollup": body.rollup_method,
        "scale": body.scale_default, "vmin": body.valid_min, "vmax": body.valid_max,
        "interval": min_interval, "cumulative": body.is_cumulative,
        "formula": body.formula, "scope": body.derived_scope,
    })).first()
    assert row is not None
    await _audit(session, user, "tag.create", "tags", row.id,
                 {"code": body.code, "unit": body.unit, "category": body.category,
                  "formula": body.formula})
    return dict(row._mapping)
