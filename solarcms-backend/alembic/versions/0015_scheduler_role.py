"""A scheduler role, distinct from ingest.

The scheduler fires escalation timers, runs Reports and verifies that continuous
aggregates are still refreshing. Running it as `solarcms_ingest` worked only
because that role happened to hold enough — and it does not: escalation reads
`escalation_policies`, `escalation_steps`, `memberships` and `users`, none of
which ingestion should be able to see at all.

So the scheduler gets its own least-privilege role rather than a widened ingest
one. Both remain NOLOGIN: the workers connect as the owner and assume the role
per transaction, which keeps one connection pool while stopping the owner's
privileges from being used to do the work.

Revision ID: 0015
Revises: 0014
"""

from __future__ import annotations

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

SCHEDULER = "solarcms_scheduler"


def upgrade() -> None:
    op.execute(f"""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{SCHEDULER}') THEN
                RAISE EXCEPTION
                    'role "{SCHEDULER}" does not exist. Re-run '
                    'scripts/bootstrap_roles.sql as a superuser.';
            END IF;
        END $$
    """)
    op.execute(f"GRANT USAGE ON SCHEMA public TO {SCHEDULER}")

    # Read what it must evaluate.
    op.execute(f"""
        GRANT SELECT ON alarms, alarm_rules, escalation_policies, escalation_steps,
                        memberships, users, roles, plants, devices, clients,
                        report_definitions, report_schedules, notification_subscriptions,
                        device_health, device_health_events, tags, device_types,
                        device_models, regions, blocks
        TO {SCHEDULER}
    """)
    # Write only what it produces. SELECT accompanies INSERT on notification_log
    # because `INSERT ... RETURNING id` requires read privilege on the returned
    # column — the insert alone is not enough.
    op.execute(f"GRANT INSERT, SELECT ON notification_log TO {SCHEDULER}")
    op.execute(f"GRANT UPDATE ON alarms TO {SCHEDULER}")
    op.execute(f"GRANT INSERT, UPDATE ON report_runs TO {SCHEDULER}")
    op.execute(f"GRANT SELECT ON report_runs TO {SCHEDULER}")
    op.execute(f"GRANT UPDATE ON report_schedules TO {SCHEDULER}")
    op.execute(f"GRANT INSERT ON audit_log TO {SCHEDULER}")
    op.execute(f"GRANT SELECT ON readings_v, agg_1h_v, agg_1d_v TO {SCHEDULER}")
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {SCHEDULER}")

    # The scheduler acts across every Client by design — an escalation timer is
    # not a user session and has no Client context to filter by. Exempted per
    # table rather than by BYPASSRLS, so the reach stays bounded to these.
    for table in ("alarms", "escalation_policies", "notification_log",
                  "notification_subscriptions", "report_runs", "report_schedules",
                  "memberships", "device_health", "device_health_events"):
        op.execute(f"""
            CREATE POLICY {table}_scheduler ON {table}
                TO {SCHEDULER} USING (true) WITH CHECK (true)
        """)
    op.execute(f"""
        CREATE POLICY audit_log_scheduler ON audit_log FOR INSERT
            TO {SCHEDULER} WITH CHECK (true)
    """)


def downgrade() -> None:
    for table in ("alarms", "escalation_policies", "notification_log",
                  "notification_subscriptions", "report_runs", "report_schedules",
                  "memberships", "device_health", "device_health_events"):
        op.execute(f"DROP POLICY IF EXISTS {table}_scheduler ON {table}")
    op.execute("DROP POLICY IF EXISTS audit_log_scheduler ON audit_log")
    op.execute(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {SCHEDULER}")
