"""The non-negotiable test (BACKEND_SPEC §11).

    Authenticate as Client A, query every endpoint, assert no Client B row is
    ever returned. Write it early; it is the test that protects the product's
    core promise.

These assertions are made at the database layer, acting as `solarcms_api` with a
Client context, which is exactly how a request executes. Testing through the API
alone would leave open the possibility that isolation depends on a route
remembering to filter — the whole point of MASTER §3.5 is that it must not.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.exc import ProgrammingError

from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

# Tables a Client-scoped session may read, and the column naming their owner.
CLIENT_SCOPED_TABLES = [
    "plants", "blocks", "devices", "device_tag_bindings", "alarms",
    "device_health", "device_health_events", "report_runs", "audit_log",
]
TELEMETRY_VIEWS = ["readings_v", "mqtt_raw_v", "agg_1m_v", "agg_1h_v"]


async def _seed_two_clients(session) -> tuple[int, int]:  # type: ignore[no-untyped-def]
    """Two Clients, each with a Plant. Returns their ids."""
    ids = []
    for code, name in (("iso-a", "Isolation A"), ("iso-b", "Isolation B")):
        client_id = (await session.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:code, :name, 'active')
            ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id
        """), {"code": code, "name": name})).scalar_one()
        await session.execute(text("""
            INSERT INTO plants (client_id, code, name, status)
            VALUES (:client_id, :code, :name, 'active')
            ON CONFLICT (client_id, code) DO NOTHING
        """), {"client_id": client_id, "code": f"{code}-plant", "name": name})
        ids.append(client_id)
    return ids[0], ids[1]


class TestCrossClientIsolation:
    async def test_client_a_sees_no_client_b_rows_in_any_scoped_table(
        self, platform_session, client_session_factory
    ) -> None:
        client_a, client_b = await _seed_two_clients(platform_session)
        await platform_session.commit()

        async with client_session_factory(client_a) as session:
            for table in CLIENT_SCOPED_TABLES:
                leaked = (await session.execute(
                    text(f"SELECT count(*) FROM {table} WHERE client_id = :other"),
                    {"other": client_b},
                )).scalar()
                assert leaked == 0, f"{table} leaked rows belonging to another Client"

    async def test_telemetry_views_leak_nothing_across_clients(
        self, platform_session, client_session_factory
    ) -> None:
        client_a, client_b = await _seed_two_clients(platform_session)
        await platform_session.commit()

        async with client_session_factory(client_a) as session:
            for view in TELEMETRY_VIEWS:
                leaked = (await session.execute(
                    text(f"SELECT count(*) FROM {view} WHERE client_id = :other"),
                    {"other": client_b},
                )).scalar()
                assert leaked == 0, f"{view} leaked another Client's telemetry"

    async def test_api_role_cannot_reach_the_telemetry_base_tables(
        self, client_session_factory
    ) -> None:
        """The barrier-view design: no grant at all, not merely a policy.

        TimescaleDB forbids RLS on a compressed hypertable, so isolation rests on
        the API holding no privilege here. If this ever succeeds, the whole
        telemetry isolation model has silently regressed.
        """
        for table in ("readings", "mqtt_raw"):
            async with client_session_factory(1) as session:
                with pytest.raises(ProgrammingError, match="permission denied"):
                    await session.execute(text(f"SELECT count(*) FROM {table}"))

    async def test_no_client_context_sees_nothing(self, client_session_factory) -> None:
        # An unconfigured session must see nothing rather than everything: the
        # accessors return NULL and every policy denies. Deny by default.
        async with client_session_factory(None, role_code=None) as session:
            for table in ("plants", "devices", "alarms"):
                count = (await session.execute(
                    text(f"SELECT count(*) FROM {table}"))).scalar()
                assert count == 0, f"{table} was readable with no Client context"


class TestPlantVisibility:
    async def test_employee_with_zero_assignments_sees_zero_plants(
        self, platform_session, client_session_factory
    ) -> None:
        """I-5: absence of assignment is never full access."""
        client_a, _ = await _seed_two_clients(platform_session)
        await platform_session.commit()

        async with client_session_factory(client_a, role_code="employee",
                                          user_id=999_999) as session:
            for table in ("plants", "devices"):
                count = (await session.execute(
                    text(f"SELECT count(*) FROM {table}"))).scalar()
                assert count == 0, f"unassigned Employee saw rows in {table}"

    async def test_employee_with_zero_assignments_sees_zero_readings(
        self, client_session_factory
    ) -> None:
        """The gap migration 0010 closed.

        Before it, an Employee with no assignments correctly saw zero Plants and
        zero Devices but every Reading of their Client, because the barrier view
        filtered on client_id alone.
        """
        async with client_session_factory(1, role_code="employee",
                                          user_id=999_999) as session:
            count = (await session.execute(
                text("SELECT count(*) FROM readings_v"))).scalar()
            assert count == 0

    async def test_admin_sees_every_plant_of_their_own_client(
        self, platform_session, client_session_factory
    ) -> None:
        """F-8: a Client Admin sees all their Client's Plants automatically, with
        no assignment rows at all."""
        client_a, _ = await _seed_two_clients(platform_session)
        await platform_session.commit()

        async with client_session_factory(client_a, role_code="admin") as session:
            count = (await session.execute(
                text("SELECT count(*) FROM plants"))).scalar()
            assert count >= 1


class TestAuditImmutability:
    async def test_audit_rows_cannot_be_updated_or_deleted(
        self, client_session_factory
    ) -> None:
        """Migration 0011: no UPDATE or DELETE policy exists, so both are denied."""
        # Asserted on the specific error, not a bare Exception: a broad match
        # would also pass on a typo or a dropped connection, which would make
        # this test claim protection it had not verified.
        for statement in ("UPDATE audit_log SET action = 'tampered' WHERE id > 0",
                          "DELETE FROM audit_log WHERE id > 0"):
            async with client_session_factory(1) as session:
                with pytest.raises(ProgrammingError, match="permission denied"):
                    await session.execute(text(statement))

    async def test_a_failed_login_can_be_recorded_without_a_client(
        self, platform_session
    ) -> None:
        """Tender §33 requires failed logins, which have no Client context."""
        await platform_session.execute(text("""
            INSERT INTO audit_log (client_id, user_id, actor_email, action)
            VALUES (NULL, NULL, 'nobody@example.test', 'auth.login.failed')
        """))
