"""Each Plant's KPIs and dashboard, worked out on a timer and read by screens.

docs/CAPACITY_AND_DEPLOYMENT.md §4.4: today's figures re-read the Plant's whole
day on every request, the Plant screen asked after every live frame, and the
Portfolio asked for every Plant's KPIs and dashboard every 10 s. The database
cost therefore grew with every viewer, every Plant and every hour since
midnight. Now:

* the scheduler works out each Plant's dashboard every `DASHBOARD_INTERVAL_S`
  and its four KPI periods every `KPI_INTERVAL_S` (once a minute, the user's
  choice on 9 Oct 2026), with the *same functions the API called*
  (`services/kpis.compute_plant_kpis`, `services/dashboard.render`), and stores
  the API's own response body in `plant_snapshots` (migration 0039);
* the API returns the stored copy while it is fresh, and computes only when it
  is not — a new Plant, or a stopped scheduler — so a stopped scheduler makes
  screens slower, never wrong;
* the Portfolio reads every Plant's copy in one request (`read_fleet`).

Nothing about any figure changes: not the rules, not the provenance, not the
coverage — only when and how often the work is done. Each stored body carries
`computed_at`, and a screen may say how old it is.

⚠ The scheduler reads with platform privileges, under which the barrier views
scope nothing. Every computation here is per Plant and reads only that Plant's
Device ids (`services/scope.py`), which is what keeps one Plant's figures from
another's; RLS on `plant_snapshots` is what keeps a reader to their own.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import scoped_session
from solarcms.services import dashboard
from solarcms.services.kpis import compute_plant_kpis

log = structlog.get_logger(__name__)

KPI_PERIODS = ("today", "month", "year", "lifetime")
#: Periods with a previous period to compare against; lifetime has none.
COMPARED = frozenset({"today", "month", "year"})

#: How often the scheduler works the figures out.
DASHBOARD_INTERVAL_S = 15
KPI_INTERVAL_S = 60
#: How old a stored copy may be and still be served. Past it the scheduler has
#: missed two or three passes — stopped, or overrunning — and the API computes
#: instead, so a stale figure is never shown as current.
DASHBOARD_MAX_AGE_S = 45
KPI_MAX_AGE_S = 150
#: Plants worked out at once, each on its own session.
CONCURRENCY = 4


def _json_default(value: Any) -> Any:
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    raise TypeError(f"not JSON serialisable: {type(value).__name__}")


def _encode(payload: dict[str, Any]) -> str:
    return json.dumps(payload, default=_json_default)


# ── reading, under the caller's RLS ──────────────────────────────────────────


async def _read(session: AsyncSession, plant_id: int, kind: str,
                max_age_s: int) -> dict[str, Any] | None:
    row = (await session.execute(text("""
        SELECT payload FROM plant_snapshots
         WHERE plant_id = :plant_id AND kind = :kind
           AND computed_at > now() - make_interval(secs => CAST(:max_age AS integer))
    """), {"plant_id": plant_id, "kind": kind, "max_age": max_age_s})).first()
    return dict(row.payload) if row is not None else None


async def read_kpis(session: AsyncSession, plant_id: int, period: str, *,
                    compare: bool) -> dict[str, Any] | None:
    """The stored KPIs for a period, if fresh. Stored with the comparison."""
    payload = await _read(session, plant_id, f"kpis:{period}", KPI_MAX_AGE_S)
    if payload is not None and not compare:
        payload["previous"] = None
    return payload


async def read_dashboard(session: AsyncSession, plant_id: int) -> dict[str, Any] | None:
    return await _read(session, plant_id, "dashboard", DASHBOARD_MAX_AGE_S)


async def read_fleet(
    session: AsyncSession, period: str, *, context: SecurityContext,
) -> list[dict[str, Any]]:
    """Every visible Plant's KPIs and dashboard, in one request (§4.4).

    The Plants are the caller's own, through RLS. Copies that are missing or
    stale are computed here, a few at a time, on sessions of the caller's own
    security context — so the Portfolio is complete even when the scheduler
    is not running, only slower.
    """
    plants = (await session.execute(text("""
        SELECT id FROM plants WHERE status <> 'decommissioned' ORDER BY id
    """))).all()
    if not plants:
        return []
    ids = [row.id for row in plants]
    rows = (await session.execute(text("""
        SELECT plant_id, kind, payload FROM plant_snapshots
         WHERE plant_id = ANY(:ids) AND kind = ANY(:kinds)
           AND computed_at > now() - make_interval(secs => CASE kind
                   WHEN 'dashboard' THEN CAST(:dash_age AS integer)
                   ELSE CAST(:kpi_age AS integer) END)
    """), {"ids": ids, "kinds": [f"kpis:{period}", "dashboard"],
           "dash_age": DASHBOARD_MAX_AGE_S, "kpi_age": KPI_MAX_AGE_S})).all()
    found: dict[tuple[int, str], dict[str, Any]] = {
        (row.plant_id, row.kind): dict(row.payload) for row in rows
    }

    gate = asyncio.Semaphore(CONCURRENCY)

    async def fill(plant_id: int, kind: str) -> None:
        async with gate, scoped_session(context) as own:
            if kind == "dashboard":
                found[(plant_id, kind)] = await dashboard.render(own, plant_id)
            else:
                result = await compute_plant_kpis(own, plant_id, period, compare=False)
                if result is not None:
                    found[(plant_id, kind)] = result

    missing = [(plant_id, kind) for plant_id in ids
               for kind in (f"kpis:{period}", "dashboard") if (plant_id, kind) not in found]
    await asyncio.gather(*(fill(plant_id, kind) for plant_id, kind in missing))

    out = []
    for plant_id in ids:
        kpis = found.get((plant_id, f"kpis:{period}"))
        if kpis is not None:
            kpis = {**kpis, "previous": None}
        out.append({"plant_id": plant_id, "kpis": kpis,
                    "dashboard": found.get((plant_id, "dashboard"))})
    return out


# ── working them out, on the scheduler ───────────────────────────────────────


async def _store(session: AsyncSession, plant_id: int, client_id: int, kind: str,
                 computed_at: datetime, payload: dict[str, Any]) -> None:
    await session.execute(text("""
        INSERT INTO plant_snapshots (plant_id, client_id, kind, computed_at, payload)
        VALUES (:plant_id, :client_id, :kind, :computed_at, CAST(:payload AS jsonb))
        ON CONFLICT (plant_id, kind) DO UPDATE
            SET computed_at = EXCLUDED.computed_at, payload = EXCLUDED.payload,
                client_id = EXCLUDED.client_id
    """), {"plant_id": plant_id, "client_id": client_id, "kind": kind,
           "computed_at": computed_at, "payload": _encode(payload)})


async def _work(plant_id: int, client_id: int, *, kpis: bool) -> int:
    """Refresh one Plant. Returns how many copies were stored."""
    now = datetime.now(UTC)
    stored = 0
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        await _store(s, plant_id, client_id, "dashboard", now,
                     await dashboard.render(s, plant_id))
        stored += 1
        if kpis:
            for period in KPI_PERIODS:
                result = await compute_plant_kpis(
                    s, plant_id, period, compare=period in COMPARED, now=now)
                if result is not None:
                    await _store(s, plant_id, client_id, f"kpis:{period}", now, result)
                    stored += 1
    return stored


async def refresh_all(
    *, kpis: bool, on_error: Callable[[int, BaseException], Awaitable[None] | None]
    | None = None,
) -> dict[str, Any]:
    """Refresh every live Plant's copies; one Plant failing never stops the rest."""
    started = time.monotonic()
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        plants = (await s.execute(text("""
            SELECT id, client_id FROM plants WHERE status <> 'decommissioned' ORDER BY id
        """))).all()
    gate = asyncio.Semaphore(CONCURRENCY)
    stats = {"plants": len(plants), "stored": 0, "failed": 0}

    async def one(plant_id: int, client_id: int) -> None:
        async with gate:
            try:
                # Awaited first, then added: `x += await f()` reads `x` before
                # the await, so plants finishing together overwrite each
                # other's counts (it reported 5 of 15 stored).
                stored = await _work(plant_id, client_id, kpis=kpis)
                stats["stored"] += stored
            except Exception as exc:
                stats["failed"] += 1
                log.error("snapshot failed", plant_id=plant_id, error=repr(exc))
                if on_error is not None:
                    outcome = on_error(plant_id, exc)
                    if outcome is not None:
                        await outcome

    await asyncio.gather(*(one(row.id, row.client_id) for row in plants))
    return {**stats, "kpis": kpis, "seconds": round(time.monotonic() - started, 3)}
