"""Dashboard slots, their candidate sources, and the four-stage SLD mapping.

Every Client wires a Plant differently — one evacuates through an MCR section fed
by two ICR sections, another is a rooftop array whose entire AC side is a net
meter — and the dashboard is nonetheless the same screen for all of them. What
varies is not which figures matter but which Device is in a position to report
them. F-14 called this "configuration-driven dashboards"; these four tables are
that configuration.

A **slot** is a position on the screen (`kpi.current_power`). It owns an ordered
list of **candidates**, each naming a Device Type, a Tag and how to combine
several Devices' readings. The first candidate the Plant is actually bound for
wins, and the resolution reports which one it was, so a tile can say whether
6.32 MW came off a settlement meter or was summed from twelve Inverters.

`assumptions.PLANT_ENERGY_SOURCE_PRECEDENCE` is this same idea applied to two
figures by hand, and it is imported by the seed rather than restated, so those
two keep a single source of truth.

Four objects:

1. **`dashboard_slots`** — platform-owned catalogue, like `tags`. Readable by
   every Client; a slot describes a position, not anyone's data. Distinct from
   `dashboards` (0001), which registers dashboard *types* a User may open.
2. **`dashboard_slot_candidates`** — the ordered sources for a slot.
3. **`plant_dashboard_slot_overrides`** — Client-owned, Plant-scoped, RLS. Where
   a Plant that the default resolves wrongly says so. Expected to be rare and
   empty for most Plants; that it is usually empty is the point of the design.
4. **`device_table_columns`** — which Tags form the columns of a per-Device table
   (the "Inverter Summary" panel), by Device Type.

Plus `device_types.sld_stage`: which of PV Array / Inverters / Transformer / Grid
a Type folds into on the four-stage diagram. A column rather than a code path
because the one genuinely ambiguous Type — a VCB, which sits at transformer bays
on some Plants and MCR feeder positions on others — has to be movable without a
deploy.

⚠ No units, no thresholds, no formulas here. A slot says where a number comes
from, never what it means; Guardrail 6 keeps meaning in `assumptions.py`. That is
what lets this land while OPEN-14, OPEN-15 and OPEN-16 are still open.

⚠ "metric" is a retired synonym for Tag (MASTER §1). Nothing here is named with
it, which is why these are `dashboard_slots` and not `metric_slots`.

Revision ID: 0021
Revises: 0020
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"
SCHEDULER_ROLE = "solarcms_scheduler"

SLD_STAGES = ("PV_ARRAY", "INVERTERS", "TRANSFORMER", "GRID")
CANDIDATE_KINDS = ("device_tag", "plant_attribute", "device_count")
AGGREGATES = ("sum", "avg", "min", "max", "first", "count")

# Columns on `plants` a `plant_attribute` candidate may read. A whitelist, not a
# free-text column name: the resolver interpolates nothing, but a slot pointing at
# a column that later disappears would fail silently for every Plant at once, and
# a CHECK turns that into a migration error instead.
PLANT_ATTRIBUTES = ("dc_capacity_kwp", "ac_capacity_kw")


def _in_list(column: str, values: tuple[str, ...]) -> str:
    rendered = ", ".join(f"'{v}'" for v in values)
    return f"{column} IN ({rendered})"


def upgrade() -> None:
    # ── Which of the four stages a Device Type folds into ────────────────────
    op.add_column("device_types", sa.Column("sld_stage", sa.String(16), nullable=True))
    op.create_check_constraint(
        "sld_stage",
        "device_types",
        f"sld_stage IS NULL OR {_in_list('sld_stage', SLD_STAGES)}",
    )
    op.execute(
        "COMMENT ON COLUMN device_types.sld_stage IS "
        "'Which of the four fixed SLD stages this Type folds into. NULL means the "
        "Type carries no current and is not drawn (MASTER §2.3) — a Weather Station "
        "is a real, monitored Device that does not belong in an electrical diagram. "
        "A column rather than a code path because a VCB sits at a transformer bay on "
        "one Plant and an MCR feeder position on another, and moving it must not be "
        "a deploy.'"
    )
    # Every in-power-path Type ought to have a stage, but this is not enforced by
    # a constraint: F-12 makes the catalogue extensible, and a new Type should be
    # insertable before anyone has decided where it belongs on the diagram. It
    # surfaces instead as `unstaged` in the SLD response, which is visible rather
    # than silent.

    # ── The slot catalogue ───────────────────────────────────────────────────
    op.execute("""
        CREATE TABLE dashboard_slots (
            id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code          TEXT        NOT NULL UNIQUE,
            label         TEXT        NOT NULL,
            panel         TEXT        NOT NULL,
            position      INTEGER     NOT NULL,
            unit_hint     TEXT,
            hide_when_unresolved  BOOLEAN NOT NULL DEFAULT TRUE,
            fallback_when_silent  BOOLEAN NOT NULL DEFAULT TRUE,
            enabled       BOOLEAN     NOT NULL DEFAULT TRUE,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_dashboard_slots_panel_position UNIQUE (panel, position)
        )
    """)
    op.execute(
        "COMMENT ON TABLE dashboard_slots IS "
        "'A position on the fixed dashboard — kpi.current_power, not \"the ABT "
        "Meter''s AC_ACTIVE_POWER\". Platform-owned and readable by every Client: a "
        "slot describes a position, not anyone''s data. Not to be confused with "
        "`dashboards`, which registers the dashboard types a User may open.'"
    )
    op.execute(
        "COMMENT ON COLUMN dashboard_slots.hide_when_unresolved IS "
        "'Hide the slot entirely when no candidate is bound, rather than showing an "
        "empty tile. A rooftop Plant has no winding temperature, and a permanent "
        "dash beside a transformer icon reads as a fault. Headline tiles set this "
        "FALSE and show an honest dash.'"
    )
    op.execute(
        "COMMENT ON COLUMN dashboard_slots.fallback_when_silent IS "
        "'When TRUE, a candidate that is bound but currently reporting nothing is "
        "passed over for the next one and the result is flagged degraded. The "
        "operational panel must show something when the settlement meter goes quiet; "
        "a Financial Report must not, and never resolves through here (I-8).'"
    )

    op.execute(f"""
        CREATE TABLE dashboard_slot_candidates (
            id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            slot_id       BIGINT  NOT NULL REFERENCES dashboard_slots(id) ON DELETE CASCADE,
            priority      INTEGER NOT NULL,
            kind          TEXT    NOT NULL,
            device_type_id BIGINT REFERENCES device_types(id) ON DELETE CASCADE,
            tag_id        BIGINT REFERENCES tags(id) ON DELETE CASCADE,
            aggregate     TEXT    NOT NULL DEFAULT 'first',
            plant_attribute TEXT,
            online_only   BOOLEAN NOT NULL DEFAULT FALSE,
            CONSTRAINT uq_slot_candidate_priority UNIQUE (slot_id, priority),
            CONSTRAINT ck_dashboard_slot_candidates_kind
                CHECK ({_in_list('kind', CANDIDATE_KINDS)}),
            CONSTRAINT ck_dashboard_slot_candidates_aggregate
                CHECK ({_in_list('aggregate', AGGREGATES)}),
            CONSTRAINT ck_dashboard_slot_candidates_plant_attribute
                CHECK (plant_attribute IS NULL
                       OR {_in_list('plant_attribute', PLANT_ATTRIBUTES)}),
            -- Each kind needs exactly the fields it can use, and no others. A
            -- device_tag candidate with a NULL tag_id resolves to nothing for
            -- every Plant forever and reports no error, which is the failure mode
            -- that motivated _validate_formulas in the seed.
            CONSTRAINT ck_dashboard_slot_candidates_shape CHECK (
                (kind = 'device_tag'
                     AND device_type_id IS NOT NULL AND tag_id IS NOT NULL
                     AND plant_attribute IS NULL AND NOT online_only)
                OR (kind = 'plant_attribute'
                     AND plant_attribute IS NOT NULL
                     AND device_type_id IS NULL AND tag_id IS NULL AND NOT online_only)
                OR (kind = 'device_count'
                     AND device_type_id IS NOT NULL
                     AND tag_id IS NULL AND plant_attribute IS NULL)
            )
        )
    """)
    op.execute(
        "CREATE INDEX ix_slot_candidates_slot "
        "ON dashboard_slot_candidates (slot_id, priority)"
    )
    op.execute(
        "COMMENT ON TABLE dashboard_slot_candidates IS "
        "'Ordered sources for one slot: prefer the settlement meter, else an MFM, "
        "else sum the Inverters. Priority ascending; the first candidate the Plant "
        "is bound for wins. Named by Device Type, never by Device or Plant "
        "(Guardrail 2), so a Plant with three MFMs and a Plant with one resolve "
        "through the same row.'"
    )
    op.execute(
        "COMMENT ON COLUMN dashboard_slot_candidates.aggregate IS "
        "'How several Devices'' readings become one number. Not cosmetic: eight "
        "Inverters produce eight lots of power, which sum, but sit at roughly one "
        "DC voltage, which does not. Summing an intensive quantity yields a "
        "physically meaningless number that still looks plausible on a tile.'"
    )

    # ── Per-Plant deviations. Client-owned, so RLS applies. ──────────────────
    op.execute("""
        CREATE TABLE plant_dashboard_slot_overrides (
            id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id     BIGINT  NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
            plant_id      BIGINT  NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
            slot_id       BIGINT  NOT NULL REFERENCES dashboard_slots(id) ON DELETE CASCADE,
            -- NULL candidate fields with hidden = TRUE means "do not show this
            -- slot on this Plant" without proposing a different source.
            kind          TEXT,
            device_type_id BIGINT REFERENCES device_types(id) ON DELETE CASCADE,
            tag_id        BIGINT REFERENCES tags(id) ON DELETE CASCADE,
            aggregate     TEXT,
            plant_attribute TEXT,
            online_only   BOOLEAN NOT NULL DEFAULT FALSE,
            hidden        BOOLEAN NOT NULL DEFAULT FALSE,
            note          TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_plant_slot_override UNIQUE (plant_id, slot_id)
        )
    """)
    op.execute(
        "COMMENT ON TABLE plant_dashboard_slot_overrides IS "
        "'Where the default candidate order resolves wrongly for one Plant — most "
        "often a Plant with parallel feeder metering, where the default `first` "
        "under-reports and `sum` is correct. Expected to be empty for almost every "
        "Plant: that it is usually empty is what distinguishes this from a "
        "per-Plant dashboard, which Guardrail 2 forbids. `note` records why, "
        "because a year later nobody remembers.'"
    )

    # ── Per-Device table columns (the Inverter Summary panel, generalised) ───
    op.execute("""
        CREATE TABLE device_table_columns (
            id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            device_type_id BIGINT  NOT NULL REFERENCES device_types(id) ON DELETE CASCADE,
            tag_id         BIGINT  NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            position       INTEGER NOT NULL,
            CONSTRAINT uq_device_table_column UNIQUE (device_type_id, tag_id),
            CONSTRAINT uq_device_table_column_position UNIQUE (device_type_id, position)
        )
    """)
    op.execute(
        "COMMENT ON TABLE device_table_columns IS "
        "'Which Tags become the columns of a per-Device table, by Device Type. A "
        "Device missing one renders an empty cell; the column disappears only when "
        "no Device of the Type is bound to that Tag anywhere on the Plant.'"
    )

    # ── Grants ───────────────────────────────────────────────────────────────
    # Platform catalogue: readable by every Client, written only through the owner
    # connection by a system.admin, exactly as `tags` and `device_types` are.
    catalog = "dashboard_slots, dashboard_slot_candidates, device_table_columns"
    op.execute(f"GRANT SELECT ON {catalog} TO {API_ROLE}")
    op.execute(f"GRANT SELECT ON {catalog} TO {SCHEDULER_ROLE}")

    # ⚠ A permissive policy is not a GRANT (0015 → 0017). Both, for the overrides.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON plant_dashboard_slot_overrides "
        f"TO {API_ROLE}"
    )
    op.execute(
        f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {API_ROLE}"
    )

    op.execute("ALTER TABLE plant_dashboard_slot_overrides ENABLE ROW LEVEL SECURITY")
    # FORCE so the owner is subject too — the commonest way this is silently lost.
    op.execute("ALTER TABLE plant_dashboard_slot_overrides FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY plant_dashboard_slot_overrides_client_isolation
            ON plant_dashboard_slot_overrides
            USING ((client_id = app_client_id() OR app_is_platform_admin())
                   AND app_can_see_plant(plant_id))
            WITH CHECK ((client_id = app_client_id() OR app_is_platform_admin())
                        AND app_can_see_plant(plant_id))
    """)


def downgrade() -> None:
    for table in (
        "plant_dashboard_slot_overrides",
        "device_table_columns",
        "dashboard_slot_candidates",
        "dashboard_slots",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    # ⚠ The bare name, not the prefixed one. `drop_constraint` applies the same
    # `ck_%(table_name)s_%(constraint_name)s` convention (db/base.py) that
    # `create_check_constraint` did, so passing the full name here produces
    # `ck_device_types_ck_device_types_sld_stage` and the downgrade fails on a
    # constraint that does not exist — the doubling 0020's docstring warns about,
    # in its less obvious direction.
    op.drop_constraint("sld_stage", "device_types", type_="check")
    op.drop_column("device_types", "sld_stage")
