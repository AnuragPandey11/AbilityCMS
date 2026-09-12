"""Telemetry: readings and mqtt_raw as hypertables, with compression and retention.

Revision ID: 0004
Revises: 0003
"""

from __future__ import annotations

from alembic import op
from solarcms.db.migration_helpers import (
    add_retention_policy,
    create_hypertable,
    enable_compression,
)

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Narrow by design (I-2, MASTER §3.5). No surrogate key: the hypertable is
    # partitioned on time and Readings are append-only.
    op.execute("""
        CREATE TABLE readings (
            time        TIMESTAMPTZ      NOT NULL,
            client_id   BIGINT           NOT NULL,
            device_id   BIGINT           NOT NULL,
            tag_id      BIGINT           NOT NULL,
            value       DOUBLE PRECISION NOT NULL,
            quality     SMALLINT         NOT NULL DEFAULT 0,
            source_time TIMESTAMPTZ
        )
    """)
    op.execute("COMMENT ON TABLE readings IS "
               "'One value of one Tag, from one Device, at one instant. Narrow, not a "
               "column per metric: Device Models expose different Tag sets, so a wide "
               "table would be mostly NULL and every new Model would need a migration.'")
    op.execute("COMMENT ON COLUMN readings.client_id IS "
               "'Deliberately denormalised — redundant with devices → plants → clients, "
               "but it lets RLS and chunk pruning work without a three-table join on "
               "every historical query (MASTER 3.5).'")
    op.execute("COMMENT ON COLUMN readings.quality IS "
               "'0 good, 1 out of range, 2 stale, 3 unparseable. Out-of-range values are "
               "stored and flagged, never discarded: 3.29151E-41 in a reactive-power Tag "
               "is diagnostic information (BACKEND_SPEC 6.4).'")
    op.execute("COMMENT ON COLUMN readings.source_time IS "
               "'Device clock, per tender 28. NULL where the publisher sends no timestamp "
               "— which is the case for the client current test broker. readings.time "
               "remains the authoritative index column = receipt time.'")

    create_hypertable("readings", "time", "1 day")
    op.execute("CREATE INDEX ix_readings_device_tag_time "
               "ON readings (device_id, tag_id, time DESC)")
    op.execute("CREATE INDEX ix_readings_client_time ON readings (client_id, time DESC)")
    # segment_by device_id: every history query filters on it, so compressed
    # chunks can be pruned without decompression.
    enable_compression("readings", "device_id, tag_id", "7 days")
    add_retention_policy("readings", "30 days")

    op.execute("""
        CREATE TABLE mqtt_raw (
            time        TIMESTAMPTZ NOT NULL,
            topic       TEXT        NOT NULL,
            seq         INTEGER     NOT NULL DEFAULT 0,
            payload     JSONB       NOT NULL,
            client_id   BIGINT,
            device_id   BIGINT,
            quarantined BOOLEAN     NOT NULL DEFAULT false,
            reason      TEXT
        )
    """)
    op.execute("COMMENT ON TABLE mqtt_raw IS "
               "'Every payload as received. The only path back to correct history if a "
               "binding scale factor is later found wrong (MASTER 5.3), and the quarantine "
               "destination for a message on an unrecognised topic — which is never "
               "attributed to a Client by inference.'")
    op.execute("COMMENT ON COLUMN mqtt_raw.client_id IS "
               "'NULL when the topic could not be resolved. Never guessed: a wrong "
               "inference silently merges one Client data into another history.'")
    create_hypertable("mqtt_raw", "time", "1 day")
    op.execute("CREATE INDEX ix_mqtt_raw_topic_time ON mqtt_raw (topic, time DESC)")
    op.execute("CREATE INDEX ix_mqtt_raw_quarantined ON mqtt_raw (time DESC) "
               "WHERE quarantined")
    # JSONB payloads are highly repetitive across a 90-day window, so compression
    # pays for itself here more than anywhere else in the schema.
    enable_compression("mqtt_raw", "topic", "7 days")
    add_retention_policy("mqtt_raw", "90 days")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS mqtt_raw CASCADE")
    op.execute("DROP TABLE IF EXISTS readings CASCADE")
