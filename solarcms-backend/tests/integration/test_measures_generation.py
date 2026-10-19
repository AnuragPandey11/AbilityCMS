"""A meter on another line than the solar output, against a real database:
the column (migration 0043), the route that sets it, and the energy reader
every Plant figure goes through.

The case is VARDHMAN_GROUP's SPINNING_AND_GENERAL_MILLS (19 Oct 2026): `MFM`
on the solar output and `MAIN_MFM` on the mill's own line, both Type MFM, and
the Plant's energy was the two added together.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.domain.assumptions import PLANT_ENERGY_COUNTER_PRECEDENCE
from solarcms.domain.counters import plant_energy
from solarcms.domain.tiering import Tier
from solarcms.services.energy import read_counter_series
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

KOLKATA = ZoneInfo("Asia/Kolkata")
PASSWORD = "MeterPass!123"


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _plant_with_two_meters() -> dict[str, Any]:
    """Two hours of a past day: `MFM` exports 200 kWh/h, `MAIN_MFM` 660."""
    suffix = uuid.uuid4().hex[:8]
    day = datetime.now(KOLKATA).date() - timedelta(days=2)
    start = datetime(day.year, day.month, day.day, 11, 0, tzinfo=KOLKATA).astimezone(UTC)
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Meter', 'active') RETURNING id
        """), {"c": f"meter-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone)
            VALUES (:c, :code, 'Meter Plant', 'active', 'Asia/Kolkata') RETURNING id
        """), {"c": client_id, "code": f"M-{suffix}"})).scalar_one()
        email = f"meter-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Meter')
            RETURNING id
        """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
        models = {
            type_code: (await s.execute(text("""
                INSERT INTO device_models (device_type_id, manufacturer, model_code)
                SELECT id, 'Meter', :m FROM device_types WHERE code = :t RETURNING id
            """), {"m": f"meter-{type_code}-{suffix}", "t": type_code})).scalar_one()
            for type_code in ("MFM", "INVERTER")
        }
        tag_id = (await s.execute(text(
            "SELECT id FROM tags WHERE code = 'ENERGY_EXPORT_TOTAL'"))).scalar_one()

        devices: dict[str, int] = {}
        for code, type_code in (("MAIN_MFM", "MFM"), ("MFM", "MFM"), ("INVERTER_1", "INVERTER")):
            devices[code] = (await s.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                     expected_interval_s)
                VALUES (:c, :p, :m, CAST(:code AS varchar(64)), CAST(:code AS text), 60)
                RETURNING id
            """), {"c": client_id, "p": plant_id, "m": models[type_code],
                   "code": code})).scalar_one()
        for code in ("MAIN_MFM", "MFM"):
            await s.execute(text("""
                INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                                 scale, value_offset, enabled)
                VALUES (:c, :d, :t, 'EXP', 1.0, 0.0, true)
            """), {"c": client_id, "d": devices[code], "t": tag_id})

        rows = []
        for code, per_hour in (("MAIN_MFM", 660.0), ("MFM", 200.0)):
            for minute in range(121):
                rows.append({"t": start + timedelta(minutes=minute), "c": client_id,
                             "d": devices[code], "tag": tag_id,
                             "v": 50_000.0 + per_hour * minute / 60.0})
        await s.execute(text("""
            INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
            VALUES (:t, :c, :d, :tag, :v, 0)
        """), rows)

    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        await s.execute(text("COMMIT"))
        await s.execute(text("CALL refresh_continuous_aggregate('agg_1m', NULL, NULL)"))
    return {"plant_id": plant_id, "client_id": client_id, "email": email,
            "devices": devices, "start": start}


async def _energy(plant: dict[str, Any]) -> float | None:
    """The Plant's export over the two hours, as every Plant figure reads it."""
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        found = await read_counter_series(
            s, tier=Tier.AGG_1M, pairs=PLANT_ENERGY_COUNTER_PRECEDENCE,
            start=plant["start"] - timedelta(minutes=1),
            end=plant["start"] + timedelta(hours=3), plant_ids=[plant["plant_id"]],
            client_id=plant["client_id"])
    return plant_energy(found.get(plant["plant_id"], []), PLANT_ENERGY_COUNTER_PRECEDENCE,
                        plant_ac_capacity_kw=None).value


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


class TestMeterOnAnotherLine:
    async def test_every_device_measures_generation_until_told_otherwise(self) -> None:
        plant = await _plant_with_two_meters()
        # Both meters' export, added: the figure the Plant showed before.
        assert await _energy(plant) == pytest.approx(2 * (660.0 + 200.0), abs=1.0)
        async with await _login(plant["email"]) as http:
            listed = (await http.get(f"/plants/{plant['plant_id']}/devices")).json()
        assert all(device["measures_generation"] is True for device in listed)

    async def test_a_meter_on_another_line_leaves_the_plants_energy(self) -> None:
        plant = await _plant_with_two_meters()
        main = plant["devices"]["MAIN_MFM"]
        async with await _login(plant["email"]) as http:
            saved = await http.patch(f"/devices/{main}", json={"measures_generation": False})
            assert saved.status_code == 200, saved.text
            assert saved.json()["measures_generation"] is False
            detail = (await http.get(f"/devices/{main}")).json()
            # An unrelated edit leaves it as it is.
            renamed = await http.patch(f"/devices/{main}", json={"name": "Mill incomer"})
            assert renamed.json()["measures_generation"] is False
        assert detail["measures_generation"] is False
        assert await _energy(plant) == pytest.approx(2 * 200.0, abs=1.0)

        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            audited = (await s.execute(text("""
                SELECT after->>'measures_generation' FROM audit_log
                 WHERE action = 'device.update' AND entity_id = :d
                 ORDER BY id LIMIT 1
            """), {"d": main})).scalar_one()
        assert audited == "false"

    async def test_it_can_be_set_back(self) -> None:
        plant = await _plant_with_two_meters()
        main = plant["devices"]["MAIN_MFM"]
        async with await _login(plant["email"]) as http:
            await http.patch(f"/devices/{main}", json={"measures_generation": False})
            back = await http.patch(f"/devices/{main}", json={"measures_generation": True})
        assert back.json()["measures_generation"] is True
        assert await _energy(plant) == pytest.approx(2 * (660.0 + 200.0), abs=1.0)

    async def test_only_a_meter_can_be_on_another_line(self) -> None:
        plant = await _plant_with_two_meters()
        async with await _login(plant["email"]) as http:
            refused = await http.patch(f"/devices/{plant['devices']['INVERTER_1']}",
                                       json={"measures_generation": False})
        assert refused.status_code == 422
        assert "Only a meter" in refused.json()["detail"]
