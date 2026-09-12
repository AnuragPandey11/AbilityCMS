"""Helpers letting migrations run with or without the TimescaleDB extension.

TimescaleDB is CONFIRMED for production (MASTER F-4) and there is no substitute
at 10-year scale. But CI and a colleague's bare Postgres must still be able to
apply every migration, so each Timescale-specific construct has a plain-Postgres
equivalent:

    hypertable          → plain table with a (time DESC) index
    continuous aggregate → ordinary materialised view, refreshed by the scheduler
    retention policy    → recorded only; the scheduler deletes by age instead

The fallback is explicitly *not* equivalent in performance, only in behaviour.
`TIMESCALE_ENABLED=false` is a development switch, never a deployment option.
"""

from __future__ import annotations

from alembic import op
from solarcms.config import get_settings


def timescale_available() -> bool:
    """True when this database can create hypertables.

    Checks the live catalogue rather than trusting configuration alone: a config
    claiming Timescale against a database without it must fail loudly at
    migration time, not at first write.
    """
    if not get_settings().timescale_enabled:
        return False
    installed = op.get_bind().exec_driver_sql(
        "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'"
    ).scalar()
    return bool(installed)


def create_hypertable(table: str, time_column: str = "time", chunk_interval: str = "1 day") -> None:
    """Convert a table to a hypertable, or index it for range scans instead."""
    if timescale_available():
        op.execute(
            f"SELECT create_hypertable('{table}', '{time_column}', "
            f"chunk_time_interval => INTERVAL '{chunk_interval}', if_not_exists => TRUE)"
        )
    else:
        op.execute(f"CREATE INDEX IF NOT EXISTS ix_{table}_{time_column} "
                   f"ON {table} ({time_column} DESC)")


def add_retention_policy(table: str, keep: str) -> None:
    """Drop chunks older than `keep`. No-op without Timescale — see module docstring."""
    if timescale_available():
        op.execute(f"SELECT add_retention_policy('{table}', INTERVAL '{keep}', "
                   f"if_not_exists => TRUE)")


def enable_compression(table: str, segment_by: str, compress_after: str) -> None:
    """Compress older chunks. `segment_by` should match the common query filter."""
    if timescale_available():
        op.execute(
            f"ALTER TABLE {table} SET (timescaledb.compress, "
            f"timescaledb.compress_segmentby = '{segment_by}', "
            f"timescaledb.compress_orderby = 'time DESC')"
        )
        op.execute(f"SELECT add_compression_policy('{table}', INTERVAL '{compress_after}', "
                   f"if_not_exists => TRUE)")


def create_continuous_aggregate(name: str, select_sql: str, *, real_time: bool = True) -> None:
    """Create a continuous aggregate, or a plain materialised view without Timescale."""
    if timescale_available():
        op.execute(
            f"CREATE MATERIALIZED VIEW {name} WITH (timescaledb.continuous) AS "
            f"{select_sql} WITH NO DATA"
        )
        if not real_time:
            op.execute(f"ALTER MATERIALIZED VIEW {name} SET (timescaledb.materialized_only = true)")
    else:
        op.execute(f"CREATE MATERIALIZED VIEW {name} AS {select_sql} WITH NO DATA")


def add_refresh_policy(name: str, start_offset: str, end_offset: str, schedule: str) -> None:
    if timescale_available():
        op.execute(
            f"SELECT add_continuous_aggregate_policy('{name}', "
            f"start_offset => INTERVAL '{start_offset}', "
            f"end_offset => INTERVAL '{end_offset}', "
            f"schedule_interval => INTERVAL '{schedule}', if_not_exists => TRUE)"
        )


def drop_continuous_aggregate(name: str) -> None:
    op.execute(f"DROP MATERIALIZED VIEW IF EXISTS {name} CASCADE")
