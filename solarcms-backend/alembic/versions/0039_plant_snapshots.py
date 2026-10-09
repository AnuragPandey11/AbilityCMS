"""Store each Plant's KPIs and dashboard, worked out by the scheduler.

Today's KPIs re-read the Plant's whole day on every request, the browser asked
after every live frame, and the Portfolio asked for every Plant every 10 s — so
the cost grew with every viewer, every Plant and every hour since midnight
(docs/CAPACITY_AND_DEPLOYMENT.md §2.7, §4.4). The scheduler now works each
Plant's figures out on a timer — the dashboard every 15 s, the four KPI periods
once a minute — with the very code the API used (`services/kpis.py`,
`services/dashboard.py`), and stores the result here. A screen reads the
stored copy; it computes only when no fresh copy exists (a new Plant, or the
scheduler down), so a stopped scheduler makes screens slower, never wrong.

One row per (Plant, kind): `kpis:today`, `kpis:month`, `kpis:year`,
`kpis:lifetime`, `dashboard`. `payload` is the API's own response body.

⚠ This changes a recorded decision: MASTER §1.1 says the Portfolio is
"computed, never stored". The Portfolio is still a view computed over these
rows — but the per-Plant figures beneath it are now stored, for up to a minute.
Recorded in MASTER §10 as PROPOSED (8 Oct 2026, the user's choice).

Isolation as for every Client-owned table: FORCE RLS, Plant visibility
inherited from `plants`, the scheduler's own policy (it writes across every
Client, as it does for `device_health`), and a GRANT beside each policy.

Status: PROPOSED / BUILT.

Revision ID: 0039
Revises: 0038
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0039"
down_revision = "0038"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"
SCHEDULER = "solarcms_scheduler"


def upgrade() -> None:
    op.create_table(
        "plant_snapshots",
        sa.Column("plant_id", sa.BigInteger,
                  sa.ForeignKey("plants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("computed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.PrimaryKeyConstraint("plant_id", "kind", name="pk_plant_snapshots"),
        sa.CheckConstraint(
            "kind IN ('kpis:today','kpis:month','kpis:year','kpis:lifetime','dashboard')",
            name="plant_snapshot_kind"),
    )
    op.execute("ALTER TABLE plant_snapshots ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE plant_snapshots FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY plant_snapshots_via_plant ON plant_snapshots
            USING ((client_id = app_client_id() OR app_is_platform_admin())
                   AND plant_id IN (SELECT id FROM plants))
            WITH CHECK ((client_id = app_client_id() OR app_is_platform_admin())
                        AND plant_id IN (SELECT id FROM plants))
    """)
    op.execute(f"""
        CREATE POLICY plant_snapshots_scheduler ON plant_snapshots
            TO {SCHEDULER} USING (true) WITH CHECK (true)
    """)
    # A permissive policy is not a GRANT (CLAUDE.md, three times over).
    op.execute(f"GRANT SELECT ON plant_snapshots TO {API_ROLE}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON plant_snapshots TO {SCHEDULER}")
    # The dashboard the scheduler now renders reads each Plant's slot overrides;
    # its policy already admits the platform context, and without the GRANT
    # every snapshot fails "permission denied" (found by the integration test).
    op.execute(f"GRANT SELECT ON plant_dashboard_slot_overrides TO {SCHEDULER}")
    op.execute("COMMENT ON TABLE plant_snapshots IS "
               "'Each Plant''s KPIs and dashboard as the scheduler last worked them "
               "out (services/snapshots.py). Screens read these; they compute only "
               "when no fresh copy exists.'")


def downgrade() -> None:
    op.execute(f"REVOKE SELECT ON plant_dashboard_slot_overrides FROM {SCHEDULER}")
    op.drop_table("plant_snapshots")
