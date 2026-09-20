"""Remove raw history for topics that have stopped publishing.

    .venv/bin/python scripts/prune_topics.py
    .venv/bin/python scripts/prune_topics.py --apply

Dry run by default. The proposal is printed in full first, because deleting raw
telemetry is irreversible and `mqtt_raw` is the only place a quarantined payload
survives — it is what makes a late registration recoverable at all.

── Why this exists ──────────────────────────────────────────────────────────
Raw history is kept 90 days; discovery looks back 7. So every topic shape a
client migrates away from keeps presenting itself as equipment awaiting
registration for a week after it died. On KULAR_GREEN that was twenty dead
topics — three retired shapes and a ten-minute publisher bug — against twenty-two
live ones, and the screen said "+20 new".

⚠ Since the liveness classification landed, those are already sorted out of the
registration list and no longer alarm: a topic is only offered when it is
publishing *now*, judged against its own cadence. This script is therefore
tidiness, not a fix. Prefer `POST /discovery/ignored` where the topic should
simply be put away — dismissing is reversible and keeps the evidence.

── Why not just shorten the discovery window ────────────────────────────────
Because a Plant commissioned on Friday must still be discoverable on Monday.
Showing nothing reads as "the broker is silent" when the truth is "nobody looked
recently", and that misreading is how a real outage gets ignored.
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

# A topic quiet for longer than this is treated as retired. Deliberately far
# longer than the liveness threshold used for alarming: this deletes evidence,
# so it errs towards keeping things.
DEFAULT_QUIET_HOURS = 24


async def run(quiet_hours: int, apply: bool) -> int:
    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        # ⚠ `mqtt_raw` carries no RLS (it is compressed — 0008/0010), so this
        # talks to it directly as the migration owner. Request-serving code
        # reads `mqtt_raw_v` and would fail here, which is the design working.
        rows = (await session.execute(text("""
            SELECT m.topic,
                   count(*)    AS rows,
                   max(m.time) AS last_seen,
                   (d.id IS NOT NULL) AS registered
              FROM mqtt_raw m
              LEFT JOIN devices d ON d.source_address = m.topic
             GROUP BY m.topic, d.id
            HAVING max(m.time) < now() - make_interval(hours => :hours)
             ORDER BY max(m.time)
        """), {"hours": quiet_hours})).all()

        if not rows:
            print(f"\n  Nothing quiet for {quiet_hours}h. Nothing to remove.\n")
            return 0

        print(f"\n  Topics silent for more than {quiet_hours}h:\n")
        print(f"  {'TOPIC':<52} {'ROWS':>7}  {'LAST SEEN':<22} REGISTERED")
        total = 0
        for row in rows:
            total += row.rows
            print(f"  {row.topic:<52} {row.rows:>7}  "
                  f"{row.last_seen:%Y-%m-%d %H:%M:%S}    "
                  f"{'yes — KEPT' if row.registered else 'no'}")

        # ⚠ A registered Device that has merely gone quiet is not a dead topic.
        # Deleting its raw history would destroy the evidence for the very
        # outage that made it quiet — exactly when it is most wanted.
        removable = [r for r in rows if not r.registered]
        keeping = len(rows) - len(removable)
        removable_rows = sum(r.rows for r in removable)
        print(f"\n  {len(rows)} silent topic(s), {total} row(s).")
        print(f"  {keeping} belong to registered Devices and are KEPT.")
        print(f"  {len(removable)} unregistered topic(s), {removable_rows} row(s) "
              f"would be removed.")

        if not apply:
            print("\n  Dry run. Nothing written. Re-run with --apply.\n")
            return 0
        if not removable:
            print("\n  Nothing to remove.\n")
            return 0

        result = await session.execute(text("""
            DELETE FROM mqtt_raw
             WHERE topic = ANY(:topics)
               AND topic NOT IN (SELECT source_address FROM devices
                                  WHERE source_address IS NOT NULL)
        """), {"topics": [r.topic for r in removable]})
        print(f"\n  Removed {result.rowcount} row(s) "
              f"across {len(removable)} topic(s).\n")

    await dispose_engine()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet-hours", type=int, default=DEFAULT_QUIET_HOURS,
                        help=f"silent for longer than this (default {DEFAULT_QUIET_HOURS})")
    parser.add_argument("--apply", action="store_true",
                        help="delete. Without it, nothing is written.")
    args = parser.parse_args()
    return asyncio.run(run(args.quiet_hours, args.apply))


if __name__ == "__main__":
    raise SystemExit(main())
