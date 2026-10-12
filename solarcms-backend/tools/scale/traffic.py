"""Measure the bytes each part of the stack moves during a live load test.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/traffic.py --minutes 10

Run while the supervisor and `publish.py` are running (README, "The live run").
Takes a snapshot at the start and the end of the window of:

* each container's network bytes (EMQX, Redis, Postgres), from the container's
  own `eth0` counters — every byte the processes on the host exchanged with it;
* Redis's `total_net_input_bytes` / `total_net_output_bytes`;
* Postgres WAL written, which is what streaming replication ships to a replica;
* the bytes each process appended to its log, split by level (JSON logs, as
  production writes them: run the supervisor with `LOG_JSON=true`);

and listens on the live-frame channel (`ws:fanout`) for the window, which is
what every API process that has a browser connected receives.

Prints figures per hour and per 730-hour month, and writes them to
$SCALE_RUN_DIR/traffic-*.json. These are the inputs to the AWS cost lines that
are billed per GB: NLB and ALB capacity units, NAT data, cross-AZ transfer and
CloudWatch Logs.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
from collections import defaultdict
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet  # noqa: F401  (puts the backend on sys.path)
import redis.asyncio as redis
from runpaths import run_dir

CONTAINERS = ("solarcms-emqx", "solarcms-redis", "solarcms-postgres")
HOURS_PER_MONTH = 730


def sh(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def container_bytes(name: str) -> dict[str, int]:
    rx = int(sh("docker", "exec", name, "cat", "/sys/class/net/eth0/statistics/rx_bytes"))
    tx = int(sh("docker", "exec", name, "cat", "/sys/class/net/eth0/statistics/tx_bytes"))
    return {"rx": rx, "tx": tx}


def redis_net() -> dict[str, int]:
    stats = sh("docker", "exec", "solarcms-redis", "redis-cli", "info", "stats")
    found = dict(re.findall(r"^(total_net_\w+_bytes):(\d+)", stats, re.M))
    return {k: int(v) for k, v in found.items()}


def wal_lsn() -> str:
    return sh("docker", "exec", "solarcms-postgres", "psql", "-U", "solarcms", "-d", "postgres",
              "-At", "-c", "select pg_current_wal_lsn()").strip()


def wal_diff(end: str, start: str) -> int:
    return int(float(sh("docker", "exec", "solarcms-postgres", "psql", "-U", "solarcms", "-d",
                        "postgres", "-At", "-c",
                        f"select pg_wal_lsn_diff('{end}', '{start}')").strip()))


def log_offsets(log_dir: Path) -> dict[str, int]:
    return {p.name: p.stat().st_size for p in log_dir.glob("*.log")}


def log_growth(log_dir: Path, start: dict[str, int]) -> dict[str, dict[str, int]]:
    """Bytes each process appended to its log since `start`, by level."""
    out: dict[str, dict[str, int]] = {}
    for path in log_dir.glob("*.log"):
        by_level: dict[str, int] = defaultdict(int)
        with path.open("rb") as f:
            f.seek(start.get(path.name, 0))
            for raw in f:
                level = "unparsed"
                try:
                    level = str(json.loads(raw).get("level", "unknown")).lower()
                except (ValueError, AttributeError):
                    match = re.search(rb"\[\s*(\w+)\s*\]", raw)
                    if match:
                        level = match.group(1).decode().lower()
                by_level[level] += len(raw)
        out[path.stem] = dict(by_level)
    return out


async def listen_frames(seconds: float) -> dict[str, int]:
    client = redis.Redis(host="localhost", port=6379)
    pubsub = client.pubsub()
    await pubsub.subscribe("ws:fanout")
    frames = 0
    size = 0
    stop = time.monotonic() + seconds
    while time.monotonic() < stop:
        message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
        if message and message.get("type") == "message":
            frames += 1
            size += len(message["data"])
    await pubsub.aclose()
    await client.aclose()
    return {"frames": frames, "bytes": size}


async def main(args: argparse.Namespace) -> None:
    log_dir = Path(args.log_dir) if args.log_dir else run_dir() / "logs"
    start = {
        "containers": {c: container_bytes(c) for c in CONTAINERS},
        "redis": redis_net(), "wal": wal_lsn(), "logs": log_offsets(log_dir),
    }
    began = time.monotonic()
    print(f"measuring for {args.minutes:g} minutes…", flush=True)
    frames = await listen_frames(args.minutes * 60)
    seconds = time.monotonic() - began
    end = {
        "containers": {c: container_bytes(c) for c in CONTAINERS},
        "redis": redis_net(), "wal": wal_lsn(),
    }
    per_hour = 3600 / seconds

    def scale(value: int) -> dict[str, float]:
        return {"per_hour_mb": round(value * per_hour / 1e6, 2),
                "per_month_gb": round(value * per_hour * HOURS_PER_MONTH / 1e9, 1)}

    result = {
        "window_s": round(seconds, 1),
        "containers": {c: {d: scale(end["containers"][c][d] - start["containers"][c][d])
                           for d in ("rx", "tx")} for c in CONTAINERS},
        "redis": {k: scale(end["redis"][k] - start["redis"][k]) for k in end["redis"]},
        "postgres_wal": scale(wal_diff(end["wal"], start["wal"])),
        "live_frames": {"per_s": round(frames["frames"] / seconds, 1),
                        "avg_bytes": round(frames["bytes"] / max(frames["frames"], 1)),
                        **scale(frames["bytes"])},
        "logs": {proc: {lvl: scale(b) for lvl, b in levels.items()}
                 for proc, levels in log_growth(log_dir, start["logs"]).items()},
    }
    out = run_dir() / f"traffic-{datetime.now(UTC):%Y%m%dT%H%M%S}.json"
    out.write_text(json.dumps(result, indent=1))
    print(json.dumps(result, indent=1))
    print(f"written to {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--minutes", type=float, default=10.0)
    parser.add_argument("--log-dir", default=None)
    asyncio.run(main(parser.parse_args()))
