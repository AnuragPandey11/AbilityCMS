"""History queries, tier-routed. Export.

BACKEND_SPEC §9. Pick the coarsest tier that both covers the range and still
retains it, then read the column matching each Tag's `rollup_method`. Averaging a
cumulative energy counter is meaningless — the mapping is data, not code.

Every query here goes through the `_v` barrier views. The API role holds no
privilege on the base tables at all (migration 0008/0010), so a query written
against `readings` directly fails loudly rather than quietly returning another
Client's rows.
"""

from __future__ import annotations

import csv
import io
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.domain.tiering import Tier, estimated_points, select_tier, value_column

router = APIRouter(tags=["readings"])

# A chart cannot draw more than a few thousand points and a browser should not be
# asked to receive more. Refused before the query runs, not after.
MAX_POINTS = 20_000


def _resolve_tier(start: datetime, end: datetime, resolution: str) -> Tier:
    if resolution == "auto":
        return select_tier(start, end, datetime.now(UTC))
    try:
        return Tier(resolution)
    except ValueError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"unknown resolution {resolution!r}; expected auto or one of "
            f"{[t.value for t in Tier]}",
        ) from exc


async def _query(
    session: Any, tier: Tier, device_ids: list[int], tag_ids: list[int] | None,
    start: datetime, end: datetime,
) -> list[dict[str, Any]]:
    params: dict[str, Any] = {"device_ids": device_ids, "start": start, "end": end,
                              "tag_ids": tag_ids}
    if tier is Tier.READINGS:
        rows = (await session.execute(text("""
            SELECT r.time AS bucket, r.device_id, r.tag_id, t.code AS tag_code,
                   r.value, r.quality
              FROM readings_v r JOIN tags t ON t.id = r.tag_id
             WHERE r.device_id = ANY(:device_ids)
               AND (CAST(:tag_ids AS bigint[]) IS NULL OR r.tag_id = ANY(:tag_ids))
               AND r.time >= :start AND r.time < :end
             ORDER BY r.time
        """), params)).all()
        return [dict(row._mapping) for row in rows]

    # The aggregate tiers store avg/min/max/last/count; which one is correct
    # depends on the Tag, so the value column is chosen per row rather than per
    # query. CASE keeps that to a single pass.
    rows = (await session.execute(text(f"""
        SELECT a.bucket, a.device_id, a.tag_id, t.code AS tag_code,
               CASE t.rollup_method
                    WHEN 'last' THEN a.{value_column('last')}
                    WHEN 'max'  THEN a.{value_column('max')}
                    ELSE             a.{value_column('avg')}
               END AS value,
               a.avg_value, a.min_value, a.max_value, a.last_value, a.sample_count,
               a.worst_quality AS quality, t.rollup_method
          FROM {tier.value}_v a JOIN tags t ON t.id = a.tag_id
         WHERE a.device_id = ANY(:device_ids)
           AND (CAST(:tag_ids AS bigint[]) IS NULL OR a.tag_id = ANY(:tag_ids))
           AND a.bucket >= :start AND a.bucket < :end
         ORDER BY a.bucket
    """), params)).all()
    return [dict(row._mapping) for row in rows]


@router.get("/readings")
async def get_readings(
    session: SessionDep,
    device_ids: list[int] = Query(...),
    start: datetime = Query(..., alias="from"),
    end: datetime = Query(..., alias="to"),
    tag_ids: list[int] | None = Query(None),
    resolution: str = Query("auto"),
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> dict[str, Any]:
    if end <= start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "`to` must follow `from`")
    tier = _resolve_tier(start, end, resolution)

    estimate = estimated_points(start, end, tier) * max(len(device_ids), 1) * \
        max(len(tag_ids or []), 1)
    if estimate > MAX_POINTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            f"query would return roughly {estimate} points, above the {MAX_POINTS} "
            f"limit; narrow the range, the devices, or pass a coarser resolution",
        )

    rows = await _query(session, tier, device_ids, tag_ids, start, end)
    return {
        "tier": tier.value,
        # Returned so a caller can tell a gap in data from a gap in retention —
        # a six-hour window two months ago is served from an aggregate because
        # raw was dropped at thirty days, not because nothing was recorded.
        "resolution_requested": resolution,
        "from": start, "to": end, "count": len(rows), "items": rows,
    }


@router.get("/readings/export")
async def export_readings(
    session: SessionDep,
    device_ids: list[int] = Query(...),
    start: datetime = Query(..., alias="from"),
    end: datetime = Query(..., alias="to"),
    tag_ids: list[int] | None = Query(None),
    resolution: str = Query("auto"),
    _: CurrentUser = Depends(require_permission("data.export")),
) -> StreamingResponse:
    """CSV export. Separate permission from viewing (MASTER §4.3)."""
    tier = _resolve_tier(start, end, resolution)
    rows = await _query(session, tier, device_ids, tag_ids, start, end)

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["time", "device_id", "tag_id", "tag_code", "value", "quality"])
    for row in rows:
        writer.writerow([
            row["bucket"].isoformat(), row["device_id"], row["tag_id"],
            row["tag_code"], row["value"], row["quality"],
        ])
    buffer.seek(0)
    filename = f"readings_{tier.value}_{start:%Y%m%d}_{end:%Y%m%d}.csv"
    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
