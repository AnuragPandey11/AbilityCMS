"""Phase 10 acceptance: every mutation is audited, in the same transaction.

    Every mutation audited; /health/system reports ingest lag.

The trail exists to answer "who changed what, and when" — and, for access
changes, "who could see what, and since when". A mutation that writes no row
makes both unanswerable for that action, silently.
"""

from __future__ import annotations

import uuid

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

async def _admin_http() -> tuple[httpx.AsyncClient, int, int]:
    from solarcms.api.main import create_app

    suffix = uuid.uuid4().hex[:8]
    email = f"audit-{suffix}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Audit', 'active')
            RETURNING id
        """), {"c": f"audit-{suffix}"})).scalar_one()
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name)
            VALUES (:e, :h, 'Audit Admin') RETURNING id
        """), {"e": email, "h": hash_password("AuditPass!12345")})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})

    async with httpx.AsyncClient(transport=ASGITransport(app=create_app()),
                                 base_url="http://test") as opener:
        token = (await opener.post("/auth/login",
                                   json={"email": email,
                                         "password": "AuditPass!12345"})
                 ).json()["access_token"]
    return (
        httpx.AsyncClient(transport=ASGITransport(app=create_app()),
                          base_url="http://test",
                          headers={"Authorization": f"Bearer {token}"}),
        client_id, user_id,
    )


async def _actions_for(client_id: int) -> list[str]:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        rows = (await s.execute(text("""
            SELECT action FROM audit_log WHERE client_id = :c ORDER BY id
        """), {"c": client_id})).all()
    return [r.action for r in rows]


class TestAuditAtRuntime:
    async def test_creating_a_plant_and_block_is_recorded(self) -> None:
        http, client_id, _user = await _admin_http()
        async with http:
            plant = await http.post("/plants", json={"code": "AUD-1", "name": "Audited"})
            plant_id = plant.json()["id"]
            await http.post(f"/plants/{plant_id}/blocks",
                            json={"code": "B1", "name": "Block 1", "capacity_kwp": 10})
            await http.patch(f"/plants/{plant_id}", json={"name": "Renamed"})

        actions = await _actions_for(client_id)
        assert "plant.create" in actions
        assert "block.create" in actions
        assert "plant.update" in actions

    async def test_a_failed_change_leaves_no_audit_row(self) -> None:
        """The row shares the transaction, so a rejected change records nothing.

        An audit written outside the transaction would claim a change that never
        happened — worse than no trail at all, because it would be believed.
        """
        http, client_id, _user = await _admin_http()
        async with http:
            await http.post("/plants", json={"code": "AUD-2", "name": "First"})
            before = len(await _actions_for(client_id))
            # Same code twice: refused by the uniqueness check.
            duplicate = await http.post("/plants",
                                        json={"code": "AUD-2", "name": "Second"})
            assert duplicate.status_code == 409
        assert len(await _actions_for(client_id)) == before

    async def test_access_changes_are_recorded(self) -> None:
        http, client_id, _user = await _admin_http()
        async with http:
            created = await http.post(
                "/users?email=member@audit.test&password=MemberPass!123"
                "&full_name=Member&role_code=employee")
            assert created.status_code == 201, created.text
            member_id = created.json()["id"]
            await http.put(f"/users/{member_id}/dashboards",
                           json=["portfolio", "single_plant"])
            await http.put(f"/users/{member_id}/plants", json=[])

        actions = await _actions_for(client_id)
        assert "user.create" in actions
        assert "user.dashboards.set" in actions
        assert "user.plants.set" in actions
