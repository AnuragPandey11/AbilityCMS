"""Custom reports a client has saved: which Plants, Devices, readings, interval.

The standard reports answer fixed questions. A custom report is the client's
own: any Plants, any of their Devices, any of the readings those Devices send,
at the interval they choose. Saved here so it can be opened again by anyone in
the same Client — the user's choice on 8 Oct 2026 ("saved, shared within the
client").

`definition` is the request itself (`schemas/reports.CustomReportDefinition`),
stored whole so a saved report reopens exactly as it was built. It names Device
ids; running it reads through the caller's own RLS, so a saved report can never
show anyone a Device they could not otherwise see.

A platform administrator belongs to no Client; a report they save has
`client_id` NULL and is visible to platform administrators only.

Status: AGREED / BUILT.

Revision ID: 0033
Revises: 0032
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"


def upgrade() -> None:
    op.create_table(
        "custom_reports",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=True),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("definition", postgresql.JSONB, nullable=False),
        sa.Column("created_by", sa.BigInteger,
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("length(btrim(name)) > 0", name="custom_report_name"),
    )
    op.create_index("ix_custom_reports_client", "custom_reports", ["client_id"])
    op.execute("ALTER TABLE custom_reports ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE custom_reports FORCE ROW LEVEL SECURITY")
    # A Client sees its own; a platform administrator sees every one.
    op.execute("""
        CREATE POLICY custom_reports_client_isolation ON custom_reports
            USING (client_id = app_client_id() OR app_is_platform_admin())
            WITH CHECK (client_id = app_client_id() OR app_is_platform_admin())
    """)
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON custom_reports TO {API_ROLE}")
    op.execute("COMMENT ON TABLE custom_reports IS "
               "'Custom reports saved by a Client: Plants, Devices, readings and "
               "interval, as built on the Reports screen. Run through the caller''s "
               "RLS, so a saved report shows nobody more than they can see.'")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS custom_reports_client_isolation ON custom_reports")
    op.drop_table("custom_reports")
