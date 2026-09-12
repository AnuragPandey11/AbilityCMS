"""Device Health, Alarms, Escalation, Notifications, Incident Snapshots.

Revision ID: 0006
Revises: 0005
"""

from __future__ import annotations

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE device_health (
            device_id        BIGINT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
            client_id        BIGINT      NOT NULL,
            plant_id         BIGINT      NOT NULL,
            comm_status      VARCHAR(16) NOT NULL DEFAULT 'unknown',
            last_seen_at     TIMESTAMPTZ,
            frozen_tag_count INTEGER     NOT NULL DEFAULT 0,
            completeness_24h DOUBLE PRECISION,
            updated_at       TIMESTAMPTZ,
            CONSTRAINT ck_device_health_health_comm_status
                CHECK (comm_status IN ('online','degraded','offline','unknown'))
        )
    """)
    # A hot table updated every sweep. At ~150 rows the default scale factor
    # never triggers on its own, so autovacuum is given an absolute threshold.
    op.execute("""
        ALTER TABLE device_health SET (
            autovacuum_vacuum_scale_factor = 0.0,
            autovacuum_vacuum_threshold = 50
        )
    """)
    op.execute("COMMENT ON COLUMN device_health.frozen_tag_count IS "
               "'Catches the opposite failure to silence: a Device reporting exactly on "
               "schedule with a value that has not changed. Every staleness check reads a "
               "stuck sensor as healthy (MASTER 6.3).'")

    op.execute("""
        CREATE TABLE device_health_events (
            id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id   BIGINT      NOT NULL,
            device_id   BIGINT      NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
            plant_id    BIGINT      NOT NULL,
            from_status VARCHAR(16),
            to_status   VARCHAR(16) NOT NULL,
            occurred_at TIMESTAMPTZ NOT NULL,
            cause       TEXT
        )
    """)
    op.execute("CREATE INDEX ix_device_health_events_device_time "
               "ON device_health_events (device_id, occurred_at DESC)")
    op.execute("COMMENT ON TABLE device_health_events IS "
               "'Availability is computed time-weighted from this table, never from "
               "current state: a Device online now says nothing about the six hours it "
               "was offline this morning.'")
    op.execute("COMMENT ON COLUMN device_health_events.cause IS "
               "'communication vs equipment. Tender 18 lists them as separate loss "
               "categories and conflating them corrupts availability.'")

    op.execute("""
        CREATE TABLE alarm_rules (
            id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id       BIGINT      REFERENCES clients(id) ON DELETE CASCADE,
            code            VARCHAR(64) NOT NULL,
            name            TEXT        NOT NULL,
            scope_type      VARCHAR(16) NOT NULL DEFAULT 'global',
            scope_id        BIGINT,
            tag_id          BIGINT      REFERENCES tags(id),
            operator        VARCHAR(16) NOT NULL,
            threshold       DOUBLE PRECISION,
            threshold_high  DOUBLE PRECISION,
            clear_threshold DOUBLE PRECISION,
            duration_s      INTEGER     NOT NULL DEFAULT 0,
            severity        VARCHAR(16) NOT NULL DEFAULT 'medium',
            classification  VARCHAR(32),
            enabled         BOOLEAN     NOT NULL DEFAULT true,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT ck_alarm_rules_rule_severity
                CHECK (severity IN ('critical','high','medium','low')),
            CONSTRAINT ck_alarm_rules_rule_scope_type
                CHECK (scope_type IN ('global','client','plant','device_type','device')),
            CONSTRAINT ck_alarm_rules_rule_operator
                CHECK (operator IN ('gt','lt','outside','inside','eq','special'))
        )
    """)
    # NULLS NOT DISTINCT: a platform default (client_id NULL, scope_id NULL) must
    # collide with another of the same code, which default NULL semantics allow.
    op.execute("""
        CREATE UNIQUE INDEX uq_alarm_rules_scope
            ON alarm_rules (client_id, code, scope_type, scope_id) NULLS NOT DISTINCT
    """)
    op.execute("COMMENT ON COLUMN alarm_rules.client_id IS "
               "'NULL is a platform default inherited by every Client. Scope resolution "
               "is most-specific-wins: device → plant → device_type → global.'")
    op.execute("COMMENT ON COLUMN alarm_rules.duration_s IS "
               "'Debounce: the condition must hold this long before opening. Stops "
               "flapping.'")
    op.execute("COMMENT ON COLUMN alarm_rules.clear_threshold IS "
               "'Hysteresis: clear here if set, otherwise at threshold.'")

    op.execute("""
        CREATE TABLE alarms (
            id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id        BIGINT      NOT NULL,
            rule_id          BIGINT      NOT NULL
                REFERENCES alarm_rules(id) ON DELETE CASCADE,
            device_id        BIGINT      REFERENCES devices(id) ON DELETE CASCADE,
            plant_id         BIGINT,
            state            VARCHAR(16) NOT NULL DEFAULT 'active',
            severity         VARCHAR(16) NOT NULL,
            opened_at        TIMESTAMPTZ NOT NULL,
            acknowledged_at  TIMESTAMPTZ,
            acknowledged_by  BIGINT      REFERENCES users(id),
            resolved_at      TIMESTAMPTZ,
            trigger_value    DOUBLE PRECISION,
            message          TEXT        NOT NULL,
            classification   VARCHAR(32),
            escalation_level INTEGER     NOT NULL DEFAULT 0,
            CONSTRAINT ck_alarms_alarm_state
                CHECK (state IN ('active','acknowledged','resolved')),
            CONSTRAINT ck_alarms_alarm_severity
                CHECK (severity IN ('critical','high','medium','low'))
        )
    """)
    # Deduplication (MASTER §3.5): a fault persisting six hours is ONE row, not
    # thousands. This index is the mechanism, not application logic.
    op.execute("""
        CREATE UNIQUE INDEX uq_alarms_open_per_rule_device
            ON alarms (rule_id, device_id)
         WHERE state IN ('active','acknowledged')
    """)
    op.execute("CREATE INDEX ix_alarms_client_opened ON alarms (client_id, opened_at DESC)")
    op.execute("CREATE INDEX ix_alarms_plant_state ON alarms (plant_id, state)")

    op.execute("""
        CREATE TABLE escalation_policies (
            id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id    BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            name         TEXT        NOT NULL,
            scope_type   VARCHAR(16) NOT NULL,
            scope_id     BIGINT,
            min_severity VARCHAR(16) NOT NULL DEFAULT 'high',
            enabled      BOOLEAN     NOT NULL DEFAULT true,
            CONSTRAINT ck_escalation_policies_escalation_scope_type
                CHECK (scope_type IN ('client','plant')),
            CONSTRAINT ck_escalation_policies_escalation_min_severity
                CHECK (min_severity IN ('critical','high','medium','low'))
        )
    """)
    op.execute("""
        CREATE TABLE escalation_steps (
            id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            policy_id      BIGINT      NOT NULL
                REFERENCES escalation_policies(id) ON DELETE CASCADE,
            level          INTEGER     NOT NULL,
            delay_minutes  INTEGER     NOT NULL,
            notify_user_id BIGINT      REFERENCES users(id),
            notify_role_id BIGINT      REFERENCES roles(id),
            channel        VARCHAR(16) NOT NULL,
            CONSTRAINT uq_escalation_steps_policy_id_level UNIQUE (policy_id, level),
            CONSTRAINT ck_escalation_steps_step_channel
                CHECK (channel IN ('email','whatsapp','sms')),
            CONSTRAINT ck_escalation_steps_step_has_recipient
                CHECK (notify_user_id IS NOT NULL OR notify_role_id IS NOT NULL)
        )
    """)
    op.execute("COMMENT ON COLUMN escalation_steps.notify_user_id IS "
               "'Preferred. Tender 23 escalates Operator → Plant Manager → Management, "
               "three roles, but the CONFIRMED four-role model has only Admin and Employee "
               "client-side — so three levels cannot be expressed by role alone. "
               "notify_role_id is a coarse fallback. See OPEN-2.'")

    op.execute("""
        CREATE TABLE notification_subscriptions (
            id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id        BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            user_id          BIGINT      NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
            plant_id         BIGINT      REFERENCES plants(id) ON DELETE CASCADE,
            channel          VARCHAR(16) NOT NULL,
            min_severity     VARCHAR(16) NOT NULL DEFAULT 'medium',
            message_template TEXT,
            priority         INTEGER     NOT NULL DEFAULT 0,
            enabled          BOOLEAN     NOT NULL DEFAULT true,
            CONSTRAINT ck_notification_subscriptions_subscription_channel
                CHECK (channel IN ('email','whatsapp','sms')),
            CONSTRAINT ck_notification_subscriptions_subscription_min_severity
                CHECK (min_severity IN ('critical','high','medium','low'))
        )
    """)

    # notification_log is created in 0007: it references report_runs, which does
    # not exist until then. Ordering is the only reason it is not here.

    op.execute("""
        CREATE TABLE incident_snapshots (
            id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            client_id        BIGINT      NOT NULL,
            alarm_id         BIGINT      REFERENCES alarms(id) ON DELETE SET NULL,
            device_id        BIGINT      NOT NULL REFERENCES devices(id),
            window_start     TIMESTAMPTZ NOT NULL,
            window_end       TIMESTAMPTZ NOT NULL,
            devices_included BIGINT[]    NOT NULL,
            artifact_url     TEXT,
            row_count        INTEGER,
            state            VARCHAR(16) NOT NULL DEFAULT 'queued',
            captured_at      TIMESTAMPTZ,
            CONSTRAINT ck_incident_snapshots_snapshot_state
                CHECK (state IN ('queued','captured','failed'))
        )
    """)
    op.execute("COMMENT ON TABLE incident_snapshots IS "
               "'PROPOSED, OPEN-6. Raw retention is 30 days; without this, raw evidence "
               "for any fault older than that is unrecoverable, which matters for warranty "
               "claims. Severity-gated so Low and Medium Alarms trigger nothing.'")


def downgrade() -> None:
    for table in (
        "incident_snapshots", "notification_subscriptions", "escalation_steps",
        "escalation_policies", "alarms", "alarm_rules",
        "device_health_events", "device_health",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
