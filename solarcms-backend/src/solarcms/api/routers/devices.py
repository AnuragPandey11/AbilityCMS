"""Devices, their bindings, and broker credentials."""

from __future__ import annotations

import contextlib
import json
import secrets
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from solarcms.api.auth import hash_password
from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.cache import live
from solarcms.cache.live import invalidate_resolution
from solarcms.domain.assumptions import SOURCE_KEY_ALIASES
from solarcms.domain.decoding import TopicPattern, collector_in_topic
from solarcms.domain.sld import crosses_collector_boundary, would_create_cycle
from solarcms.schemas.assets import (
    BindingsReplace,
    DeviceBulkImport,
    DeviceCreate,
    DeviceUpdate,
)
from solarcms.services.onboarding import bind_from_model

router = APIRouter(tags=["devices"])


async def _refuse_collector_against_topic(
    session: Any, *, device_code: str, topic: str | None, collector: str | None
) -> None:
    """Refuse a Collector the Device's own topic contradicts.

    **A Device outside an enclosure cannot be put inside one, and one inside
    cannot be moved out or moved to another.** Which room a Device publishes
    from is part of its origin, and the topic is the sole authority for origin
    (Guardrail 5) — so where the topic answers the question, a typed-in name is
    not an override, it is a contradiction.

    Three cases, and only the third is editable:

        six-segment topic   → the collector is that segment, fixed
        five-segment topic  → the Device is in no collector, fixed
        no or unmatched topic → nothing is known; a human may say

    The third is not a loophole: a Device registered before commissioning has
    no topic yet, and somebody has to be able to record which panel it is in.
    The moment a topic arrives, the topic wins.
    """
    rows = (await session.execute(text(
        "SELECT pattern, priority FROM topic_patterns WHERE enabled ORDER BY priority"
    ))).all()
    patterns: list[TopicPattern] = []
    for row in rows:
        with contextlib.suppress(ValueError):
            patterns.append(TopicPattern(pattern=row.pattern, priority=row.priority))

    # A synthetic Device cannot be in a room. The Plant KPI panel is not
    # equipment: it publishes nothing, has no topic and never will, and its
    # Tags are computed by the scheduler rather than received. "Which enclosure
    # does it publish from" has no answer, so the field must not be offered —
    # and without this the no-topic branch below would leave it editable
    # forever, which is exactly how it ended up recorded as sitting in the MCR.
    #
    # A Device *Type*, not a Device or a Client, so Guardrail 2 is untouched —
    # the same way `in_power_path` and `sld_stage` are branched on.
    if collector is not None:
        synthetic = (await session.execute(text("""
            SELECT 1 FROM devices d
              JOIN device_models dm ON dm.id = d.device_model_id
              JOIN device_types dt  ON dt.id = dm.device_type_id
             WHERE d.code = :code AND dt.code = 'PLANT_KPI'
        """), {"code": device_code})).first()
        if synthetic is not None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"{device_code} is a Plant KPI panel, not equipment — its "
                f"figures are computed, not published, so it sits in no "
                f"enclosure and cannot be put in {collector!r}.")

    known, expected = collector_in_topic(topic, patterns)
    if not known or expected == collector:
        return

    if expected is None:
        detail = (
            f"{device_code} publishes on {topic!r}, which has no collector "
            f"segment — so it is in no collector, and it cannot be put in "
            f"{collector!r}. A collector is the enclosure a Device publishes "
            f"from, and the topic is the only thing that decides it."
        )
    else:
        detail = (
            f"{device_code} publishes on {topic!r}, so it is in collector "
            f"{expected!r} and cannot be "
            + (f"moved to {collector!r}." if collector else "taken out of it.")
            + " The topic decides which collector a Device is in, not this field."
        )
    raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail)


def _clean_collector(value: str | None) -> str | None:
    """Normalise a Collector name, treating whitespace-only as absent.

    A Collector named `"  "` is not a Collector, and an empty box in a form
    posts an empty string rather than null — which would otherwise create an
    enclosure with a blank label that nothing can be moved out of. The CHECK
    constraint in migration 0022 refuses it at the last line; this turns it into
    "no Collector" at the first, which is what the operator meant.

    ⚠ Case is preserved exactly. `MCR` and `mcr` stay two Collectors for the
    same reason `KULAR_GREEN` and `kular_green` stay two origins: the topic is
    case-sensitive (Guardrail 5), and folding here would silently merge two
    enclosures that the broker keeps apart.
    """
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


@router.get("/plants/{plant_id}/devices")
async def list_devices(
    plant_id: int, session: SessionDep,
    block_id: int | None = Query(None),
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT d.id, d.code, d.name, d.status, d.block_id, d.parent_device_id,
               d.reports_via_device_id, d.collector_code, d.source_address,
               d.expected_interval_s, d.rated_capacity_kw, d.string_count,
               d.serial_number, d.installed_on,
               dt.code AS type_code, dt.name AS type_name, dt.in_power_path,
               -- The stage this Device folds into, and the accepted correction
               -- where one exists. The schematic orders ties by stage rather
               -- than alphabetically, which needs both.
               dt.sld_stage, d.sld_stage_override,
               dm.variant, dm.model_code, dm.manufacturer,
               h.comm_status, h.last_seen_at, h.frozen_tag_count,
               h.completeness_24h,
               (SELECT count(*) FROM device_tag_bindings b
                 WHERE b.device_id = d.id AND b.enabled) AS binding_count
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


@router.get("/devices/{device_id}/unmapped-keys")
async def unmapped_keys(
    device_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Payload keys this Device is publishing that nothing is bound to.

    The most useful thing on a commissioning screen, and it is available nowhere
    else: an unmapped key never becomes a Reading, so no query over `readings`
    can reveal one. Each entry is a signal the Device really sends and that the
    platform is currently discarding.

    `suggested_tag_code` is the registry's own alias for that key where one
    exists — the client's sheet spells it "AMBINT TEMP." and the canonical Tag is
    AMBIENT_TEMPERATURE. A suggestion only: the binding is the authority.
    """
    exists = (await session.execute(
        text("SELECT 1 FROM devices WHERE id = :id"), {"id": device_id})).first()
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    keys = await live.read_unmapped_keys(device_id)
    return {
        "device_id": device_id,
        "keys": [
            {"source_key": key, "suggested_tag_code": SOURCE_KEY_ALIASES.get(key)}
            for key in keys
        ],
    }


@router.delete("/devices/{device_id}/unmapped-keys",
               status_code=status.HTTP_204_NO_CONTENT)
async def forget_unmapped_keys(
    device_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> Response:
    """Forget the unmapped-key list, so it rebuilds from what arrives next.

    Used after editing bindings: the old list still names keys that are now
    mapped, and a commissioning screen that keeps reporting solved problems stops
    being read.
    """
    device = (await session.execute(
        text("SELECT client_id FROM devices WHERE id = :id"), {"id": device_id})).first()
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")
    keys = await live.read_unmapped_keys(device_id)
    await live.clear_unmapped_keys(device_id)
    # Audited like any other configuration action: it changes what the
    # commissioning screen reports, and "who cleared the warning" is exactly the
    # question asked when a signal turns out to have been missing all along.
    await _audit(session, user, device.client_id, "device.unmapped_keys.clear",
                 device_id, after={"cleared": keys})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
        # The topic decides which enclosure a Device is in, at registration as
        # well as afterwards — otherwise the rule is one import away from being
        # bypassed wholesale.
        await _refuse_collector_against_topic(
            session, device_code=device.code, topic=device.source_address,
            collector=_clean_collector(device.collector_code),
        )
        try:
            row = (await session.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                     serial_number, block_id, parent_device_id,
                                     reports_via_device_id, collector_code,
                                     source_address,
                                     expected_interval_s, rated_capacity_kw,
                                     string_count, installed_on)
                VALUES (:client_id, :plant_id, :model_id, :code, :name, :serial,
                        :block_id, :parent_id, :collector_id, :collector_code,
                        :source_address,
                        :interval_s, :capacity, :string_count, :installed_on)
                RETURNING id, code, name, status, source_address, expected_interval_s,
                          string_count, collector_code
            """), {
                "client_id": plant.client_id, "plant_id": plant_id,
                "model_id": device.device_model_id, "code": device.code,
                "name": device.name, "serial": device.serial_number,
                "block_id": device.block_id, "parent_id": device.parent_device_id,
                "collector_id": device.reports_via_device_id,
                "collector_code": _clean_collector(device.collector_code),
                "source_address": device.source_address,
                "interval_s": device.expected_interval_s,
                "capacity": device.rated_capacity_kw,
                "string_count": device.string_count,
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
        created = dict(row._mapping)
        if device.bind_from_model:
            # Seeded from the Model's schedule so the Device decodes something
            # from its first message. A starting point, not the authority: the
            # commissioning screen is where it is corrected (MASTER §5.2).
            created["bindings"] = await bind_from_model(
                session, plant.client_id, row.id)
        out.append(created)
        await _audit(session, user, plant.client_id, "device.create", row.id,
                     after={"code": device.code, "topic": device.source_address,
                            "collector_code": device.collector_code,
                            "string_count": device.string_count})
    return out


@router.delete("/devices/{device_id}", status_code=status.HTTP_200_OK)
async def delete_device(
    device_id: int, session: SessionDep,
    force: bool = Query(
        False, description="Also delete this Device's stored Readings. Without "
                           "it, a Device that has recorded data is refused."),
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Remove a Device from a Plant.

    ⚠ **Readings have no foreign key to `devices`** — deliberately, because a
    hypertable that checks one on every inserted row cannot keep up with
    ingestion. The consequence is that deleting a Device does *not* remove its
    history: the rows stay, attributed to an id that no longer resolves,
    invisible on every screen and counted by every "how much data do we hold"
    query forever.

    So a Device with stored Readings is refused by default and the caller is
    told what it would cost. Three honest outcomes:

    * **no Readings** — deleted outright; nothing is lost because nothing exists.
    * **has Readings, `force=false`** — refused, with the count, and
      `decommission` offered as the alternative that keeps the history.
    * **has Readings, `force=true`** — Readings deleted first, then the Device.

    Decommissioning (`PATCH status=decommissioned`) remains the right answer for
    equipment that really existed: it stops ingestion and hides the Device from
    the diagram while its generation history stays attributable.
    """
    row = (await session.execute(text("""
        SELECT d.id, d.code, d.client_id, d.plant_id, d.source_address
          FROM devices d WHERE d.id = :id
    """), {"id": device_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")

    children = (await session.execute(text(
        "SELECT count(*) FROM devices WHERE parent_device_id = :id"
    ), {"id": device_id})).scalar() or 0
    if children:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{row.code} has {children} Device(s) wired into it. Re-point them "
            f"first, or the diagram loses a limb with no indication why.")

    readings = (await session.execute(text(
        "SELECT count(*) FROM readings_v WHERE device_id = :id"
    ), {"id": device_id})).scalar() or 0
    if readings and not force:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{row.code} has {readings} stored Reading(s). Deleting it would "
            f"strand them under an id that no longer resolves. Decommission it "
            f"instead to keep the history, or repeat with force=true to delete "
            f"the Readings as well.")

    # Order matters: the telemetry tables carry no foreign key, so nothing
    # cascades and nothing stops this happening in the wrong order either.
    if readings:
        await session.execute(
            text("DELETE FROM readings WHERE device_id = :id"), {"id": device_id})
    await session.execute(
        text("DELETE FROM device_tag_bindings WHERE device_id = :id"), {"id": device_id})
    await session.execute(
        text("UPDATE devices SET reports_via_device_id = NULL "
             "WHERE reports_via_device_id = :id"), {"id": device_id})
    await session.execute(text("DELETE FROM devices WHERE id = :id"), {"id": device_id})

    # The resolver caches topic → Device for 300s; without this, ingest keeps
    # decoding into a Device that no longer exists for five minutes.
    if row.source_address:
        await invalidate_resolution(row.source_address)

    await _audit(session, user, row.client_id, "device.delete", device_id,
                 before={"code": row.code, "topic": row.source_address,
                         "readings_deleted": readings if force else 0})
    return {"deleted": device_id, "code": row.code, "readings_deleted": readings if force else 0}


@router.patch("/devices/{device_id}")
async def update_device(
    device_id: int, body: DeviceUpdate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Edit a Device — its wiring, its topic, its interval, its string count.

    The three groupings are edited here because they are *discovered*: which
    Collector actually transmits a Device, and what it really feeds into, are
    routinely corrected after the first day of live data. A platform where that
    requires a developer is a platform where the SLD quietly stays wrong.
    """
    before = (await session.execute(text("""
        SELECT client_id, plant_id, code, name, status, block_id, parent_device_id,
               reports_via_device_id, collector_code, source_address,
               expected_interval_s, string_count
          FROM devices WHERE id = :id
    """), {"id": device_id})).first()
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")

    clear = set(body.clear or [])
    unknown = clear - {"block_id", "parent_device_id", "reports_via_device_id",
                       "collector_code", "source_address", "string_count",
                       "sld_stage_override"}
    if unknown:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            f"cannot clear {sorted(unknown)}")

    # ── Refuse a loop at the moment it is made ───────────────────────────────
    # The composite foreign key already forces a parent to share the Plant, and a
    # CHECK forbids a Device being its own parent, but neither can see a longer
    # ring: A feeds B, B feeds C, C feeds A. `build_sld` survives that — it
    # detaches the ring and reports it — but the hierarchy editor makes the
    # mistake one drag away, and a diagram with pieces silently missing is a far
    # worse answer than "that would make MFM-01 feed into itself".
    if body.parent_device_id is not None and "parent_device_id" not in clear:
        rows = (await session.execute(text("""
            SELECT id, parent_device_id FROM devices WHERE plant_id = :plant_id
        """), {"plant_id": before.plant_id})).all()
        parents = {row.id: row.parent_device_id for row in rows}
        if would_create_cycle(parents, device_id, body.parent_device_id):
            target = (await session.execute(
                text("SELECT code FROM devices WHERE id = :id"),
                {"id": body.parent_device_id})).scalar()
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"{before.code} cannot feed into {target or body.parent_device_id}: "
                f"{target or 'that Device'} already feeds back into {before.code}, "
                f"directly or through others, and electricity cannot flow in a ring.",
            )

    # ── Refuse a Collector the Device's own topic contradicts ───────────────
    # Checked against the topic this Device will have *after* the request: one
    # PATCH may move a Device to a new topic and set the matching collector in
    # the same breath, and validating the old topic would refuse a pair that
    # ends up perfectly consistent.
    topic_after = (
        None if "source_address" in clear
        else (body.source_address or before.source_address)
    )
    collector_after = (
        None if "collector_code" in clear
        else (_clean_collector(body.collector_code) or before.collector_code)
    )
    if body.collector_code is not None or "collector_code" in clear \
            or body.source_address is not None or "source_address" in clear:
        await _refuse_collector_against_topic(
            session, device_code=before.code, topic=topic_after,
            collector=collector_after,
        )

    # ── Refuse an edge through the wall of an enclosure ──────────────────────
    # A Collector's outward connection belongs to the box, not to each occupant
    # (migration 0024). Checked against the collector each Device will have
    # *after* this request, not before: the same PATCH may move a Device into a
    # room and re-wire it, and validating the old value would refuse a pair that
    # ends up perfectly legal.
    if body.parent_device_id is not None and "parent_device_id" not in clear:
        child_collector = (
            None if "collector_code" in clear
            else (_clean_collector(body.collector_code) or before.collector_code)
        )
        parent = (await session.execute(text(
            "SELECT code, collector_code FROM devices WHERE id = :id"
        ), {"id": body.parent_device_id})).first()
        if parent is not None and crosses_collector_boundary(
            child_collector, parent.collector_code
        ):
            here = f"collector {child_collector}" if child_collector else "no collector"
            there = (f"collector {parent.collector_code}"
                     if parent.collector_code else "no collector")
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"{before.code} is in {here} and {parent.code} is in {there}, so "
                f"one cannot feed into the other. A collector is an enclosure: its "
                f"outward connection belongs to the collector itself, not to the "
                f"Devices inside it. Set the collector's own connection instead, "
                f"or move the two Devices into the same collector.",
            )

    def value(field: str, supplied: Any) -> Any:
        return None if field in clear else supplied

    try:
        row = (await session.execute(text("""
            UPDATE devices
               SET name = coalesce(:name, name),
                   serial_number = coalesce(:serial, serial_number),
                   block_id = CASE WHEN :clear_block THEN NULL
                                   ELSE coalesce(:block_id, block_id) END,
                   parent_device_id = CASE WHEN :clear_parent THEN NULL
                                           ELSE coalesce(:parent_id, parent_device_id) END,
                   reports_via_device_id =
                       CASE WHEN :clear_collector THEN NULL
                            ELSE coalesce(:collector_id, reports_via_device_id) END,
                   collector_code =
                       CASE WHEN :clear_collector_code THEN NULL
                            ELSE coalesce(CAST(:collector_code AS varchar(64)),
                                          collector_code) END,
                   source_address = CASE WHEN :clear_topic THEN NULL
                                         ELSE coalesce(:source_address, source_address) END,
                   expected_interval_s = coalesce(:interval_s, expected_interval_s),
                   rated_capacity_kw = coalesce(:capacity, rated_capacity_kw),
                   string_count = CASE WHEN :clear_strings THEN NULL
                                       ELSE coalesce(:string_count, string_count) END,
                   installed_on = coalesce(CAST(:installed_on AS date), installed_on),
                   sld_stage_override =
                       CASE WHEN :clear_stage THEN NULL
                            ELSE coalesce(CAST(:stage_override AS varchar(16)),
                                          sld_stage_override) END,
                   status = coalesce(:status, status)
             WHERE id = :id
            RETURNING id, code, name, status, block_id, parent_device_id,
                      reports_via_device_id, collector_code, source_address,
                      expected_interval_s, rated_capacity_kw, string_count,
                      sld_stage_override
        """), {
            "id": device_id, "name": body.name, "serial": body.serial_number,
            "block_id": value("block_id", body.block_id),
            "parent_id": value("parent_device_id", body.parent_device_id),
            "collector_id": value("reports_via_device_id", body.reports_via_device_id),
            "collector_code": None if "collector_code" in clear
                              else _clean_collector(body.collector_code),
            "source_address": value("source_address", body.source_address),
            "interval_s": body.expected_interval_s,
            "capacity": body.rated_capacity_kw,
            "string_count": value("string_count", body.string_count),
            "installed_on": body.installed_on, "status": body.status,
            "stage_override": value("sld_stage_override", body.sld_stage_override),
            "clear_stage": "sld_stage_override" in clear,
            "clear_block": "block_id" in clear,
            "clear_parent": "parent_device_id" in clear,
            "clear_collector": "reports_via_device_id" in clear,
            "clear_collector_code": "collector_code" in clear,
            "clear_topic": "source_address" in clear,
            "clear_strings": "string_count" in clear,
        })).first()
    except IntegrityError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"device {before.code!r} violates a constraint: "
            f"{_explain_integrity_error(exc)}",
        ) from exc
    assert row is not None

    # The resolver caches topic → Device with its bindings and constants for
    # 300s. Editing any of them without invalidating means ingest keeps decoding
    # against the old mapping for five minutes — long enough to look like the
    # edit silently failed.
    for topic in {before.source_address, row.source_address}:
        if topic:
            await invalidate_resolution(topic)

    await _audit(session, user, before.client_id, "device.update", device_id,
                 before=dict(before._mapping), after=dict(row._mapping))
    return dict(row._mapping)


@router.post("/devices/{device_id}/bindings/from-model")
async def rebind_from_model(
    device_id: int, session: SessionDep,
    replace: bool = Query(False, description="Discard existing bindings first."),
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Regenerate this Device's bindings from its Model's signal schedule.

    The operation to reach for after changing a Device's string count: raising a
    12-string Inverter to 24 adds the twelve new PV inputs without disturbing the
    corrections already made to the rest.

    `replace=true` discards existing bindings first, which also discards any
    per-Device scale or source-key correction — so it is opt-in, and the default
    adds without overwriting.
    """
    device = (await session.execute(
        text("SELECT client_id, source_address FROM devices WHERE id = :id"),
        {"id": device_id})).first()
    if device is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "device not found")

    result = await bind_from_model(session, device.client_id, device_id,
                                   replace=replace)
    if device.source_address:
        await invalidate_resolution(device.source_address)
    await _audit(session, user, device.client_id, "device.bindings.from_model",
                 device_id, after={**result, "replace": replace})
    return result


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
    *, after: dict[str, Any] | None = None, before: dict[str, Any] | None = None,
) -> None:
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id,
                               before, after)
        VALUES (:client_id, :user_id, :action, 'devices', :entity_id,
                CAST(:before AS jsonb), CAST(:after AS jsonb))
    """), {"client_id": client_id, "user_id": user.user_id, "action": action,
           "entity_id": entity_id,
           "before": json.dumps(before, default=str) if before else None,
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
