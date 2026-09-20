"""Turn real-time aggregation back on. Every KPI was hours stale.

`create_continuous_aggregate` has always taken `real_time: bool = True` and
0005 has always used the default, so every tier was *intended* to be real-time
from the first migration. None of them were.

The helper only ever wrote the flag in the `real_time=False` branch, leaving
the `True` case to TimescaleDB's default — and **that default flipped**.
Through 2.12 a continuous aggregate was created with `materialized_only =
false`; from 2.13 it is created with `true`. This deployment runs 2.30, so all
four tiers were created materialized-only, and the parameter that was supposed
to prevent exactly this was silently doing nothing.

── Why it was invisible, and then very visible ─────────────────────────────
A materialized-only aggregate returns nothing newer than its last refresh, and
the refresh policies deliberately leave the current bucket alone (`end_offset`)
so a half-filled bucket is never materialised early. That is correct on its
own. But **the cascade is hierarchical** — `agg_1m` reads `readings`, `agg_15m`
reads `agg_1m`, `agg_1h` reads `agg_15m`, `agg_1d` reads `agg_1h` — so each
tier inherits the lag of the tier beneath it and adds its own:

    agg_1m    end_offset  1 min  + refresh  1 min   →  ~2 min behind
    agg_15m   ~2 min      + 15 + 15                 →  ~32 min behind
    agg_1h    ~32 min     + 60 + 60                 →  ~2.5 h behind
    agg_1d    ~2.5 h      + 60 + 60                 →  ~4.5 h behind

Measured on 18 Sep 2026 at 20:09 UTC, `agg_1h`'s newest bucket was 17:00.
`GET /plants/{id}/kpis` reads the hourly tier, so *today's energy, PR, CUF and
CO2 were computed from data that stopped three hours ago* — on a dashboard
whose entire purpose is to say what the plant is doing now. Nothing errored and
no figure was wrong for the window it described; it simply described a window
that had closed.

── What real-time aggregation does ─────────────────────────────────────────
With `materialized_only = false` the view UNIONs the materialised buckets with
a live aggregation over whatever the refresh policy has not covered yet. The
figure becomes current to the second and the refresh policies keep their
conservative offsets, which is the combination 0005 was reaching for.

Measured cost on this deployment, 21 Devices at ~3 s intervals: 5 ms for a
day-range query against `agg_1h`, 10 ms against `agg_1m` — against 1 ms or so
materialised-only. The uncovered window is bounded by `end_offset` plus one
schedule interval, so this does not grow with retention.

⚠ Real-time aggregation over a *hierarchical* aggregate chains: `agg_1h`'s live
part reads `agg_15m`'s view, which reads `agg_1m`'s view, which reads
`readings`. All four are switched together on purpose — leaving one
materialised-only in the middle would cap the freshness of every tier above it
and reintroduce the bug one level up, where it would be harder to see.

Status: BUILT. Behaviour only — no table, column or policy changes, and every
stored figure is untouched. MASTER §10 carries the change-log row.

Revision ID: 0023
Revises: 0022
"""

from __future__ import annotations

from alembic import op
from solarcms.db.migration_helpers import timescale_available

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None

# Finest first. The order does not matter to Postgres — each ALTER is
# independent — but it is the order the cascade reads in, and a half-applied
# migration should leave the *lower* tiers real-time rather than the upper ones.
TIERS = ("agg_1m", "agg_15m", "agg_1h", "agg_1d")


def upgrade() -> None:
    # Without TimescaleDB these are ordinary materialised views refreshed by the
    # scheduler; they have no such setting and nothing to correct.
    if not timescale_available():
        return
    for tier in TIERS:
        op.execute(
            f"ALTER MATERIALIZED VIEW {tier} "
            f"SET (timescaledb.materialized_only = false)"
        )


def downgrade() -> None:
    if not timescale_available():
        return
    for tier in reversed(TIERS):
        op.execute(
            f"ALTER MATERIALIZED VIEW {tier} "
            f"SET (timescaledb.materialized_only = true)"
        )
