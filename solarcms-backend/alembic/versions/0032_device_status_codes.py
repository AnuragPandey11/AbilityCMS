"""What a Device's status code means, as the client says it does.

Inverters send a status code (`STS` → `DEVICE_STATUS`) and every screen has so
far shown it *as sent*, because nobody had said what its values mean
(CLAUDE.md, "One Inverter opens in full"). The meanings are the equipment
maker's, they differ between makes — on 8 Oct 2026 KULAR_GREEN's Inverters
sent 0, 2, 512 and 40960 and VARDHMAN_GROUP's 0 and 1 — and only the client
knows them. So the client enters them here, one row per code.

── Per Plant ───────────────────────────────────────────────────────────────
Kept per Plant, Device Type and Tag: a Plant's Inverters are one make, and the
same number from another make means something else. Any Tag whose unit is
`code` can be labelled, so a Device Type that starts sending a status code
later needs no change here.

`kind` is the client's verdict on the state — normal, standby, warning or
fault — and is what colours it; a code nobody has labelled is shown as sent,
uncoloured, never guessed.

Status: AGREED (the user, 8 Oct 2026) / BUILT.

Revision ID: 0032
Revises: 0031
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"


def upgrade() -> None:
    op.create_table(
        "device_status_codes",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("plant_id", sa.BigInteger,
                  sa.ForeignKey("plants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_type_id", sa.BigInteger,
                  sa.ForeignKey("device_types.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("tag_id", sa.BigInteger,
                  sa.ForeignKey("tags.id", ondelete="RESTRICT"), nullable=False),
        # A code is a whole number as the equipment sends it; 40960 is 0xA000.
        sa.Column("code", sa.BigInteger, nullable=False),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("kind", sa.String(16), nullable=False, server_default="normal"),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column("updated_by", sa.BigInteger,
                  sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("plant_id", "device_type_id", "tag_id", "code",
                            name="uq_device_status_codes_plant_type_tag_code"),
        sa.CheckConstraint("kind IN ('normal', 'standby', 'warning', 'fault')",
                           name="device_status_code_kind"),
        sa.CheckConstraint("length(btrim(label)) > 0", name="device_status_code_label"),
    )
    op.execute("ALTER TABLE device_status_codes ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE device_status_codes FORCE ROW LEVEL SECURITY")
    # Plant visibility inherited from `plants`, as data_issue_acknowledgements.
    op.execute("""
        CREATE POLICY device_status_codes_via_plant ON device_status_codes
            USING ((client_id = app_client_id() OR app_is_platform_admin())
                   AND plant_id IN (SELECT id FROM plants))
            WITH CHECK ((client_id = app_client_id() OR app_is_platform_admin())
                        AND plant_id IN (SELECT id FROM plants))
    """)
    # A permissive policy is not a GRANT.
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON device_status_codes TO {API_ROLE}")
    op.execute("COMMENT ON TABLE device_status_codes IS "
               "'What a status code (a Tag with unit code, e.g. an Inverter''s STS) "
               "means at one Plant, as the client says. A code with no row is shown "
               "as sent.'")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS device_status_codes_via_plant ON device_status_codes")
    op.drop_table("device_status_codes")
