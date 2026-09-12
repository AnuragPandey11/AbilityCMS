"""The audit trail. Read-only, Super Admin."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("")
async def list_audit(
    session: SessionDep,
    action: str | None = None,
    since: datetime | None = None,
    limit: int = Query(100, ge=1, le=1000),
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> list[dict[str, Any]]:
    """No write route exists, deliberately: the trail is immutable, and every row
    is written in the same transaction as the change it records."""
    rows = (await session.execute(text("""
        SELECT id, client_id, user_id, actor_email, action, entity_type, entity_id,
               before, after,
               -- asyncpg hands INET back as ipaddress.IPv4Address, which the JSON
               -- serialiser cannot encode; text is what the API returns anyway.
               host(ip_address) AS ip_address,
               user_agent, occurred_at
          FROM audit_log
         WHERE (CAST(:action AS text) IS NULL OR action = :action)
           AND (CAST(:since AS timestamptz) IS NULL OR occurred_at >= :since)
         ORDER BY occurred_at DESC LIMIT :limit
    """), {"action": action, "since": since, "limit": limit})).all()
    return [dict(row._mapping) for row in rows]
