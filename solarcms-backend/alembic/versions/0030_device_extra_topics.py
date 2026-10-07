"""Let one Device be fed by more than one topic.

Until now a Device had exactly one topic, `devices.source_address`, and the
resolver's first path is an exact match on it. On 6 Oct 2026 the client's
broker began publishing each Inverter's PV strings on topics of their own:

    SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_1            AC side, PVV, PVI
    SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_1_STRING16   I1..I16, P1..P16
    SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_1_STRING28   I17..I28, P17..P28

Those are not a second instrument. INVERTER_1's I1..I28 summed to 148.49 A in
the first round observed, which is *exactly* the `PVI` the Inverter itself
published in the same round: they are its own PV inputs, the PVn_CURRENT Tags
String Analysis has been waiting for (OPEN-24). Registering each string topic
as a Device of its own would put 34 power-less "Inverters" on KULAR_GREEN's
Inverter Monitoring and leave String Analysis empty, because it reads the PV
Tags of the Inverter.

So a Device may carry extra topics:

    device_topics(device_id, topic)

`devices.source_address` stays the Device's *primary* topic and every reader
that wants "the topic" keeps reading it. A row here says "messages on this
topic are this Device's too", and the resolver honours it as an exact match —
the same path, with the same immunity to case and shape that pattern matching
has to care about. Origin is still decided by the topic and by nothing else
(Guardrail 5); this only lets more than one topic name the same Device.

── One answer to "which Device owns this topic" ─────────────────────────────
`registered_topics` is the union of both, and every query that used to ask
`devices.source_address = m.topic` — the unregistered-publishing sweep, Plant
silence, topic-migration candidates, discovery, pruning — asks it instead, so a
string topic is never reported as unregistered equipment, never offered for
registration, and never has its raw history pruned. `security_invoker` so the
caller's own RLS on `devices` and `device_topics` applies, rather than the
view owner's.

── What is not enforced here ────────────────────────────────────────────────
A topic may not be one Device's primary and another's extra. `devices.
source_address` and `device_topics.topic` are each UNIQUE, but a constraint
cannot span the two tables, and a trigger that looked across them would run
under FORCE ROW LEVEL SECURITY and see only the caller's own Client — which is
precisely the case it would need to catch. The API and the CLI refuse it, and
the resolver tries the primary first, so even a duplicate resolves the same
way every time.

Status: OBSERVED (6 Oct 2026) / BUILT. BROKER_OBSERVATIONS §8 has the evidence.

Revision ID: 0030
Revises: 0029
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"
INGEST_ROLE = "solarcms_ingest"
SCHEDULER_ROLE = "solarcms_scheduler"


def upgrade() -> None:
    op.create_table(
        "device_topics",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False),
        # CASCADE: a topic belongs to its Device and means nothing without it.
        sa.Column("device_id", sa.BigInteger,
                  sa.ForeignKey("devices.id", ondelete="CASCADE"), nullable=False),
        # Exactly as the publisher spells it. Case-sensitive, for the reason
        # Guardrail 5 gives: folding would merge two origins.
        sa.Column("topic", sa.Text, nullable=False),
        # Why this topic is this Device's, for the reader a year later.
        sa.Column("note", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("topic", name="uq_device_topics_topic"),
        sa.CheckConstraint("length(btrim(topic)) > 0", name="device_topic_not_blank"),
    )
    op.create_index("ix_device_topics_device", "device_topics", ["device_id"])

    op.execute("ALTER TABLE device_topics ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE device_topics FORCE ROW LEVEL SECURITY")
    # Inherited from `devices`, not restated, so per-User Plant visibility
    # applies without this policy knowing how it is computed.
    op.execute("""
        CREATE POLICY device_topics_via_device ON device_topics
            USING ((client_id = app_client_id() OR app_is_platform_admin())
                   AND device_id IN (SELECT id FROM devices))
            WITH CHECK ((client_id = app_client_id() OR app_is_platform_admin())
                        AND device_id IN (SELECT id FROM devices))
    """)
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON device_topics TO {API_ROLE}")
    # The resolver and the health sweep read it under these roles. A permissive
    # policy is not a GRANT — that pairing has cost this project three times.
    op.execute(f"GRANT SELECT ON device_topics TO {INGEST_ROLE}, {SCHEDULER_ROLE}")
    op.execute("COMMENT ON TABLE device_topics IS "
               "'Topics beyond devices.source_address whose messages are this "
               "Device''s too -- e.g. an Inverter''s PV strings published on "
               "INVERTER_1_STRING16. Resolved by exact match, like the primary. "
               "A topic is never both one Device''s primary and another''s extra; "
               "the API and CLI enforce that, since no constraint spans both tables.'")

    op.execute("""
        CREATE VIEW registered_topics WITH (security_invoker = true) AS
            SELECT d.source_address AS topic, d.id AS device_id, true AS is_primary
              FROM devices d
             WHERE d.source_address IS NOT NULL
            UNION ALL
            SELECT t.topic, t.device_id, false AS is_primary
              FROM device_topics t
    """)
    op.execute(f"GRANT SELECT ON registered_topics "
               f"TO {API_ROLE}, {INGEST_ROLE}, {SCHEDULER_ROLE}")
    op.execute("COMMENT ON VIEW registered_topics IS "
               "'Every topic a Device is registered on: its primary "
               "(devices.source_address) and its extras (device_topics). The one "
               "place to ask which Device owns a topic. security_invoker, so the "
               "caller''s RLS applies.'")


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS registered_topics")
    op.execute("DROP POLICY IF EXISTS device_topics_via_device ON device_topics")
    op.drop_table("device_topics")
