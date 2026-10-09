"""The Inverter ranking: every Inverter of a Plant over a period, side by side.

Generation, availability, PR, downtime and what the stops cost —
`services/inverter_ranking.py` has the rules (⚠ downtime PROPOSED). Read-only;
`dashboard.view`, as for the Inverter Monitoring screen it sits on.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.services.inverter_ranking import ranking

router = APIRouter(tags=["inverters"])


@router.get("/plants/{plant_id}/inverter-ranking")
async def get_inverter_ranking(
    plant_id: int, session: SessionDep,
    period: str = Query("today"),
    from_date: date | None = None,
    to_date: date | None = None,
    from_time: time | None = None,
    to_time: time | None = None,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    """Each Inverter's generation, availability, PR, downtime and loss.

    `period` is today, yesterday, last_7_days, last_30_days or custom (with
    `from_date` and `to_date`, the Plant's own dates, at most 31 days), as for
    the Report tables.
    """
    try:
        payload = await ranking(session, plant_id, period, datetime.now(UTC),
                                from_date, to_date, from_time, to_time)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if payload is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    return payload
