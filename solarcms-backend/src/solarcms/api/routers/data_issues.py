"""The Data Issues screen: what the broker sends that the platform cannot use.

Read-only except for acknowledgements. Every fix the screen offers is made
through the route that already owns it — `POST /devices/{id}/topics` attaches
a string topic, `PATCH /devices/{id}` sets a string count or moves a Device to
its new topic, the binding routes map a key — so each keeps its own checks,
its own audit row and its own cache invalidation, and nothing here can make a
change those routes would refuse.

`config.modify`: a Client Admin and a Super Admin. Unregistered topics are
listed for a platform administrator only, because they are quarantined with
no Client (Guardrail 5); for anyone else the response says so rather than
implying there are none.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.cache import keys
from solarcms.cache.live import get_redis
from solarcms.db.session import scoped_session
from solarcms.domain.data_issues import DataIssue, find_issues
from solarcms.logging import get_logger
from solarcms.services.data_issues import gather, unregistered_plants

log = get_logger("data_issues")

router = APIRouter(tags=["data-issues"])

# The categories a badge counts. `setup` is left out on purpose: a Plant whose
# capacity nobody has supplied would keep it lit for months, and a badge that
# is always lit is one people stop reading.
URGENT = ("data_lost", "data_wrong")

#: How many Plants the summary works out at once when their counts are not
#: cached, each on its own session — one at a time took 13.6 s at 50 Plants.
SUMMARY_CONCURRENCY = 4


def _counts_key(plant_id: int, can_see_unregistered: bool) -> str:
    return keys.DATA_ISSUE_COUNTS.format(
        plant_id=plant_id, audience="platform" if can_see_unregistered else "client")


async def _store_counts(plant_id: int, can_see_unregistered: bool,
                        counts: dict[str, int]) -> None:
    """Best effort: a Redis that cannot be written only costs the next caller."""
    try:
        await get_redis().set(_counts_key(plant_id, can_see_unregistered),
                              json.dumps(counts), ex=keys.DATA_ISSUE_COUNTS_TTL_S)
    except Exception as exc:
        log.warning("data issue counts not cached", plant_id=plant_id, error=str(exc))


async def _forget_counts(plant_id: int) -> None:
    """Drop a Plant's cached counts after a change that alters them."""
    try:
        await get_redis().delete(_counts_key(plant_id, True), _counts_key(plant_id, False))
    except Exception as exc:
        log.warning("data issue counts not cleared", plant_id=plant_id, error=str(exc))


class AcknowledgeIn(BaseModel):
    issue_key: str = Field(min_length=1, max_length=1024)
    note: str | None = Field(default=None, max_length=1000)


async def _acknowledgements(session: Any, plant_id: int) -> dict[str, dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT a.id, a.issue_key, a.note, a.created_at, u.email AS created_by
          FROM data_issue_acknowledgements a
          LEFT JOIN users u ON u.id = a.created_by
         WHERE a.plant_id = :plant_id
    """), {"plant_id": plant_id})).all()
    return {
        row.issue_key: {"id": row.id, "note": row.note, "created_at": row.created_at,
                        "created_by": row.created_by}
        for row in rows
    }


def _counts(issues: list[DataIssue], acks: dict[str, dict[str, Any]]) -> dict[str, int]:
    counts = {"data_lost": 0, "data_wrong": 0, "setup": 0, "acknowledged": 0}
    for issue in issues:
        if issue.key in acks:
            counts["acknowledged"] += 1
        else:
            counts[issue.category] += 1
    return counts


@router.get("/plants/{plant_id}/data-issues")
async def plant_data_issues(
    plant_id: int, session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Every data issue on one Plant, most costly first, each with its facts."""
    now = datetime.now(UTC)
    facts = await gather(session, plant_id, now=now,
                         can_see_unregistered=user.is_platform_admin)
    if facts is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    issues = find_issues(facts)
    acks = await _acknowledgements(session, plant_id)
    counts = _counts(issues, acks)
    # Fresh by construction, so the badge's cached copy is refreshed with it:
    # after a fix the screen re-reads this Plant first, then the summary.
    await _store_counts(plant_id, user.is_platform_admin, counts)
    return {
        "plant_id": plant_id,
        "generated_at": now,
        "can_see_unregistered": user.is_platform_admin,
        "counts": counts,
        "issues": [
            {
                "key": issue.key, "kind": issue.kind, "category": issue.category,
                "title": issue.title, "detail": issue.detail,
                "device_id": issue.device_id, "device_code": issue.device_code,
                "facts": dict(issue.facts),
                "acknowledged": acks.get(issue.key),
            }
            for issue in issues
        ],
    }


@router.get("/data-issues/summary")
async def data_issues_summary(
    session: SessionDep,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Open issue counts for every visible Plant, for the navigation badge.

    `open_urgent` counts data being lost or wrong, never `setup`, and never an
    acknowledged issue — a badge only means something if it can go out.
    """
    now = datetime.now(UTC)
    # The Plants are the caller's own, through RLS, before any cached count is
    # read — the cache holds per-Plant facts, never who may see them.
    plants = (await session.execute(text(
        "SELECT id, code, name FROM plants WHERE status <> 'decommissioned' ORDER BY code"
    ))).all()
    admin = user.is_platform_admin
    cached: list[str | None] = []
    if plants:
        try:
            cached = await get_redis().mget([_counts_key(p.id, admin) for p in plants])
        except Exception as exc:
            log.warning("data issue counts cache unreadable", error=str(exc))
            cached = [None] * len(plants)
    counts_by_plant: dict[int, dict[str, int]] = {
        plant.id: json.loads(raw) for plant, raw in zip(plants, cached, strict=True) if raw
    }

    # Whatever is not cached is worked out several Plants at a time, each on a
    # session of the caller's own security context.
    gate = asyncio.Semaphore(SUMMARY_CONCURRENCY)

    async def compute(plant_id: int) -> None:
        async with gate, scoped_session(user.context) as own:
            facts = await gather(own, plant_id, now=now, can_see_unregistered=admin)
            if facts is None:
                return
            counts = _counts(find_issues(facts), await _acknowledgements(own, plant_id))
        counts_by_plant[plant_id] = counts
        await _store_counts(plant_id, admin, counts)

    await asyncio.gather(*(compute(p.id) for p in plants if p.id not in counts_by_plant))
    out: list[dict[str, Any]] = [
        {"plant_id": plant.id, "code": plant.code, "name": plant.name,
         "counts": counts_by_plant[plant.id]}
        for plant in plants if plant.id in counts_by_plant
    ]
    unregistered = await unregistered_plants(session, now) if user.is_platform_admin else []
    return {
        "generated_at": now,
        "plants": out,
        "unregistered_plants": unregistered,
        "can_see_unregistered": user.is_platform_admin,
        "open_urgent": (
            sum(p["counts"][c] for p in out for c in URGENT) + len(unregistered)
        ),
    }


@router.post("/plants/{plant_id}/data-issues/acknowledgements",
             status_code=status.HTTP_201_CREATED)
async def acknowledge_issue(
    plant_id: int, body: AcknowledgeIn, session: SessionDep, background: BackgroundTasks,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> dict[str, Any]:
    """Mark an issue as known. Re-acknowledging replaces the note."""
    plant = (await session.execute(
        text("SELECT client_id FROM plants WHERE id = :id"), {"id": plant_id})).first()
    if plant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "plant not found")
    note = (body.note or "").strip() or None
    row = (await session.execute(text("""
        INSERT INTO data_issue_acknowledgements (client_id, plant_id, issue_key, note,
                                                 created_by)
        VALUES (:client_id, :plant_id, :issue_key, :note, :user_id)
        ON CONFLICT (plant_id, issue_key) DO UPDATE
            SET note = EXCLUDED.note, created_by = EXCLUDED.created_by,
                created_at = now()
        RETURNING id, issue_key, note, created_at
    """), {"client_id": plant.client_id, "plant_id": plant_id,
           "issue_key": body.issue_key.strip(), "note": note,
           "user_id": user.user_id})).first()
    assert row is not None  # DO UPDATE always returns a row
    # Same transaction as the change: an audit row written separately can
    # succeed while the change rolls back, and the trail then lies.
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :user_id, 'data_issue.acknowledge',
                'data_issue_acknowledgements', :entity_id, CAST(:after AS jsonb))
    """), {"client_id": plant.client_id, "user_id": user.user_id, "entity_id": row.id,
           "after": json.dumps({"plant_id": plant_id, "issue_key": row.issue_key,
                                "note": note})})
    # After the commit (a background task runs once the session has closed),
    # or a summary in between would cache the count from before this change.
    background.add_task(_forget_counts, plant_id)
    return {"id": row.id, "issue_key": row.issue_key, "note": row.note,
            "created_at": row.created_at}


@router.delete("/data-issues/acknowledgements/{ack_id}",
               status_code=status.HTTP_204_NO_CONTENT, response_class=Response)
async def unacknowledge_issue(
    ack_id: int, session: SessionDep, background: BackgroundTasks,
    user: CurrentUser = Depends(require_permission("config.modify")),
) -> Response:
    """Take an acknowledgement back; the issue returns to the open list."""
    row = (await session.execute(text("""
        DELETE FROM data_issue_acknowledgements WHERE id = :id
        RETURNING client_id, plant_id, issue_key, note
    """), {"id": ack_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such acknowledgement")
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, before)
        VALUES (:client_id, :user_id, 'data_issue.unacknowledge',
                'data_issue_acknowledgements', :entity_id, CAST(:before AS jsonb))
    """), {"client_id": row.client_id, "user_id": user.user_id, "entity_id": ack_id,
           "before": json.dumps({"plant_id": row.plant_id, "issue_key": row.issue_key,
                                 "note": row.note})})
    background.add_task(_forget_counts, row.plant_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
