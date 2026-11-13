"""Quick reports: the saved custom reports each User keeps at the top of Reports.

A saved custom report (0033) is shared within its Client, so the list of them
grows with everyone's work. A pin is one User's: up to five of those reports,
in the order they chose, shown as cards they can download from in one click —
the user's request of 13 Nov 2026 ("so that every time we don't have to do the
same selection over and over again").

Per User, never per Client, so one person's row does not rearrange another's.
The cap lives in the API (`schemas/reports.CUSTOM_REPORT_PIN_LIMIT`), not
in a CHECK, so changing it is not a migration. Deleting a saved report removes
its pins (CASCADE); a pin names a report only the pinner could see when they
pinned it, and listing joins `custom_reports` under its own RLS, so a report
the User can no longer see drops out of their row rather than leaking a name.

Status: PROPOSED (the user's choice of 13 Nov 2026) / BUILT.

Revision ID: 0049
Revises: 0048
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"


def upgrade() -> None:
    op.create_table(
        "custom_report_pins",
        sa.Column("user_id", sa.BigInteger,
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("report_id", sa.BigInteger,
                  sa.ForeignKey("custom_reports.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.SmallInteger, nullable=False),
        sa.Column("pinned_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("user_id", "report_id"),
        sa.UniqueConstraint("user_id", "position", name="uq_custom_report_pin_position"),
        sa.CheckConstraint("position >= 1", name="custom_report_pin_position"),
    )
    op.create_index("ix_custom_report_pins_report", "custom_report_pins", ["report_id"])
    op.execute("ALTER TABLE custom_report_pins ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE custom_report_pins FORCE ROW LEVEL SECURITY")
    # Each User reads and writes their own pins, and nobody else's — a
    # platform administrator included: a pin is a preference, not a record.
    op.execute("""
        CREATE POLICY custom_report_pins_own ON custom_report_pins
            USING (user_id = app_user_id())
            WITH CHECK (user_id = app_user_id())
    """)
    # A policy is not a grant (0015/0017, 0025): without these every pin is
    # "permission denied". SELECT also serves the DELETE's own WHERE.
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON custom_report_pins TO {API_ROLE}")
    op.execute("COMMENT ON TABLE custom_report_pins IS "
               "'Saved custom reports one User keeps as quick reports at the top of "
               "Reports, in their order. Per User; the cap is the API''s.'")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS custom_report_pins_own ON custom_report_pins")
    op.drop_table("custom_report_pins")
