"""Operator entry points: seed the catalogue, create the first Super Admin.

    python -m solarcms.cli seed
    python -m solarcms.cli create-superadmin --email a@b.com --password ...
    python -m solarcms.cli onboard-test-plant
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import text

from solarcms.config import get_settings
from solarcms.db.rls import SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.logging import configure_logging, get_logger
from solarcms.services.seed import seed_catalog

log = get_logger("cli")


async def _seed() -> int:
    # role=None: the seeder runs as the migration owner. Catalogue tables carry
    # no RLS, but `clients` does and FORCE applies to the owner too, so a
    # platform context is still required for anything Client-scoped.
    async with scoped_session(SecurityContext.platform(user_id=0), role=None) as session:
        counts = await seed_catalog(session)
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

    args = parser.parse_args(argv)

    async def run() -> int:
        try:
            if args.command == "seed":
                return await _seed()
            if args.command == "create-superadmin":
                return await _create_superadmin(args.email, args.password, args.full_name)
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
