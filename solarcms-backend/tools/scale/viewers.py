"""People looking at screens, requesting what the frontend requests, as often.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/viewers.py --plant-viewers 10 --portfolio-viewers 2 --minutes 10

Against a running API (the supervisor's, on :8000). Two kinds of viewer,
copying the frontend's own cadence:

* **Plant screen** — `live/useLiveRefresh.ts` refetches the dashboard, the KPIs
  (with the previous-period comparison) and the operating status after every
  live frame, grouped into one refetch per second. A 57-topic Plant sends a
  frame every half second, so in practice: those three, in parallel, every
  second after the last ones came back.
* **Portfolio** — `usePlantKpiFanout` and the dashboard fan-out: today's KPIs
  and the dashboard for every Plant, every 10 s, six requests at a time (a
  browser's connection limit per host over HTTP/1.1).

Each Plant viewer logs in as that Plant's own Client Admin; Portfolio viewers
log in as the Super Admin and see all 50. Prints latency percentiles per
request every minute and at the end, and writes them to $SCALE_RUN_DIR.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet
import httpx
from runpaths import run_dir

LATENCY: dict[str, list[float]] = defaultdict(list)
ERRORS: dict[str, int] = defaultdict(int)


async def login(h: httpx.AsyncClient, email: str, password: str) -> None:
    r = await h.post("/auth/login", json={"email": email, "password": password})
    r.raise_for_status()
    h.headers["Authorization"] = f"Bearer {r.json()['access_token']}"


async def get(h: httpx.AsyncClient, label: str, path: str) -> None:
    began = time.perf_counter()
    try:
        r = await h.get(path)
        if r.status_code >= 400:
            ERRORS[f"{label} {r.status_code}"] += 1
    except httpx.HTTPError as exc:
        ERRORS[f"{label} {type(exc).__name__}"] += 1
    LATENCY[label].append(time.perf_counter() - began)


async def plant_viewer(base: str, email: str, plant_id: int, stop_at: float) -> None:
    async with httpx.AsyncClient(base_url=base, timeout=120) as h:
        await login(h, email, fleet.PASSWORD)
        while time.monotonic() < stop_at:
            began = time.monotonic()
            await asyncio.gather(
                get(h, "plant: dashboard", f"/plants/{plant_id}/dashboard"),
                get(h, "plant: kpis today+compare",
                    f"/plants/{plant_id}/kpis?period=today&compare=true"),
                get(h, "plant: operating-status", f"/plants/{plant_id}/operating-status"),
            )
            await asyncio.sleep(max(0.0, 1.0 - (time.monotonic() - began)))


async def portfolio_viewer(base: str, email: str, password: str, plant_ids: list[int],
                           stop_at: float) -> None:
    async with httpx.AsyncClient(base_url=base, timeout=300) as h:
        await login(h, email, password)
        slots = asyncio.Semaphore(6)

        async def one(label: str, path: str) -> None:
            async with slots:
                await get(h, label, path)

        while time.monotonic() < stop_at:
            began = time.monotonic()
            await asyncio.gather(*(
                one(label, path) for pid in plant_ids for label, path in (
                    ("portfolio: kpis today", f"/plants/{pid}/kpis?period=today"),
                    ("portfolio: dashboard", f"/plants/{pid}/dashboard"),
                )))
            took = time.monotonic() - began
            LATENCY["portfolio: whole refresh"].append(took)
            await asyncio.sleep(max(0.0, 10.0 - took))


def summary() -> dict[str, dict[str, float]]:
    out = {}
    for label, values in sorted(LATENCY.items()):
        v = sorted(values)
        out[label] = {"n": len(v), "p50_ms": statistics.median(v) * 1000,
                      "p95_ms": v[int(len(v) * 0.95) - 1] * 1000 if len(v) > 1 else v[0] * 1000,
                      "max_ms": v[-1] * 1000}
    return out


async def reporter(stop_at: float) -> None:
    while time.monotonic() < stop_at:
        await asyncio.sleep(60)
        print(f"── {datetime.now(UTC):%H:%M:%S}", flush=True)
        for label, s in summary().items():
            print(f"  {label:<30} n={s['n']:>6}  p50 {s['p50_ms']:>8,.0f} ms  "
                  f"p95 {s['p95_ms']:>8,.0f} ms  max {s['max_ms']:>8,.0f} ms", flush=True)
        if ERRORS:
            print(f"  errors: {dict(ERRORS)}", flush=True)


async def main(args: argparse.Namespace) -> None:
    async with httpx.AsyncClient(base_url=args.base, timeout=60) as h:
        await login(h, args.admin_email, args.admin_password)
        plants = (await h.get("/plants")).json()
        plants = plants if isinstance(plants, list) else plants.get("items", [])
    by_code = {p["code"]: p["id"] for p in plants}
    all_ids = [by_code[p.code] for c in fleet.FLEET for p in c.plants if p.code in by_code]
    # One Plant viewer per Plant, spread over the Clients: LT01_P1, LT02_P1, ...
    chosen = [(c, p) for i in range(fleet.PLANTS_PER_CLIENT) for c in fleet.FLEET
              for p in c.plants[i:i + 1]][:args.plant_viewers]
    stop_at = time.monotonic() + args.minutes * 60
    print(f"{len(chosen)} Plant viewers, {args.portfolio_viewers} Portfolio viewers "
          f"over {len(all_ids)} Plants, {args.minutes:g} min", flush=True)
    await asyncio.gather(
        reporter(stop_at),
        *(plant_viewer(args.base, c.admin_email, by_code[p.code], stop_at) for c, p in chosen),
        *(portfolio_viewer(args.base, args.admin_email, args.admin_password, all_ids, stop_at)
          for _ in range(args.portfolio_viewers)),
    )
    result = {"args": vars(args), "latency": summary(), "errors": dict(ERRORS)}
    out = run_dir() / f"viewers-{datetime.now(UTC):%Y%m%dT%H%M%S}.json"
    out.write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--plant-viewers", type=int, default=10)
    parser.add_argument("--portfolio-viewers", type=int, default=1)
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--admin-email", default="admin@loadtest.example.com")
    parser.add_argument("--admin-password", default="admin12345")
    asyncio.run(main(parser.parse_args()))
