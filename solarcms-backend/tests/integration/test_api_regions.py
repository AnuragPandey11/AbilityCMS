"""Regions can be created by a Super Admin and referenced by a new Plant.

Before 0018 the API role held SELECT only on `regions`, so the only Region a
Plant could ever name was the placeholder the onboarding script inserted as the
migration owner; every real code (`IN-UP`) was 422 "unknown region". This
exercises the whole path: create the Region as a Super Admin, then create a
Plant under a Client Admin that references it.
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
from tests.integration.test_api_onboarding import _admin_client, _app

pytestmark = [pytest.mark.asyncio, requires_db]


async def _super_admin() -> httpx.AsyncClient:
    suffix = uuid.uuid4().hex[:8]
    email = f"region-super-{suffix}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        await setup.execute(text("""
            INSERT INTO users (email, password_hash, full_name, platform_role)
            VALUES (:email, :hash, 'Region Super', 'super_admin')
        """), {"email": email, "hash": hash_password("RegionPass!123")})
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as opener:
        login = await opener.post(
            "/auth/login", json={"email": email, "password": "RegionPass!123"})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(
        transport=ASGITransport(app=_app()), base_url="http://test",
        headers={"Authorization": f"Bearer {login.json()['access_token']}"},
    )


async def test_super_admin_creates_region_and_plant_references_it() -> None:
    code = f"IN-T{uuid.uuid4().hex[:4].upper()}"
    async with await _super_admin() as superuser:
        created = await superuser.post("/regions", json={
            "code": code, "name": "Test State", "grid_emission_factor_kg_per_kwh": "0.71",
        })
        assert created.status_code == 201, created.text
        assert created.json()["code"] == code

        duplicate = await superuser.post("/regions", json={"code": code, "name": "Again"})
        assert duplicate.status_code == 409

        listed = await superuser.get("/regions")
        assert code in {r["code"] for r in listed.json()}

    http, _ = await _admin_client()
    async with http:
        # A Client Admin can read Regions (catalogue) but not create them.
        forbidden = await http.post("/regions", json={"code": "IN-NOPE", "name": "No"})
        assert forbidden.status_code == 403

        plant = await http.post("/plants", json={
            "code": f"rp-{uuid.uuid4().hex[:6]}", "name": "Region Plant",
            "region_code": code, "timezone": "Asia/Kolkata",
        })
        assert plant.status_code == 201, plant.text

        unknown = await http.post("/plants", json={
            "code": f"rp-{uuid.uuid4().hex[:6]}", "name": "Unknown Region Plant",
            "region_code": "IN-DOES-NOT-EXIST", "timezone": "Asia/Kolkata",
        })
        assert unknown.status_code == 422
