"""Generate days of history for one Plant, through ingest's own decoding.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/history.py --plant LT01_P1 --days 8
    .venv/bin/python tools/scale/history.py --plant LT01_P1 --resume   (fill up to now)

Drives the fleet simulator over past timestamps, one 30 s cycle at a time, and
puts every message through the same `resolve` and `decode` the ingest worker
uses — bindings, scaling, quality flags and per-Tag throttling — then COPYs the
result into `readings` and `mqtt_raw` as the ingest role. So the rows are the
ones ingest would have written had the Plant been publishing all along; only
the MQTT hop is skipped. It runs until it catches up with the clock, and saves
the simulator's counters so `publish.py` carries on from them.

Afterwards, once for all Plants: `finish_history.py` (aggregates, compression).

⚠ Writes into $SCALE_DB only, and refuses to run without it.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import asyncpg
import fleet
from runpaths import run_dir

from solarcms.cache.live import close_redis
from solarcms.config import get_settings
from solarcms.db.rls import INGEST_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.decoding import decode
from solarcms.logging import configure_logging
from solarcms.workers.ingest import MQTT_RAW_COLUMNS, READINGS_COLUMNS
from solarcms.workers.resolver import ResolutionFailure, load_topic_patterns, resolve

FLUSH_ROWS = 200_000


def find_plant(code: str) -> tuple[fleet.sf.ClientSpec, fleet.sf.PlantSpec]:
    for client in fleet.FLEET:
        for plant in client.plants:
            if plant.code == code:
                return client, plant
    sys.exit(f"no Plant {code} in the load-test fleet")


async def main(args: argparse.Namespace) -> None:
    name = os.environ.get("SCALE_DB", "")
    if not name or not os.environ.get("DATABASE_URL", "").endswith(f"/{name}"):
        sys.exit("DATABASE_URL does not name $SCALE_DB; source tools/scale/env.sh")
    configure_logging("WARNING", False)
    settings = get_settings()
    client, plant = find_plant(args.plant)
    interval = timedelta(seconds=plant.interval_s)
    start = datetime.now(UTC) - timedelta(days=args.days)
    start = start.replace(second=0, microsecond=0)
    saved = None
    if args.resume:
        # Carry on from this Plant's last reading, with the counters it saved,
        # so a pause between generating and measuring leaves no hole in "today".
        state = run_dir() / f"state-{plant.code}.json"
        if not state.exists():
            sys.exit(f"nothing to resume: {state} does not exist")
        saved = json.loads(state.read_text())
        conn = await asyncpg.connect(settings.asyncpg_dsn)
        await conn.execute("SELECT set_config('app.is_platform_admin', 'true', false)")
        last = await conn.fetchval("""
            SELECT max(r.time) FROM readings r JOIN devices d ON d.id = r.device_id
              JOIN plants p ON p.id = d.plant_id WHERE p.code = $1""", plant.code)
        await conn.close()
        start = last + interval

    topics = [topic for topic, _ in fleet.messages(fleet.sf.PlantSim(client, plant), start)]
    async with scoped_session(SecurityContext.platform(0), role=None) as session:
        patterns = await load_topic_patterns(session)
        resolutions = {t: await resolve(session, t, patterns) for t in topics}
    missing = [t for t, r in resolutions.items() if isinstance(r, ResolutionFailure)]
    if missing:
        sys.exit(f"{len(missing)} topics are not registered (commission first): {missing[:3]}")

    sim = fleet.sf.PlantSim(client, plant, 0.0, saved)
    pool = await asyncpg.create_pool(settings.asyncpg_dsn, min_size=1, max_size=1,
                                     server_settings={"role": INGEST_ROLE})
    throttle: dict[int, dict] = defaultdict(dict)
    counters: dict[int, dict] = defaultdict(dict)
    standing: dict[int, dict] = defaultdict(dict)
    readings: list[tuple] = []
    raw: list[tuple] = []
    totals = {"messages": 0, "readings": 0, "raw": 0}
    seq = 0
    began = time.monotonic()

    async def flush() -> None:
        async with pool.acquire() as conn, conn.transaction():
            if readings:
                await conn.copy_records_to_table("readings", records=readings,
                                                 columns=list(READINGS_COLUMNS))
            if raw:
                await conn.copy_records_to_table("mqtt_raw", records=raw,
                                                 columns=list(MQTT_RAW_COLUMNS))
        totals["readings"] += len(readings)
        totals["raw"] += len(raw)
        readings.clear()
        raw.clear()

    moment = start
    last_report = time.monotonic()
    while moment <= datetime.now(UTC):
        for topic, payload in fleet.messages(sim, moment):
            res = resolutions[topic]
            device = res.device_id
            result = decode(topic, payload, res, moment, source_time=None,
                            last_written=throttle[device],
                            last_counter_value=counters[device],
                            standing=standing[device] if res.derived else None)
            totals["messages"] += 1
            seq = (seq + 1) % 1_000_000
            if result.quarantined:
                raw.append((moment, topic, seq, json.dumps(payload), res.client_id, device,
                            True, result.rejection))
                continue
            if not result.readings:
                continue  # every Tag inside its throttle window: ingest stores nothing
            for r in result.readings:
                readings.append((r.time, r.client_id, r.device_id, r.tag_id, r.value,
                                 r.quality, r.source_time))
                throttle[device][r.tag_id] = moment
                counters[device][r.tag_id] = r.value
                if r.value is not None:
                    standing[device][r.tag_code] = r.value
            raw.append((moment, topic, seq, json.dumps(payload), res.client_id, device,
                        False, None))
        if len(readings) >= FLUSH_ROWS:
            await flush()
        if time.monotonic() - last_report > 30:
            print(f"{plant.code} at {moment:%Y-%m-%d %H:%M} UTC: {totals['messages']:,} "
                  f"messages, {totals['readings']:,} readings written", flush=True)
            last_report = time.monotonic()
        moment += interval
    await flush()
    await pool.close()

    store = fleet.sf.StateStore(run_dir() / f"state-{plant.code}.json")
    store.sims = [sim]
    store.save()
    await close_redis()
    await dispose_engine()
    took = time.monotonic() - began
    print(f"{plant.code}: from {start:%Y-%m-%d %H:%M} UTC, {totals['messages']:,} messages, "
          f"{totals['readings']:,} readings, {totals['raw']:,} raw rows in {took:,.0f} s "
          f"({totals['messages'] / took:,.0f} messages/s)", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plant", required=True)
    parser.add_argument("--days", type=float, default=8.0)
    parser.add_argument("--resume", action="store_true",
                        help="continue from this Plant's last reading up to now")
    asyncio.run(main(parser.parse_args()))
