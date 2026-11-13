"""The Performance History tab: a Plant's days on a calendar, its months, and any day opened.

Registered here, not by the seed (0028: which screens a build contains is a
fact about the build). ⚠ **Given to nobody** — the user's standing choice of
1 Nov 2026 (0046): a platform administrator sees it at once and ticks it for
anyone else under Users. No backfill, deliberately.

⚠ The downgrade drops nothing: `user_dashboard_access` cascades, so deleting
the row would silently revoke it from everyone it was given to.

Revision ID: 0049
Revises: 0048
"""

from __future__ import annotations

from sqlalchemy import text

from alembic import op

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None


#: (code, name, sort_order) — the same shape as 0028's list, which
#: `solarcms-frontend/tests/dashboards.test.ts` reads to check the menu's list.
DASHBOARDS: tuple[tuple[str, str, int], ...] = (
    ("performance_history", "Performance History", 63),
)


def upgrade() -> None:
    stmt = text("""
        INSERT INTO dashboards (code, name, sort_order, kind)
        VALUES (:code, :name, :sort_order, 'screen')
        ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order, kind = EXCLUDED.kind
    """)
    for code, name, sort_order in DASHBOARDS:
        op.execute(stmt.bindparams(code=code, name=name, sort_order=sort_order))


def downgrade() -> None:
    """Keeps the row — see the module note."""
