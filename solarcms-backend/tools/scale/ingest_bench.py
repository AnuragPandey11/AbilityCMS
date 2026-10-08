"""How many messages per second the ingest worker handles, on the fleet's real mix.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/ingest_bench.py
    tools/scale/latency.sh 1        (the same, with 1 ms added to every round trip)

Feeds `IngestWorker.handle()` directly — no broker, so it measures ingest and
nothing in front of it — with one publishing cycle of several load-test Plants
(57 topics each: Inverters, their two string topics, meters, WMS, VCB, PPC),
flushing to the database exactly as the worker does. Two paths, because the
real one lies between them:

* **throttled** — every Tag still inside its throttle window, so nothing is
  stored. What most messages are, when Devices publish faster than Tags store.
* **unthrottled** — throttling disabled, so every value is decoded, cached,
  buffered and written. The ceiling's worst case.

Ingest handles one message at a time, so 1 / (time per message) is its
ceiling in messages per second, whatever else the machine is doing.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet

from solarcms.cache import live
from solarcms.config import get_settings
from solarcms.logging import configure_logging
from solarcms.workers.ingest import IngestWorker

PLANTS = ("LT06_P1", "LT07_P1", "LT08_P1", "LT09_P1", "LT10_P1")
ROUNDS = 6


async def run(worker: IngestWorker, messages: list[tuple[str, bytes]]) -> tuple[float, int]:
    stored_before = worker.stats["stored"] + len(worker.batch.readings)
    began = time.perf_counter()
    for _ in range(ROUNDS):
        for topic, body in messages:
            await worker.handle(topic, body)
            if worker.batch.should_flush(worker.settings, datetime.now(UTC)):
                await worker.flush()
    await worker.flush()
    took = time.perf_counter() - began
    return took / (ROUNDS * len(messages)), worker.stats["stored"] - stored_before


async def main() -> None:
    name = os.environ.get("SCALE_DB", "")
    if not name or f"/{name}" not in os.environ.get("DATABASE_URL", ""):
        sys.exit("DATABASE_URL does not name $SCALE_DB; source tools/scale/env.sh")
    configure_logging("ERROR", False)
    settings = get_settings()
    sims = [s for s in fleet.all_sims() if s.plant.code in PLANTS]
    import json
    messages = [(t, json.dumps(b).encode()) for s in sims
                for t, b in fleet.messages(s, datetime.now(UTC))]

    worker = IngestWorker(settings)
    await worker.start()
    for topic, body in messages:            # warm the resolution cache
        await worker.handle(topic, body)
    await worker.flush()

    per_msg, _ = await run(worker, messages)
    print(f"throttled   : {per_msg * 1000:6.2f} ms/message -> {1 / per_msg:7,.0f} messages/s",
          flush=True)

    original = live.read_throttle_state

    async def nothing_throttled(device_id: int, tag_ids: list[int]) -> dict:
        return {}

    live.read_throttle_state = nothing_throttled
    per_msg, stored = await run(worker, messages)
    live.read_throttle_state = original
    n = ROUNDS * len(messages)
    print(f"unthrottled : {per_msg * 1000:6.2f} ms/message -> {1 / per_msg:7,.0f} messages/s "
          f"({stored / n:.1f} readings per message)", flush=True)
    await worker.stop()


if __name__ == "__main__":
    asyncio.run(main())
