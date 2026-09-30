"""Let a dashboard slot read how far a lifetime register advanced since midnight.

Today's export and import sit in the Energy Summary as `ENERGY_EXPORT_TODAY` /
`ENERGY_IMPORT_TODAY`: the meter's own daily register, which resets at the
Plant's midnight. A meter that publishes only its lifetime registers
(`ENERGY_EXPORT_TOTAL` / `ENERGY_IMPORT_TOTAL`) answered neither, and both rows
disappeared from the screen with nothing said.

A fourth candidate kind, `counter_today`, answers them from the lifetime
register: where it stands now less where it stood at the Plant's midnight —
the subtraction settlement makes from a meter's midnight readings, integrated
by `domain/counters` exactly as the KPI endpoint and the Daily Plant report
integrate it, so the three cannot disagree over the same day. It is ranked
after the meter's own daily register, never before: a published value beats a
computed one.

It needs the same fields as `device_tag` — a Device Type and a Tag — and only
the aggregates under which energy adds (`sum`, `first`). The shape CHECK says
so, for the reason 0021 gives: a candidate missing a field resolves to nothing
for every Plant, for ever, and reports no error.

`plant_dashboard_slot_overrides.kind` carries no CHECK (0021) and is left alone.

The candidate rows themselves arrive from `cli seed`, which rewrites every
candidate list from `domain/dashboard_spec.py`.

Revision ID: 0029
Revises: 0028
"""

from __future__ import annotations

from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None

# Literal snapshots, never imported: a migration must replay the same way for ever.
KINDS_BEFORE = ("device_tag", "plant_attribute", "device_count")
KINDS_AFTER = (*KINDS_BEFORE, "counter_today")

SHAPE_BEFORE = """
    (kind = 'device_tag'
         AND device_type_id IS NOT NULL AND tag_id IS NOT NULL
         AND plant_attribute IS NULL AND NOT online_only)
    OR (kind = 'plant_attribute'
         AND plant_attribute IS NOT NULL
         AND device_type_id IS NULL AND tag_id IS NULL AND NOT online_only)
    OR (kind = 'device_count'
         AND device_type_id IS NOT NULL
         AND tag_id IS NULL AND plant_attribute IS NULL)
"""
SHAPE_AFTER = SHAPE_BEFORE + """
    OR (kind = 'counter_today'
         AND device_type_id IS NOT NULL AND tag_id IS NOT NULL
         AND plant_attribute IS NULL AND NOT online_only
         AND aggregate IN ('sum', 'first'))
"""


def _in_list(column: str, values: tuple[str, ...]) -> str:
    rendered = ", ".join(f"'{v}'" for v in values)
    return f"{column} IN ({rendered})"


def _replace_checks(kinds: tuple[str, ...], shape: str) -> None:
    op.execute(f"""
        ALTER TABLE dashboard_slot_candidates
            DROP CONSTRAINT ck_dashboard_slot_candidates_kind,
            DROP CONSTRAINT ck_dashboard_slot_candidates_shape,
            ADD CONSTRAINT ck_dashboard_slot_candidates_kind
                CHECK ({_in_list('kind', kinds)}),
            ADD CONSTRAINT ck_dashboard_slot_candidates_shape CHECK ({shape})
    """)


def upgrade() -> None:
    _replace_checks(KINDS_AFTER, SHAPE_AFTER)


def downgrade() -> None:
    # The old CHECK would refuse the new rows, so they go first. `cli seed` on
    # the older code writes the candidate lists that code expects.
    op.execute("DELETE FROM dashboard_slot_candidates WHERE kind = 'counter_today'")
    _replace_checks(KINDS_BEFORE, SHAPE_BEFORE)
