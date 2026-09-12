"""Every endpoint's permission guard denies correctly (BACKEND_SPEC §11).

Dimension A-4: what a User may *do* with what they can see. The matrix is
asserted rather than eyeballed, because a guard that silently loosens is
invisible — the endpoint keeps working, just for more people than intended.

Note what is *not* tested here: whether a caller sees another Client's rows.
That is A-1/A-2 and belongs to `test_isolation.py`, which asserts it at the
database layer where it is actually enforced.
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

PASSWORD = "GuardTest!12345"

# (method, path, permission the route requires)
GUARDED = [
    ("GET", "/plants", "dashboard.view"),
    ("GET", "/catalog/tags", "dashboard.view"),
    ("GET", "/alarms", "dashboard.view"),
    ("GET", "/health/devices", "dashboard.view"),
    ("GET", "/readings/export?device_ids=1&from=2026-01-01T00:00:00Z"
            "&to=2026-01-02T00:00:00Z", "data.export"),
    ("GET", "/reports/definitions", "report.generate"),
    ("GET", "/alarm-rules", "config.modify"),
    ("GET", "/devices/1/bindings", "config.modify"),
    ("GET", "/users", "user.manage"),
    ("POST", "/plants", "plant.manage"),
    ("GET", "/audit", "system.admin"),
    ("GET", "/clients", "system.admin"),
    ("GET", "/health/system", "system.admin"),
    ("POST", "/catalog/tags", "system.admin"),
]

ROLE_PERMISSIONS = {
    "guest": {"dashboard.view"},
    "employee": {"dashboard.view", "alarm.acknowledge", "data.export",
                 "report.generate"},
    "admin": {"dashboard.view", "alarm.acknowledge", "data.export", "report.generate",
              "config.modify", "user.manage", "plant.manage"},
}


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _token_for(role_code: str) -> str:
    suffix = uuid.uuid4().hex[:8]
    email = f"guard-{role_code}-{suffix}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        client_id = (await setup.execute(text("""
            INSERT INTO clients (code, name, status, is_demo)
            VALUES (:code, 'Guard Test', 'active', true) RETURNING id
        """), {"code": f"guard-{suffix}"})).scalar_one()
        user_id = (await setup.execute(text("""
            INSERT INTO users (email, password_hash, full_name)
            VALUES (:email, :hash, 'Guard') RETURNING id
        """), {"email": email, "hash": hash_password(PASSWORD)})).scalar_one()
        await setup.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = :role
        """), {"u": user_id, "c": client_id, "role": role_code})

    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as http:
        response = await http.post("/auth/login",
                                   json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text
    return str(response.json()["access_token"])


@pytest.mark.parametrize("role_code", ["guest", "employee", "admin"])
async def test_permission_matrix(role_code: str) -> None:
    """A route must answer 403 to exactly those roles lacking its permission."""
    token = await _token_for(role_code)
    held = ROLE_PERMISSIONS[role_code]

    async with httpx.AsyncClient(
        transport=ASGITransport(app=_app()), base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    ) as http:
        for method, path, permission in GUARDED:
            response = await http.request(method, path, json={})
            forbidden = response.status_code == 403
            if permission in held:
                assert not forbidden, (
                    f"{role_code} holds {permission} but {method} {path} returned 403"
                )
            else:
                assert forbidden, (
                    f"{role_code} lacks {permission} yet {method} {path} "
                    f"returned {response.status_code}, not 403"
                )


async def test_no_token_is_rejected_everywhere() -> None:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as http:
        for method, path, _ in GUARDED:
            response = await http.request(method, path, json={})
            assert response.status_code == 401, f"{method} {path} allowed no token"


async def test_a_refresh_token_is_not_accepted_as_an_access_token() -> None:
    """A refresh token is long-lived; accepting one as access would turn a
    15-minute window into a week."""
    suffix = uuid.uuid4().hex[:8]
    email = f"guard-refresh-{suffix}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        client_id = (await setup.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:code, 'R', 'active')
            RETURNING id
        """), {"code": f"guardr-{suffix}"})).scalar_one()
        user_id = (await setup.execute(text("""
            INSERT INTO users (email, password_hash, full_name)
            VALUES (:email, :hash, 'R') RETURNING id
        """), {"email": email, "hash": hash_password(PASSWORD)})).scalar_one()
        await setup.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})

    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as http:
        tokens = (await http.post("/auth/login",
                                  json={"email": email, "password": PASSWORD})).json()
        response = await http.get(
            "/plants",
            headers={"Authorization": f"Bearer {tokens['refresh_token']}"})
        assert response.status_code == 401


async def test_a_deactivated_user_loses_access_immediately() -> None:
    """Not in fifteen minutes when the access token expires."""
    suffix = uuid.uuid4().hex[:8]
    email = f"guard-off-{suffix}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        client_id = (await setup.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:code, 'D', 'active')
            RETURNING id
        """), {"code": f"guardd-{suffix}"})).scalar_one()
        user_id = (await setup.execute(text("""
            INSERT INTO users (email, password_hash, full_name)
            VALUES (:email, :hash, 'D') RETURNING id
        """), {"email": email, "hash": hash_password(PASSWORD)})).scalar_one()
        await setup.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})

    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as http:
        token = (await http.post("/auth/login",
                                 json={"email": email, "password": PASSWORD})
                 ).json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        assert (await http.get("/plants", headers=headers)).status_code == 200

        async with scoped_session(SecurityContext.platform(0), role=None) as setup:
            await setup.execute(
                text("UPDATE users SET is_active = false WHERE id = :id"),
                {"id": user_id})

        # Same still-valid token, now refused: permissions and account state are
        # read per request rather than carried in the token.
        assert (await http.get("/plants", headers=headers)).status_code == 401
