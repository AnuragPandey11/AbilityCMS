"""Calculated Tags, repeating signal groups, and the Plant KPI writer's grants.

The client's signal schedule (third revision, `docs/TAG_CATALOGUE.md` §2.15)
supplies three things the schema could not yet hold:

1. **Rows marked "Need to Calculate", with the arithmetic beside them.** AVG
   VOLTAGE, TOTAL CURRENT, DC POWER, SPECIFIC YIELD, PR. These are Tags the
   platform computes rather than receives, so `tags` gains `formula` — the
   expression, as text — and `derived_scope`, which says whether its inputs come
   from one Device or from a whole Plant. The formula is *data*: adding a
   calculated metric stays an INSERT, exactly as I-2 requires of measured ones,
   and no Plant or Device name can ever reach a code path through it
   (Guardrail 2). `domain/derived.py` is the only thing that evaluates it, and it
   parses against a whitelist, so a formula an administrator types cannot call
   anything.

2. **PV1..PV28 per-string inputs on the Inverter.** How many strings a given
   Inverter has is a property of the *unit*, not the Model — the same datasheet
   covers a 12-string and a 24-string machine — so `devices.string_count` records
   it and `device_model_tags.repeat_index` marks which template rows belong to
   the group. Binding a Device then takes the first `string_count` of them. The
   alternative, a Model per string count, multiplies the catalogue by 28 and
   still cannot express a unit with a dead input.

3. **A Plant-level KPI panel** — the sheet's `DASHBOARD` Device, carrying PR,
   CUF, peak power, plant start/stop time and the functional-Inverter count.
   Those are written by the scheduler, which is the only process that sees a
   whole Plant at once, so it needs INSERT on `readings` and SELECT on the
   bindings it reads. ⚠ The scheduler's existing policies are a reminder that a
   permissive policy is not a GRANT (0015 → 0017): both are granted here.

`sort_order` on `device_model_tags` exists so a Model's signal list can be shown
in the order the client's own sheet lists it. Alphabetical ordering of eighty
PV-string rows is unreadable to the engineer commissioning the Device, and they
are the person this screen is for.

Revision ID: 0020
Revises: 0019
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"
SCHEDULER_ROLE = "solarcms_scheduler"
INGEST_ROLE = "solarcms_ingest"


def upgrade() -> None:
    # ── Calculated Tags ──────────────────────────────────────────────────────
    op.add_column("tags", sa.Column("formula", sa.Text(), nullable=True))
    op.add_column("tags", sa.Column("derived_scope", sa.String(16), nullable=True))

    # `is_derived` is not a separate flag to be kept in step with `formula`: a Tag
    # is derived exactly when it has one. A boolean beside the text is two places
    # to disagree, and the disagreement would be silent.
    #
    # ⚠ The name passed here carries no `ck_<table>_` prefix. The metadata naming
    # convention (`db/base.py`) is `ck_%(table_name)s_%(constraint_name)s`, so a
    # prefixed name comes out doubled — `ck_tags_ck_tags_derived_scope` — and the
    # downgrade then drops a constraint that does not exist.
    op.create_check_constraint(
        "derived_scope", "tags",
        "(formula IS NULL AND derived_scope IS NULL) OR "
        "(formula IS NOT NULL AND derived_scope IN ('device','plant'))",
    )
    op.execute("COMMENT ON COLUMN tags.formula IS "
               "'Arithmetic over other Tag codes, evaluated by domain/derived.py. "
               "NULL means the value is published by a Device rather than computed. "
               "A published value always wins over a computed one.'")
    op.execute("COMMENT ON COLUMN tags.derived_scope IS "
               "'device: inputs are this Device''s own Tags, evaluated in ingest. "
               "plant: inputs are dotted aggregates over a Plant (SUM.TAG), "
               "evaluated by the scheduler, which is the only process that sees a "
               "whole Plant at once.'")

    # ── Repeating signal groups ──────────────────────────────────────────────
    op.add_column("device_model_tags", sa.Column("repeat_index", sa.Integer(), nullable=True))
    op.add_column(
        "device_model_tags",
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_check_constraint(
        "repeat_index", "device_model_tags",
        "repeat_index IS NULL OR repeat_index >= 1",
    )
    op.execute("COMMENT ON COLUMN device_model_tags.repeat_index IS "
               "'Position within a repeating group (PV1..PV28). NULL for a signal "
               "that appears once. A Device binds rows up to devices.string_count.'")

    op.add_column("devices", sa.Column("string_count", sa.Integer(), nullable=True))
    op.create_check_constraint(
        "string_count", "devices",
        "string_count IS NULL OR (string_count >= 0 AND string_count <= 512)",
    )
    op.execute("COMMENT ON COLUMN devices.string_count IS "
               "'How many inputs of a repeating group this unit actually has. A "
               "property of the unit, not of the Model: the same datasheet covers "
               "a 12-string and a 24-string machine.'")

    # ── The Plant KPI writer ─────────────────────────────────────────────────
    # ⚠ A permissive policy is not a GRANT. Migration 0015 gave the scheduler
    # policies but no privilege on some of what it reads, and 0017 had to repair
    # the same mistake for the health sweeper: every sweep failed, logged it, and
    # slept, with comm_status NULL fleet-wide and nothing else noticing.
    op.execute(f"GRANT INSERT ON readings TO {SCHEDULER_ROLE}")
    op.execute(f"GRANT SELECT ON device_tag_bindings TO {SCHEDULER_ROLE}")
    op.execute(f"GRANT SELECT ON plant_device_counts TO {SCHEDULER_ROLE}")
    # `readings` carries no RLS by design (a compressed hypertable refuses it,
    # BACKEND_SPEC §5.4), so the GRANT is the whole of the permission and there is
    # no policy to add. The scheduler's own predicate is what scopes it, which is
    # the one place isolation is not inherited from the database.
    # Dropped first so a re-run after a failed attempt does not stop on "policy
    # already exists" — which turns one fixable error into two.
    op.execute("DROP POLICY IF EXISTS device_tag_bindings_scheduler "
               "ON device_tag_bindings")
    op.execute(f"""
        CREATE POLICY device_tag_bindings_scheduler ON device_tag_bindings
            TO {SCHEDULER_ROLE} USING (true)
    """)

    # The ingest worker writes derived Readings alongside measured ones, on the
    # same COPY. It already holds INSERT on readings; what it lacked was the
    # formula text, which it now reads through the resolver.
    op.execute(f"GRANT SELECT ON tags TO {INGEST_ROLE}")

    # The catalogue is platform-owned, but a Super Admin edits it through the API
    # — a Model's signal list, a Tag's formula, a Device's string count.
    op.execute(f"GRANT INSERT, UPDATE, DELETE ON device_model_tags TO {API_ROLE}")
    op.execute(f"GRANT INSERT, UPDATE ON device_models TO {API_ROLE}")
    op.execute(f"GRANT INSERT, UPDATE ON device_types TO {API_ROLE}")
    op.execute(f"GRANT UPDATE ON tags TO {API_ROLE}")

    op.create_index(
        "ix_device_model_tags_model_sort", "device_model_tags",
        ["device_model_id", "sort_order"],
    )


def downgrade() -> None:
    op.drop_index("ix_device_model_tags_model_sort", table_name="device_model_tags")
    op.execute("DROP POLICY IF EXISTS device_tag_bindings_scheduler ON device_tag_bindings")
    op.execute(f"REVOKE INSERT ON readings FROM {SCHEDULER_ROLE}")
    op.execute(f"REVOKE SELECT ON device_tag_bindings FROM {SCHEDULER_ROLE}")
    op.execute(f"REVOKE SELECT ON plant_device_counts FROM {SCHEDULER_ROLE}")
    op.execute(f"REVOKE SELECT ON tags FROM {INGEST_ROLE}")
    op.execute(f"REVOKE INSERT, UPDATE, DELETE ON device_model_tags FROM {API_ROLE}")
    op.execute(f"REVOKE INSERT, UPDATE ON device_models FROM {API_ROLE}")
    op.execute(f"REVOKE INSERT, UPDATE ON device_types FROM {API_ROLE}")
    op.execute(f"REVOKE UPDATE ON tags FROM {API_ROLE}")

    # IF EXISTS, and both spellings. An earlier revision of this migration named
    # these with a `ck_<table>_` prefix that the metadata naming convention then
    # doubled, so a database that ran that version carries the doubled name and
    # one that ran this version carries the plain one. Reversing must work on
    # both, and dropping a column takes its constraint anyway — these statements
    # only keep the reversal explicit.
    for table, name in (
        ("devices", "string_count"),
        ("device_model_tags", "repeat_index"),
        ("tags", "derived_scope"),
    ):
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS ck_{table}_{name}")
        op.execute(
            f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS ck_{table}_ck_{table}_{name}"
        )

    op.drop_column("devices", "string_count")
    op.drop_column("device_model_tags", "sort_order")
    op.drop_column("device_model_tags", "repeat_index")
    op.drop_column("tags", "derived_scope")
    op.drop_column("tags", "formula")
