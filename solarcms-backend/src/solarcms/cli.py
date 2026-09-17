"""Operator entry points: seed the catalogue, create the first Super Admin.

    python -m solarcms.cli seed
    python -m solarcms.cli create-superadmin --email a@b.com --password ...
    python -m solarcms.cli onboard-test-plant
    python -m solarcms.cli commission-from-broker --seconds 45
    python -m solarcms.cli commission-from-broker --seconds 45 --apply
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

from sqlalchemy import text

from solarcms.config import get_settings
from solarcms.db.rls import SecurityContext
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
