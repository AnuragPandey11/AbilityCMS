"""Let the scheduler role read the 1-minute and 15-minute tiers.

0015 granted `solarcms_scheduler` SELECT on `readings_v`, `agg_1h_v` and
`agg_1d_v` only. Two reads moved onto the finer tiers for scale
(docs/CAPACITY_AND_DEPLOYMENT.md):

* the health sweep's 24-hour reading count now sums `agg_15m_v.sample_count`
  instead of counting every raw row (§4.2);
* the scheduler computes each Plant's figures for today once a minute, from the
  minute just ended (§4.4).

Without the GRANT both would fail "permission denied" inside a worker that
catches, logs and carries on — the failure CLAUDE.md records three times.

The views are security barriers owned by the migration role; reading one needs
only SELECT on the view, as for `readings_v` already.

Status: AGREED (8 Oct 2026) / BUILT.

Revision ID: 0037
Revises: 0036
"""

from __future__ import annotations

from alembic import op

revision = "0037"
down_revision = "0036"
branch_labels = None
depends_on = None

SCHEDULER = "solarcms_scheduler"


def upgrade() -> None:
    op.execute(f"GRANT SELECT ON agg_1m_v, agg_15m_v TO {SCHEDULER}")


def downgrade() -> None:
    op.execute(f"REVOKE SELECT ON agg_1m_v, agg_15m_v FROM {SCHEDULER}")
