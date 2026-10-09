"""Compress the four aggregate tiers, and `readings` after 1 day instead of 7.

None of the tiers had compression enabled (docs/CAPACITY_AND_DEPLOYMENT.md
§2.4, §4.3). At the client's publishing rate `agg_1m` has about one row per
reading, so it was an uncompressed copy of the raw data kept twelve times
longer, and the largest table: ~3 GB per Device per year as built, an
estimated ~0.4 GB compressed (if it compresses like `readings`, 12 times).

Segmented by (device_id, tag_id) and ordered by time, as `readings` is, because
every read of a tier filters on exactly those (`services/scope.py`): a
compressed segment is then one Device's one Tag, found without decompressing
anyone else's.

Each tier compresses only past the window its refresh policy still rewrites —
TimescaleDB refuses a compress_after inside it, and a chunk that is still
being refreshed would be decompressed and recompressed every pass:

| tier    | refresh rewrites | compressed after |
|---------|------------------|------------------|
| agg_1m  | last 2 hours     | 2 days           |
| agg_15m | last 1 day       | 3 days           |
| agg_1h  | last 7 days      | 14 days          |
| agg_1d  | last 30 days     | 60 days          |

`readings` after 1 day (§4.3): today and yesterday's raw rows, which the
operating-status rule reads to the second, stay uncompressed; older raw rows
are read only by reports and replays. ⚠ `backfill-device` inserts into chunks
that may now be compressed — TimescaleDB 2.17 supports that, at some cost, and
it is a rare, deliberate operation. `mqtt_raw` stays at 7 days: its payloads are
what `backfill-device` reads back, and they are read most in the first week.

The tiers carry no RLS (0008/0010 — TimescaleDB refuses RLS on a compressed
hypertable, which is why the API reads only through the `*_v` views), so no
`set_config` is needed.

Status: PROPOSED (docs/CAPACITY_AND_DEPLOYMENT.md, 8 Oct 2026) / BUILT.

Revision ID: 0038
Revises: 0037
"""

from __future__ import annotations

from alembic import op

revision = "0038"
down_revision = "0037"
branch_labels = None
depends_on = None

TIERS = (
    ("agg_1m", "2 days"),
    ("agg_15m", "3 days"),
    ("agg_1h", "14 days"),
    ("agg_1d", "60 days"),
)


def upgrade() -> None:
    for view, after in TIERS:
        op.execute(f"""
            ALTER MATERIALIZED VIEW {view} SET (
                timescaledb.compress = true,
                timescaledb.compress_segmentby = 'device_id, tag_id',
                timescaledb.compress_orderby = 'bucket DESC'
            )
        """)
        op.execute(f"SELECT add_compression_policy('{view}', "
                   f"compress_after => INTERVAL '{after}', if_not_exists => true)")
    op.execute("SELECT remove_compression_policy('readings', if_exists => true)")
    op.execute("SELECT add_compression_policy('readings', INTERVAL '1 day')")


def downgrade() -> None:
    op.execute("SELECT remove_compression_policy('readings', if_exists => true)")
    op.execute("SELECT add_compression_policy('readings', INTERVAL '7 days')")
    for view, _after in TIERS:
        op.execute(f"SELECT remove_compression_policy('{view}', if_exists => true)")
        # Every chunk must be decompressed before compression can be turned off.
        op.execute(f"""
            SELECT decompress_chunk(c, if_compressed => true)
              FROM show_chunks('{view}') AS c
        """)
        op.execute(f"ALTER MATERIALIZED VIEW {view} SET (timescaledb.compress = false)")
