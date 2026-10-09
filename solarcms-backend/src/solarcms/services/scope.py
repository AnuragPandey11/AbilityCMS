"""Resolve a Plant's Device and Tag ids *before* reading telemetry.

The load test (docs/CAPACITY_AND_DEPLOYMENT.md §4.9) found the most expensive
defect in the app: a query shaped

    FROM agg_1m_v a JOIN devices d ON d.id = a.device_id
    WHERE d.plant_id = :plant_id AND a.bucket >= :start

reads **every Plant's** rows in the window and discards the others only after
the join. The Plant filter sits on `devices`, outside the security-barrier
view, so the planner cannot push it into the scan, and the view's
`(device_id, bucket)` index is never used. One Plant's screen then slows with
every Plant added and every hour since midnight: 31 s for one statement at 50
Plants, and 0.042 s once the Device and Tag ids were passed in.

So every telemetry read takes its ids from here first — one cheap query on the
small, RLS-protected `devices` and `tags` tables — and filters the view with
`device_id = ANY(:device_ids)` and `tag_id = ANY(:tag_ids)`, which the planner
*can* push down (both are leakproof comparisons on view columns). The result
is identical: the same rows, found without reading the fleet's.

RLS still scopes the lookup: an API session sees only the Devices its caller
may see, so the ids handed on are already bounded by it, exactly as the join
was. The scheduler, which reads with platform privileges, passes `client_id`
(services/energy.py explains why).
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def device_ids(
    session: AsyncSession,
    *,
    plant_ids: Sequence[int] | None = None,
    block_id: int | None = None,
    client_id: int | None = None,
    type_codes: Iterable[str] | None = None,
    with_topic: bool = False,
) -> list[int]:
    """The ids of the Devices in scope, optionally only of some Device Types.

    `with_topic` leaves out Devices that have never had a topic — the Plant KPI
    panel, whose rows the scheduler writes — for questions about when the
    *equipment* reported.
    """
    if plant_ids is None and block_id is None and client_id is None:
        raise ValueError("device_ids needs plant_ids, block_id or client_id")
    where: list[str] = []
    params: dict[str, Any] = {}
    if plant_ids is not None:
        where.append("d.plant_id = ANY(:plant_ids)")
        params["plant_ids"] = list(plant_ids)
    if block_id is not None:
        where.append("d.block_id = :block_id")
        params["block_id"] = block_id
    if client_id is not None:
        where.append("d.client_id = :client_id")
        params["client_id"] = client_id
    if with_topic:
        where.append("d.source_address IS NOT NULL")
    join = ""
    if type_codes is not None:
        codes = sorted(set(type_codes))
        if not codes:
            return []
        join = ("JOIN device_models dm ON dm.id = d.device_model_id "
                "JOIN device_types dt ON dt.id = dm.device_type_id")
        where.append("dt.code = ANY(:type_codes)")
        params["type_codes"] = codes
    rows = (await session.execute(text(
        f"SELECT d.id FROM devices d {join} WHERE {' AND '.join(where)} ORDER BY d.id"
    ), params)).all()
    return [int(row.id) for row in rows]


async def tag_ids(session: AsyncSession, codes: Iterable[str]) -> list[int]:
    """The ids of the Tags with these codes. Unknown codes are simply absent."""
    wanted = sorted(set(codes))
    if not wanted:
        return []
    rows = (await session.execute(
        text("SELECT id FROM tags WHERE code = ANY(:codes) ORDER BY id"),
        {"codes": wanted})).all()
    return [int(row.id) for row in rows]


async def tag_ids_matching(session: AsyncSession, pattern: str) -> list[int]:
    """The ids of the Tags whose code matches a regular expression."""
    rows = (await session.execute(
        text("SELECT id FROM tags WHERE code ~ :pattern ORDER BY id"),
        {"pattern": pattern})).all()
    return [int(row.id) for row in rows]
