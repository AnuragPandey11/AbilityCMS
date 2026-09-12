"""Plants, Blocks, KPIs and the Single Line Diagram."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.domain.formulas import (
    availability,
    co2_avoided_kg,
    cuf,
    performance_ratio,
    specific_yield,
)
from solarcms.domain.sld import SldDevice, build_sld
from solarcms.schemas.assets import (
    BlockCreate,
    BlockUpdate,
    DeviceCounts,
    PlantCreate,
    PlantUpdate,
)

router = APIRouter(prefix="/plants", tags=["plants"])
# Block routes addressed by their own id sit at /blocks/{id}, not under
# /plants — a Block id is globally unique and the caller may not know its
# Plant (BACKEND_SPEC §8.2).
blocks_router = APIRouter(prefix="/blocks", tags=["plants"])

async def _audit(
    session: Any, user: CurrentUser, action: str, entity_type: str, entity_id: int,
    *, before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
) -> None:
    """Write the audit row in the SAME transaction as the change (BACKEND_SPEC §8.3).

    Not after it: an audit written separately can succeed while the change rolls
    back, or the reverse, and either leaves the trail lying.
    """
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id,
                               before, after)
        VALUES (:client_id, :user_id, :action, :entity_type, :entity_id,
                CAST(:before AS jsonb), CAST(:after AS jsonb))
    """), {
        "client_id": user.client_id, "user_id": user.user_id, "action": action,
        "entity_type": entity_type, "entity_id": entity_id,
        "before": json.dumps(before, default=str) if before else None,
        "after": json.dumps(after, default=str) if after else None,
    })


async def _replace_device_counts(
    session: Any, client_id: int, plant_id: int, counts: DeviceCounts,
) -> dict[str, int]:
    """Set the planned Device count per Device Type, replacing what is there.

    Validated against the seeded `device_types` catalogue rather than a list in
    code, so a Device Type added by a later seed is accepted here the same day
    without touching this route (guardrail 2: no Device name becomes a code
    path).

    A count of zero is stored, not skipped. "This Plant has no Module Trackers"
    is a statement about the design; a missing row only says nobody filled it in.
    """
    if not counts:
        await session.execute(
            text("DELETE FROM plant_device_counts WHERE plant_id = :p"),
            {"p": plant_id})
        return {}

    known = {
        row.code: row.id for row in (await session.execute(
            text("SELECT id, code FROM device_types"))).all()
    }
    unknown = sorted(set(counts) - set(known))
    if unknown:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"unknown Device Type(s): {', '.join(unknown)}")
    negative = sorted(code for code, n in counts.items() if n < 0)
    if negative:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"Device count cannot be negative: {', '.join(negative)}")

    # Replace rather than merge: a Type removed from the design sheet must
    # disappear, and an upsert alone would strand it with no way to clear it.
    await session.execute(
        text("DELETE FROM plant_device_counts WHERE plant_id = :p"), {"p": plant_id})
    await session.execute(text("""
        INSERT INTO plant_device_counts (client_id, plant_id, device_type_id,
                                         planned_count)
        VALUES (:client_id, :plant_id, :device_type_id, :planned_count)
    """), [
        {"client_id": client_id, "plant_id": plant_id,
         "device_type_id": known[code], "planned_count": n}
        for code, n in sorted(counts.items())
    ])
    return dict(sorted(counts.items()))


async def _read_device_counts(session: Any, plant_id: int) -> list[dict[str, Any]]:
    """Planned counts beside the live registered count, per Device Type.

    Both figures together, because neither answers the question alone: `planned`
    is what the contract says the Plant has, `registered` is how many Devices
    actually exist, and commissioning progress is the difference.
    """
    rows = (await session.execute(text("""
        SELECT dt.code AS device_type_code, dt.name AS device_type_name,
               c.planned_count,
               (SELECT count(*) FROM devices d
                 WHERE d.plant_id = c.plant_id
                   AND d.device_model_id IN (SELECT id FROM device_models
                                              WHERE device_type_id = dt.id)
               ) AS registered_count
          FROM plant_device_counts c
          JOIN device_types dt ON dt.id = c.device_type_id
         WHERE c.plant_id = :plant_id
         ORDER BY dt.code
    """), {"plant_id": plant_id})).all()
    return [dict(row._mapping) for row in rows]


PERIODS = {"today": timedelta(days=1), "month": timedelta(days=30),
           "year": timedelta(days=365), "lifetime": timedelta(days=3650)}


@router.get("")
async def list_plants(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
    limit: int = Query(50, ge=1, le=200),
    cursor: int | None = None,
    status_filter: str | None = Query(None, alias="status"),
) -> dict[str, Any]:
    """RLS-filtered, paginated, sortable, filterable.

    No client_id predicate appears here on purpose: the policies supply it, and
    adding one in application code would suggest the isolation depends on
    remembering to write it.
    """
    rows = (await session.execute(text("""
        SELECT p.id, p.code, p.name, p.status, p.ac_capacity_kw, p.dc_capacity_kwp,
               r.code AS region_code,
               (SELECT count(*) FROM devices d WHERE d.plant_id = p.id) AS device_count
          FROM plants p LEFT JOIN regions r ON r.id = p.region_id
         WHERE (CAST(:cursor AS bigint) IS NULL OR p.id > :cursor)
           AND (CAST(:status AS text) IS NULL OR p.status = :status)
         ORDER BY p.id LIMIT :limit
    """), {"cursor": cursor, "status": status_filter, "limit": limit})).all()

    items = [dict(row._mapping) for row in rows]
    return {"items": items,
            "next_cursor": str(items[-1]["id"]) if len(items) == limit else None}


@router.get("/{plant_id}")
async def get_plant(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    row = (await session.execute(text("""
        SELECT p.*, r.code AS region_code,
               r.grid_emission_factor_kg_per_kwh AS grid_factor
          FROM plants p LEFT JOIN regions r ON r.id = p.region_id
         WHERE p.id = :plant_id
    """), {"plant_id": plant_id})).first()
    if row is None:
        # 404 whether the Plant does not exist or the caller cannot see it. RLS
        # already returned nothing; distinguishing the two would leak the
        # existence of another Client's Plant.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    return {**dict(row._mapping),
            "device_counts": await _read_device_counts(session, plant_id)}


@router.get("/{plant_id}/kpis")
async def plant_kpis(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
    period: str = Query("today", pattern="^(today|month|year|lifetime)$"),
) -> dict[str, Any]:
    """PR, CUF, availability, CO2 — each reported with the formula variant used.

    ⚠ Every figure here is provisional (OPEN-16). The variant travels with the
    value so that when the client's definitions arrive, historical figures can be
    identified and recomputed rather than silently superseded.
    """
    plant = (await session.execute(text("""
        SELECT p.dc_capacity_kwp, p.ac_capacity_kw,
               r.grid_emission_factor_kg_per_kwh AS grid_factor
          FROM plants p LEFT JOIN regions r ON r.id = p.region_id
         WHERE p.id = :plant_id
    """), {"plant_id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")

    now = datetime.now(UTC)
    start = now - PERIODS[period]

    # Energy from the export counter's endpoints, and irradiation from the WMS.
    # Aggregates, never raw readings (MASTER §6.6).
    energy = (await session.execute(text("""
        SELECT max(last_value) - min(last_value) AS delta
          FROM agg_1h_v a JOIN tags t ON t.id = a.tag_id
          JOIN devices d ON d.id = a.device_id
         WHERE d.plant_id = :plant_id AND t.code = 'ENERGY_EXPORT_TOTAL'
           AND a.bucket >= :start
    """), {"plant_id": plant_id, "start": start})).scalar()

    irradiation = (await session.execute(text("""
        SELECT max(last_value) AS total
          FROM agg_1h_v a JOIN tags t ON t.id = a.tag_id
          JOIN devices d ON d.id = a.device_id
         WHERE d.plant_id = :plant_id AND t.code = 'GHI_CUMULATIVE'
           AND a.bucket >= :start
    """), {"plant_id": plant_id, "start": start})).scalar()

    energy_kwh = float(energy or 0.0)
    dc_kwp = float(plant.dc_capacity_kwp or 0.0)
    ac_kw = float(plant.ac_capacity_kw or 0.0)
    hours = PERIODS[period].total_seconds() / 3600.0

    # GHI_CUMULATIVE is kWh/m2; performance_ratio wants Wh/m2 over the period.
    irradiation_wh = float(irradiation or 0.0) * 1000.0

    pr = performance_ratio(energy_kwh, irradiation_wh, dc_kwp)
    cuf_result = cuf(energy_kwh, ac_kw, hours)
    co2 = co2_avoided_kg(
        energy_kwh,
        float(plant.grid_factor) if plant.grid_factor is not None else None,
    )

    uptime = (await session.execute(text("""
        SELECT count(*) FILTER (WHERE comm_status = 'online')::float
             / NULLIF(count(*), 0) AS ratio
          FROM device_health WHERE plant_id = :plant_id
    """), {"plant_id": plant_id})).scalar()
    avail = availability(float(uptime or 0.0) * hours * 3600, hours * 3600)

    def render(result: Any) -> dict[str, Any]:
        return {"value": result.value, "variant": result.variant,
                "undefined_reason": result.undefined_reason}

    return {
        "plant_id": plant_id, "period": period,
        "energy_kwh": energy_kwh,
        "performance_ratio": render(pr),
        "cuf": render(cuf_result),
        "availability": render(avail),
        "co2_avoided_kg": render(co2),
        "assumptions_note": (
            "All KPI formulas are provisional pending OPEN-16. The client's own "
            "definitions may differ by percentage points."
        ),
    }


@router.get("/{plant_id}/sld")
async def plant_sld(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    """The electrical tree. Power path only; Blocks never appear (Guardrail 11)."""
    rows = (await session.execute(text("""
        SELECT d.id, d.code, d.name, d.parent_device_id, d.rated_capacity_kw,
               dt.code AS type_code, dt.in_power_path, dm.variant
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
    """), {"plant_id": plant_id})).all()

    tree = build_sld([
        SldDevice(
            device_id=r.id, code=r.code, name=r.name, device_type_code=r.type_code,
            in_power_path=r.in_power_path, parent_device_id=r.parent_device_id,
            variant=r.variant,
            rated_capacity_kw=float(r.rated_capacity_kw) if r.rated_capacity_kw else None,
        ) for r in rows
    ])

    def serialise(node: Any) -> dict[str, Any]:
        return {
            "device_id": node.device.device_id, "code": node.device.code,
            "name": node.device.name, "type": node.device.device_type_code,
            "variant": node.device.variant,
            "children": [serialise(child) for child in node.children],
        }

    return {
        "plant_id": plant_id,
        "roots": [serialise(root) for root in tree.roots],
        "device_count": tree.device_count,
        # Returned rather than dropped: these Devices are real and monitored, they
        # simply carry no current, and the caller still has to show them somewhere.
        "excluded_not_in_power_path": [
            {"device_id": d.device_id, "code": d.code, "type": d.device_type_code}
            for d in tree.excluded_not_in_power_path
        ],
        "orphaned": [{"device_id": d.device_id, "code": d.code} for d in tree.orphaned],
    }


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_plant(
    body: PlantCreate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Create a Plant in `draft`.

    Held by a Client Admin per F-15 — and scoped to their own Client by
    construction: `client_id` comes from the session context, never from the
    request, so a Client Admin cannot create a Plant under another Client (I-9).
    """
    if user.client_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "a Client context is required to create a Plant")

    region_id = None
    if body.region_code:
        region_id = (await session.execute(
            text("SELECT id FROM regions WHERE code = :code"),
            {"code": body.region_code})).scalar()
        if region_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"unknown region {body.region_code!r}")

    existing = (await session.execute(
        text("SELECT id FROM plants WHERE client_id = :c AND code = :code"),
        {"c": user.client_id, "code": body.code})).first()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"plant code {body.code!r} already exists for this Client")

    row = (await session.execute(text("""
        INSERT INTO plants (client_id, region_id, code, name, status, ac_capacity_kw,
                            dc_capacity_kwp, latitude, longitude, timezone,
                            commissioned_on)
        VALUES (:client_id, :region_id, :code, :name, 'draft', :ac, :dc, :lat, :lon,
                :tz, :commissioned_on)
        RETURNING id, code, name, status
    """), {
        "client_id": user.client_id, "region_id": region_id, "code": body.code,
        "name": body.name, "ac": body.ac_capacity_kw, "dc": body.dc_capacity_kwp,
        "lat": body.latitude, "lon": body.longitude, "tz": body.timezone,
        "commissioned_on": body.commissioned_on,
    })).first()
    assert row is not None
    # Same transaction as the Plant: a Plant that exists with its design sheet
    # half-written is worse than one that failed to be created at all.
    counts = await _replace_device_counts(
        session, user.client_id, row.id, body.device_counts or {})
    await _audit(session, user, "plant.create", "plants", row.id,
                 after={"code": body.code, "name": body.name,
                        "device_counts": counts})
    return {**dict(row._mapping), "device_counts": counts}


@router.patch("/{plant_id}")
async def update_plant(
    plant_id: int, body: PlantUpdate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    before = (await session.execute(
        text("SELECT client_id, code, name, status FROM plants WHERE id = :id"),
        {"id": plant_id})).first()
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")

    region_id = None
    if body.region_code is not None:
        region_id = (await session.execute(
            text("SELECT id FROM regions WHERE code = :code"),
            {"code": body.region_code})).scalar()
        if region_id is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"unknown region {body.region_code!r}")

    row = (await session.execute(text("""
        UPDATE plants
           SET name = coalesce(:name, name),
               status = coalesce(:status, status),
               region_id = coalesce(:region_id, region_id),
               ac_capacity_kw = coalesce(:ac, ac_capacity_kw),
               dc_capacity_kwp = coalesce(:dc, dc_capacity_kwp),
               latitude = coalesce(:lat, latitude),
               longitude = coalesce(:lon, longitude),
               commissioned_on = coalesce(CAST(:commissioned_on AS date),
                                          commissioned_on)
         WHERE id = :id
        RETURNING id, code, name, status
    """), {"id": plant_id, "name": body.name, "status": body.status,
           "region_id": region_id, "ac": body.ac_capacity_kw,
           "dc": body.dc_capacity_kwp, "lat": body.latitude, "lon": body.longitude,
           "commissioned_on": body.commissioned_on})).first()
    assert row is not None

    # `is not None`, not truthiness: `{}` means "this Plant has no planned
    # Devices", which must clear the set. Omitting the field entirely leaves it
    # alone, which is what a PATCH of the name should do.
    after: dict[str, Any] = dict(row._mapping)
    if body.device_counts is not None:
        after["device_counts"] = await _replace_device_counts(
            session, before.client_id, plant_id, body.device_counts)

    await _audit(session, user, "plant.update", "plants", plant_id,
                 before={k: v for k, v in before._mapping.items() if k != "client_id"},
                 after=after)
    return after


@router.get("/{plant_id}/blocks")
async def list_blocks(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    """Blocks with their capacity. Empty array when the Plant has none (§2.2)."""
    rows = (await session.execute(text("""
        SELECT b.id, b.code, b.name, b.capacity_kwp,
               (SELECT count(*) FROM devices d WHERE d.block_id = b.id) AS device_count
          FROM blocks b WHERE b.plant_id = :plant_id ORDER BY b.code
    """), {"plant_id": plant_id})).all()
    return [dict(row._mapping) for row in rows]


@router.post("/{plant_id}/blocks", status_code=status.HTTP_201_CREATED)
async def create_block(
    plant_id: int, body: BlockCreate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    plant = (await session.execute(
        text("SELECT client_id FROM plants WHERE id = :id"), {"id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")

    duplicate = (await session.execute(
        text("SELECT id FROM blocks WHERE plant_id = :p AND code = :code"),
        {"p": plant_id, "code": body.code})).first()
    if duplicate is not None:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"block code {body.code!r} already exists in this Plant")

    row = (await session.execute(text("""
        INSERT INTO blocks (client_id, plant_id, code, name, capacity_kwp)
        VALUES (:client_id, :plant_id, :code, :name, :capacity_kwp)
        RETURNING id, code, name, capacity_kwp
    """), {"client_id": plant.client_id, "plant_id": plant_id, "code": body.code,
           "name": body.name, "capacity_kwp": body.capacity_kwp})).first()
    assert row is not None
    await _audit(session, user, "block.create", "blocks", row.id,
                 after={"code": body.code, "capacity_kwp": body.capacity_kwp})
    return dict(row._mapping)


@blocks_router.patch("/{block_id}")
async def update_block(
    block_id: int, body: BlockUpdate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    row = (await session.execute(text("""
        UPDATE blocks SET name = coalesce(:name, name),
                          capacity_kwp = coalesce(:capacity, capacity_kwp)
         WHERE id = :id
        RETURNING id, code, name, capacity_kwp
    """), {"id": block_id, "name": body.name, "capacity": body.capacity_kwp})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "block not found")
    await _audit(session, user, "block.update", "blocks", block_id,
                 after=dict(row._mapping))
    return dict(row._mapping)


@blocks_router.delete("/{block_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_block(
    block_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> Response:
    """Delete a Block.

    Refused while Devices still reference it. A Block is optional and Devices
    attach directly to the Plant without one (§2.2), so the safe resolution is to
    clear `block_id` on those Devices first — doing it implicitly here would move
    equipment out of a zone as a side effect of a delete.
    """
    attached = (await session.execute(
        text("SELECT count(*) FROM devices WHERE block_id = :id"),
        {"id": block_id})).scalar()
    if attached:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{attached} Device(s) are still in this Block; clear their block_id first",
        )
    row = (await session.execute(
        text("DELETE FROM blocks WHERE id = :id RETURNING id, code"),
        {"id": block_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "block not found")
    await _audit(session, user, "block.delete", "blocks", block_id,
                 before={"code": row.code})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@blocks_router.get("/{block_id}/kpis")
async def block_kpis(
    block_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
    period: str = Query("today", pattern="^(today|month|year|lifetime)$"),
) -> dict[str, Any]:
    """Per-Block KPIs, scaled to `blocks.capacity_kwp`.

    This is why capacity is NOT NULL on a Block: a Client who defines zones wants
    zone-level performance, and PR is meaningless without the capacity to divide
    by (MASTER §2.2).
    """
    block = (await session.execute(text("""
        SELECT b.id, b.plant_id, b.capacity_kwp FROM blocks b WHERE b.id = :id
    """), {"id": block_id})).first()
    if block is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "block not found")

    now = datetime.now(UTC)
    start = now - PERIODS[period]
    energy = (await session.execute(text("""
        SELECT max(a.last_value) - min(a.last_value)
          FROM agg_1h_v a JOIN tags t ON t.id = a.tag_id
          JOIN devices d ON d.id = a.device_id
         WHERE d.block_id = :block_id AND t.code = 'ENERGY_EXPORT_TOTAL'
           AND a.bucket >= :start
    """), {"block_id": block_id, "start": start})).scalar()

    energy_kwh = float(energy or 0.0)
    yield_result = specific_yield(energy_kwh, float(block.capacity_kwp))
    return {
        "block_id": block_id, "period": period,
        "capacity_kwp": float(block.capacity_kwp),
        "energy_kwh": energy_kwh,
        "specific_yield": {"value": yield_result.value, "variant": yield_result.variant,
                           "undefined_reason": yield_result.undefined_reason},
        "assumptions_note": "Provisional pending OPEN-16.",
    }
