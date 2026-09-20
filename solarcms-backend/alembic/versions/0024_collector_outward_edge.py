"""Give a Collector somewhere to hang its outward connection.

Migration 0022 established what a Collector *is*: an enclosure — an MCR, an
ICR, a panel — named by one segment of the topic, holding equipment, carrying
no current, and drawn as a box around its Devices rather than as one of them.
That is still true and nothing here weakens it.

What 0022 left unanswerable is the question every real single line diagram asks
next: **what does the room feed into?** Seventeen Inverters in the MCR do not
each run their own cable to the transformer; the MCR has one outgoing
connection. Expressed per-Device, that is seventeen identical
`parent_device_id` values which the reader has to notice are identical, and
which say nothing about the box itself. Expressed once, on the box, it is the
one fact the diagram is trying to show.

So the Collector gets a row — and only a row.

    plant_collectors(plant_id, code, parent_device_id)

⚠ **This is not a Device and must never become one** (Guardrail 12). It has no
Device Model, no Device Type, no Tags, no bindings, no topic and no Readings. It
cannot be selected as a Device anywhere, it never appears in a Device list, and
`devices` gains no foreign key to it. It carries exactly one piece of
information beyond its name: what it connects to.

── Membership stays on the Device, and stays derived from the topic ─────────
`devices.collector_code` remains the authority for *which* Devices are inside,
because that comes from the topic and the topic is the sole authority for
origin (Guardrail 5). This table does not list members and must not: a row here
is not required for a Collector to exist. Sixteen Devices can share
`collector_code = 'MCR'` with no row in this table at all, and the box still
draws.

A row appears only when somebody has said something *about* the enclosure —
today, only what it feeds into. The table is therefore expected to be sparse,
in the manner of `plant_dashboard_slot_overrides`: its emptiness is normal, not
a gap, and the join is LEFT everywhere.

── The boundary rule ────────────────────────────────────────────────────────
With an edge available on the box, a Device inside a Collector no longer has
any business pointing at a Device outside it — the room's connection is the
room's, not each occupant's. That rule is enforced in the API against
`domain/sld.crosses_collector_boundary`, not by a constraint here, for the same
reason cycle detection lives there: a CHECK cannot see another row, and a
composite foreign key would be satisfied vacuously whenever `collector_code` is
NULL (MATCH SIMPLE), which is exactly the case it would most need to catch.

Status: CONFIRMED (client, 19 Sep 2026) / BUILT. MASTER §10 carries the row.

Revision ID: 0024
Revises: 0023
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"


def upgrade() -> None:
    op.create_table(
        "plant_collectors",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), primary_key=True),
        sa.Column("client_id", sa.BigInteger,
                  sa.ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("plant_id", sa.BigInteger,
                  sa.ForeignKey("plants.id", ondelete="CASCADE"), nullable=False),
        # The enclosure's name, exactly as the topic spells it. Case-sensitive,
        # for the reason Guardrail 5 gives: folding would merge two origins.
        sa.Column("code", sa.String(64), nullable=False),
        # What the room feeds into. NULL is a real answer — an enclosure whose
        # outward connection nobody has recorded yet, which is every Collector
        # the moment it first appears on the broker.
        sa.Column("parent_device_id", sa.BigInteger, nullable=True),
        # Why it is wired that way, for the reader a year later.
        sa.Column("note", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint("plant_id", "code", name="uq_plant_collectors_plant_code"),
        # I-3 applied to the box: a Collector cannot feed into a Device at
        # another Plant. Structural, exactly as `fk_parent_same_plant` is for a
        # Device, so no code path can bypass it.
        sa.ForeignKeyConstraint(
            ["parent_device_id", "plant_id"], ["devices.id", "devices.plant_id"],
            name="fk_collector_parent_same_plant",
        ),
        sa.CheckConstraint("length(btrim(code)) > 0", name="collector_code_not_blank"),
    )
    op.create_index("ix_plant_collectors_plant", "plant_collectors", ["plant_id"])

    op.execute("ALTER TABLE plant_collectors ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE plant_collectors FORCE ROW LEVEL SECURITY")
    # Inherited from `plants`, not restated: per-User Plant assignment is
    # honoured without this policy knowing `user_plant_access` exists (0019).
    op.execute("""
        CREATE POLICY plant_collectors_via_plant ON plant_collectors
            USING (plant_id IN (SELECT id FROM plants))
            WITH CHECK (plant_id IN (SELECT id FROM plants))
    """)
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON plant_collectors TO {API_ROLE}")
    op.execute("COMMENT ON TABLE plant_collectors IS "
               "'Per-Collector facts -- today only what the enclosure feeds into. "
               "NOT a Device and never to become one: no Model, no Tags, no topic, "
               "no Readings. Membership stays on devices.collector_code, which "
               "comes from the topic; a Collector needs no row here to exist, so "
               "this table is expected to be sparse.'")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS plant_collectors_via_plant ON plant_collectors")
    op.drop_table("plant_collectors")
