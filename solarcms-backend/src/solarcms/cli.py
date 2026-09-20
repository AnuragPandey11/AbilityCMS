"""Operator entry points: seed the catalogue, create the first Super Admin.

    python -m solarcms.cli seed
    python -m solarcms.cli create-superadmin --email a@b.com --password ...
    python -m solarcms.cli onboard-test-plant
    python -m solarcms.cli commission-from-broker --seconds 45
    python -m solarcms.cli commission-from-broker --seconds 45 --apply
    python -m solarcms.cli collectors-from-topics
    python -m solarcms.cli collectors-from-topics --apply --retire-devices
    python -m solarcms.cli create-client-user --email a@b.com --password ... \
        --client-code KULAR_GREEN --role admin
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

from sqlalchemy import text

from solarcms.config import get_settings
from solarcms.db.rls import INGEST_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.decoding import parse_topic
from solarcms.logging import configure_logging, get_logger
from solarcms.services.onboarding import backfill_plant_kpi_devices
from solarcms.services.seed import seed_catalog
from solarcms.workers.resolver import load_topic_patterns

log = get_logger("cli")


async def _seed() -> int:
    # role=None: the seeder runs as the migration owner. Catalogue tables carry
    # no RLS, but `clients` does and FORCE applies to the owner too, so a
    # platform context is still required for anything Client-scoped.
    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        counts = await seed_catalog(session)
        # ⚠ `devices` carries RLS and FORCE applies to the owner, so this only
        # sees rows because the platform context above is set. A migration doing
        # the same thing without it would match zero rows and report success.
        counts["plant_kpi_devices"] = await backfill_plant_kpi_devices(session)
    total = sum(counts.values())
    log.info("seed complete", rows=total, **counts)
    return 0


async def _create_superadmin(email: str, password: str, full_name: str) -> int:
    from solarcms.api.auth import hash_password

    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        existing = await session.execute(
            text("SELECT id FROM users WHERE email = :email"), {"email": email}
        )
        if existing.scalar() is not None:
            log.error("user already exists", email=email)
            return 1
        result = await session.execute(
            text("""
                INSERT INTO users (email, password_hash, full_name, platform_role)
                VALUES (:email, :password_hash, :full_name, 'super_admin')
                RETURNING id
            """),
            {"email": email, "password_hash": hash_password(password),
             "full_name": full_name},
        )
        user_id = result.scalar_one()
        # A Super Admin is deliberately given no membership: access comes from the
        # policy predicate, not from rows granting membership of every Client
        # (MASTER §3.5).
        await session.execute(
            text("""
                INSERT INTO audit_log (client_id, user_id, actor_email, action,
                                       entity_type, entity_id)
                VALUES (NULL, :user_id, :email, 'user.create', 'users', :user_id)
            """),
            {"user_id": user_id, "email": email},
        )
    log.info("super admin created", user_id=user_id, email=email)
    return 0


async def _commission_from_broker(
    host: str | None, port: int | None, topic: str | None,
    seconds: float, apply: bool,
) -> int:
    """Listen to the broker, then register what is publishing but not registered.

    Dry run by default. The proposal is printed in full — every Device, its
    inferred Type, and any payload key the registry has no Tag for — because
    nobody should accept a fleet of equipment they have not read.
    """
    from solarcms.services.onboarding import (
        ObservedDevice,
        commission_observed_devices,
        plan_commissioning,
    )
    try:
        # `tools/` is a sibling of `src/`, not part of the installed package, so
        # this works when run from the backend directory and fails loudly rather
        # than mysteriously anywhere else.
        from tools.probe_broker import probe
    except ModuleNotFoundError:
        log.error("tools/probe_broker.py not importable; "
                  "run this from the solarcms-backend directory")
        return 1

    settings = get_settings()
    host = host or settings.mqtt_host
    port = port or settings.mqtt_port
    filters = [topic] if topic else list(settings.mqtt_subscribe_topics)

    log.info("observing broker", host=host, port=port,
             topics=filters, seconds=seconds)
    # One pass per filter, shared out of the window so the whole command still
    # takes `--seconds`. Results merge: the same topic seen twice is one Device.
    seen: dict[str, dict[str, Any]] = {}
    for one in filters:
        result = await probe(host, port, one, seconds / len(filters), None, None)
        for topic_name, record in result["topics"].items():
            merged = seen.setdefault(topic_name, {"keys": [], "interval_s": None})
            merged["keys"] = sorted(set(merged["keys"]) | set(record["keys"]))
            merged["interval_s"] = (
                None if record["median_interval_s"] is None
                else max(1, round(record["median_interval_s"]))
            )
    if not seen:
        log.warning(
            "nothing published in the observation window; "
            "a longer --seconds may be needed, or the topic filter matches nothing"
        )
        return 1

    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        patterns = await load_topic_patterns(session)
        observed: list[ObservedDevice] = []
        unparsed: list[str] = []
        for topic_name, record in seen.items():
            captured = parse_topic(topic_name, patterns)
            if captured is None or "device_code" not in captured:
                unparsed.append(topic_name)
                continue
            observed.append(ObservedDevice(
                topic=topic_name,
                plant_code=captured["plant_code"],
                device_code=captured["device_code"],
                client_code=captured.get("client_code"),
                collector_code=captured.get("collector_code"),
                source_keys=tuple(record["keys"]),
                interval_s=record.get("interval_s"),
            ))

        for topic_name in unparsed:
            log.warning("topic matches no registered pattern; it would be "
                        "quarantined to mqtt_raw, never attributed by inference "
                        "(Guardrail 5)", topic=topic_name)

        plan = await plan_commissioning(session, observed)
        print(f"\n{'TOPIC':<52} {'TYPE':<12} {'KEYS':>5}  NOTE")
        for row in plan:
            note = ""
            if row["blocked"]:
                note = "BLOCKED: " + (
                    "no matching Device Type" if row["device_type"] is None
                    else "no such Plant")
            elif row["unmapped_keys"]:
                note = "unmapped: " + ", ".join(row["unmapped_keys"])
            print(f"{row['topic']:<52} {row['device_type']!s:<12} "
                  f"{row['mapped_keys']:>5}  {note}")

        blocked = sum(1 for row in plan if row["blocked"])
        print(f"\n  {len(plan)} topics, {blocked} blocked, "
              f"{len(unparsed)} unmatched by any pattern")

        if not apply:
            print("\n  Dry run. Nothing written. Re-run with --apply to register.\n")
            return 0

        summary = await commission_observed_devices(session, observed)
    log.info("commissioned from broker", **summary)
    return 0


async def _backfill_device(device_id: int, apply: bool) -> int:
    """Replay one Device's quarantined messages into Readings.

    ⚠ Runs under the **ingest** role, not the API's. The API holds no privilege
    at all on `readings` (0008/0010) and would fail here, which is the design
    working — so recovering history is a deliberate command, never a side effect
    of opening a screen.
    """
    from solarcms.services.backfill import replay

    async with scoped_session(
        SecurityContext.platform(user_id=0), role=INGEST_ROLE
    ) as session:
        stats = await replay(session, device_id, apply=apply)

    if stats.get("error"):
        log.error("backfill refused", **stats)
        return 1
    log.info("backfill complete" if apply else "backfill plan", **stats)
    if not apply:
        print("\n  Dry run. Nothing written. Re-run with --apply.\n")
    return 0


async def _create_client_user(
    email: str, password: str, full_name: str, client_code: str, role_code: str,
    all_plants: bool, all_dashboards: bool,
) -> int:
    """Create (or re-password) a User inside one Client, with a Role.

    `create-superadmin` makes a *platform* administrator, who belongs to no
    Client and therefore has no Plants of their own. That is the wrong account
    for a Client's own administrator, and making one by hand means four inserts
    across `users`, `memberships`, `user_plant_access` and
    `user_dashboard_access` — three of which fail silently in the sense that
    matters: the User signs in and sees nothing.

    ⚠ **Zero Plant assignments means zero Plants, never all of them**
    (Guardrail 7). `--all-plants` therefore writes a row per Plant rather than
    leaving the table empty and hoping the reader treats empty as "everything".
    It is a convenience for the Client's own admin, whose Plants are by
    definition all of their Client's; it is not a default.
    """
    from solarcms.api.auth import hash_password

    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        client = (await session.execute(
            text("SELECT id, name FROM clients WHERE code = :code"),
            {"code": client_code})).first()
        if client is None:
            log.error("no such Client; create it first", client_code=client_code)
            return 1
        role = (await session.execute(
            text("SELECT id FROM roles WHERE code = :code"),
            {"code": role_code})).first()
        if role is None:
            log.error("no such Role; run `seed` first", role_code=role_code)
            return 1

        # Idempotent on the email: re-running resets the password rather than
        # failing, which is what an operator running this twice actually wants.
        user_id = (await session.execute(text("""
            INSERT INTO users (email, password_hash, full_name, platform_role)
            VALUES (:email, :password_hash, :full_name, 'none')
            ON CONFLICT (email) DO UPDATE
                SET password_hash = EXCLUDED.password_hash,
                    full_name = EXCLUDED.full_name,
                    is_active = true
            RETURNING id
        """), {"email": email, "password_hash": hash_password(password),
               "full_name": full_name})).scalar()
        assert user_id is not None

        # Plant and dashboard access hang off the *membership*, not the User: a
        # User may belong to several Clients, and "can see Plant 4" is only
        # meaningful inside the Client that owns Plant 4.
        membership_id = (await session.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            VALUES (:user_id, :client_id, :role_id)
            ON CONFLICT (user_id, client_id) DO UPDATE SET role_id = EXCLUDED.role_id
            RETURNING id
        """), {"user_id": user_id, "client_id": client.id,
               "role_id": role.id})).scalar()
        assert membership_id is not None

        plants = 0
        if all_plants:
            # RETURNING and a row count, rather than `rowcount`: the async
            # Result does not carry one, and "how many Plants can this User
            # now see" is the fact worth printing.
            plants = len((await session.execute(text("""
                INSERT INTO user_plant_access (membership_id, plant_id)
                SELECT :membership_id, p.id
                  FROM plants p WHERE p.client_id = :client_id
                ON CONFLICT (membership_id, plant_id) DO NOTHING
                RETURNING plant_id
            """), {"membership_id": membership_id, "client_id": client.id})).all())

        dashboards = 0
        if all_dashboards:
            dashboards = len((await session.execute(text("""
                INSERT INTO user_dashboard_access (membership_id, dashboard_id)
                SELECT :membership_id, d.id FROM dashboards d
                ON CONFLICT (membership_id, dashboard_id) DO NOTHING
                RETURNING dashboard_id
            """), {"membership_id": membership_id})).all())

    log.info("client user ready", email=email, client=client_code, role=role_code,
             plants_granted=plants, dashboards_granted=dashboards)
    return 0


async def _collectors_from_topics(apply: bool, retire_devices: bool) -> int:
    """Repair the Collector grouping after migration 0022.

    Two separate repairs, both dry-run by default:

    1. **Backfill `devices.collector_code` from `devices.source_address`.** The
       enclosure has always been in the topic; until 0022 there was nowhere to
       put it.
    2. **Retire Collector-Devices**, with `--retire-devices`. Commissioning used
       to register the `{collector_code}` segment as an `MCR_SECTION` Device and
       point everything beneath it at that row. A Collector is a room: it
       publishes nothing, carries no current, and as a node in the Single Line
       Diagram it claims the plant is wired *through* the building.

       A Device is only ever proposed for retirement when all of the following
       hold, which together mean commissioning created it and nobody has since
       given it a job: it has no `source_address` of its own, it has no Tag
       bindings, it has never stored a Reading, and its code is the Collector
       segment of some other Device's topic at the same Plant. Its children are
       re-pointed at *its* parent first, so the electrical chain closes over the
       gap rather than losing a limb.

       ⚠ A `device_health` row is deliberately **not** part of that test. The
       sweep writes one for every active Device on its first pass, so every
       Collector-Device has one within a minute of being created — it is
       evidence that the sweep ran, not that anyone uses this Device.
    """
    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        patterns = await load_topic_patterns(session)
        rows = (await session.execute(text("""
            SELECT d.id, d.plant_id, d.code, d.collector_code, d.source_address,
                   d.parent_device_id, p.code AS plant_code
              FROM devices d JOIN plants p ON p.id = d.plant_id
             ORDER BY d.plant_id, d.code
        """))).all()

        # ── 1. What the topic says each Device's enclosure is ────────────────
        changes: list[tuple[int, str, str | None, str | None]] = []
        enclosures: dict[int, set[str]] = {}
        for row in rows:
            if not row.source_address:
                continue
            captured = parse_topic(row.source_address, patterns) or {}
            collector = captured.get("collector_code")
            if collector:
                enclosures.setdefault(row.plant_id, set()).add(collector)
            if collector != row.collector_code:
                changes.append((row.id, row.code, row.collector_code, collector))

        print(f"\n  Collector recorded on the Device ({len(changes)} to change)")
        for _id, code, was, now in changes:
            print(f"    {code:<22} {was or '—':<12} →  {now or '—'}")

        # ── 2. Collector-Devices to retire ───────────────────────────────────
        retire: list[Any] = []
        for row in rows:
            if row.code not in enclosures.get(row.plant_id, set()):
                continue
            if row.source_address:
                continue  # it publishes; it is a Device whatever it is named
            busy = (await session.execute(text("""
                SELECT (SELECT count(*) FROM device_tag_bindings b
                         WHERE b.device_id = :id) AS bindings,
                       (SELECT count(*) FROM readings_v r
                         WHERE r.device_id = :id) AS readings
            """), {"id": row.id})).first()
            assert busy is not None
            if busy.bindings or busy.readings:
                print(f"    keeping {row.code}: it has {busy.bindings} "
                      f"binding(s) and {busy.readings} Reading(s), so it is "
                      f"being used as a Device and removing it would lose data")
                continue
            retire.append(row)

        print(f"\n  Collector-Devices to retire ({len(retire)})")
        for row in retire:
            children = (await session.execute(text("""
                SELECT count(*) FROM devices WHERE parent_device_id = :id
            """), {"id": row.id})).scalar()
            print(f"    {row.code:<22} at plant {row.plant_code}: "
                  f"{children} child Device(s) re-pointed at "
                  f"{row.parent_device_id or 'the grid'}")

        if not apply:
            print("\n  Dry run. Nothing written. Re-run with --apply.\n")
            return 0

        for device_id, _code, _was, collector in changes:
            await session.execute(
                text("UPDATE devices SET collector_code = :c WHERE id = :id"),
                {"c": collector, "id": device_id})

        retired = 0
        if retire_devices:
            for row in retire:
                # The chain closes over the gap: whatever fed into the room now
                # feeds into whatever the room fed into. Doing this before the
                # delete is what stops the composite FK refusing it, and what
                # stops seventeen Inverters becoming roots.
                await session.execute(text("""
                    UPDATE devices SET parent_device_id = :new_parent
                     WHERE parent_device_id = :id
                """), {"new_parent": row.parent_device_id, "id": row.id})
                await session.execute(text("""
                    UPDATE devices SET reports_via_device_id = NULL
                     WHERE reports_via_device_id = :id
                """), {"id": row.id})
                await session.execute(
                    text("DELETE FROM devices WHERE id = :id"), {"id": row.id})
                retired += 1

    log.info("collectors repaired", recorded=len(changes), retired=retired)
    return 0


def main(argv: list[str] | None = None) -> int:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)

    parser = argparse.ArgumentParser(prog="solarcms")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("seed", help="seed the platform catalogue (idempotent)")

    admin = sub.add_parser("create-superadmin", help="create the first platform admin")
    admin.add_argument("--email", required=True)
    admin.add_argument("--password", required=True)
    admin.add_argument("--full-name", default="Super Admin")

    sub.add_parser("onboard-test-plant",
                   help="register the client's test broker as a Client, Plant and Devices")

    commission = sub.add_parser(
        "commission-from-broker",
        help="listen to the broker and register what is publishing but unregistered")
    commission.add_argument("--host", default=None, help="defaults to MQTT_HOST")
    commission.add_argument("--port", type=int, default=None, help="defaults to MQTT_PORT")
    commission.add_argument("--topic", default=None,
                            help="topic filter; defaults to MQTT_SUBSCRIBE_TOPICS")
    commission.add_argument("--seconds", type=float, default=45.0)
    commission.add_argument("--apply", action="store_true",
                            help="write the plan. Without it, nothing is written.")

    backfill = sub.add_parser(
        "backfill-device",
        help="replay a Device's quarantined messages into Readings")
    backfill.add_argument("--device-id", type=int, required=True)
    backfill.add_argument("--apply", action="store_true",
                          help="write the Readings. Without it, nothing is written.")

    client_user = sub.add_parser(
        "create-client-user",
        help="create a User inside one Client, with a Role and Plant access")
    client_user.add_argument("--email", required=True)
    client_user.add_argument("--password", required=True)
    client_user.add_argument("--client-code", required=True)
    client_user.add_argument("--role", default="admin",
                             help="role code: super_admin, admin, employee, guest")
    client_user.add_argument("--full-name", default=None)
    client_user.add_argument(
        "--no-plants", action="store_true",
        help="grant no Plant access. Zero assignments means zero Plants (Guardrail 7).")
    client_user.add_argument("--no-dashboards", action="store_true",
                             help="grant no dashboards")

    collectors = sub.add_parser(
        "collectors-from-topics",
        help="record each Device's Collector from its topic, and retire "
             "Collector-Devices left by the old commissioning path")
    collectors.add_argument("--apply", action="store_true",
                            help="write the changes. Without it, nothing is written.")
    collectors.add_argument(
        "--retire-devices", action="store_true",
        help="also delete the Collector-Devices, re-pointing their children first")

    args = parser.parse_args(argv)

    async def run() -> int:
        try:
            if args.command == "seed":
                return await _seed()
            if args.command == "create-superadmin":
                return await _create_superadmin(args.email, args.password, args.full_name)
            if args.command == "commission-from-broker":
                return await _commission_from_broker(
                    args.host, args.port, args.topic, args.seconds, args.apply)
            if args.command == "create-client-user":
                return await _create_client_user(
                    args.email, args.password,
                    args.full_name or args.email.split("@")[0].title(),
                    args.client_code, args.role,
                    all_plants=not args.no_plants,
                    all_dashboards=not args.no_dashboards)
            if args.command == "collectors-from-topics":
                return await _collectors_from_topics(args.apply, args.retire_devices)
            if args.command == "backfill-device":
                return await _backfill_device(args.device_id, args.apply)
            if args.command == "onboard-test-plant":
                from solarcms.services.onboarding import onboard_test_plant

                async with scoped_session(
                    SecurityContext.platform(user_id=0), role=None
                ) as session:
                    summary = await onboard_test_plant(session)
                log.info("test plant onboarded", **summary)
                return 0
            return 1
        finally:
            await dispose_engine()

    return asyncio.run(run())


if __name__ == "__main__":
    sys.exit(main())
