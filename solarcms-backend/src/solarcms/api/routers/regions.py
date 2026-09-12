"""Regions: the state or grid area a Plant belongs to (MASTER §1, §3.6).

Readable by every authenticated User — a Region is catalogue, not Client data —
and written by a Super Admin only, because the grid emission factor it carries
feeds every Plant's CO₂-avoided figure in that Region (tender §18).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, CurrentUserDep, SessionDep, require_permission
from solarcms.schemas.identity import RegionCreate, RegionUpdate

router = APIRouter(prefix="/regions", tags=["regions"])


@router.get("")
async def list_regions(session: SessionDep, _: CurrentUserDep) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT id, code, name, country, grid_emission_factor_kg_per_kwh, created_at
          FROM regions ORDER BY code
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_region(
    body: RegionCreate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Create a Region. Codes follow ISO 3166-2, e.g. `IN-UP` (MASTER §3.6).

    The emission factor is optional on purpose: it is a client-supplied number
    (OPEN-15 territory), and a Region without one simply yields no CO₂ figure
    rather than a wrong one.
    """
    existing = (await session.execute(
        text("SELECT id FROM regions WHERE code = :code"), {"code": body.code})).first()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"region code {body.code!r} already exists")

    row = (await session.execute(text("""
        INSERT INTO regions (code, name, country, grid_emission_factor_kg_per_kwh)
        VALUES (:code, :name, :country, :factor)
        RETURNING id, code, name, country, grid_emission_factor_kg_per_kwh, created_at
    """), {"code": body.code, "name": body.name, "country": body.country,
           "factor": body.grid_emission_factor_kg_per_kwh})).first()
    assert row is not None
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (NULL, :user_id, 'region.create', 'regions', :id, CAST(:after AS jsonb))
    """), {"user_id": user.user_id, "id": row.id,
           "after": json.dumps({"code": body.code, "name": body.name})})
    return dict(row._mapping)


@router.patch("/{region_id}")
async def update_region(
    region_id: int, body: RegionUpdate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    before = (await session.execute(text("""
        SELECT name, country, grid_emission_factor_kg_per_kwh FROM regions WHERE id = :id
    """), {"id": region_id})).first()
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "region not found")

    row = (await session.execute(text("""
        UPDATE regions
           SET name = coalesce(:name, name),
               country = coalesce(:country, country),
               grid_emission_factor_kg_per_kwh =
                   coalesce(:factor, grid_emission_factor_kg_per_kwh)
         WHERE id = :id
        RETURNING id, code, name, country, grid_emission_factor_kg_per_kwh, created_at
    """), {"id": region_id, "name": body.name, "country": body.country,
           "factor": body.grid_emission_factor_kg_per_kwh})).first()
    assert row is not None
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id,
                               before, after)
        VALUES (NULL, :user_id, 'region.update', 'regions', :id,
                CAST(:before AS jsonb), CAST(:after AS jsonb))
    """), {"user_id": user.user_id, "id": region_id,
           "before": json.dumps(dict(before._mapping), default=str),
           "after": json.dumps(body.model_dump(exclude_none=True), default=str)})
    return dict(row._mapping)
