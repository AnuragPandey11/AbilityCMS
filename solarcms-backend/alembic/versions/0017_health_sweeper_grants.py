"""Write privileges the health sweeper needs on the scheduler role.

The sweeper runs as `solarcms_scheduler` (0015) and is the only mechanism that
detects a silent Device (MASTER §6.3). It upserts `device_health` and appends to
`device_health_events`, but 0015 granted the scheduler only SELECT on both — so
every sweep failed with "permission denied", the sweeper logged it and slept,
and `comm_status` stayed NULL for every Device. Availability, which is computed
time-weighted from `device_health_events`, was therefore never computable.

0015 already created the `device_health_scheduler` and
`device_health_events_scheduler` RLS policies with `WITH CHECK (true)`, so the
intent was always for the sweeper to write as this role; only the table-level
grant was missing. RLS is orthogonal to GRANT — a permissive policy does nothing
without the underlying privilege.

The read side is fixed in code, not here: the sweeper now reads `readings_v`,
which the scheduler already holds, rather than the `readings` hypertable, which
no role but ingest may touch (0008/0010). Under the platform context the sweeper
runs in, the barrier view returns every row, which is what a fleet-wide sweep
requires.

Revision ID: 0017
Revises: 0016
"""

from __future__ import annotations

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

SCHEDULER = "solarcms_scheduler"


def upgrade() -> None:
    # SELECT is already held (0015) and is required alongside INSERT for the
    # `ON CONFLICT ... DO UPDATE` upsert to read the existing row.
    op.execute(f"GRANT INSERT, UPDATE ON device_health TO {SCHEDULER}")
    op.execute(f"GRANT INSERT ON device_health_events TO {SCHEDULER}")


def downgrade() -> None:
    op.execute(f"REVOKE INSERT, UPDATE ON device_health FROM {SCHEDULER}")
    op.execute(f"REVOKE INSERT ON device_health_events FROM {SCHEDULER}")
