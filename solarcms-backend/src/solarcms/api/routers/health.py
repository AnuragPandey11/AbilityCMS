"""Device Health, and system health for the platform operator."""

from __future__ import annotations

import hmac
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, get_current_user, require_permission
from solarcms.cache import keys
from solarcms.cache.live import get_redis
from solarcms.config import get_settings
from solarcms.services.metrics import render_metrics
from solarcms.services.platform_health import platform_health

router = APIRouter(prefix="/health", tags=["health"])


@router.get("/devices")
async def device_health(
    session: SessionDep, plant_id: int | None = None,
    _: CurrentUser = Depends(require_permission("dashboard.view")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT h.device_id, d.code AS device_code, h.plant_id, h.comm_status,
               h.last_seen_at, h.frozen_tag_count, h.completeness_24h, h.updated_at,
               d.expected_interval_s, d.reports_via_device_id
          FROM device_health h JOIN devices d ON d.id = h.device_id
         WHERE (CAST(:plant_id AS bigint) IS NULL OR h.plant_id = :plant_id)
         ORDER BY h.comm_status, d.code
    """), {"plant_id": plant_id})).all()
    return [dict(row._mapping) for row in rows]


@router.get("/processes")
async def platform_processes(
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Is each SolarCMS process running, working, and connected to the broker?

    From the processes' own heartbeats, in Redis only — so it still answers when
    the database is the thing that is down, and it is cheap enough for the
    header to ask every few seconds. Verdicts are `domain/system_health.py`'s.
    """
    return await platform_health()


@router.get("/system")
async def system_health(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Ingest lag, aggregate freshness and queue depth.

    Ingest lag is measured as the age of the newest Reading. It is the one number
    that distinguishes "nothing is generating" from "nothing is arriving", and
    the two look identical on every other dashboard.
    """
    # readings_v, never `readings`. The API holds no privilege on the base table
    # (migration 0008), which is what caught this query being written against it
    # in the first place.
    #
    # Bounded, newest window first: `max(time)` over the barrier view cannot
    # become an ordered LIMIT 1, so unbounded it read every Reading in
    # retention — 4.6 s at 50 Plants (docs/CAPACITY_AND_DEPLOYMENT.md §4.11).
    # Two hours answers a working system at once; a week is read only when
    # nothing arrived in two hours, which is itself the news.
    ingest_lag = None
    for window in ("2 hours", "7 days"):
        ingest_lag = (await session.execute(text(f"""
            SELECT extract(epoch FROM now() - max(time)) FROM readings_v
             WHERE time > now() - interval '{window}'
        """))).scalar()
        if ingest_lag is not None:
            break
    quarantined = (await session.execute(text("""
        SELECT count(*) FROM mqtt_raw_v
         WHERE quarantined AND time > now() - interval '1 hour'
    """))).scalar()

    # Whether each continuous aggregate is still being refreshed. A stalled
    # aggregate is invisible on every other dashboard — the data simply stops
    # arriving in the tier that serves week and month views, while raw looks fine.
    aggregates = (await session.execute(text("""
        SELECT view_name,
               (SELECT max(last_successful_finish)
                  FROM timescaledb_information.job_stats js
                  JOIN timescaledb_information.jobs j USING (job_id)
                 WHERE j.hypertable_name = ca.materialization_hypertable_name
               ) AS last_refresh
          FROM timescaledb_information.continuous_aggregates ca
         ORDER BY view_name
    """))).all()

    # The alarm worker's input: its length (read and unread), and below it the
    # backlog — a growing backlog means alarm evaluation is falling behind
    # ingestion, the one lag that matters for how soon an Alarm opens.
    stream_depth = await get_redis().xlen(keys.STREAM_READINGS)
    # ⚠ The length is not the backlog: the stream keeps up to STREAM_MAXLEN
    # entries after they are read, so a fully caught-up worker showed "21,033"
    # and read as 21,000 readings behind. The group's lag (not yet delivered)
    # plus pending (delivered, not acknowledged) is what is actually waiting.
    backlog: int | None = None
    try:
        for group in await get_redis().xinfo_groups(keys.STREAM_READINGS):
            if group.get("name") == keys.STREAM_READINGS_GROUP:
                # Its own name: this once reused `lag`, so "ingest lag" on the
                # page reported the alarm group's lag instead.
                group_lag = group.get("lag")
                backlog = (None if group_lag is None
                           else int(group_lag) + int(group.get("pending") or 0))
    except Exception:
        # No group yet (the alarm worker has never run) — nothing to measure.
        backlog = None

    return {
        # None: nothing stored in the last week.
        "ingest_lag_seconds": float(ingest_lag) if ingest_lag is not None else None,
        "quarantined_last_hour": quarantined,
        "alarm_stream_depth": stream_depth,
        "alarm_backlog": backlog,
        "continuous_aggregates": [
            {"view": row.view_name, "last_refresh": row.last_refresh}
            for row in aggregates
        ],
    }


@router.get("/metrics", response_class=Response)
async def metrics(authorization: Annotated[str | None, Header()] = None) -> Response:
    """Process health in Prometheus' text format, for a monitoring agent (§6.6).

    Queue depths, save times, pass durations against their intervals, and the
    alarm backlog — the figures that show a slow decline before it becomes an
    outage (docs/CAPACITY_AND_DEPLOYMENT.md §6.6). From Redis only, like
    `/health/processes`, so it still answers with the database down.

    Allowed with the `METRICS_TOKEN` bearer token, for an agent that has no
    user login, or to a signed-in platform administrator.
    """
    token = get_settings().metrics_token
    presented = (authorization or "").removeprefix("Bearer ").removeprefix("bearer ")
    if not (token and presented and hmac.compare_digest(presented, token.get_secret_value())):
        user = await get_current_user(authorization)
        if "system.admin" not in user.permissions:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "permission system.admin required")
    return Response(await render_metrics(), media_type="text/plain; version=0.0.4")
