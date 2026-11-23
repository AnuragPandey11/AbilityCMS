"""A Device's nameplate — serial number, installation date, kW and kVA
ratings — against a real database.

All are edited in Tag Mapping → Device settings (23 Nov 2026). The route
wrote them with `coalesce`, so an emptied box saved and the old value came
back — they are clearable through `clear` now, and audited both ways. The kVA
rating is its own column (migration 0049): a Transformer has no fixed kW.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from tests.conftest import requires_db
from tests.integration.access import grant_admin_tabs

pytestmark = [pytest.mark.asyncio, requires_db]

PASSWORD = "NameplatePass!123"


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _transformer() -> dict[str, Any]:
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Plate', 'active') RETURNING id
        """), {"c": f"plate-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone)
            VALUES (:c, :code, 'Plate Plant', 'active', 'Asia/Kolkata') RETURNING id
        """), {"c": client_id, "code": f"P-{suffix}"})).scalar_one()
        email = f"plate-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Plate')
            RETURNING id
        """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
        await grant_admin_tabs(s)
        model_id = (await s.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code)
            SELECT id, 'Plate', :m FROM device_types WHERE code = 'TRANSFORMER' RETURNING id
        """), {"m": f"plate-{suffix}"})).scalar_one()
        device_id = (await s.execute(text("""
            INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                 expected_interval_s)
            VALUES (:c, :p, :m, 'TRANSFORMER', 'Transformer', 60) RETURNING id
        """), {"c": client_id, "p": plant_id, "m": model_id})).scalar_one()
    return {"email": email, "device_id": device_id}


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


class TestNameplate:
    async def test_kva_is_its_own_rating_and_kw_can_be_cleared(self) -> None:
        plate = await _transformer()
        device = plate["device_id"]
        async with await _login(plate["email"]) as http:
            # A kW figure typed before kVA existed, then the real rating.
            await http.patch(f"/devices/{device}", json={"rated_capacity_kw": 1000})
            saved = await http.patch(f"/devices/{device}", json={
                "rated_apparent_power_kva": 1250})
            assert saved.status_code == 200, saved.text
            both = (await http.get(f"/devices/{device}")).json()
            assert float(both["rated_apparent_power_kva"]) == 1250
            assert float(both["rated_capacity_kw"]) == 1000

            cleared = await http.patch(f"/devices/{device}", json={
                "clear": ["rated_capacity_kw"]})
            assert cleared.status_code == 200, cleared.text
            after = (await http.get(f"/devices/{device}")).json()
            listed = (await http.get(f"/plants/{after['plant_id']}/devices")).json()
            refused = await http.patch(f"/devices/{device}", json={
                "rated_apparent_power_kva": -1})
        assert after["rated_capacity_kw"] is None
        assert float(after["rated_apparent_power_kva"]) == 1250
        assert float(listed[0]["rated_apparent_power_kva"]) == 1250
        assert refused.status_code == 422

    async def test_set_kept_by_an_unrelated_edit_then_cleared(self) -> None:
        plate = await _transformer()
        device = plate["device_id"]
        async with await _login(plate["email"]) as http:
            saved = await http.patch(f"/devices/{device}", json={
                "serial_number": "TX-2024-0117", "installed_on": "2024-03-15"})
            assert saved.status_code == 200, saved.text
            detail = (await http.get(f"/devices/{device}")).json()
            assert detail["serial_number"] == "TX-2024-0117"
            assert detail["installed_on"].startswith("2024-03-15")

            await http.patch(f"/devices/{device}", json={"name": "Main transformer"})
            kept = (await http.get(f"/devices/{device}")).json()
            assert kept["serial_number"] == "TX-2024-0117"
            assert kept["installed_on"].startswith("2024-03-15")

            cleared = await http.patch(f"/devices/{device}", json={
                "clear": ["serial_number", "installed_on"]})
            assert cleared.status_code == 200, cleared.text
            gone = (await http.get(f"/devices/{device}")).json()
        assert gone["serial_number"] is None
        assert gone["installed_on"] is None

        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            audited = (await s.execute(text("""
                SELECT before->>'serial_number', after->>'serial_number'
                  FROM audit_log
                 WHERE action = 'device.update' AND entity_id = :d
                 ORDER BY id DESC LIMIT 1
            """), {"d": device})).one()
        assert tuple(audited) == ("TX-2024-0117", None)
