"""Create the fabricated fleet's Clients, Plants and logins — and nothing else.

    .venv/bin/python scripts/seed_fleet.py
    .venv/bin/python scripts/seed_fleet.py --client VARDHMAN
    .venv/bin/python scripts/seed_fleet.py --password 'something-else'

The fleet itself is defined once, in `tools/simulate_fleet.py` (`FLEET`); this
reads it, so a Plant code here can never disagree with the topic being
published. Idempotent: re-running updates names and re-sets passwords — each
Client's own (`ClientSpec.password`) unless `--password` overrides them all.
`--client` seeds only the named Clients and leaves the rest as they are.

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
zero Plants, and zero means none (Guardrail 7). Every fleet Client is marked
`is_demo`, which is what the prune script and anyone reading `clients` should
use to tell fabricated tenants from real ones — never the code.

── Why the operator's Plants are rows, and stop at today's ──────────────────
A Client with an `operator_email` also gets a Client Employee: may view,
export and acknowledge Alarms, administers nothing. `--all-plants` grants the
Plants the Client has *now*, one row each, so a Plant added later is invisible
to the operator until someone grants it — which is the Employee's rule, not a
defect. Re-run this after adding a Plant to FLEET and the grant catches up.
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


async def seed(password: str | None, only: list[str]) -> int:
    fleet = [c for c in FLEET if not only or c.code in only]
    unknown = set(only) - {c.code for c in FLEET}
    if unknown or not fleet:
        print(f"no Client {', '.join(sorted(unknown))} in FLEET "
              f"(have {', '.join(c.code for c in FLEET)})", file=sys.stderr)
        return 1

    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        for client in fleet:
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
    for client in fleet:
        logins = [(client.admin_email, "admin", "Admin")]
        if client.operator_email:
            logins.append((client.operator_email, "employee", "Operator"))
        for email, role_code, title in logins:
            rc = await _create_client_user(
                email=email, password=password or client.password,
                full_name=f"{client.name} {title}", client_code=client.code,
                role_code=role_code, all_plants=True, all_dashboards=True,
            )
            if rc != 0:
                return rc

    print("\nLogins (every Plant of their own Client):")
    for client in fleet:
        pw = password or client.password
        print(f"  {client.code:<10} {client.admin_email:<24} {pw:<12} Client Admin")
        if client.operator_email:
            print(f"  {'':<10} {client.operator_email:<24} {pw:<12} Client Employee")
    print("\nNext: start tools/simulate_fleet.py, then commission-from-broker "
          "--seconds 150 (dry run), then --apply.\n")
    await dispose_engine()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--password", default=None,
                        help="password for every login seeded, overriding each "
                             "Client's own in FLEET (dev only)")
    parser.add_argument("--client", action="append", default=[],
                        help="seed only this Client code (repeatable)")
    args = parser.parse_args()
    return asyncio.run(seed(args.password, args.client))


if __name__ == "__main__":
    raise SystemExit(main())
