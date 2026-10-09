"""Notifications become a queue: written with the Alarm, sent by the scheduler.

Every notification used to be *sent* inside the transaction that raised its
Alarm — by the alarm worker, the health sweep and the escalation timer alike —
one recipient after another, each SMTP or WhatsApp call allowed 15 seconds. A
slow mail server therefore held up every other Device's Alarm behind it, and a
send that failed once was recorded `failed` and never tried again.

Now the raising transaction only records the notification, `queued`, beside
the Alarm (so one never exists without the other), and the scheduler's
dispatcher sends it: claimed with a lease so two dispatchers never send the
same row, retried with backoff on a failure that may pass (a timeout, a 5xx),
and failed at once on one that will not (no provider configured, no address).

Columns:

* `subject`        — the email subject, held until it is sent.
* `attempts`       — sends tried so far.
* `next_attempt_at`— when a queued row may next be tried; also the lease.
* `queued_at`      — when it was recorded.
* `sent_at`        — now NULL until a send succeeds or is abandoned. It used to
                     default to the insert time, which was also the send time.

The scheduler role gains UPDATE: `notification_log_scheduler` (0015) already
admits it, and a policy without the GRANT is the failure this project has hit
three times (CLAUDE.md, "A permissive RLS policy is not a GRANT").

Status: AGREED (8 Oct 2026, the user) / BUILT.

Revision ID: 0035
Revises: 0034
"""

from __future__ import annotations

from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None

SCHEDULER = "solarcms_scheduler"


def upgrade() -> None:
    # FORCE ROW LEVEL SECURITY applies to the owner: without this the backfill
    # below matches nothing.
    op.execute("SELECT set_config('app.is_platform_admin', 'true', true)")
    op.execute("""
        ALTER TABLE notification_log
            ADD COLUMN subject         TEXT,
            ADD COLUMN attempts        INTEGER     NOT NULL DEFAULT 0,
            ADD COLUMN next_attempt_at TIMESTAMPTZ,
            ADD COLUMN queued_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    """)
    # History: every existing row was one attempt, made when it was written.
    op.execute("UPDATE notification_log SET queued_at = sent_at, attempts = 1")
    op.execute("ALTER TABLE notification_log ALTER COLUMN sent_at DROP NOT NULL")
    op.execute("ALTER TABLE notification_log ALTER COLUMN sent_at DROP DEFAULT")
    op.execute("""
        CREATE INDEX ix_notification_log_due ON notification_log (next_attempt_at)
         WHERE delivery_status = 'queued'
    """)
    op.execute(f"GRANT UPDATE ON notification_log TO {SCHEDULER}")


def downgrade() -> None:
    op.execute("SELECT set_config('app.is_platform_admin', 'true', true)")
    op.execute(f"REVOKE UPDATE ON notification_log FROM {SCHEDULER}")
    op.execute("DROP INDEX IF EXISTS ix_notification_log_due")
    op.execute("UPDATE notification_log SET sent_at = queued_at WHERE sent_at IS NULL")
    op.execute("ALTER TABLE notification_log ALTER COLUMN sent_at SET DEFAULT now()")
    op.execute("ALTER TABLE notification_log ALTER COLUMN sent_at SET NOT NULL")
    op.execute("""
        ALTER TABLE notification_log
            DROP COLUMN subject,
            DROP COLUMN attempts,
            DROP COLUMN next_attempt_at,
            DROP COLUMN queued_at
    """)
