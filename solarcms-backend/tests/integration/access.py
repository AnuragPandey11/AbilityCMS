"""Tabs for the Client Admins the integration fixtures make (migration 0046).

A Client Admin no longer sees every screen by role: they see the tabs ticked
for them, and the write routes of the admin pages check those ticks. The
fixtures insert memberships directly, so each gives its Client Admins every
tab here — what a Client Admin was given implicitly before, and what every
creation path (`POST /clients`, `cli create-client-user`) still gives one.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def grant_admin_tabs(session: AsyncSession) -> None:
    """Every tab to every Client Admin membership that has none."""
    await session.execute(text("""
        INSERT INTO user_dashboard_access (membership_id, dashboard_id)
        SELECT m.id, d.id
          FROM memberships m
          JOIN roles r ON r.id = m.role_id AND r.code = 'admin'
         CROSS JOIN dashboards d
         WHERE NOT EXISTS (SELECT 1 FROM user_dashboard_access u
                            WHERE u.membership_id = m.id)
        ON CONFLICT DO NOTHING
    """))
