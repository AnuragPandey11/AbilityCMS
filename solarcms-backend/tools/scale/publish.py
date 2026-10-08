"""Publish the load-test fleet to the broker, every Plant every 30 s.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/publish.py                       (all 50 Plants)
    .venv/bin/python tools/scale/publish.py --daylight            (live Plants at noon)
    .venv/bin/python tools/scale/publish.py --minutes 20

Plants are staggered across the interval, as real dataloggers are, and each
keeps its own 30 s cadence against the clock rather than sleeping 30 s after
publishing (which would drift and slowly bunch the fleet together).

The Plants in `fleet.HISTORY_PLANTS` resume from the counters `history.py`
saved, so their lifetime registers carry on from the generated history instead
of jumping. `--daylight` shifts only the *other* Plants' sun, so the live load
is a generating fleet whatever the hour; the history Plants keep their real
clock, or their history would have a step in it.

Every minute it prints messages published, and the rate.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import aiomqtt
import fleet
from runpaths import run_dir


def load_saved() -> dict:
    saved: dict = {}
    for path in run_dir().glob("state-*.json"):
        saved.update(json.loads(path.read_text()))
    return saved


def noon_offset(timezone: str) -> float:
    """Hours to add to the real clock so the sun stands at noon in `timezone`."""
    local = datetime.now(UTC).astimezone(ZoneInfo(timezone))
    return 12.0 - (local.hour + local.minute / 60)


async def run_plant(client: aiomqtt.Client, sim: fleet.sf.PlantSim, stats: dict[str, int],
                    stop_at: float | None) -> None:
    interval = sim.plant.interval_s
    start = time.monotonic() + random.uniform(0, interval)
    cycle = 0
    while stop_at is None or time.monotonic() < stop_at:
        await asyncio.sleep(max(0.0, start + cycle * interval - time.monotonic()))
        for topic, body in fleet.messages(sim, datetime.now(UTC)):
            await client.publish(topic, json.dumps(body).encode(), qos=1)
            stats["published"] += 1
        cycle += 1


async def report(stats: dict[str, int], stop_at: float | None) -> None:
    last, last_t = 0, time.monotonic()
    while stop_at is None or time.monotonic() < stop_at:
        await asyncio.sleep(60)
        now = time.monotonic()
        n = stats["published"]
        print(f"{datetime.now(UTC):%H:%M:%S} published {n:,} "
              f"({(n - last) / (now - last_t):.1f} msg/s)", flush=True)
        last, last_t = n, now


async def main(args: argparse.Namespace) -> None:
    saved = load_saved()
    sims = []
    for client in fleet.FLEET:
        for plant in client.plants:
            if args.plant and plant.code not in args.plant:
                continue
            history = plant.code in fleet.HISTORY_PLANTS
            offset = noon_offset(plant.timezone) if args.daylight and not history else 0.0
            sims.append(fleet.sf.PlantSim(client, plant, offset, saved))
    stop_at = time.monotonic() + args.minutes * 60 if args.minutes else None
    stats = {"published": 0}
    # Counted from the specs: sampling here would accrue one extra interval.
    topics = sum(3 if d.kind == "INVERTER" and d.strings else 1
                 for s in sims for d in s.plant.devices)
    print(f"{len(sims)} Plants, {topics} topics every {fleet.INTERVAL_S:g}s "
          f"= {topics / fleet.INTERVAL_S:.1f} msg/s expected", flush=True)
    async with aiomqtt.Client(hostname=args.host, port=args.port,
                              identifier=f"loadtest-pub-{random.randint(1000, 9999)}",
                              max_queued_outgoing_messages=100_000) as client:
        await asyncio.gather(report(stats, stop_at),
                             *(run_plant(client, s, stats, stop_at) for s in sims))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--plant", action="append", default=[])
    parser.add_argument("--daylight", action="store_true")
    parser.add_argument("--minutes", type=float, default=0.0)
    try:
        asyncio.run(main(parser.parse_args()))
    except KeyboardInterrupt:
        pass
