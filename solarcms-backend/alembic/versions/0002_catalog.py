"""Catalog: device_types, device_models, tags. Global and platform-owned.

Revision ID: 0002
Revises: 0001
"""

from __future__ import annotations

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE device_types (
            id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code          VARCHAR(32) NOT NULL UNIQUE,
            name          TEXT        NOT NULL,
            in_power_path BOOLEAN     NOT NULL DEFAULT false,
            variant_set   TEXT[],
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("COMMENT ON COLUMN device_types.in_power_path IS "
               "'Determines Single Line Diagram membership. A Device outside the power "
               "path is monitored but carries no current; placing it in the electrical "
               "tree would corrupt the diagram (MASTER 2.3).'")

    op.execute("""
        CREATE TABLE device_models (
            id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            device_type_id    BIGINT      NOT NULL REFERENCES device_types(id),
            manufacturer      TEXT        NOT NULL,
            model_code        TEXT        NOT NULL,
            variant           VARCHAR(32),
            rated_capacity_kw DOUBLE PRECISION,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_device_models_manufacturer_model_code
                UNIQUE (manufacturer, model_code)
        )
    """)
    op.execute("COMMENT ON COLUMN device_models.variant IS "
               "'Variants belong to the Model, not the Device: a Sungrow SG250HX is "
               "always a string inverter (MASTER 2.3).'")

    op.execute("""
        CREATE TABLE tags (
            id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code           VARCHAR(64)      NOT NULL UNIQUE,
            name           TEXT             NOT NULL,
            unit           VARCHAR(32)      NOT NULL,
            category       VARCHAR(32)      NOT NULL DEFAULT 'performance',
            rollup_method  VARCHAR(8)       NOT NULL DEFAULT 'avg',
            scale_default  DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            valid_min      DOUBLE PRECISION,
            valid_max      DOUBLE PRECISION,
            min_interval_s INTEGER          NOT NULL DEFAULT 60,
            is_cumulative  BOOLEAN          NOT NULL DEFAULT false,
            created_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
            CONSTRAINT ck_tags_tag_category CHECK (category IN
                ('performance','electrical','diagnostic','environmental','status')),
            CONSTRAINT ck_tags_tag_rollup_method
                CHECK (rollup_method IN ('avg','last','max'))
        )
    """)
    op.execute("COMMENT ON TABLE tags IS "
               "'The canonical metric registry. I-2: no Tag is ever a column — adding a "
               "metric is an INSERT. This is the decision that makes F-12 and F-14 "
               "possible.'")
    op.execute("COMMENT ON COLUMN tags.rollup_method IS "
               "'Carried per Tag because a continuous aggregate cannot infer it from the "
               "value: avg for power, last for cumulative counters, max for peaks. "
               "Averaging a cumulative energy counter is meaningless.'")
    op.execute("COMMENT ON COLUMN tags.scale_default IS "
               "'⚠ ASSUMED, seeded from domain/assumptions.py. Wrong until the client "
               "supplies the real table (OPEN-15). The authoritative scale is per-Device, "
               "in device_tag_bindings.'")

    op.execute("""
        CREATE TABLE device_model_tags (
            device_model_id    BIGINT NOT NULL
                REFERENCES device_models(id) ON DELETE CASCADE,
            tag_id             BIGINT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            default_source_key TEXT,
            PRIMARY KEY (device_model_id, tag_id)
        )
    """)
    op.execute("COMMENT ON TABLE device_model_tags IS "
               "'A template only. What a specific Device was actually wired as lives in "
               "device_tag_bindings, because field wiring never matches the datasheet.'")


def downgrade() -> None:
    for table in ("device_model_tags", "tags", "device_models", "device_types"):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
