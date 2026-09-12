"""Assets: regions, plants, blocks, devices, bindings, ingress registry.

No `locations` table — the Location hierarchy level is retired entirely
(MASTER §2.1). Block covers the Client-defined-subdivision case it was meant for.

Revision ID: 0003
Revises: 0002
"""

from __future__ import annotations

from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE regions (
            id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code    VARCHAR(32) NOT NULL UNIQUE,
            name    TEXT        NOT NULL,
            country VARCHAR(2)  NOT NULL DEFAULT 'IN',
            grid_emission_factor_kg_per_kwh NUMERIC(6,4),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("COMMENT ON COLUMN regions.grid_emission_factor_kg_per_kwh IS "
               "'CO2-avoided varies by grid, so it belongs to the Region rather than "
               "being a constant (tender 18).'")

    op.execute("""
        CREATE TABLE plants (
            id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id       BIGINT      NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
            region_id       BIGINT      REFERENCES regions(id),
            code            VARCHAR(64) NOT NULL,
            name            TEXT        NOT NULL,
            status          VARCHAR(32) NOT NULL DEFAULT 'draft',
            ac_capacity_kw  NUMERIC(12,2),
            dc_capacity_kwp NUMERIC(12,2),
            latitude        NUMERIC(9,6),
            longitude       NUMERIC(9,6),
            timezone        VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
            commissioned_on DATE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_plants_client_id_code UNIQUE (client_id, code),
            CONSTRAINT ck_plants_plant_status CHECK (status IN
                ('draft','commissioning','active','decommissioned'))
        )
    """)
    op.execute("COMMENT ON COLUMN plants.status IS "
               "'A Plant in draft or commissioning is excluded from Portfolio aggregates, "
               "so a half-mapped Plant never drags fleet PR down (MASTER 6.5).'")

    # Plant Assignment — dimension A-2. Created here because it references plants.
    op.execute("""
        CREATE TABLE user_plant_access (
            membership_id BIGINT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
            plant_id      BIGINT NOT NULL REFERENCES plants(id)      ON DELETE CASCADE,
            PRIMARY KEY (membership_id, plant_id)
        )
    """)
    op.execute("COMMENT ON TABLE user_plant_access IS "
               "'I-5: an Employee with zero rows here sees zero Plants. Absence of "
               "assignment is never full access.'")

    op.execute("""
        CREATE TABLE blocks (
            id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id    BIGINT        NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
            plant_id     BIGINT        NOT NULL REFERENCES plants(id)  ON DELETE CASCADE,
            code         VARCHAR(64)   NOT NULL,
            name         TEXT          NOT NULL,
            capacity_kwp NUMERIC(10,2) NOT NULL,
            CONSTRAINT uq_blocks_plant_id_code UNIQUE (plant_id, code)
        )
    """)
    # No parent_block_id. Blocks are flat, one level only (MASTER §2.2, Guardrail 11).
    op.execute("COMMENT ON TABLE blocks IS "
               "'An optional, Client-defined subdivision of a Plant. Flat — no "
               "sub-Blocks. Geographic, never electrical: a Block never appears in the "
               "Single Line Diagram. capacity_kwp is NOT NULL so per-Block PR and CUF "
               "are computable.'")

    op.execute("""
        CREATE TABLE devices (
            id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id             BIGINT      NOT NULL
                REFERENCES clients(id) ON DELETE RESTRICT,
            plant_id              BIGINT      NOT NULL
                REFERENCES plants(id) ON DELETE CASCADE,
            device_model_id       BIGINT      NOT NULL REFERENCES device_models(id),
            code                  VARCHAR(64) NOT NULL,
            name                  TEXT        NOT NULL,
            serial_number         TEXT,
            block_id              BIGINT      REFERENCES blocks(id),
            parent_device_id      BIGINT,
            reports_via_device_id BIGINT      REFERENCES devices(id),
            source_address        TEXT        UNIQUE,
            expected_interval_s   INTEGER     NOT NULL DEFAULT 60,
            rated_capacity_kw     NUMERIC(12,2),
            status                VARCHAR(32) NOT NULL DEFAULT 'active',
            installed_on          DATE,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_devices_plant_id_code UNIQUE (plant_id, code),
            CONSTRAINT uq_device_plant UNIQUE (id, plant_id),
            CONSTRAINT ck_devices_device_status CHECK (status IN
                ('active','maintenance','decommissioned')),
            CONSTRAINT ck_devices_device_not_own_parent
                CHECK (parent_device_id IS NULL OR parent_device_id <> id)
        )
    """)
    # I-3 enforced structurally: a composite FK, not a trigger, so it cannot be
    # bypassed by any code path.
    op.execute("""
        ALTER TABLE devices ADD CONSTRAINT fk_parent_same_plant
            FOREIGN KEY (parent_device_id, plant_id) REFERENCES devices (id, plant_id)
    """)
    op.execute("COMMENT ON COLUMN devices.block_id IS "
               "'Where is it? Geographic. One of three independent groupings (I-10).'")
    op.execute("COMMENT ON COLUMN devices.parent_device_id IS "
               "'What is it wired into? Electrical — this column alone builds the Single "
               "Line Diagram. Constrained to the same Plant (I-3).'")
    op.execute("COMMENT ON COLUMN devices.reports_via_device_id IS "
               "'What transmits it? Communication. Without this column a failed "
               "Collector is recorded as generation downtime, corrupting the availability "
               "figures performance guarantees are calculated from (MASTER 3.4).'")
    op.execute("COMMENT ON COLUMN devices.source_address IS "
               "'The MQTT topic this Device publishes on. MASTER 3.7: this column already "
               "is the data-source mapping, which is why data_source_connections was "
               "dropped once ingestion became MQTT-only.'")
    op.execute("COMMENT ON COLUMN devices.expected_interval_s IS "
               "'Set per Device from observation at commissioning, never from the assumed "
               "60s default — the client test broker publishes ~21x faster. Health "
               "detection multiplies this column.'")
    op.execute("CREATE INDEX ix_devices_plant_id ON devices (plant_id)")
    op.execute("CREATE INDEX ix_devices_client_id ON devices (client_id)")
    op.execute("CREATE INDEX ix_devices_reports_via ON devices (reports_via_device_id)")

    op.execute("""
        CREATE TABLE device_tag_bindings (
            id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id    BIGINT           NOT NULL
                REFERENCES clients(id) ON DELETE RESTRICT,
            device_id    BIGINT           NOT NULL
                REFERENCES devices(id) ON DELETE CASCADE,
            tag_id       BIGINT           NOT NULL REFERENCES tags(id),
            source_key   TEXT             NOT NULL,
            scale        DOUBLE PRECISION NOT NULL DEFAULT 1.0,
            value_offset DOUBLE PRECISION NOT NULL DEFAULT 0.0,
            valid_min    DOUBLE PRECISION,
            valid_max    DOUBLE PRECISION,
            enabled      BOOLEAN          NOT NULL DEFAULT true,
            created_at   TIMESTAMPTZ      NOT NULL DEFAULT now(),
            CONSTRAINT uq_device_tag_bindings_device_id_tag_id UNIQUE (device_id, tag_id),
            CONSTRAINT uq_device_tag_bindings_device_id_source_key
                UNIQUE (device_id, source_key)
        )
    """)
    op.execute("COMMENT ON TABLE device_tag_bindings IS "
               "'Per-Device, never per-Model. MASTER 5.2: INV-01 binds AC_ACTIVE_POWER to "
               "source key pa at scale 0.1; INV-02, same Model and Plant on newer "
               "firmware, binds the same Tag to P_ac at scale 1.0. Both are correct.'")

    op.execute("""
        CREATE TABLE topic_patterns (
            id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id   BIGINT      REFERENCES clients(id) ON DELETE CASCADE,
            pattern     TEXT        NOT NULL UNIQUE,
            priority    INTEGER     NOT NULL DEFAULT 100,
            description TEXT,
            enabled     BOOLEAN     NOT NULL DEFAULT true,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("COMMENT ON TABLE topic_patterns IS "
               "'Ingress registry: how to read origin out of a topic. The topic is the "
               "sole authority for origin (Guardrail 5); keeping the shapes as data is "
               "what stops a Client name becoming a code path (I-1). NULL client_id is a "
               "platform-wide pattern such as the canonical contract.'")

    op.execute("""
        CREATE TABLE broker_credentials (
            id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id     BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            plant_id      BIGINT      REFERENCES plants(id)  ON DELETE CASCADE,
            device_id     BIGINT      REFERENCES devices(id) ON DELETE CASCADE,
            username      TEXT        NOT NULL UNIQUE,
            password_hash TEXT        NOT NULL,
            topic_scope   TEXT        NOT NULL,
            revoked_at    TIMESTAMPTZ,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("COMMENT ON TABLE broker_credentials IS "
               "'One per publishing endpoint, issued by the CMS. The broker authenticates "
               "against us and holds no independent user list — maintaining one guarantees "
               "drift within weeks (MASTER 5.1). Shown once, stored irreversibly. Scope "
               "constrained to the issuing Client (I-9).'")


def downgrade() -> None:
    for table in (
        "broker_credentials", "topic_patterns", "device_tag_bindings",
        "devices", "blocks", "user_plant_access", "plants", "regions",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
