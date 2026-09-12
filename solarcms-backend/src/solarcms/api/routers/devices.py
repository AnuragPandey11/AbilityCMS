"""Devices, their bindings, and broker credentials."""

from __future__ import annotations

import json
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from solarcms.api.auth import hash_password
from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.cache.live import invalidate_resolution
from solarcms.schemas.assets import BindingsReplace, DeviceBulkImport, DeviceCreate

router = APIRouter(tags=["devices"])


@router.get("/plants/{plant_id}/devices")
async def list_devices(
    plant_id: int, session: SessionDep,
    block_id: int | None = Query(None),
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT d.id, d.code, d.name, d.status, d.block_id, d.parent_device_id,
               d.reports_via_device_id, d.source_address, d.expected_interval_s,
               dt.code AS type_code, dt.in_power_path, dm.variant,
               h.comm_status, h.last_seen_at, h.frozen_tag_count
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id
           AND (CAST(:block_id AS bigint) IS NULL OR d.block_id = :block_id)
         ORDER BY d.code
    """), {"plant_id": plant_id, "block_id": block_id})).all()
    return [dict(row._mapping) for row in rows]


@router.get("/devices/{device_id}")
async def get_device(
    device_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    row = (await session.execute(text("""
        SELECT d.*, dt.code AS type_code, dt.in_power_path, dm.variant,
               h.comm_status, h.last_seen_at, h.frozen_tag_count, h.completeness_24h
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.id = :device_id
    """), {"device_id": device_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    return dict(row._mapping)


@router.get("/devices/{device_id}/bindings")
async def get_bindings(
    device_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("config.modify")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT b.id, b.source_key, b.tag_id, t.code AS tag_code, t.unit,
               b.scale, b.value_offset, b.valid_min, b.valid_max, b.enabled
          FROM device_tag_bindings b JOIN tags t ON t.id = b.tag_id
         WHERE b.device_id = :device_id ORDER BY t.code
    """), {"device_id": device_id})).all()
    return [dict(row._mapping) for row in rows]


@router.post("/devices", status_code=status.HTTP_201_CREATED)
async def create_device(
    plant_id: int, body: DeviceCreate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Register one Device.

    `client_id` is taken from the Plant, which RLS already filtered to the
    caller's Client — so a Device cannot be created under another Client's Plant
    even by supplying its id (I-9).
    """
    created = await _insert_devices(session, user, plant_id, [body])
    return created[0]


@router.post("/devices/bulk-import", status_code=status.HTTP_201_CREATED)
async def bulk_import_devices(
    plant_id: int, body: DeviceBulkImport, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Import many Devices at once, all-or-nothing.

    The whole request shares one transaction, so a Plant is never left
    half-imported with an SLD referencing parents that were never created.
    Devices are inserted in the order given: a parent must appear before its
    child, which is the caller's responsibility and is reported plainly if
    violated.
    """
    created = await _insert_devices(session, user, plant_id, body.devices)
    return {"created": len(created), "devices": created}


async def _insert_devices(
    session: Any, user: CurrentUser, plant_id: int, devices: list[DeviceCreate]
) -> list[dict[str, Any]]:
    plant = (await session.execute(
        text("SELECT client_id FROM plants WHERE id = :id"), {"id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")

    out: list[dict[str, Any]] = []
    for device in devices:
        try:
            row = (await session.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                     serial_number, block_id, parent_device_id,
                                     reports_via_device_id, source_address,
                                     expected_interval_s, rated_capacity_kw, installed_on)
                VALUES (:client_id, :plant_id, :model_id, :code, :name, :serial,
                        :block_id, :parent_id, :collector_id, :source_address,
                        :interval_s, :capacity, :installed_on)
                RETURNING id, code, name, status, source_address, expected_interval_s
            """), {
                "client_id": plant.client_id, "plant_id": plant_id,
                "model_id": device.device_model_id, "code": device.code,
                "name": device.name, "serial": device.serial_number,
                "block_id": device.block_id, "parent_id": device.parent_device_id,
                "collector_id": device.reports_via_device_id,
                "source_address": device.source_address,
                "interval_s": device.expected_interval_s,
                "capacity": device.rated_capacity_kw,
                "installed_on": device.installed_on,
            })).first()
        except IntegrityError as exc:
            # I-3 (parent shares the Plant) and topic uniqueness are enforced
            # structurally. Translated here so the caller learns which Device and
            # which rule, rather than reading a constraint name out of a 500.
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"device {device.code!r} violates a constraint: "
                f"{_explain_integrity_error(exc)}",
            ) from exc
        assert row is not None
        out.append(dict(row._mapping))
        await _audit(session, user, plant.client_id, "device.create", row.id,
                     after={"code": device.code, "topic": device.source_address})
    return out


def _explain_integrity_error(exc: IntegrityError) -> str:
    text_form = str(exc.orig) if exc.orig else str(exc)
    if "fk_parent_same_plant" in text_form:
        return "its parent Device belongs to a different Plant (I-3)"
    if "source_address" in text_form:
        return "that MQTT topic is already registered to another Device"
    if "uq_devices_plant_id_code" in text_form:
        return "a Device with that code already exists in this Plant"
    if "device_not_own_parent" in text_form:
        return "a Device cannot be its own parent"
    return text_form.splitlines()[0]


async def _audit(
    session: Any, user: CurrentUser, client_id: int, action: str, entity_id: int,
    *, after: dict[str, Any] | None = None,
) -> None:
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :user_id, :action, 'devices', :entity_id,
                CAST(:after AS jsonb))
    """), {"client_id": client_id, "user_id": user.user_id, "action": action,
           "entity_id": entity_id,
           "after": json.dumps(after, default=str) if after else None})


@router.put("/devices/{device_id}/bindings")
async def replace_bindings(
    device_id: int, body: BindingsReplace, session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Replace a Device's Tag bindings wholesale.

    Replace rather than merge: a binding set is a coherent description of how one
    Device was wired, and merging leaves stale keys behind that silently keep
    decoding after the field change that removed them.

    ⚠ Changing a binding changes how every future Reading is decoded. `mqtt_raw`
    retains the original payloads for 90 days, which is the only route back if a
    scale here turns out wrong (MASTER §5.3).
    """
    device = (await session.execute(
        text("SELECT id, client_id, source_address FROM devices WHERE id = :id"),
        {"id": device_id})).first()
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")

    unknown = []
    for binding in body.bindings:
        exists = (await session.execute(
            text("SELECT id FROM tags WHERE code = :code"),
            {"code": binding.tag_code})).scalar()
        if exists is None:
            unknown.append(binding.tag_code)
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            f"unknown Tag codes: {sorted(set(unknown))}")

    await session.execute(
        text("DELETE FROM device_tag_bindings WHERE device_id = :id"), {"id": device_id})
    for binding in body.bindings:
        await session.execute(text("""
            INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                             scale, value_offset, valid_min, valid_max,
                                             enabled)
            SELECT :client_id, :device_id, t.id, :source_key, :scale, :offset,
                   :valid_min, :valid_max, :enabled
              FROM tags t WHERE t.code = :tag_code
        """), {
            "client_id": device.client_id, "device_id": device_id,
            "source_key": binding.source_key, "tag_code": binding.tag_code,
            "scale": binding.scale, "offset": binding.value_offset,
            "valid_min": binding.valid_min, "valid_max": binding.valid_max,
            "enabled": binding.enabled,
        })

    await _audit(session, user, device.client_id, "device.bindings.replace", device_id,
                 after={"count": len(body.bindings)})
    # The ingest worker caches topic resolution for 300s; invalidate now so a
    # corrected scale takes effect on the next message rather than in five minutes.
    if device.source_address:
        await invalidate_resolution(device.source_address)
    return {"device_id": device_id, "bindings": len(body.bindings),
            "resolution_cache": "invalidated" if device.source_address else "n/a"}


@router.post("/devices/{device_id}/credential", status_code=status.HTTP_201_CREATED)
async def mint_credential(
    device_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Mint a broker credential for a publishing endpoint.

    Shown **once** and stored irreversibly (MASTER §5.1): a lost credential is
    regenerated, never retrieved. Scope is constrained to the Device's own Plant,
    which satisfies I-9 structurally — the Device row was already RLS-filtered to
    the caller's Client, so a credential for another Client's Plant cannot be
    minted even by asking for one.
    """
    device = (await session.execute(text("""
        SELECT d.id, d.client_id, d.plant_id, d.code, p.code AS plant_code,
               c.code AS client_code
          FROM devices d JOIN plants p ON p.id = d.plant_id
          JOIN clients c ON c.id = p.client_id
         WHERE d.id = :device_id
    """), {"device_id": device_id})).first()
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")

    username = f"pub-{device.client_code}-{device.plant_code}-{device.code}".lower()
    password = secrets.token_urlsafe(32)
    topic_scope = f"scms/v1/{device.client_code}/{device.plant_code}/#"

    await session.execute(text("""
        INSERT INTO broker_credentials (client_id, plant_id, device_id, username,
                                        password_hash, topic_scope)
        VALUES (:client_id, :plant_id, :device_id, :username, :password_hash,
                :topic_scope)
        ON CONFLICT (username) DO UPDATE
            SET password_hash = EXCLUDED.password_hash, revoked_at = NULL
    """), {"client_id": device.client_id, "plant_id": device.plant_id,
           "device_id": device.id, "username": username,
           "password_hash": hash_password(password), "topic_scope": topic_scope})

    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id)
        VALUES (:client_id, :user_id, 'credential.mint', 'devices', :device_id)
    """), {"client_id": device.client_id, "user_id": user.user_id,
           "device_id": device.id})

    return {"username": username, "password": password, "topic_scope": topic_scope,
            "note": "Shown once. Store it now; it cannot be retrieved."}
