"""Managing a User from the Users screen: what they hold, their role, their password.

Three things are asserted against the real database, because each one fails
silently otherwise:

- `GET /users` carries each membership's current Plants and dashboards, so the
  screen can open with them ticked instead of blank — both PUTs replace the
  whole list, and a blank panel turned "grant one more" into "revoke the rest".
- A role change takes effect on the person's **next request**, with the token
  they already hold. The role decides what RLS shows (`app_can_see_plant` gives
  an admin every Plant) and used to be read from the token, which a refresh
  copies forward — so a demoted Client Admin kept seeing every Plant until they
  signed out.
- The guards on a role change (not your own; never the Client's last admin; a
  platform administrator's account is not a Client's to reset) and a password
  change that works, is audited, and never records the password.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

PASSWORD = "ManageTest!12345"


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


@dataclass
class Fixture:
    client_id: int
    plant_ids: list[int]
    users: dict[str, tuple[int, str]]  # name -> (user id, email)


async def _fixture(roles: dict[str, str]) -> Fixture:
    """A Client with two Plants and one User per entry of `roles` (name → role)."""
    suffix = uuid.uuid4().hex[:8]
    users: dict[str, tuple[int, str]] = {}
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        client_id = (await setup.execute(text("""
            INSERT INTO clients (code, name, status, is_demo)
            VALUES (:code, 'Manage Test', 'active', false) RETURNING id
        """), {"code": f"MANAGE_{suffix}"})).scalar_one()
        plant_ids = [
            (await setup.execute(text("""
                INSERT INTO plants (client_id, code, name, status)
                VALUES (:c, :code, :name, 'active') RETURNING id
            """), {"c": client_id, "code": f"P{n}_{suffix}", "name": f"Plant {n}"})).scalar_one()
            for n in (1, 2)
        ]
        for name, role in roles.items():
            email = f"manage-{name}-{suffix}@test.local"
            user_id = (await setup.execute(text("""
                INSERT INTO users (email, password_hash, full_name)
                VALUES (:email, :hash, :name) RETURNING id
            """), {"email": email, "hash": hash_password(PASSWORD), "name": name})).scalar_one()
            await setup.execute(text("""
                INSERT INTO memberships (user_id, client_id, role_id)
                SELECT :u, :c, id FROM roles WHERE code = :role
            """), {"u": user_id, "c": client_id, "role": role})
            users[name] = (user_id, email)
    return Fixture(client_id=client_id, plant_ids=plant_ids, users=users)


async def _login(email: str, password: str = PASSWORD) -> httpx.Response:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as http:
        return await http.post("/auth/login", json={"email": email, "password": password})


def _as(token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {token}"})


async def _token(email: str) -> str:
    response = await _login(email)
    assert response.status_code == 200, response.text
    return str(response.json()["access_token"])


async def _super_admin_in(client_id: int) -> str:
    """A platform administrator's token, switched into `client_id`."""
    email = f"manage-super-{uuid.uuid4().hex[:8]}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        await setup.execute(text("""
            INSERT INTO users (email, password_hash, full_name, platform_role)
            VALUES (:email, :hash, 'Super', 'super_admin')
        """), {"email": email, "hash": hash_password(PASSWORD)})
    async with _as(await _token(email)) as superuser:
        switched = await superuser.post("/auth/switch-client", params={"client_id": client_id})
    assert switched.status_code == 200, switched.text
    return str(switched.json()["access_token"])


async def test_users_list_carries_current_plants_and_dashboards() -> None:
    f = await _fixture({"admin": "admin", "ravi": "employee"})
    ravi_id = f.users["ravi"][0]
    async with _as(await _token(f.users["admin"][1])) as admin:
        assert (await admin.put(f"/users/{ravi_id}/plants",
                                json=[f.plant_ids[1]])).status_code == 200
        assert (await admin.put(f"/users/{ravi_id}/dashboards",
                                json=["alarms", "single_plant"])).status_code == 200
        listed = await admin.get("/users")
    assert listed.status_code == 200, listed.text
    ravi = next(row for row in listed.json() if row["id"] == ravi_id)
    assert ravi["plant_ids"] == [f.plant_ids[1]]
    # In the screens' own order (sort_order), whatever order they were sent in.
    assert ravi["dashboards"] == ["single_plant", "alarms"]
    admin_row = next(row for row in listed.json() if row["id"] == f.users["admin"][0])
    assert admin_row["plant_ids"] == [] and admin_row["dashboards"] == []


async def test_role_change_takes_effect_on_the_next_request() -> None:
    f = await _fixture({"admin": "admin", "ravi": "employee"})
    ravi_id, ravi_email = f.users["ravi"]
    ravi_token = await _token(ravi_email)

    async with _as(ravi_token) as ravi:
        assert (await ravi.get("/plants")).json()["items"] == []

        async with _as(await _token(f.users["admin"][1])) as admin:
            promoted = await admin.patch(f"/users/{ravi_id}", json={"role_code": "admin"})
            assert promoted.status_code == 200, promoted.text
            # The same token, unrefreshed: the role is the membership's now.
            seen = {plant["id"] for plant in (await ravi.get("/plants")).json()["items"]}
            assert seen == set(f.plant_ids)
            assert "user.manage" in (await ravi.get("/auth/me")).json()["permissions"]

            demoted = await admin.patch(f"/users/{ravi_id}", json={"role_code": "employee"})
            assert demoted.status_code == 200, demoted.text
            assert (await ravi.get("/plants")).json()["items"] == []
            me = (await ravi.get("/auth/me")).json()
            assert me["role"] == "employee" and me["plants"] == []


async def test_nobody_changes_their_own_role() -> None:
    f = await _fixture({"admin": "admin", "other": "admin"})
    admin_id, admin_email = f.users["admin"]
    async with _as(await _token(admin_email)) as admin:
        refused = await admin.patch(f"/users/{admin_id}", json={"role_code": "employee"})
    assert refused.status_code == 409
    assert "your own role" in refused.json()["detail"]


async def test_the_last_client_admin_cannot_be_demoted() -> None:
    f = await _fixture({"only": "admin", "ravi": "employee"})
    only_id = f.users["only"][0]
    async with _as(await _super_admin_in(f.client_id)) as superuser:
        refused = await superuser.patch(f"/users/{only_id}", json={"role_code": "employee"})
        assert refused.status_code == 409
        assert "only active Client Admin" in refused.json()["detail"]

        # With a second admin in place, the first may step down.
        ravi_id = f.users["ravi"][0]
        assert (await superuser.patch(f"/users/{ravi_id}",
                                      json={"role_code": "admin"})).status_code == 200
        allowed = await superuser.patch(f"/users/{only_id}", json={"role_code": "employee"})
        assert allowed.status_code == 200, allowed.text


async def test_a_password_change_works_and_is_audited_without_the_password() -> None:
    f = await _fixture({"admin": "admin", "ravi": "employee"})
    ravi_id, ravi_email = f.users["ravi"]
    new_password = "a-brand-new-password"
    async with _as(await _token(f.users["admin"][1])) as admin:
        short = await admin.patch(f"/users/{ravi_id}", json={"password": "short"})
        assert short.status_code == 422
        changed = await admin.patch(f"/users/{ravi_id}", json={"password": new_password})
        assert changed.status_code == 200, changed.text

    assert (await _login(ravi_email)).status_code == 401
    assert (await _login(ravi_email, new_password)).status_code == 200

    async with scoped_session(SecurityContext.platform(0), role=None) as check:
        after = (await check.execute(text("""
            SELECT after FROM audit_log
             WHERE action = 'user.update' AND entity_id = :id
             ORDER BY id DESC LIMIT 1
        """), {"id": ravi_id})).scalar_one()
    recorded = after if isinstance(after, dict) else json.loads(after)
    assert recorded["password_changed"] is True
    assert new_password not in json.dumps(recorded)


async def test_a_client_admin_cannot_reset_a_platform_administrator() -> None:
    f = await _fixture({"admin": "admin"})
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        super_id = (await setup.execute(text("""
            INSERT INTO users (email, password_hash, full_name, platform_role)
            VALUES (:email, :hash, 'Super', 'super_admin') RETURNING id
        """), {"email": f"manage-plat-{suffix}@test.local",
               "hash": hash_password(PASSWORD)})).scalar_one()
        await setup.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'employee'
        """), {"u": super_id, "c": f.client_id})
    async with _as(await _token(f.users["admin"][1])) as admin:
        refused = await admin.patch(f"/users/{super_id}",
                                    json={"password": "taken-over-password"})
    assert refused.status_code == 403


async def test_a_removed_member_is_signed_out_at_once() -> None:
    f = await _fixture({"admin": "admin", "ravi": "employee"})
    ravi_id, ravi_email = f.users["ravi"]
    async with _as(await _token(ravi_email)) as ravi:
        assert (await ravi.get("/auth/me")).status_code == 200
        async with _as(await _token(f.users["admin"][1])) as admin:
            assert (await admin.delete(f"/users/{ravi_id}")).status_code == 204
        assert (await ravi.get("/auth/me")).status_code == 401
