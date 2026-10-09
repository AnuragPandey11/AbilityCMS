"""Time what the app does per request and on a timer, against the load-test data.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/measure.py                 (3 repeats per request)
    .venv/bin/python tools/scale/measure.py --repeat 5 --label after-sweep-fix

In-process (the FastAPI app under httpx's ASGI transport), so it needs no API
server and measures the application and the database, not a socket. For every
request it records the wall time, the number of SQL statements and their summed
time. Statements run partly in parallel, so that sum can exceed the wall time:
it is an upper bound on database work, which on AWS is what costs money.

Measures each history Plant (each at a different hour of its own day, which is
the point: today's figures re-read today), one Plant with only live data, the
fleet-wide requests, and the workers' periodic units of work called directly —
one health sweep, one scheduler KPI tick.

Writes a table to stdout and the raw figures to $SCALE_RUN_DIR/measure-*.json,
so a run before a fix and a run after it can be compared line by line.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import asyncpg
import fleet
import httpx
from runpaths import run_dir
from sqlalchemy import event

from solarcms.config import get_settings
from solarcms.db.session import get_engine
from solarcms.logging import configure_logging

SQL = {"statements": 0, "seconds": 0.0}


def hook_engine() -> None:
    engine = get_engine().sync_engine

    @event.listens_for(engine, "before_cursor_execute")
    def _before(conn, cursor, statement, params, context, executemany):  # type: ignore[no-untyped-def]
        conn.info.setdefault("t0", []).append(time.perf_counter())

    @event.listens_for(engine, "after_cursor_execute")
    def _after(conn, cursor, statement, params, context, executemany):  # type: ignore[no-untyped-def]
        SQL["statements"] += 1
        SQL["seconds"] += time.perf_counter() - conn.info["t0"].pop()


async def timed(call: Any, repeat: int) -> dict[str, Any]:
    samples = []
    status = None
    for _ in range(repeat):
        SQL.update(statements=0, seconds=0.0)
        began = time.perf_counter()
        result = await call()
        took = time.perf_counter() - began
        status = getattr(result, "status_code", "ok")
        samples.append((took, SQL["statements"], SQL["seconds"]))
    walls = [s[0] for s in samples]
    middle = sorted(samples)[len(samples) // 2]
    return {"first_ms": walls[0] * 1000, "median_ms": statistics.median(walls) * 1000,
            "statements": middle[1], "db_ms": middle[2] * 1000, "status": status}


async def main(args: argparse.Namespace) -> None:
    name = os.environ.get("SCALE_DB", "")
    if not name or not os.environ.get("DATABASE_URL", "").endswith(f"/{name}"):
        sys.exit("DATABASE_URL does not name $SCALE_DB; source tools/scale/env.sh")
    configure_logging("WARNING", False)
    hook_engine()

    from solarcms.api.main import create_app
    from solarcms.workers.health_sweeper import sweep_once
    from solarcms.workers.scheduler import run_plant_kpis

    conn = await asyncpg.connect(get_settings().asyncpg_dsn)
    await conn.execute("SELECT set_config('app.is_platform_admin', 'true', false)")
    plants = {r["code"]: (r["id"], r["timezone"])
              for r in await conn.fetch("SELECT id, code, timezone FROM plants")}
    abroad = fleet.not_in_india({code: zone for code, (_id, zone) in plants.items()})
    if abroad:
        sys.exit(f"refusing to measure: every load-test Plant must be on {fleet.TIMEZONE}, "
                 f"and these are not: {', '.join(abroad)}")
    context = {
        "readings_approx": await conn.fetchval("SELECT approximate_row_count('readings')"),
        "mqtt_raw_approx": await conn.fetchval("SELECT approximate_row_count('mqtt_raw')"),
        "devices": await conn.fetchval("SELECT count(*) FROM devices"),
        "database_size": await conn.fetchval(
            "SELECT pg_size_pretty(pg_database_size(current_database()))"),
    }
    inverters = {}
    for code in [*fleet.HISTORY_PLANTS, args.live_plant]:
        inverters[code] = [r["id"] for r in await conn.fetch(
            "SELECT id FROM devices WHERE plant_id = $1 AND code LIKE 'INVERTER%' "
            "ORDER BY id LIMIT 10", plants[code][0])]
    await conn.close()

    rows: list[dict[str, Any]] = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app()),
                                 base_url="http://t", timeout=900) as h:
        async def login() -> None:
            token = (await h.post("/auth/login", json={
                "email": args.email, "password": args.password})).json()["access_token"]
            h.headers["Authorization"] = f"Bearer {token}"

        async def request(method: str, path: str, body: Any) -> httpx.Response:
            # Slow requests can outlive the 15-minute access token; log in again
            # rather than record a 401 as a measurement.
            response = await h.request(method, path, json=body)
            if response.status_code == 401:
                await login()
                response = await h.request(method, path, json=body)
            return response

        await login()

        for code in [*fleet.HISTORY_PLANTS, args.live_plant]:
            if args.scope and code not in args.scope:
                continue
            pid, tz = plants[code]
            local = datetime.now(UTC).astimezone(ZoneInfo(tz))
            hours = round(local.hour + local.minute / 60, 1)
            custom = {"plant_ids": [pid], "interval_minutes": 15, "period": "last_7_days",
                      "series": [{"device_id": d, "tag_code": "AC_ACTIVE_POWER"}
                                 for d in inverters[code]]}
            requests = [
                ("kpis today", "GET", f"/plants/{pid}/kpis?period=today", None),
                ("kpis today+compare", "GET",
                 f"/plants/{pid}/kpis?period=today&compare=true", None),
                ("kpis month", "GET", f"/plants/{pid}/kpis?period=month", None),
                ("kpis lifetime", "GET", f"/plants/{pid}/kpis?period=lifetime", None),
                ("dashboard", "GET", f"/plants/{pid}/dashboard", None),
                ("operating-status", "GET", f"/plants/{pid}/operating-status", None),
                ("strings", "GET", f"/plants/{pid}/strings", None),
                ("sld-stages", "GET", f"/plants/{pid}/sld-stages", None),
                ("forecast", "GET", f"/plants/{pid}/forecast", None),
                ("data-issues", "GET", f"/plants/{pid}/data-issues", None),
                ("report daily, last 7 days", "GET",
                 f"/reports/tables/daily_plant?plant_id={pid}&period=last_7_days", None),
                ("report inverter, yesterday", "GET",
                 f"/reports/tables/inverter?plant_id={pid}&period=yesterday", None),
                ("custom report, 10 series, 7 d, 15 min", "POST",
                 "/reports/custom/table", custom),
            ]
            for label, method, path, body in requests:
                async def call(method: str = method, path: str = path, body: Any = body):  # type: ignore[no-untyped-def]
                    return await request(method, path, body)
                result = await timed(call, args.repeat)
                rows.append({"scope": code, "hours_into_day": hours, "what": label, **result})
                print(f"{code:<8} {hours:>5}h  {label:<40} {result['median_ms']:>8,.0f} ms "
                      f"(first {result['first_ms']:,.0f})  {result['statements']:>3} stmts "
                      f"{result['db_ms']:>8,.0f} ms db  [{result['status']}]", flush=True)

        fleet_requests = [
            ("plants list", "GET", "/plants", None),
            ("data-issues summary", "GET", "/data-issues/summary", None),
            ("discovery clients", "GET", "/discovery/clients", None),
            ("discovery plants (LT01)", "GET", "/discovery/plants?client_code=LT01", None),
            ("alarms, latest 100", "GET", "/alarms?limit=100", None),
            ("health processes", "GET", "/health/processes", None),
            ("health system", "GET", "/health/system", None),
        ]
        for label, method, path, body in fleet_requests:
            if args.scope and "fleet" not in args.scope:
                break
            async def call(method: str = method, path: str = path, body: Any = body):  # type: ignore[no-untyped-def]
                return await request(method, path, body)
            result = await timed(call, args.repeat)
            rows.append({"scope": "fleet", "hours_into_day": None, "what": label, **result})
            print(f"{'fleet':<8} {'':>6}  {label:<40} {result['median_ms']:>8,.0f} ms "
                  f"(first {result['first_ms']:,.0f})  {result['statements']:>3} stmts "
                  f"{result['db_ms']:>8,.0f} ms db  [{result['status']}]", flush=True)

    for label, work in (() if args.scope and "worker" not in args.scope else (
                        ("health sweep (one pass)", sweep_once),
                        ("scheduler KPI tick (every Plant)", run_plant_kpis))):
        result = await timed(work, 2 if label.startswith("health") else 1)
        rows.append({"scope": "worker", "hours_into_day": None, "what": label, **result})
        print(f"{'worker':<8} {'':>6}  {label:<40} {result['median_ms']:>8,.0f} ms "
              f"(first {result['first_ms']:,.0f})  {result['statements']:>3} stmts "
              f"{result['db_ms']:>8,.0f} ms db", flush=True)

    out = run_dir() / f"measure-{args.label}-{datetime.now(UTC):%Y%m%dT%H%M%S}.json"
    out.write_text(json.dumps({"label": args.label, "context": context, "rows": rows},
                              indent=1, default=str))
    print(f"\n{context}\nwritten to {out}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--label", default="baseline")
    parser.add_argument("--scope", action="append", default=[],
                        help="a Plant code, 'fleet' or 'worker' (repeatable); default all")
    parser.add_argument("--live-plant", default="LT05_P1")
    parser.add_argument("--email", default="admin@loadtest.example.com")
    parser.add_argument("--password", default="admin12345")
    asyncio.run(main(parser.parse_args()))
