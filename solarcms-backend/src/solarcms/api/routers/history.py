"""Performance History: one Plant's figures day by day and month by month.

`services/performance_history.py` reads and builds. Read-only, guarded by
`dashboard.view` alone like the other screens' reads (`api/pages.py`): the
same figures are in the Reports a User may download, and none of them is money.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.services.performance_history import plant_history

router = APIRouter(tags=["history"])


@router.get("/plants/{plant_id}/history")
async def get_plant_history(
    plant_id: int,
    session: SessionDep,
    from_date: date,
    to_date: date,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    """Each Plant-local day from `from_date` to `to_date` inclusive (at most 366),
    and each month they touch: energy, irradiation, specific yield, PR, peak and
    coverage, with the notes that say what each stands on."""
    try:
        payload = await plant_history(session, plant_id, from_date, to_date, datetime.now(UTC))
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if payload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    return payload
