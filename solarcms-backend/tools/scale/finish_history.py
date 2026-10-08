"""After `history.py`: make the generated history look as if it had been live.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/finish_history.py

1. Backdates the history Plants' Devices to their first reading. Coverage and
   availability count only from when a Device existed, so without this every
   generated day before commissioning would be ignored.
2. Refreshes the four continuous aggregates over the whole history, in cascade
   order — the background policies would get there, slowly.
3. Runs the compression policies, so chunks older than 7 days are compressed
   as they would be in production.

Prints each hypertable's size afterwards.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import asyncpg
import fleet

from solarcms.config import get_settings

TIERS = ("agg_1m", "agg_15m", "agg_1h", "agg_1d")


async def main() -> None:
    name = os.environ.get("SCALE_DB", "")
    if not name or not os.environ.get("DATABASE_URL", "").endswith(f"/{name}"):
        sys.exit("DATABASE_URL does not name $SCALE_DB; source tools/scale/env.sh")
    conn = await asyncpg.connect(get_settings().asyncpg_dsn)
    # FORCE ROW LEVEL SECURITY applies to the owner too.
    await conn.execute("SELECT set_config('app.is_platform_admin', 'true', false)")

    codes = list(fleet.HISTORY_PLANTS)
    first = await conn.fetchval("""
        SELECT min(r.time) FROM readings r JOIN devices d ON d.id = r.device_id
          JOIN plants p ON p.id = d.plant_id WHERE p.code = ANY($1)""", codes)
    updated = await conn.execute("""
        UPDATE devices d SET created_at = $2 FROM plants p
         WHERE p.id = d.plant_id AND p.code = ANY($1) AND d.created_at > $2""", codes, first)
    print(f"history starts {first:%Y-%m-%d %H:%M} UTC; backdated: {updated}")

    for tier in TIERS:
        began = time.monotonic()
        await conn.execute(
            f"CALL refresh_continuous_aggregate('{tier}', $1::timestamptz, NULL)", first)
        print(f"refreshed {tier} in {time.monotonic() - began:,.0f} s", flush=True)

    jobs = await conn.fetch("""
        SELECT job_id, hypertable_name FROM timescaledb_information.jobs
         WHERE proc_name = 'policy_compression'""")
    for job in jobs:
        began = time.monotonic()
        await conn.execute(f"CALL run_job({job['job_id']})")
        print(f"compressed {job['hypertable_name']} in {time.monotonic() - began:,.0f} s")

    for row in await conn.fetch("""
        SELECT hypertable_name AS name,
               pg_size_pretty(hypertable_size(format('%I.%I', hypertable_schema,
                                                     hypertable_name)::regclass)) AS size
          FROM timescaledb_information.hypertables ORDER BY 1"""):
        print(f"  {row['name']:<32} {row['size']}")
    await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
