"""Plants, Blocks, KPIs and the Single Line Diagram."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.cache import live
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
    PlantStatusChange,
    PlantUpdate,
)
from solarcms.services import dashboard

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


@router.get("/{plant_id}/dashboard")
async def plant_dashboard(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    """The fixed dashboard, resolved against whatever this Plant actually has.

    Same panels, same positions, every Plant. What differs between an 8 MW Plant
    with a settlement meter and a rooftop array publishing four Inverters is only
    which Device answers each slot — and every resolved value carries that
    provenance, so a tile can say whether it was measured or summed.
    """
    exists = (await session.execute(
        text("SELECT 1 FROM plants WHERE id = :plant_id"), {"plant_id": plant_id}
    )).first()
    if exists is None:
        # RLS makes an invisible Plant indistinguishable from a missing one here,
        # which is the intended behaviour: 404 leaks nothing about another Client.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    return await dashboard.render(session, plant_id)


@router.get("/{plant_id}/sld-stages")
async def plant_sld_stages(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    """The four-stage schematic: PV Array → Inverters → Transformer → Grid.

    Always those four, always in that order, whatever the Plant contains — an
    operator comparing two Plants cannot do it across two differently-shaped
    diagrams. Every power-path Device folds into one stage by its Device Type
    (`device_types.sld_stage`), and a stage with nothing in it still renders,
    marked not instrumented.

    `GET /plants/{id}/sld` remains the true `parent_device_id` tree, which is
    what you want when something is wrong and you need to know *which* Inverter.
    """
    rendered = await dashboard.render(session, plant_id)
    return {"plant_id": plant_id, **rendered["sld"]}


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


@router.get("/{plant_id}/commissioning")
async def commissioning_readiness(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    """What still stands between this Plant and going live.

    Onboarding fails quietly, not loudly: a Device with no topic simply never
    reports, a Device with no bindings decodes nothing, and both look exactly
    like equipment that has not been switched on yet. This turns each of those
    into a named, countable item, so that "the Plant is ready" is a check rather
    than an opinion.

    Read-only and advisory. Moving the Plant to `active` consults it, but an
    operator who knows better can still force the transition.
    """
    plant = (await session.execute(text("""
        SELECT id, code, name, status, ac_capacity_kw, dc_capacity_kwp, region_id
          FROM plants WHERE id = :id
    """), {"id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")

    devices = (await session.execute(text("""
        SELECT d.id, d.code, d.name, d.source_address, d.string_count,
               d.rated_capacity_kw, dt.code AS type_code, dt.in_power_path,
               dm.variant, d.parent_device_id,
               COALESCE(h.comm_status, 'unknown') AS comm_status,
               (SELECT count(*) FROM device_tag_bindings b
                 WHERE b.device_id = d.id AND b.enabled) AS binding_count,
               (SELECT count(*) FROM device_model_tags mt
                  JOIN tags t ON t.id = mt.tag_id
                 WHERE mt.device_model_id = d.device_model_id
                   AND t.formula IS NULL
                   AND (mt.repeat_index IS NULL
                        OR mt.repeat_index <= COALESCE(d.string_count, 0))
               ) AS expected_binding_count
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
         ORDER BY d.code
    """), {"plant_id": plant_id})).all()

    issues: list[dict[str, Any]] = []

    def flag(severity: str, code: str, detail: str, **extra: Any) -> None:
        issues.append({"severity": severity, "code": code, "detail": detail, **extra})

    if not devices:
        flag("blocking", "no_devices",
             "No Devices are registered, so nothing can report.")
    if plant.dc_capacity_kwp is None:
        # PR divides by it. Without it the KPI is undefined rather than wrong,
        # which is correct behaviour and a blank tile nobody can explain.
        flag("blocking", "no_dc_capacity",
             "DC capacity is not set, so Performance Ratio cannot be computed.")
    if plant.ac_capacity_kw is None:
        flag("warning", "no_ac_capacity",
             "AC capacity is not set, so CUF cannot be computed.")
    if plant.region_id is None:
        flag("warning", "no_region",
             "No Region, so the grid emission factor falls back to the national "
             "average in CO2 figures.")

    kpi_devices = [d for d in devices if d.type_code == "PLANT_KPI"]
    if not kpi_devices:
        flag("warning", "no_kpi_panel",
             "This Plant has no KPI panel Device, so PR, CUF and peak power have "
             "nowhere to be written. Re-run the seed to create one.")

    unmapped_total = 0
    for device in devices:
        if device.type_code == "PLANT_KPI":
            continue  # computed, never published to: it needs no topic or binding
        if not device.source_address:
            flag("blocking", "device_without_topic",
                 f"{device.code} has no MQTT topic, so nothing can be attributed "
                 f"to it.", device_id=device.id, device_code=device.code)
        if device.binding_count == 0:
            flag("blocking", "device_without_bindings",
                 f"{device.code} has no Tag bindings, so its payload decodes to "
                 f"nothing.", device_id=device.id, device_code=device.code)
        elif device.binding_count < device.expected_binding_count:
            flag("warning", "device_partially_bound",
                 f"{device.code} has {device.binding_count} of "
                 f"{device.expected_binding_count} Tags bound.",
                 device_id=device.id, device_code=device.code)
        if device.comm_status in ("offline", "unknown"):
            flag("warning", "device_never_heard",
                 f"{device.code} has not been heard from "
                 f"({device.comm_status}).",
                 device_id=device.id, device_code=device.code)
        if device.type_code == "INVERTER" and not device.rated_capacity_kw:
            flag("warning", "inverter_without_capacity",
                 f"{device.code} has no rated capacity, so its specific yield "
                 f"cannot be computed.", device_id=device.id,
                 device_code=device.code)
        if device.in_power_path and device.parent_device_id is None:
            # Not blocking: exactly one Device in the power path — the one that
            # meets the grid — legitimately has no parent. Several is a diagram
            # of disconnected fragments.
            flag("info", "device_without_parent",
                 f"{device.code} feeds into nothing, so it is a root of the "
                 f"Single Line Diagram.", device_id=device.id,
                 device_code=device.code)

        keys = await live.read_unmapped_keys(device.id)
        if keys:
            unmapped_total += len(keys)
            flag("warning", "device_unmapped_keys",
                 f"{device.code} is publishing {len(keys)} signal(s) that no "
                 f"binding maps: {', '.join(keys[:8])}"
                 f"{'…' if len(keys) > 8 else ''}",
                 device_id=device.id, device_code=device.code, keys=keys)

    roots = [d for d in devices if d.in_power_path and d.parent_device_id is None]
    if len(roots) > 1:
        flag("warning", "multiple_sld_roots",
             f"{len(roots)} Devices in the power path have no parent, so the "
             f"Single Line Diagram will render as {len(roots)} separate trees.")

    blocking = [i for i in issues if i["severity"] == "blocking"]
    return {
        "plant_id": plant.id, "status": plant.status,
        "device_count": len(devices),
        "unmapped_key_count": unmapped_total,
        "ready": not blocking,
        "blocking_count": len(blocking),
        "issues": issues,
        # What each status means, so the screen does not have to restate it.
        "next_status": _next_status(plant.status),
    }


def _next_status(current: str) -> str | None:
    return {"draft": "commissioning", "commissioning": "active"}.get(current)


@router.post("/{plant_id}/status")
async def change_plant_status(
    plant_id: int, body: PlantStatusChange, session: SessionDep,
    user: CurrentUser = Depends(require_permission("plant.manage")),
) -> dict[str, Any]:
    """Move a Plant along `draft → commissioning → active` (MASTER §6.5).

    Its own route rather than a PATCH field, because a transition is not an edit.
    Going `active` publishes the Plant into every Portfolio total the Client sees
    — a half-mapped Plant dragging fleet PR down is the exact failure the status
    exists to prevent — so the readiness checks run first and a failure must be
    overridden deliberately with `force`.
    """
    plant = (await session.execute(
        text("SELECT id, code, status FROM plants WHERE id = :id"),
        {"id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")

    if body.status == plant.status:
        return {"plant_id": plant_id, "status": plant.status, "changed": False}

    readiness = await commissioning_readiness(plant_id, session, user)
    if body.status == "active" and not readiness["ready"] and not body.force:
        # A plain sentence, not a structured payload. The error handler renders
        # `detail` as a string, so a dict arrives at the browser as a Python repr
        # — and the caller does not need the issues here anyway: the readiness
        # endpoint is what the panel lists them from, in full, with remedies.
        blocking = [i for i in readiness["issues"] if i["severity"] == "blocking"]
        summary = "; ".join(i["detail"] for i in blocking[:3])
        if len(blocking) > 3:
            summary += f"; and {len(blocking) - 3} more"
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{len(blocking)} blocking issue(s) must be resolved before this Plant "
            f"can go active, or activate anyway to override. {summary}",
        )

    # ⚠ Both uses of :status are CAST, and neither is decorative. The column is
    # varchar(32) and the comparison literal is text, so asyncpg deduces two
    # different types for one parameter and refuses the statement outright:
    # "inconsistent types deduced for parameter $1". Same family as the `IS NULL`
    # inference trap already recorded in CLAUDE.md, and the same remedy — an
    # explicit CAST, since `:param::type` collides with SQLAlchemy's bind syntax.
    row = (await session.execute(text("""
        UPDATE plants SET status = CAST(:status AS text),
               commissioned_on = CASE
                   WHEN CAST(:status AS text) = 'active' AND commissioned_on IS NULL
                   THEN CURRENT_DATE ELSE commissioned_on END
         WHERE id = :id
        RETURNING id, code, name, status, commissioned_on
    """), {"id": plant_id, "status": body.status})).first()
    assert row is not None

    await _audit(session, user, "plant.status", "plants", plant_id,
                 before={"status": plant.status},
                 after={"status": body.status, "forced": body.force,
                        "note": body.note,
                        "blocking_issues": readiness["blocking_count"]})
    changed: dict[str, Any] = dict(row._mapping)
    changed.update(changed=True, forced=body.force,
                   blocking_issues_at_change=readiness["blocking_count"])
    return changed


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
