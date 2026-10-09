"""Measure one round trip to Postgres and to Redis on the given ports.

    .venv/bin/python tools/scale/rtt.py 5433 6379 direct

Used by `latency.sh` to print the delay a run actually had. Connects to the
`postgres` database, which always exists, with the docker-compose credentials.
"""

from __future__ import annotations

import asyncio
import sys
import time

import asyncpg
import redis.asyncio as redis

ROUNDS = 300


async def main(pg_port: int, redis_port: int, label: str) -> None:
    r = redis.Redis(port=redis_port)
    conn = await asyncpg.connect(
        f"postgresql://solarcms:solarcms@localhost:{pg_port}/postgres")
    for _ in range(20):
        await r.ping()
        await conn.fetchval("SELECT 1")
    began = time.perf_counter()
    for _ in range(ROUNDS):
        await r.ping()
    redis_ms = (time.perf_counter() - began) / ROUNDS * 1000
    began = time.perf_counter()
    for _ in range(ROUNDS):
        await conn.fetchval("SELECT 1")
    pg_ms = (time.perf_counter() - began) / ROUNDS * 1000
    await conn.close()
    await r.aclose()
    print(f"round trip {label:<18}: Postgres {pg_ms:.3f} ms, Redis {redis_ms:.3f} ms",
          flush=True)


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]))
