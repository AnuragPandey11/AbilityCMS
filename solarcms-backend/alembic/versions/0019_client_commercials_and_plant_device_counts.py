"""Commercial identity on a Client, and planned Device counts on a Plant.

Onboarding previously captured only what the *telemetry* needed: a Client was a
code and a name. A Super Admin registering a real Client also holds commercial
facts about them — GSTIN, the client's own account number, a billing contact,
and how long the contract runs — and with nowhere to put them they lived in a
spreadsheet beside the platform.

⚠ **Status: PROPOSED, not client-confirmed.** No tender clause or MASTER section
specifies these fields; they were requested directly by the operator on
2026-09-12. Every column is NULLABLE and nothing reads them in a formula, so if
the client's real onboarding sheet names different fields this is an additive
migration, not a rework. MASTER §10 carries the change-log row.

`contract_valid_till` is a DATE, not the day count that is typed into the form.
The form asks "valid for N days" because that is how the contract reads, but a
stored count is wrong the day after it is written, and every "expiring soon"
query would have to recompute it against created_at. The route does the addition
once, at creation, and stores both ends.

── Planned Device counts ────────────────────────────────────────────────────
"Number of inverters" is deliberately NOT a column on `plants`, and neither are
its four siblings. A column per Device Type repeats exactly the mistake
guardrail 1 forbids for metrics: seventeen Device Types are seeded today and a
Client with Module Trackers would need a migration to record how many. So the
counts are rows keyed on `device_types`, which makes the onboarding form
catalogue-driven — a new Device Type gets a count field for free.

This is the *planned* count from the contract or design sheet, recorded at
onboarding before a single Device is registered. It is never the live count:
that is `SELECT count(*) FROM devices`, and the gap between the two is the
useful figure — it says how much of the Plant is still to be commissioned.

Visibility rides on the parent's RLS in the manner 0012 established for
`escalation_steps`: a count row is reachable exactly when its Plant is, so the
`plants_client_isolation` policy (and with it the user_plant_access check inside
`app_can_see_plant`) is inherited rather than restated.

Revision ID: 0019
Revises: 0018
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"


def upgrade() -> None:
    # ── Client commercial identity ───────────────────────────────────────────
    op.add_column("clients", sa.Column("client_number", sa.String(64), nullable=True))
    op.add_column("clients", sa.Column("gst_number", sa.String(15), nullable=True))
    op.add_column("clients", sa.Column("contact_email", sa.Text(), nullable=True))
    op.add_column("clients", sa.Column("contract_start_date", sa.Date(), nullable=True))
    op.add_column("clients", sa.Column("contract_valid_till", sa.Date(), nullable=True))

    # Unique but nullable: most Clients will carry the operator's own account
    # number, and the ones that do must not collide. NULL never collides in
    # Postgres, so Clients without one are unaffected.
    op.create_index(
        "uq_clients_client_number", "clients", ["client_number"], unique=True,
        postgresql_where=sa.text("client_number IS NOT NULL"),
    )

    # GSTIN is a fixed 15-character format: 2 state digits, a 10-character PAN,
    # an entity digit, a literal 'Z', then a checksum character. Checked for
    # shape only — the checksum is not verified here, because rejecting a real
    # GSTIN over a checksum implementation would block onboarding entirely.
    op.create_check_constraint(
        "ck_clients_gst_number_format", "clients",
        "gst_number IS NULL OR gst_number ~ "
        "'^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'",
    )
    # A contract that expires before it starts is a typo, not a state worth
    # representing. Both NULL, or only a start, remain valid: a Client may be
    # registered before its paperwork is signed.
    op.create_check_constraint(
        "ck_clients_contract_dates", "clients",
        "contract_valid_till IS NULL OR contract_start_date IS NULL "
        "OR contract_valid_till >= contract_start_date",
    )

    op.execute("COMMENT ON COLUMN clients.contract_valid_till IS "
               "'Stored as a date, though onboarding asks for a duration in days. "
               "A stored day count is stale the day after it is written.'")
    op.execute("COMMENT ON COLUMN clients.contact_email IS "
               "'Commercial contact for the Client organisation. NOT a login: a User "
               "signs in through users.email, and this address has no account.'")

    # ── Planned Device counts per Plant ──────────────────────────────────────
    op.create_table(
        "plant_device_counts",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), primary_key=True),
        # Denormalised for the same reason `readings.client_id` is: it lets a
        # policy or an index prune without joining back through `plants`.
        sa.Column("client_id", sa.BigInteger(),
                  sa.ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("plant_id", sa.BigInteger(),
                  sa.ForeignKey("plants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("device_type_id", sa.BigInteger(),
                  sa.ForeignKey("device_types.id"), nullable=False),
        sa.Column("planned_count", sa.Integer(), nullable=False),
        sa.CheckConstraint("planned_count >= 0", name="ck_plant_device_counts_positive"),
        sa.UniqueConstraint("plant_id", "device_type_id",
                            name="uq_plant_device_counts_plant_type"),
    )
    op.create_index("ix_plant_device_counts_plant", "plant_device_counts", ["plant_id"])

    op.execute("ALTER TABLE plant_device_counts ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE plant_device_counts FORCE ROW LEVEL SECURITY")
    # Inherited, not restated: `plant_id IN (SELECT id FROM plants)` returns only
    # Plants the caller can already see, so per-User Plant assignment is honoured
    # without this policy knowing that user_plant_access exists.
    op.execute("""
        CREATE POLICY plant_device_counts_via_plant ON plant_device_counts
            USING (plant_id IN (SELECT id FROM plants))
            WITH CHECK (plant_id IN (SELECT id FROM plants))
    """)
    op.execute(
        f"GRANT SELECT, INSERT, UPDATE, DELETE ON plant_device_counts TO {API_ROLE}"
    )
    op.execute("COMMENT ON TABLE plant_device_counts IS "
               "'Planned Device count per Device Type, from the contract or design "
               "sheet, recorded at onboarding. Never the live count -- that is "
               "count(*) on devices. The gap between the two is what remains to be "
               "commissioned.'")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS plant_device_counts_via_plant "
               "ON plant_device_counts")
    op.drop_table("plant_device_counts")

    op.drop_constraint("ck_clients_contract_dates", "clients", type_="check")
    op.drop_constraint("ck_clients_gst_number_format", "clients", type_="check")
    op.drop_index("uq_clients_client_number", table_name="clients")
    for column in ("contract_valid_till", "contract_start_date", "contact_email",
                   "gst_number", "client_number"):
        op.drop_column("clients", column)
