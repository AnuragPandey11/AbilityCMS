"""Reporting, notification history, and the audit trail.

Revision ID: 0007
Revises: 0006
"""

from __future__ import annotations

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE report_definitions (
            id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id    BIGINT      REFERENCES clients(id) ON DELETE CASCADE,
            code         VARCHAR(64) NOT NULL,
            name         TEXT        NOT NULL,
            description  TEXT,
            query_spec   JSONB       NOT NULL,
            is_financial BOOLEAN     NOT NULL DEFAULT false,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)
    op.execute("COMMENT ON TABLE report_definitions IS "
               "'Generic by design — the full tender 25 catalogue is rows here, not code.'")
    op.execute("COMMENT ON COLUMN report_definitions.is_financial IS "
               "'I-11: when true, only ABT Meter Readings are admissible as input. The ABT "
               "Meter is the sealed settlement instrument; an MFM has no commercial "
               "standing.'")

    op.execute("""
        CREATE TABLE report_schedules (
            id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id          BIGINT      NOT NULL
                REFERENCES clients(id) ON DELETE CASCADE,
            definition_id      BIGINT      NOT NULL
                REFERENCES report_definitions(id) ON DELETE CASCADE,
            cron               VARCHAR(64) NOT NULL,
            timezone           VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata',
            recipient_user_ids BIGINT[]    NOT NULL,
            formats            TEXT[]      NOT NULL,
            enabled            BOOLEAN     NOT NULL DEFAULT true,
            last_run_at        TIMESTAMPTZ,
            next_run_at        TIMESTAMPTZ
        )
    """)
    op.execute("""
        CREATE TABLE report_runs (
            id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id     BIGINT      NOT NULL,
            definition_id BIGINT      NOT NULL
                REFERENCES report_definitions(id) ON DELETE CASCADE,
            schedule_id   BIGINT      REFERENCES report_schedules(id) ON DELETE SET NULL,
            requested_by  BIGINT      REFERENCES users(id),
            period_start  TIMESTAMPTZ NOT NULL,
            period_end    TIMESTAMPTZ NOT NULL,
            state         VARCHAR(16) NOT NULL DEFAULT 'queued',
            artifact_urls JSONB,
            row_count     INTEGER,
            error         TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            completed_at  TIMESTAMPTZ,
            CONSTRAINT ck_report_runs_run_state
                CHECK (state IN ('queued','running','succeeded','failed'))
        )
    """)
    op.execute("CREATE INDEX ix_report_runs_client_created "
               "ON report_runs (client_id, created_at DESC)")

    # Deferred from 0006: references report_runs.
    op.execute("""
        CREATE TABLE notification_log (
            id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id         BIGINT      NOT NULL,
            alarm_id          BIGINT      REFERENCES alarms(id)      ON DELETE SET NULL,
            report_run_id     BIGINT      REFERENCES report_runs(id) ON DELETE SET NULL,
            recipient_user_id BIGINT      REFERENCES users(id),
            channel           VARCHAR(16) NOT NULL,
            message           TEXT        NOT NULL,
            escalation_level  INTEGER,
            sent_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            delivery_status   VARCHAR(16) NOT NULL DEFAULT 'queued',
            failure_reason    TEXT,
            CONSTRAINT ck_notification_log_notification_channel
                CHECK (channel IN ('email','whatsapp','sms')),
            CONSTRAINT ck_notification_log_notification_delivery_status
                CHECK (delivery_status IN ('queued','sent','delivered','failed'))
        )
    """)
    op.execute("CREATE INDEX ix_notification_log_client_sent "
               "ON notification_log (client_id, sent_at DESC)")
    op.execute("COMMENT ON TABLE notification_log IS "
               "'One delivery attempt, to one recipient, via one channel (tender 24). "
               "escalation_level is NULL when the notification did not come from an "
               "Escalation Step.'")

    op.execute("""
        CREATE TABLE audit_log (
            id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id   BIGINT,
            user_id     BIGINT      REFERENCES users(id) ON DELETE SET NULL,
            actor_email TEXT,
            action      VARCHAR(64) NOT NULL,
            entity_type VARCHAR(64),
            entity_id   BIGINT,
            before      JSONB,
            after       JSONB,
            ip_address  INET,
            user_agent  TEXT,
            occurred_at TIMESTAMPTZ  NOT NULL DEFAULT now()
        )
    """)
    op.execute("CREATE INDEX ix_audit_log_client_time "
               "ON audit_log (client_id, occurred_at DESC)")
    op.execute("CREATE INDEX ix_audit_log_action ON audit_log (action, occurred_at DESC)")
    op.execute("COMMENT ON TABLE audit_log IS "
               "'Immutable. Every mutation writes a row here in the SAME transaction as "
               "the change, not after it (BACKEND_SPEC 8.3).'")
    op.execute("COMMENT ON COLUMN audit_log.client_id IS "
               "'NULL for platform actions and failed logins: a failed login must be "
               "recorded even when the email matches no user at all (tender 33).'")
    op.execute("COMMENT ON COLUMN audit_log.actor_email IS "
               "'Recorded as text as well as user_id, so a failed login against an "
               "unknown address is still attributable.'")


def downgrade() -> None:
    for table in (
        "audit_log", "notification_log", "report_runs",
        "report_schedules", "report_definitions",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
