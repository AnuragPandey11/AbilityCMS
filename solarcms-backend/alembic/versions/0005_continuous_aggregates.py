"""The rollup cascade: agg_1m → agg_15m → agg_1h → agg_1d, with policies.

Each tier stores avg/min/max/last/count. A continuous aggregate cannot branch on
`tags.rollup_method`, so all four are stored and the read path selects
(MASTER §5.3). Averaging a cumulative energy counter is meaningless, which is why
`last_value` exists at every tier.

Retention differs per tier and is what carries F-13's 10-year mandate on the
hourly and daily tiers alone:

    readings  30 days · agg_1m 1 year · agg_15m 3 years · agg_1h/agg_1d 10 years

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

from alembic import op
from solarcms.db.migration_helpers import (
    add_refresh_policy,
    add_retention_policy,
    create_continuous_aggregate,
    drop_continuous_aggregate,
    timescale_available,
)

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

# The base tier reads the hypertable; every later tier reads the tier below it,
# which is what makes the cascade cheap (MASTER §6.2).
_AGG_1M = """
    SELECT time_bucket(INTERVAL '1 minute', time) AS bucket,
           client_id, device_id, tag_id,
           avg(value)        AS avg_value,
           min(value)        AS min_value,
           max(value)        AS max_value,
           last(value, time) AS last_value,
           count(*)          AS sample_count,
           max(quality)      AS worst_quality
      FROM readings
     GROUP BY bucket, client_id, device_id, tag_id
"""


def _rollup(source: str, interval: str) -> str:
    """A tier built on the tier below it.

    GROUP BY is positional deliberately. The output column and the source column
    are both named `bucket`, so `GROUP BY bucket` binds to the *source* column and
    TimescaleDB then reports that the view has no valid time bucket function.
    """
    return f"""
    SELECT time_bucket(INTERVAL '{interval}', bucket) AS bucket,
           client_id, device_id, tag_id,
           avg(avg_value)           AS avg_value,
           min(min_value)           AS min_value,
           max(max_value)           AS max_value,
           last(last_value, bucket) AS last_value,
           sum(sample_count)        AS sample_count,
           max(worst_quality)       AS worst_quality
      FROM {source}
     GROUP BY 1, 2, 3, 4
"""


def upgrade() -> None:
    create_continuous_aggregate("agg_1m", _AGG_1M)
    create_continuous_aggregate("agg_15m", _rollup("agg_1m", "15 minutes"))
    create_continuous_aggregate("agg_1h", _rollup("agg_15m", "1 hour"))
    create_continuous_aggregate("agg_1d", _rollup("agg_1h", "1 day"))

    if timescale_available():
        # start_offset bounds the work per run; end_offset leaves the most recent
        # bucket alone so a partially-filled bucket is not materialised early.
        add_refresh_policy("agg_1m", "2 hours", "1 minute", "1 minute")
        add_refresh_policy("agg_15m", "1 day", "15 minutes", "15 minutes")
        add_refresh_policy("agg_1h", "7 days", "1 hour", "1 hour")
        add_refresh_policy("agg_1d", "30 days", "1 hour", "1 hour")

        add_retention_policy("agg_1m", "1 year")
        add_retention_policy("agg_15m", "3 years")
        add_retention_policy("agg_1h", "10 years")
        add_retention_policy("agg_1d", "10 years")
    else:
        # Plain materialised views have no refresh policy; the scheduler refreshes
        # them and deletes by age. Behaviourally equivalent, not performant.
        for name in ("agg_1m", "agg_15m", "agg_1h", "agg_1d"):
            op.execute(f"CREATE UNIQUE INDEX uq_{name}_key "
                       f"ON {name} (bucket, client_id, device_id, tag_id)")


def downgrade() -> None:
    for name in ("agg_1d", "agg_1h", "agg_15m", "agg_1m"):
        drop_continuous_aggregate(name)
