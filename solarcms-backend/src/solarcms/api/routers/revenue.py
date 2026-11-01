"""Revenue: exported energy times tariff per Plant, its trend, and every Plant side by side.

`services/revenue.py` reads, `domain/revenue.py` has the rules (⚠ PROPOSED).
Read-only. Money is shown only to someone given the Revenue tab
(`require_dashboard("revenue")`) — unlike the other screens' routes, which
need `dashboard.view` alone — because a tab is how an administrator decides
who sees what a Plant earns.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from solarcms.api.deps import CurrentUser, SessionDep, require_dashboard, require_permission
from solarcms.services.revenue import fleet_revenue, plant_revenue, revenue_trend

router = APIRouter(tags=["revenue"])

_GUARDS = [Depends(require_permission("dashboard.view")), Depends(require_dashboard("revenue"))]


@router.get("/revenue/plants", dependencies=_GUARDS)
async def get_fleet_revenue(
    session: SessionDep, period: str = Query("month"),
) -> dict[str, Any]:
    """Every visible active Plant's energy and revenue for today, month or year."""
    try:
        return await fleet_revenue(session, period, datetime.now(UTC))
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc


@router.get("/plants/{plant_id}/revenue", dependencies=_GUARDS)
async def get_plant_revenue(plant_id: int, session: SessionDep) -> dict[str, Any]:
    """Today, this month and this financial year: energy, revenue, expected and loss."""
    payload = await plant_revenue(session, plant_id, datetime.now(UTC))
    if payload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    return payload


@router.get("/plants/{plant_id}/revenue/trend", dependencies=_GUARDS)
async def get_revenue_trend(
    plant_id: int, session: SessionDep, granularity: str = Query("day"),
) -> dict[str, Any]:
    """Revenue per day (last 30), month (last 12) or financial year."""
    try:
        payload = await revenue_trend(session, plant_id, granularity, datetime.now(UTC))
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if payload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    return payload


__all__ = ["router", "CurrentUser"]
