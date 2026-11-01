"""Admin pages become tabs a person is given, and a Client Admin is given tabs too.

The user's decision of 1 Nov 2026: a platform administrator ticks, per User,
every screen *and* every admin page that User may open — for a Client Admin as
for an Employee. Until now a Client Admin saw every screen whatever was ticked,
and admin pages were decided by the role alone.

* `dashboards.kind` — `screen` (the monitoring tabs, as before) or `admin` (an
  admin page). One catalogue and one grant table (`user_dashboard_access`), so
  dimension A-3 stays one mechanism.
* `dashboards.permission` — the role permission an admin page also needs. A
  tick never grants a permission: the page opens only where the role holds it
  and the box is ticked.
* **Every existing Client Admin is given every row**, screens and pages, so
  nobody loses anything on the day this lands. Nobody else is given an admin
  page: no other role holds a permission one needs.

⚠ **A tab added by a later migration is given to nobody** (the user's choice):
a new screen stays hidden from every Client Admin and Employee until a platform
administrator ticks it. Do not add a backfill to that migration by reflex.

⚠ The rows are literal, never imported (see 0028), and the downgrade drops
nothing: `user_dashboard_access` cascades, so deleting a row would silently
revoke what administrators granted.

Revision ID: 0046
Revises: 0045
"""

from __future__ import annotations

from sqlalchemy import text

from alembic import op

revision = "0046"
down_revision = "0045"
branch_labels = None
depends_on = None

#: (code, name, sort order, the role permission it also needs). Platform-only
#: pages (Clients, System, System Health) are not here: they need system.admin,
#: which no Client role holds.
ADMIN_PAGES: tuple[tuple[str, str, int, str], ...] = (
    ("admin_data_issues", "Data Issues", 100, "config.modify"),
    ("admin_onboarding", "Plant Onboarding", 110, "plant.manage"),
    ("admin_plant_setup", "Plants & Devices", 120, "plant.manage"),
    ("admin_hierarchy", "Wiring & Diagram", 130, "plant.manage"),
    ("admin_bindings", "Tag Mapping", 140, "config.modify"),
    ("admin_alarm_rules", "Alarm Rules", 150, "config.modify"),
    ("admin_users", "Users", 160, "user.manage"),
    ("admin_alarm_emails", "Alarm Emails", 170, "user.manage"),
)


def upgrade() -> None:
    op.execute("""
        ALTER TABLE dashboards
            ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'screen',
            ADD COLUMN permission VARCHAR(64),
            ADD CONSTRAINT dashboards_kind CHECK (kind IN ('screen', 'admin'))
    """)
    stmt = text("""
        INSERT INTO dashboards (code, name, sort_order, kind, permission)
        VALUES (:code, :name, :sort_order, 'admin', :permission)
        ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order,
                kind = EXCLUDED.kind, permission = EXCLUDED.permission
    """)
    for code, name, sort_order, permission in ADMIN_PAGES:
        op.execute(stmt.bindparams(code=code, name=name, sort_order=sort_order,
                                   permission=permission))

    # `memberships` is under FORCE ROW LEVEL SECURITY, which binds the owner
    # too: without this the backfill matches no membership and writes nothing.
    op.execute("SELECT set_config('app.is_platform_admin', 'true', true)")
    op.execute("""
        INSERT INTO user_dashboard_access (membership_id, dashboard_id)
        SELECT m.id, d.id
          FROM memberships m
          JOIN roles r ON r.id = m.role_id AND r.code = 'admin'
         CROSS JOIN dashboards d
        ON CONFLICT DO NOTHING
    """)


def downgrade() -> None:
    """Drops the two columns and keeps every row — see the module note."""
    op.execute("""
        ALTER TABLE dashboards
            DROP CONSTRAINT IF EXISTS dashboards_kind,
            DROP COLUMN IF EXISTS permission,
            DROP COLUMN IF EXISTS kind
    """)
