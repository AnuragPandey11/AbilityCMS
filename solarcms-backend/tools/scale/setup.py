"""Create the load-test database from empty: migrate, seed, add the fleet.

    source tools/scale/env.sh
    .venv/bin/python tools/scale/setup.py            (refuses if the database exists)
    .venv/bin/python tools/scale/setup.py --drop     (drops the load-test database)

Devices are *not* created here, for the reason `scripts/seed_fleet.py` gives:
they are registered by `commission-from-broker` from what the publisher sends,
so the onboarding path is under load too. After this:

    .venv/bin/python tools/scale/publish.py &
    .venv/bin/python -m solarcms.cli commission-from-broker \
        --topic 'loadtest/v1/#' --seconds 75
    .venv/bin/python -m solarcms.cli commission-from-broker \
        --topic 'loadtest/v1/#' --seconds 75 --apply

⚠ Refuses to touch any database but $SCALE_DB, and refuses to run unless
DATABASE_URL names it — so a forgotten `source` cannot migrate or seed the
development database.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fleet

BACKEND = fleet.BACKEND
PYTHON = str(BACKEND / ".venv" / "bin" / "python")


def psql(sql: str, database: str = "postgres") -> str:
    return subprocess.run(
        ["docker", "exec", "-i", "solarcms-postgres", "psql", "-U", "solarcms", "-d",
         database, "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
        check=True, capture_output=True, text=True).stdout.strip()


def guard() -> str:
    name = os.environ.get("SCALE_DB")
    if not name or name in {"solarcms", "postgres"}:
        sys.exit("SCALE_DB is not set to a load-test database; source tools/scale/env.sh")
    if not os.environ.get("DATABASE_URL", "").endswith(f"/{name}"):
        sys.exit(f"DATABASE_URL does not name {name}; source tools/scale/env.sh")
    return name


async def seed_fleet() -> None:
    # seed_fleet reads FLEET from tools.simulate_fleet at import, so the
    # load-test fleet is put there first.
    fleet.sf.FLEET = fleet.FLEET
    sys.path.insert(0, str(BACKEND / "scripts"))
    import seed_fleet  # type: ignore[import-not-found]
    await seed_fleet.seed(None, [])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--drop", action="store_true")
    args = parser.parse_args()
    name = guard()
    exists = psql(f"SELECT 1 FROM pg_database WHERE datname = '{name}'") == "1"

    if args.drop:
        if exists:
            psql(f"DROP DATABASE {name} WITH (FORCE)")
        print(f"dropped {name}" if exists else f"{name} did not exist")
        return 0
    if exists:
        sys.exit(f"{name} already exists; --drop it first")

    psql(f"CREATE DATABASE {name} OWNER solarcms")
    print(f"created {name}")
    subprocess.run([str(BACKEND / ".venv" / "bin" / "alembic"), "upgrade", "head"],
                   cwd=BACKEND, check=True)
    subprocess.run([PYTHON, "-m", "solarcms.cli", "seed"], cwd=BACKEND, check=True)
    for pattern, priority in fleet.TOPIC_PATTERNS:
        psql("SELECT set_config('app.is_platform_admin', 'true', false); "
             f"INSERT INTO topic_patterns (pattern, priority, enabled) "
             f"VALUES ('{pattern}', {priority}, true)", name)
    print(f"added {len(fleet.TOPIC_PATTERNS)} topic patterns")
    # Every load-test Plant is in India (fleet.TIMEZONE): refuse a fleet that
    # is not, before writing it, and confirm it in the database afterwards.
    abroad = fleet.not_in_india({p.code: p.timezone for c in fleet.FLEET for p in c.plants})
    if abroad:
        sys.exit(f"refusing: these load-test Plants are not on {fleet.TIMEZONE}: "
                 f"{', '.join(abroad)}")
    asyncio.run(seed_fleet())
    plants = sum(len(c.plants) for c in fleet.FLEET)
    stored = psql("SELECT string_agg(code || '=' || timezone, ',') FROM plants "
                  f"WHERE timezone <> '{fleet.TIMEZONE}'", name)
    if stored:
        sys.exit(f"refusing: Plants stored on another clock: {stored}")
    print(f"seeded {len(fleet.FLEET)} Clients and {plants} Plants, all on {fleet.TIMEZONE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
