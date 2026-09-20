"""Remove Plants, and Devices left behind by a retired topic shape.

    .venv/bin/python scripts/prune_plants.py --keep KULAR_GREEN
    .venv/bin/python scripts/prune_plants.py --keep KULAR_GREEN --apply

Dry run by default. Nothing here is subtle, but all of it is irreversible, so
the proposal is printed in full first and `--apply` is a separate decision.

── Why this is a script and not a migration ─────────────────────────────────
A migration describes the *shape* of the database and must produce the same
result on every deployment. "Delete every Plant except this one" is true of one
environment on one afternoon — running it against production would destroy a
Client's history. Alembic is the wrong place for it, and so is the CLI, whose
commands are all safe to run anywhere.

── Why Readings are deleted explicitly ──────────────────────────────────────
`readings`, `agg_*` and `mqtt_raw` carry **no foreign key** to `devices`. That
is deliberate — a hypertable with an FK checks it on every inserted row, and
ingestion writes thousands per second — but it means deleting a Device leaves
its Readings behind, attributed to a device_id that no longer resolves. They
are not visible anywhere, they are not reachable, and they are counted by every
"how much data do we hold" query forever. So they go first, by hand.

⚠ `readings` is compressed and carries no RLS (0008/0010), so this script talks
to it directly as the migration owner. That is the one context permitted to;
request-serving code reads `readings_v` and would fail here, which is the
design working.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from sqlalchemy import text

from solarcms.db.rls import SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.decoding import TopicPattern

# Tables holding telemetry keyed on device_id with no foreign key to enforce it.
# `agg_*` are continuous aggregates over `readings` and cannot be deleted from
# directly; they are refreshed from what remains, so they need no entry here.
TELEMETRY_TABLES = ("readings",)


async def _plants_to_remove(session, keep: set[str]) -> list:  # type: ignore[no-untyped-def]
    rows = (await session.execute(text("""
        SELECT p.id, p.code, p.name, p.status, c.code AS client_code,
               (SELECT count(*) FROM devices d WHERE d.plant_id = p.id) AS devices
          FROM plants p JOIN clients c ON c.id = p.client_id
         ORDER BY p.id
    """))).all()
    # Matched case-insensitively: an operator typing a Plant code at a shell
    # prompt is not the topic resolver, and getting the case wrong here would
    # silently delete the Plant they meant to keep.
    folded = {code.casefold() for code in keep}
    return [row for row in rows if row.code.casefold() not in folded]


async def _devices_on_pattern(session, pattern: str) -> list:  # type: ignore[no-untyped-def]
    """Devices whose topic matches a shape being retired.

    Matched against the same `TopicPattern` the resolver uses, not a LIKE: a
    pattern is segment-anchored, and `KULAR_GREEN/%` would also match the
    six-segment topics that are staying.
    """
    shape = TopicPattern(pattern=pattern)
    rows = (await session.execute(text("""
        SELECT d.id, d.code, d.source_address, p.code AS plant_code
          FROM devices d JOIN plants p ON p.id = d.plant_id
         WHERE d.source_address IS NOT NULL
         ORDER BY d.id
    """))).all()
    return [row for row in rows if shape.match(row.source_address) is not None]


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="append", default=[], metavar="PLANT_CODE",
                        help="a Plant code to keep; repeatable. Everything else goes.")
    parser.add_argument("--drop-devices-on-pattern", action="append", default=[],
                        metavar="PATTERN",
                        help="also remove Devices publishing on this retired topic "
                             "shape, e.g. '{plant_code}/{category}'")
    parser.add_argument("--apply", action="store_true",
                        help="perform the deletions. Without it, nothing is written.")
    args = parser.parse_args()

    if not args.keep:
        print("Refusing to run with no --keep: that would delete every Plant.")
        return 2

    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        plants = await _plants_to_remove(session, set(args.keep))
        print(f"\n  Plants to remove ({len(plants)}); keeping {', '.join(args.keep)}")
        for row in plants:
            print(f"    #{row.id:<4} {row.code:<16} {row.client_code:<14} "
                  f"{row.status:<14} {row.devices} Device(s)  {row.name}")

        stale: list = []
        for pattern in args.drop_devices_on_pattern:
            stale.extend(await _devices_on_pattern(session, pattern))
        if args.drop_devices_on_pattern:
            print(f"\n  Devices on a retired topic shape ({len(stale)})")
            for row in stale:
                print(f"    #{row.id:<4} {row.code:<16} {row.plant_code:<14} "
                      f"{row.source_address}")

        plant_ids = [row.id for row in plants]
        device_ids = [row.id for row in stale]
        if plant_ids:
            device_ids.extend(
                r.id for r in (await session.execute(text(
                    "SELECT id FROM devices WHERE plant_id = ANY(:ids)"
                ), {"ids": plant_ids})).all()
            )
        device_ids = sorted(set(device_ids))

        readings = 0
        if device_ids:
            readings = (await session.execute(text(
                "SELECT count(*) FROM readings WHERE device_id = ANY(:ids)"
            ), {"ids": device_ids})).scalar() or 0
        print(f"\n  {len(device_ids)} Device(s) and {readings} Reading(s) affected")

        if not args.apply:
            print("\n  Dry run. Nothing written. Re-run with --apply.\n")
            return 0

        if device_ids:
            for table in TELEMETRY_TABLES:
                await session.execute(
                    text(f"DELETE FROM {table} WHERE device_id = ANY(:ids)"),
                    {"ids": device_ids})
            # NO ACTION rather than CASCADE, so this would otherwise refuse the
            # delete with a foreign-key error naming a table nobody remembers.
            await session.execute(text(
                "DELETE FROM incident_snapshots WHERE device_id = ANY(:ids)"
            ), {"ids": device_ids})
            # Devices explicitly named by --drop-devices-on-pattern. Those
            # belonging to a Plant being deleted go with it, by cascade.
            await session.execute(text(
                "DELETE FROM devices WHERE id = ANY(:ids) AND plant_id <> ALL(:plants)"
            ), {"ids": device_ids, "plants": plant_ids or [0]})
        if plant_ids:
            await session.execute(
                text("DELETE FROM plants WHERE id = ANY(:ids)"), {"ids": plant_ids})

    print(f"\n  Removed {len(plant_ids)} Plant(s), {len(device_ids)} Device(s), "
          f"{readings} Reading(s).\n")
    await dispose_engine()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
