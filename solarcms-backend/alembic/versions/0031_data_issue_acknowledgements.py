"""Let a person mark a data issue as known.

The Data Issues screen lists what the broker sends that the platform cannot
use or does not trust (`domain/data_issues.py`). Most rows are fixed where they
are listed — map the key, attach the topic, set the count — and disappear on
their own. Some cannot be fixed here at all: an Inverter that sends -1 for its
efficiency, a weather station with no tilted sensor, a key the equipment sends
that nobody needs. Left in the list, those rows bury the ones that can be fixed
and teach people to stop reading it.

So an issue can be **acknowledged**: recorded as known, with who, when and
why. It is not deleted and not hidden — the screen moves it to an
"Acknowledged" section, and it can be taken back with one click.

`issue_key` is the issue's own stable fingerprint (`DataIssue.key`), e.g.
`rejected:78:INVERTER_EFFICIENCY`. It identifies the *thing that is wrong*,
not its current values, so an acknowledgement outlives a changing number and
lapses only when the thing itself stops being wrong.

Status: PROPOSED / BUILT.

Revision ID: 0031
Revises: 0030
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"


def upgrade() -> None:
    op.create_table(
        "data_issue_acknowledgements",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False),
        # CASCADE: an acknowledgement is about one Plant's data and means
        # nothing once the Plant is gone.
        sa.Column("plant_id", sa.BigInteger,
                  sa.ForeignKey("plants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("issue_key", sa.Text, nullable=False),
        sa.Column("note", sa.Text, nullable=True),
        # SET NULL: removing a User must not take the record of what they knew.
        sa.Column("created_by", sa.BigInteger,
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("plant_id", "issue_key",
                            name="uq_data_issue_acknowledgements_plant_key"),
        sa.CheckConstraint("length(btrim(issue_key)) > 0",
                           name="data_issue_key_not_blank"),
    )

    op.execute("ALTER TABLE data_issue_acknowledgements ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE data_issue_acknowledgements FORCE ROW LEVEL SECURITY")
    # Plant visibility is inherited from `plants`, not restated, so a User sees
    # acknowledgements for exactly the Plants they can see.
    op.execute("""
        CREATE POLICY data_issue_acknowledgements_via_plant ON data_issue_acknowledgements
            USING ((client_id = app_client_id() OR app_is_platform_admin())
                   AND plant_id IN (SELECT id FROM plants))
            WITH CHECK ((client_id = app_client_id() OR app_is_platform_admin())
                        AND plant_id IN (SELECT id FROM plants))
    """)
    # A permissive policy is not a GRANT — the pairing this project has been
    # caught by three times. The API is the only process that reads or writes it.
    op.execute(
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON data_issue_acknowledgements TO {API_ROLE}"
    )
    op.execute("COMMENT ON TABLE data_issue_acknowledgements IS "
               "'Data issues a person has marked as known (the Data Issues "
               "screen), keyed by the issue''s stable fingerprint. Shown in an "
               "Acknowledged section, never deleted or hidden; removable.'")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS data_issue_acknowledgements_via_plant "
               "ON data_issue_acknowledgements")
    op.drop_table("data_issue_acknowledgements")
