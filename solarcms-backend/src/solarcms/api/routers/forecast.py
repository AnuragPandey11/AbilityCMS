"""A Plant's forecast: next 15 minutes and hour, the rest of today, tomorrow, the
week ahead, and how the method did against what happened.

From the Plant's own history only — no weather forecast (the user's choice, 8
Oct 2026); `domain/forecast.py` has the method and `services/forecast.py` the
facts. Read-only; `dashboard.view`, as for the figures it sits beside.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.services.forecast import plant_forecast

router = APIRouter(tags=["forecast"])


@router.get("/plants/{plant_id}/forecast")
async def get_forecast(
    plant_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    payload = await plant_forecast(session, plant_id, datetime.now(UTC))
    if payload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    return payload
