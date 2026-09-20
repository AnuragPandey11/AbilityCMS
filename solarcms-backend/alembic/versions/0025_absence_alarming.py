"""Make absence raisable: device-less Alarms, maintenance windows, dismissals.

Every Alarm this system could raise before this migration was driven by a value
*arriving* and being compared against a threshold. The conditions that cost a
Plant owner money are the opposite — something stopped, or something never
started — and three of them could not be represented at all:

* **a Collector going quiet** is one failure shared by many Devices, and belongs
  to an enclosure, which since 0022 is a name and not a `devices` row;
* **a topic publishing with nothing registered for it** belongs to a topic, and
  by Guardrail 5 must not be attributed to a Device by inference;
* **a whole Plant falling silent** belongs to the Plant.

`alarms.device_id` was already nullable for exactly this, but nothing recorded
*which* Collector or *which* topic, so two simultaneous ones were
indistinguishable — and the deduplication index is on (rule_id, device_id),
where NULLs are distinct, so the same condition would re-open on every sweep and
re-notify every time.

── `subject` ────────────────────────────────────────────────────────────────
One nullable column naming what a device-less Alarm is about, plus a partial
unique index with NULLS NOT DISTINCT so one Collector, one topic or one Plant
holds exactly one open Alarm. Device-scoped Alarms are untouched and keep using
the original index; the two indexes are disjoint by `device_id IS [NOT] NULL`.

── The grant that would otherwise be missing ────────────────────────────────
⚠ The health sweep runs as `solarcms_scheduler`, which migration 0015 gave
SELECT and UPDATE on `alarms` but **not INSERT** — while also creating an
`alarms_scheduler` policy `WITH CHECK (true)`. A permissive policy is not a
GRANT. That exact pairing already cost this project once: 0015 created
`device_health_scheduler` with no INSERT, so every sweep failed with "permission
denied", logged it, slept, and `comm_status` stayed NULL fleet-wide until 0017.
The sweep is about to start inserting Alarms, so the grant is corrected here.

── Two new tables, both deliberately sparse ─────────────────────────────────
`maintenance_windows` exists so planned work does not read as failure. Without
it a scheduled outage raises Alarms, pages somebody at 2am, and — worse — is
recorded as downtime in the availability figure a performance guarantee is paid
against.

`discovery_ignored_topics` exists so a retired topic can be dismissed. Raw
history is kept 90 days and discovery looks back 7, so a topic shape the client
migrated away from keeps offering itself as equipment to register for a week
after it died. Registering one produces a Device that never reports, which is
indistinguishable from broken equipment.

Revision ID: 0025
Revises: 0024
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"
SCHEDULER = "solarcms_scheduler"


def upgrade() -> None:
    # ── What a device-less Alarm is about ───────────────────────────────────
    op.add_column("alarms", sa.Column("subject", sa.String(255), nullable=True))
    op.execute(
        "COMMENT ON COLUMN alarms.subject IS "
        "'What this Alarm is about when it is not about a Device: a Collector "
        "name, a topic, or a Plant. NULL for a Device-scoped Alarm.'"
    )
    # NULLS NOT DISTINCT so (rule, plant, subject) dedupes even where plant_id
    # is NULL — which it is for a topic under a Client we have not registered.
    op.execute("""
        CREATE UNIQUE INDEX uq_alarms_open_per_rule_subject
            ON alarms (rule_id, plant_id, subject) NULLS NOT DISTINCT
         WHERE state IN ('active','acknowledged') AND device_id IS NULL
    """)

    # ── The grant 0015 left out ─────────────────────────────────────────────
    # SELECT accompanies INSERT because the sweep reads back what it opened;
    # `INSERT ... RETURNING` needs read privilege on the returned column.
    op.execute(f"GRANT INSERT, SELECT, UPDATE ON alarms TO {SCHEDULER}")
    # The sweep must see what is publishing to notice what is publishing
    # *unregistered*, and must split topics the same way ingest does.
    op.execute(f"GRANT SELECT ON mqtt_raw_v TO {SCHEDULER}")
    op.execute(f"GRANT SELECT ON topic_patterns TO {SCHEDULER}")

    # ── Planned work is not failure ─────────────────────────────────────────
    op.create_table(
        "maintenance_windows",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("plant_id", sa.BigInteger,
                  sa.ForeignKey("plants.id", ondelete="CASCADE"), nullable=False),
        # NULL means the whole Plant. A window is usually taken on one Device,
        # but a grid outage or a shutdown covers everything at once.
        sa.Column("device_id", sa.BigInteger,
                  sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        # NULL is open-ended: work that has begun and has not been closed off.
        # Left open, it suppresses indefinitely, which is why the UI shows it.
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        # Why the plant was down, for the reader reconciling an availability
        # report months later. Required: an unexplained exclusion is the thing
        # an auditor will challenge.
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("created_by", sa.BigInteger, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("ends_at IS NULL OR ends_at > starts_at",
                           name="maintenance_window_ends_after_start"),
        sa.CheckConstraint("length(btrim(reason)) > 0",
                           name="maintenance_window_reason_not_blank"),
    )
    op.create_index("ix_maintenance_windows_plant", "maintenance_windows",
                    ["plant_id", "starts_at"])
    op.create_index("ix_maintenance_windows_device", "maintenance_windows",
                    ["device_id"], postgresql_where=sa.text("device_id IS NOT NULL"))

    # ── A retired topic can be put away ─────────────────────────────────────
    op.create_table(
        "discovery_ignored_topics",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        # NULL where the topic belongs to a Client we have not registered —
        # which is precisely when discovery is most useful, so it must be
        # dismissable too.
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="CASCADE"), nullable=True),
        # Case-sensitive and exact, because the topic is the identity. Two
        # topics differing only in case are two origins (Guardrail 5).
        sa.Column("topic", sa.Text, nullable=False),
        sa.Column("reason", sa.Text, nullable=True),
        sa.Column("created_by", sa.BigInteger, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("topic", name="uq_discovery_ignored_topics_topic"),
    )

    for table in ("maintenance_windows", "discovery_ignored_topics"):
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {API_ROLE}")
        op.execute(f"GRANT SELECT ON {table} TO {SCHEDULER}")
        op.execute(f"""
            CREATE POLICY {table}_scheduler ON {table}
                TO {SCHEDULER} USING (true) WITH CHECK (true)
        """)

    # Plant-scoped, so per-User Plant assignment is honoured without this policy
    # knowing `user_plant_access` exists — the same inheritance 0024 uses.
    op.execute("""
        CREATE POLICY maintenance_windows_via_plant ON maintenance_windows
            USING (plant_id IN (SELECT id FROM plants))
            WITH CHECK (plant_id IN (SELECT id FROM plants))
    """)
    # ⚠ Platform-admin only, matching discovery itself: an unregistered topic is
    # quarantined with client_id NULL because attributing it by reading the
    # topic is the inference Guardrail 5 forbids, so only a platform admin sees
    # those rows — and only they can dismiss one.
    op.execute("""
        CREATE POLICY discovery_ignored_topics_admin ON discovery_ignored_topics
            USING (app_is_platform_admin() OR client_id = app_client_id())
            WITH CHECK (app_is_platform_admin())
    """)


def downgrade() -> None:
    for table in ("maintenance_windows", "discovery_ignored_topics"):
        op.execute(f"DROP POLICY IF EXISTS {table}_scheduler ON {table}")
    op.execute("DROP POLICY IF EXISTS maintenance_windows_via_plant ON maintenance_windows")
    op.execute(
        "DROP POLICY IF EXISTS discovery_ignored_topics_admin ON discovery_ignored_topics"
    )
    op.drop_table("discovery_ignored_topics")
    op.drop_table("maintenance_windows")
    op.execute("DROP INDEX IF EXISTS uq_alarms_open_per_rule_subject")
    op.drop_column("alarms", "subject")
    op.execute(f"REVOKE INSERT ON alarms FROM {SCHEDULER}")
    op.execute(f"REVOKE SELECT ON mqtt_raw_v FROM {SCHEDULER}")
    op.execute(f"REVOKE SELECT ON topic_patterns FROM {SCHEDULER}")
