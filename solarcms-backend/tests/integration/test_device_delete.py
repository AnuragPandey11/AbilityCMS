"""Removing a Device that has stored Readings, against a real database.

`DELETE /devices/{id}?force=true` ran `DELETE FROM readings` as the API role,
which holds no privilege on `readings`, so every confirmed removal from the
Plant screen was a 500 (20 Oct 2026). Migration 0044 gives the API one
function that deletes one visible Device's Readings, and nothing else.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from solarcms.api.auth import hash_password
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

PASSWORD = "DeletePass!123"
READINGS = 30


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _client_with_a_device() -> dict[str, Any]:
    """A Client, its admin, and one Device with `READINGS` stored Readings."""
    suffix = uuid.uuid4().hex[:8]
    start = datetime.now(UTC) - timedelta(hours=2)
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Delete', 'active') RETURNING id
        """), {"c": f"delete-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone)
            VALUES (:c, :code, 'Delete Plant', 'active', 'Asia/Kolkata') RETURNING id
        """), {"c": client_id, "code": f"D-{suffix}"})).scalar_one()
        email = f"delete-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Delete')
            RETURNING id
        """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
        model_id = (await s.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code)
            SELECT id, 'Delete', :m FROM device_types WHERE code = 'MFM' RETURNING id
        """), {"m": f"delete-{suffix}"})).scalar_one()
        device_id = (await s.execute(text("""
            INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                 expected_interval_s)
            VALUES (:c, :p, :m, 'WRONG_TOPIC_MFM', 'Wrong topic', 60) RETURNING id
        """), {"c": client_id, "p": plant_id, "m": model_id})).scalar_one()
        tag_id = (await s.execute(text(
            "SELECT id FROM tags WHERE code = 'AC_ACTIVE_POWER'"))).scalar_one()
        await s.execute(text("""
            INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                             scale, value_offset, enabled)
            VALUES (:c, :d, :t, 'P', 1.0, 0.0, true)
        """), {"c": client_id, "d": device_id, "t": tag_id})
        await s.execute(text("""
            INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
            VALUES (:t, :c, :d, :tag, :v, 0)
        """), [{"t": start + timedelta(minutes=minute), "c": client_id, "d": device_id,
                "tag": tag_id, "v": float(minute)} for minute in range(READINGS)])
    return {"client_id": client_id, "plant_id": plant_id, "device_id": device_id,
            "email": email}


async def _stored(device_id: int) -> int:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        return int((await s.execute(text(
            "SELECT count(*) FROM readings WHERE device_id = :d"), {"d": device_id})).scalar_one())


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


class TestDeleteDeviceWithReadings:
    async def test_refused_without_force_and_says_how_many(self) -> None:
        setup = await _client_with_a_device()
        async with await _login(setup["email"]) as http:
            refused = await http.delete(f"/devices/{setup['device_id']}")
        assert refused.status_code == 409
        assert f"{READINGS} stored Reading(s)" in refused.json()["detail"]
        assert await _stored(setup["device_id"]) == READINGS

    async def test_force_deletes_the_readings_and_the_device(self) -> None:
        setup = await _client_with_a_device()
        async with await _login(setup["email"]) as http:
            removed = await http.delete(f"/devices/{setup['device_id']}",
                                        params={"force": "true"})
            assert removed.status_code == 200, removed.text
            assert removed.json()["readings_deleted"] == READINGS
            gone = await http.get(f"/devices/{setup['device_id']}")
        assert gone.status_code == 404
        assert await _stored(setup["device_id"]) == 0

    async def test_the_function_refuses_a_device_of_another_client(self) -> None:
        ours = await _client_with_a_device()
        theirs = await _client_with_a_device()
        stranger = SecurityContext(user_id=0, client_id=theirs["client_id"], role_code="admin")
        with pytest.raises(DBAPIError, match="no Device"):
            async with scoped_session(stranger) as s:
                await s.execute(text("SELECT app_delete_device_readings(:d)"),
                                {"d": ours["device_id"]})
        assert await _stored(ours["device_id"]) == READINGS

    async def test_the_api_still_cannot_touch_readings_directly(self) -> None:
        setup = await _client_with_a_device()
        context = SecurityContext(user_id=0, client_id=setup["client_id"], role_code="admin")
        with pytest.raises(DBAPIError, match="permission denied"):
            async with scoped_session(context) as s:
                await s.execute(text("DELETE FROM readings WHERE device_id = :d"),
                                {"d": setup["device_id"]})
        assert await _stored(setup["device_id"]) == READINGS
