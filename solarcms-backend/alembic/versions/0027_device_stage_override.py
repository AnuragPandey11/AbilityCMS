"""Let one Device sit in a different stage than its Type implies.

The four-stage spine folds every power-path Device into PV Array → Inverters →
Transformer → Grid by **Device Type** (`device_types.sld_stage`). That is what
makes two Plants comparable: four boxes, same order, whatever the Plant
contains. It is also the one thing it cannot express — that a particular Device
sits somewhere its Type does not usually sit.

The case that forces it: an LT feeder meter wired between the Inverters and the
Transformer is `Type = MFM`, so it folds into **Grid**, the rightmost box, while
the wiring puts it third from the left. The Plant schematic (derived from
`parent_device_id`) and the spine then show the same meter in two different
places, and nothing reconciles them.

Changing `device_types.sld_stage` is not the fix. That column is global — it
would move every MFM on every Plant of every Client, to describe one meter on
one site.

── Why this column and not a per-Plant table ────────────────────────────────
The exception belongs to a Device, not to a Plant: a Plant does not have a stage
opinion, one piece of its equipment does. A nullable column on `devices` says
exactly that, costs nothing when unset, and needs no join. It is expected to be
**NULL almost everywhere** — in the manner of `plant_dashboard_slot_overrides`,
whose emptiness is the sign the defaults are right rather than a gap.

⚠ It is never set by inference. `domain/sld_conflicts.py` detects that wiring and
stage assignment contradict each other and offers the assignments that would
satisfy both; a human accepts one, and that acceptance is what lands here. An
override is re-validated afterwards, so one the wiring has since made
unnecessary is reported stale rather than quietly outliving its reason.

Revision ID: 0027
Revises: 0026
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None

# Kept in step with `domain/sld_stages.SLD_STAGES`. A constraint rather than a
# free string: a typo here would silently drop a Device out of the diagram,
# which is the failure this whole feature exists to stop.
STAGES = ("PV_ARRAY", "INVERTERS", "TRANSFORMER", "GRID")


def upgrade() -> None:
    op.add_column(
        "devices", sa.Column("sld_stage_override", sa.String(16), nullable=True)
    )
    op.create_check_constraint(
        "ck_devices_sld_stage_override",
        "devices",
        "sld_stage_override IS NULL OR sld_stage_override IN "
        f"({', '.join(repr(s) for s in STAGES)})",
    )
    op.execute(
        "COMMENT ON COLUMN devices.sld_stage_override IS "
        "'Stage this Device folds into on the four-stage diagram, overriding "
        "device_types.sld_stage for this Device alone. NULL means the Type "
        "default, which is the normal case. Set only by a human accepting a "
        "reported conflict between the wiring and the Type default.'"
    )


def downgrade() -> None:
    op.drop_constraint("ck_devices_sld_stage_override", "devices", type_="check")
    op.drop_column("devices", "sld_stage_override")
