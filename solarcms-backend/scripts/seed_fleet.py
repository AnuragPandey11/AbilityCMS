"""Create the fabricated fleet's Clients, Plants and logins — and nothing else.

    .venv/bin/python scripts/seed_fleet.py
    .venv/bin/python scripts/seed_fleet.py --password 'something-else'

The fleet itself is defined once, in `tools/simulate_fleet.py` (`FLEET`); this
reads it, so a Plant code here can never disagree with the topic being
published. Idempotent: re-running updates names and re-sets passwords.

── Why Devices are not created here ─────────────────────────────────────────
The Clients and Plants *have* to be typed in: a Client cannot be discovered
from a topic (Guardrail 5 forbids inventing one), and a Plant's capacity and
timezone are not on the wire. Everything downstream of that — which Devices
exist, in which Collector, sending which keys at what interval — is exactly
what the broker states and `commission-from-broker` reads. Registering them
here too would mean the fleet works whether or not commissioning does, which
is the opposite of a test. So:

    python tools/simulate_fleet.py                 (leave running)
    python -m solarcms.cli commission-from-broker --seconds 150
    python -m solarcms.cli commission-from-broker --seconds 150 --apply

150 s because the slowest Plant publishes every 120 s and the probe must see
each topic at least twice to measure its interval.

── Why the Plants have different Regions ────────────────────────────────────
CO₂ avoided is energy times the Region's grid factor, so one factor everywhere
makes the fleet's CO₂ split identical to its energy split. `FLEET` gives three
Plants three invented factors and leaves WH2 on the national default; the
reasons are in that module's docstring.

── Why one Client Admin each, with every Plant ──────────────────────────────
`app_can_see_plant` grants an `admin` every Plant of their own Client, so
these logins keep working as Plants are added. Any other role starts with
zero Plants, and zero means none (Guardrail 7). Both Clients are marked
`is_demo`, which is what the prune script and anyone reading `clients` should
use to tell fabricated tenants from real ones — never the code.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "src"))
sys.path.insert(0, str(_ROOT))

import structlog  # noqa: E402
from sqlalchemy import text  # noqa: E402

from solarcms.cli import _create_client_user  # noqa: E402
from solarcms.db.rls import SecurityContext  # noqa: E402
from solarcms.db.session import dispose_engine, scoped_session  # noqa: E402
from solarcms.services.onboarding import (  # noqa: E402
    ensure_plant_kpi_device,
    upsert_client,
    upsert_plant,
    upsert_region,
)
from tools.simulate_fleet import FLEET  # noqa: E402

log = structlog.get_logger(__name__)


async def seed(password: str) -> int:
    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        for client in FLEET:
            client_id = await upsert_client(
                session, client.code, client.name, status="active", is_demo=True)
            await session.execute(text(
                "UPDATE clients SET contact_email = :email WHERE id = :id"
            ), {"email": client.admin_email, "id": client_id})
            for plant in client.plants:
                # A Region is shared by every Client, so an existing one keeps
                # its own factor: `upsert_region` renames on conflict and never
                # overwrites the factor, and a demo seed must not either.
                region_id = None
                if plant.region is not None:
                    region_id = await upsert_region(
                        session, plant.region.code, plant.region.name,
                        country=plant.region.country,
                        grid_factor=plant.region.grid_factor)
                # `region_id` is written on conflict too, so a Plant FLEET gives
                # no Region is set back to none — WH2's fallback is deliberate.
                plant_id = await upsert_plant(
                    session, client_id, plant.code, plant.name,
                    status="active",
                    region_id=region_id,
                    ac_capacity_kw=plant.ac_capacity_kw,
                    dc_capacity_kwp=plant.dc_capacity_kwp,
                    timezone=plant.timezone,
                )
                # `upsert_plant` does not update the timezone on conflict, and
                # a Plant in the wrong zone books its 23:55 rollover to the
                # wrong day — so set it explicitly, every run.
                await session.execute(text(
                    "UPDATE plants SET timezone = :tz WHERE id = :id"
                ), {"tz": plant.timezone, "id": plant_id})
                await ensure_plant_kpi_device(session, client_id, plant_id, plant.code)
                log.info("plant ready", client=client.code, plant=plant.code,
                         plant_id=plant_id, timezone=plant.timezone,
                         region=plant.region.code if plant.region else None)

    # Separate transactions, after the Plants exist: `--all-plants` grants
    # whatever Plants the Client has *at that moment*.
    for client in FLEET:
        rc = await _create_client_user(
            email=client.admin_email, password=password,
            full_name=f"{client.name} Admin", client_code=client.code,
            role_code="admin", all_plants=True, all_dashboards=True,
        )
        if rc != 0:
            return rc

    print("\nLogins (Client Admin, every Plant of their Client):")
    for client in FLEET:
        print(f"  {client.code:<10} {client.admin_email:<24} {password}")
    print("\nNext: start tools/simulate_fleet.py, then commission-from-broker "
          "--seconds 150 (dry run), then --apply.\n")
    await dispose_engine()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--password", default="fleet12345",
                        help="password for every fleet login (dev only)")
    args = parser.parse_args()
    return asyncio.run(seed(args.password))


if __name__ == "__main__":
    raise SystemExit(main())
