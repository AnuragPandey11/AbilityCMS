"""The Collector is a grouping, not a Device.

`scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}` has always
carried a Collector segment, and commissioning-from-broker turned it into a
Device — an `MCR_SECTION` row with no topic of its own that every Device beneath
it pointed at through `reports_via_device_id`. The client confirmed on
2026-09-19 that this is wrong: **a Collector is a logical enclosure — an MCR, an
ICR, a panel — that holds Devices. It is never itself a Device.** It publishes
nothing, it carries no current, and drawing it as a box in the Single Line
Diagram claims a piece of equipment exists that does not.

So the Collector becomes what it is: a *name on the Devices inside it*.

    devices.collector_code   the enclosure this Device sits in, or NULL

NULL is a first-class answer, not missing data. The same client also publishes
`scms/v1/{client_code}/{plant_code}/{device_code}` — five segments, no Collector
— and a Device on that shape genuinely has no enclosure. The UI draws those
outside every box rather than inventing an "Unassigned" one.

── Why a column and not a table ─────────────────────────────────────────────
A Collector has no attributes. It has a name, it comes from the topic, and its
membership is the only fact about it. A `collectors` table would add a join to
every Device query and an FK to maintain in exchange for nothing the topic does
not already say. `blocks` earns its table because a Block carries capacity that
PR and specific yield are computed from; a Collector carries nothing.

── What this is NOT ─────────────────────────────────────────────────────────
It is not a fourth grouping competing with the three of MASTER §3.4. It is the
*communication* grouping's name, sitting beside `reports_via_device_id` rather
than replacing it: `reports_via_device_id` still records one Device transmitting
another (a real datalogger, registered as a Device, that relays an Inverter's
Modbus), which is a different claim from "these two live in the same room".
Both survive, and the health sweep correlates on whichever is present.

It is not a Block either (Guardrail 11 stands). A Block is geographic and
carries capacity; a Collector is a communications enclosure and carries none.
Neither appears in the electrical tree — a Collector is drawn *around* the
Devices in it, never as a node in the chain.

⚠ Status: CONFIRMED (client, 2026-09-19) / IN SCHEMA. MASTER §10 carries the
change-log row. Existing Collector-Devices are not removed here: deleting rows a
human registered is a decision, not a schema change. `python -m solarcms.cli
collectors-from-topics` backfills this column from `source_address` and offers
to retire the Collector-Devices that commissioning created, dry-run by default.

Revision ID: 0022
Revises: 0021
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "devices", sa.Column("collector_code", sa.String(64), nullable=True)
    )
    # Every screen that draws a Collector asks the same question — "which
    # Devices are in this enclosure, at this Plant" — so the index carries the
    # Plant first. Partial: a Plant publishing on the five-segment shape has no
    # Collector on any row, and indexing those NULLs helps nothing.
    op.create_index(
        "ix_devices_plant_collector", "devices", ["plant_id", "collector_code"],
        postgresql_where=sa.text("collector_code IS NOT NULL"),
    )
    # A Collector named by the empty string is not a Collector. The topic
    # resolver already rejects an empty segment; this stops the API and a
    # backfill from writing one by a different route.
    op.create_check_constraint(
        "collector_code_not_blank", "devices",
        "collector_code IS NULL OR length(btrim(collector_code)) > 0",
    )


def downgrade() -> None:
    # The bare name: `create_check_constraint` applied the
    # `ck_%(table_name)s_%(constraint_name)s` convention from db/base.py, and
    # `drop_constraint` applies it again — passing the full name here produces
    # `ck_devices_ck_devices_collector_code_not_blank` and fails (0021).
    op.drop_constraint("collector_code_not_blank", "devices", type_="check")
    op.drop_index("ix_devices_plant_collector", table_name="devices")
    op.drop_column("devices", "collector_code")
