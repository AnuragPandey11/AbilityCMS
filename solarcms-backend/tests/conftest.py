"""Shared fixtures.

Integration tests run against the **local** Postgres and Redis rather than
testcontainers: Docker is not installed on this machine, and the local stack is
the real thing — TimescaleDB 2.30 on Postgres 18 — so the tests exercise
hypertables, continuous aggregates and RLS exactly as production would. The
BACKEND_SPEC §11 requirement is that these run against a real Postgres with
TimescaleDB and a real Redis, which is satisfied; swapping in testcontainers is a
fixture change, not a test change.

Every integration test is skipped rather than failed when the database is absent,
so `pytest tests/unit` stays runnable with nothing installed.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Iterator

import pytest
import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache.live import close_redis
from solarcms.db.rls import SecurityContext
from solarcms.db.session import dispose_engine, scoped_session


def _database_available() -> bool:
    async def probe() -> bool:
        try:
            async with scoped_session(SecurityContext.platform(0), role=None) as s:
                await s.execute(text("SELECT 1"))
            return True
        except Exception:
            return False
        finally:
            await dispose_engine()

    try:
        return asyncio.run(probe())
    except Exception:
        return False


DATABASE_AVAILABLE = _database_available()

requires_db = pytest.mark.skipif(
    not DATABASE_AVAILABLE,
    reason="no database reachable; run `alembic upgrade head` and `solarcms seed` first",
)


@pytest_asyncio.fixture(autouse=True)
async def _engine_per_test() -> AsyncIterator[None]:
    """Dispose the engine and Redis client after every test.

    Both are process-wide singletons, and pytest-asyncio gives each test its own
    event loop. An asyncpg connection is bound to the loop that created it, so a
    pool reused across tests raises "attached to a different loop" on the second
    one. Disposing here is cheaper than threading a fixture through every call
    site and keeps production code free of test-only plumbing.
    """
    yield
    await dispose_engine()
    await close_redis()


@pytest_asyncio.fixture
async def platform_session() -> AsyncIterator[AsyncSession]:
    """A session with platform privileges, for arranging test data."""
    async with scoped_session(SecurityContext.platform(0), role=None) as session:
        yield session


@pytest_asyncio.fixture
async def client_session_factory():  # type: ignore[no-untyped-def]
    """Build a session acting as a specific Client, through the API role.

    This is the shape that matters: the API never connects as the owner, it
    assumes `solarcms_api` per transaction, so a test that arranges data as the
    owner and asserts as the owner would prove nothing about isolation.
    """
    def factory(client_id: int | None, role_code: str = "admin", user_id: int = 1):  # type: ignore[no-untyped-def]
        return scoped_session(
            SecurityContext(user_id=user_id, client_id=client_id,
                            role_code=role_code, is_platform_admin=False)
        )
    return factory


# ════════════════════════════════════════════════════════════════════════════
# Teardown of integration fixtures.
#
# These tests run against the developer's own database rather than a throwaway
# container (see the module docstring), and for eleven build phases they left
# everything they created behind: ~30 Plants and ~35 Clients per run, compounded
# by any IDE test-runner firing on save. The debris is not inert — a Super Admin
# opening the Clients list saw 133 `esc-*`, `rep-*` and `guard-*` rows ahead of
# the real ones, and Portfolio aggregates counted their Plants.
#
# Rather than convert every test to a rolled-back transaction (many deliberately
# commit, because RLS and the workers are being exercised across connections),
# the whole run is bracketed: note the highest id in each root table before the
# first test, delete everything above that watermark after the last. Rows that
# existed beforehand — the seeded catalogue, Kular Green, the operator's own
# Super Admin — are never touched, because their ids are at or below the mark.
#
# Set SOLARCMS_KEEP_TEST_DATA=1 to skip the sweep when a failure needs to be
# inspected in the database afterwards.
# ════════════════════════════════════════════════════════════════════════════

# Ordered by dependency, not alphabetically. Every one of these is a FK that is
# NO ACTION or RESTRICT against the roots below, so an arbitrary order fails.
_SWEEP_BY_CLIENT: tuple[str, ...] = (
    "DELETE FROM incident_snapshots WHERE device_id IN "
    "    (SELECT id FROM devices WHERE client_id > :client_id)",
    "DELETE FROM alarms WHERE device_id IN "
    "    (SELECT id FROM devices WHERE client_id > :client_id)",
    "DELETE FROM device_tag_bindings WHERE client_id > :client_id",
    # devices.parent_device_id and reports_via_device_id are self-references with
    # NO ACTION: a Device pointing at a sibling blocks the sibling's delete, and
    # which of the pair goes first is not knowable. Break the links, then delete.
    "UPDATE devices SET parent_device_id = NULL, reports_via_device_id = NULL "
    "  WHERE client_id > :client_id",
    "DELETE FROM devices WHERE client_id > :client_id",
    "DELETE FROM blocks WHERE client_id > :client_id",
    "DELETE FROM plants WHERE client_id > :client_id",
    "DELETE FROM audit_log WHERE client_id > :client_id",
    # The rest — memberships, alarm_rules, broker_credentials, escalation_*,
    # notification_*, report_*, topic_patterns, plant_device_counts — cascade.
    "DELETE FROM clients WHERE id > :client_id",
)

# Only the FKs to `users` that are NO ACTION need clearing by hand. `memberships`
# and `notification_subscriptions` cascade from the User, and
# `user_plant_access` is keyed on membership_id — not user_id — so it cascades
# from the membership. Deleting them explicitly would be dead SQL that stops
# matching the day a key changes.
_SWEEP_BY_USER: tuple[str, ...] = (
    # Kept rather than deleted: the Alarm belongs to a Device, not to whoever
    # acknowledged it, and its Device may be one of Kular Green's.
    "UPDATE alarms SET acknowledged_by = NULL WHERE acknowledged_by > :user_id",
    "DELETE FROM escalation_steps WHERE notify_user_id > :user_id",
    "DELETE FROM notification_log WHERE recipient_user_id > :user_id",
    "DELETE FROM report_runs WHERE requested_by > :user_id",
    "DELETE FROM users WHERE id > :user_id",
)

_SWEEP_BY_REGION: tuple[str, ...] = (
    "UPDATE plants SET region_id = NULL WHERE region_id > :region_id",
    "DELETE FROM regions WHERE id > :region_id",
)

# Swept in its own transaction, and allowed to fail. `readings` is a compressed
# hypertable, and a DELETE touching a compressed chunk can be refused outright;
# taking that failure inside the main sweep would abort the transaction and
# leave every Client behind over some telemetry nobody was going to read. There
# is no FK from `readings` to `clients`, so the order does not matter either —
# orphaned rows are invisible through the barrier views once the Devices are
# gone, and the 30-day retention policy drops them regardless.
_SWEEP_TELEMETRY: tuple[str, ...] = (
    "DELETE FROM readings WHERE client_id > :client_id",
)


async def _watermarks() -> dict[str, int]:
    """Highest id in each root table, read before the first test runs.

    Disposes the engine on the way out, exactly as `_database_available` does
    and for the same reason: this runs in its own `asyncio.run` loop, and an
    asyncpg connection left in the pool is bound to that loop. The first test to
    check it out would get "Event loop is closed" from the pre-ping — a failure
    in whichever test happened to be first, with nothing to do with that test.
    """
    try:
        async with scoped_session(SecurityContext.platform(0), role=None) as session:
            return {
                table: int(
                    (await session.execute(
                        text(f"SELECT coalesce(max(id), 0) FROM {table}"))).scalar_one()
                )
                for table in ("clients", "users", "regions")
            }
    finally:
        await dispose_engine()


async def _sweep(marks: dict[str, int]) -> None:
    # Best-effort, separate transaction — see _SWEEP_TELEMETRY.
    try:
        async with scoped_session(SecurityContext.platform(0), role=None) as session:
            for sql in _SWEEP_TELEMETRY:
                await session.execute(text(sql), {"client_id": marks["clients"]})
    except Exception as exc:  # pragma: no cover - diagnostics only
        print(f"\n[conftest] telemetry sweep skipped ({exc}).")

    async with scoped_session(SecurityContext.platform(0), role=None) as session:
        for sql in _SWEEP_BY_CLIENT:
            await session.execute(text(sql), {"client_id": marks["clients"]})
        for sql in _SWEEP_BY_USER:
            await session.execute(text(sql), {"user_id": marks["users"]})
        for sql in _SWEEP_BY_REGION:
            await session.execute(text(sql), {"region_id": marks["regions"]})


@pytest.fixture(scope="session", autouse=True)
def _clean_fixtures_after_run() -> Iterator[None]:
    """Delete every Client, User and Region the run created. Session-scoped.

    Deliberately *not* per-test: several tests hand rows to a worker in another
    process and assert on them afterwards, and deleting between tests would race
    that. The blast radius is bounded by the watermark either way.
    """
    if not DATABASE_AVAILABLE or os.environ.get("SOLARCMS_KEEP_TEST_DATA") == "1":
        yield
        return

    marks = asyncio.run(_watermarks())
    try:
        yield
    finally:
        try:
            asyncio.run(_sweep(marks))
        except Exception as exc:  # pragma: no cover - diagnostics only
            # Never fail the run over cleanup: a green suite that could not tidy
            # up is still a green suite, and the message says what to do.
            print(f"\n[conftest] fixture cleanup failed ({exc}); "
                  f"rows above clients.id={marks['clients']} remain.")
        finally:
            asyncio.run(dispose_engine())
