"""Sample every process during a live load test: is each one keeping up?

    source tools/scale/env.sh
    .venv/bin/python tools/scale/monitor.py --minutes 20

Every 15 s, records:

* **ingest** — messages handled (from its heartbeat) against messages
  published (from the publisher's log), and its resident memory. ⚠ Ingest
  acknowledges on receipt (CAPACITY_AND_DEPLOYMENT.md §4.1), so a backlog does
  not wait at the broker: it sits in ingest's memory. Handled-rate below the
  published rate, and memory climbing, is what falling behind looks like.
* **health sweep / scheduler** — the gap between consecutive completed cycles.
  Each sleeps 60 s after its work, so the gap minus 60 s is how long one pass
  took; past 60 s, it no longer finishes within its own interval.
* **alarm worker** — the stream backlog (`alarm_backlog`, from /health/system).
* **CPU and memory** of every SolarCMS process and of the Postgres container.

Writes one JSON line per sample to $SCALE_RUN_DIR/monitor-*.jsonl and prints a
one-line digest.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet  # noqa: F401  (puts the backend on sys.path)
import httpx
from runpaths import run_dir

PROCESSES = ("solarcms.api.main", "solarcms.workers.ingest", "solarcms.workers.alarm",
             "solarcms.workers.health_sweeper", "solarcms.workers.scheduler")


def ps() -> dict[str, dict[str, float]]:
    out = subprocess.run(["ps", "-axo", "pid,%cpu,rss,command"], capture_output=True,
                         text=True).stdout.splitlines()[1:]
    found: dict[str, dict[str, float]] = {}
    for line in out:
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        for name in PROCESSES:
            if name in parts[3] and "supervisor" not in parts[3]:
                entry = found.setdefault(name.rsplit(".", 1)[-1], {"cpu": 0.0, "rss_mb": 0.0})
                entry["cpu"] += float(parts[1])
                entry["rss_mb"] += int(parts[2]) / 1024
    return found


def postgres() -> dict[str, str]:
    line = subprocess.run(["docker", "stats", "--no-stream", "--format",
                           "{{.CPUPerc}} {{.MemUsage}}", "solarcms-postgres"],
                          capture_output=True, text=True).stdout.strip()
    cpu, _, mem = line.partition(" ")
    return {"cpu": cpu, "mem": mem.split(" /")[0]}


def published(log: Path | None) -> int | None:
    if log is None or not log.exists():
        return None
    for line in reversed(log.read_text().splitlines()):
        if " published " in line:
            return int(line.split(" published ")[1].split(" ")[0].replace(",", ""))
    return None


async def main(args: argparse.Namespace) -> None:
    out = run_dir() / f"monitor-{datetime.now(UTC):%Y%m%dT%H%M%S}.jsonl"
    pub_log = Path(args.publish_log) if args.publish_log else None
    stop_at = time.monotonic() + args.minutes * 60
    last_cycle: dict[str, str] = {}
    gaps: dict[str, float] = {}
    prev: tuple[float, int, int | None] | None = None
    async with httpx.AsyncClient(base_url=args.base, timeout=30) as h:
        r = await h.post("/auth/login", json={"email": args.admin_email,
                                              "password": args.admin_password})
        h.headers["Authorization"] = f"Bearer {r.json()['access_token']}"
        while time.monotonic() < stop_at:
            now = time.monotonic()
            health = (await h.get("/health/processes")).json()
            system = (await h.get("/health/system")).json()
            procs = {p["name"]: p for p in health.get("processes", [])}
            handled = int((health.get("broker") or {}).get("messages") or 0)
            for name in ("health_sweeper", "scheduler"):
                at = (procs.get(name) or {}).get("last_cycle_at")
                if at and last_cycle.get(name) and at != last_cycle[name]:
                    gaps[name] = (datetime.fromisoformat(at)
                                  - datetime.fromisoformat(last_cycle[name])).total_seconds()
                if at:
                    last_cycle[name] = at
            pub = published(pub_log)
            rates = {}
            if prev is not None:
                span = now - prev[0]
                rates["handled_per_s"] = round((handled - prev[1]) / span, 1)
                if pub is not None and prev[2] is not None:
                    rates["published_per_s"] = round((pub - prev[2]) / span, 1)
            prev = (now, handled, pub)
            sample = {
                "at": datetime.now(UTC).isoformat(timespec="seconds"),
                "ingest_handled": handled, "published": pub, **rates,
                "alarm_backlog": system.get("alarm_backlog"),
                "cycle_gap_s": dict(gaps), "processes": ps(), "postgres": postgres(),
                "health": health, "system": system,
            }
            with out.open("a") as f:
                f.write(json.dumps(sample, default=str) + "\n")
            cpu = " ".join(f"{k}={v['cpu']:.0f}%/{v['rss_mb']:.0f}MB"
                           for k, v in sample["processes"].items())
            print(f"{sample['at'][11:]} handled {rates.get('handled_per_s', '-')}/s "
                  f"published {rates.get('published_per_s', '-')}/s  "
                  f"backlog {sample['alarm_backlog']}  gaps {gaps}  {cpu}  "
                  f"pg {sample['postgres']['cpu']}", flush=True)
            await asyncio.sleep(max(0.0, 15 - (time.monotonic() - now)))
    print(f"written to {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://localhost:8000")
    parser.add_argument("--minutes", type=float, default=20.0)
    parser.add_argument("--publish-log", default=None)
    parser.add_argument("--admin-email", default="admin@loadtest.example.com")
    parser.add_argument("--admin-password", default="admin12345")
    asyncio.run(main(parser.parse_args()))
