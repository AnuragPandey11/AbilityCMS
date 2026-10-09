"""The Inverter ranking against a real database: the route, the two new fields
(`devices.dc_capacity_kwp`, `plants.energy_tariff_inr_per_kwh`, migration
0040), the barrier views it reads, and isolation."""

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
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

KOLKATA = ZoneInfo("Asia/Kolkata")
PASSWORD = "RankPass!123"


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _plant_with_inverters() -> dict[str, Any]:
    """Three Inverters over two hours of a past day; INV-03 stops for 30 minutes."""
    suffix = uuid.uuid4().hex[:8]
    day = datetime.now(KOLKATA).date() - timedelta(days=2)
    # 11:30 to 13:30 in Kolkata: the middle of the day.
    start = datetime(day.year, day.month, day.day, 11, 30, tzinfo=KOLKATA).astimezone(UTC)
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Rank', 'active') RETURNING id
        """), {"c": f"rank-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone)
            VALUES (:c, :code, 'Rank Plant', 'active', 'Asia/Kolkata') RETURNING id
        """), {"c": client_id, "code": f"R-{suffix}"})).scalar_one()
        email = f"rank-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Rank')
            RETURNING id
        """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
        model_id = (await s.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code, variant)
            SELECT id, 'Rank', :m, 'string' FROM device_types WHERE code = 'INVERTER'
            RETURNING id
        """), {"m": f"rank-{suffix}"})).scalar_one()
        tags = {row.code: row.id for row in (await s.execute(text("""
            SELECT id, code FROM tags WHERE code IN ('AC_ACTIVE_POWER', 'ENERGY_TOTAL')
        """))).all()}

        devices: dict[str, int] = {}
        for n in (1, 2, 3):
            code = f"INV-0{n}"
            devices[code] = (await s.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                     expected_interval_s)
                VALUES (:c, :p, :m, CAST(:code AS varchar(64)), CAST(:code AS text), 60)
                RETURNING id
            """), {"c": client_id, "p": plant_id, "m": model_id, "code": code})).scalar_one()
            for tag_code, key in (("AC_ACTIVE_POWER", "PAC"), ("ENERGY_TOTAL", "ETOT")):
                await s.execute(text("""
                    INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                                     scale, value_offset, enabled)
                    VALUES (:c, :d, :t, :k, 1.0, 0.0, true)
                """), {"c": client_id, "d": devices[code], "t": tags[tag_code], "k": key})

        rows = []
        for code, device_id in devices.items():
            energy = 1000.0
            for minute in range(120):
                down = code == "INV-03" and 40 <= minute < 70
                power = 0.0 if down else 60.0
                at = start + timedelta(minutes=minute)
                rows.append({"t": at, "c": client_id, "d": device_id,
                             "tag": tags["AC_ACTIVE_POWER"], "v": power})
                rows.append({"t": at, "c": client_id, "d": device_id,
                             "tag": tags["ENERGY_TOTAL"], "v": energy})
                energy += power / 60.0
        await s.execute(text("""
            INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
            VALUES (:t, :c, :d, :tag, :v, 0)
        """), rows)

    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        await s.execute(text("COMMIT"))
        for view in ("agg_1m", "agg_15m", "agg_1h", "agg_1d"):
            await s.execute(text(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)"))
    return {"plant_id": plant_id, "email": email, "devices": devices, "day": day}


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


def _params(day: Any) -> dict[str, str]:
    return {"period": "custom", "from_date": day.isoformat(), "to_date": day.isoformat()}


class TestInverterRanking:
    async def test_a_stop_while_the_others_ran_is_downtime(self) -> None:
        plant = await _plant_with_inverters()
        async with await _login(plant["email"]) as http:
            response = await http.get(f"/plants/{plant['plant_id']}/inverter-ranking",
                                      params=_params(plant["day"]))
            assert response.status_code == 200, response.text
            body = response.json()
        rows = {row["code"]: row for row in body["inverters"]}
        assert set(rows) == {"INV-01", "INV-02", "INV-03"}
        stopped = rows["INV-03"]
        assert stopped["downtime_hours"] == pytest.approx(0.5)
        assert stopped["stop_count"] == 1
        assert stopped["availability"]["value"] == pytest.approx(1 - 30 / 120, abs=0.01)
        assert rows["INV-01"]["availability"]["value"] == pytest.approx(1.0)
        # Generation from each register, as the Inverter Report counts it.
        assert rows["INV-01"]["generation_kwh"] == pytest.approx(119.0, abs=1.5)
        assert stopped["generation_kwh"] < rows["INV-01"]["generation_kwh"]
        # No sizes and no tariff yet: said, never estimated.
        assert stopped["performance_ratio"]["value"] is None
        assert stopped["lost_kwh"]["value"] is None
        assert "DC size" in stopped["lost_kwh"]["undefined_reason"]
        assert rows["INV-01"]["lost_kwh"]["value"] == 0.0

    async def test_sizes_and_tariff_price_the_stop(self) -> None:
        plant = await _plant_with_inverters()
        async with await _login(plant["email"]) as http:
            for device_id in plant["devices"].values():
                saved = await http.patch(f"/devices/{device_id}",
                                         json={"dc_capacity_kwp": 120})
                assert saved.status_code == 200, saved.text
                assert float(saved.json()["dc_capacity_kwp"]) == 120.0
            tariff = await http.patch(f"/plants/{plant['plant_id']}",
                                      json={"energy_tariff_inr_per_kwh": 4.5})
            assert tariff.status_code == 200, tariff.text
            body = (await http.get(f"/plants/{plant['plant_id']}/inverter-ranking",
                                   params=_params(plant["day"]))).json()
            listed = (await http.get(f"/plants/{plant['plant_id']}/devices")).json()
        stopped = next(row for row in body["inverters"] if row["code"] == "INV-03")
        # Neighbours made 60 kW from 120 kWp; INV-03 lost 60 kW for 30 minutes.
        assert stopped["lost_kwh"]["value"] == pytest.approx(30.0, abs=0.5)
        assert stopped["loss_inr"]["value"] == pytest.approx(30.0 * 4.5, abs=2.5)
        assert body["tariff_inr_per_kwh"] == 4.5
        assert all(float(d["dc_capacity_kwp"]) == 120.0 for d in listed)

        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            audited = (await s.execute(text("""
                SELECT count(*) FROM audit_log
                 WHERE action = 'device.update' AND entity_id = ANY(:ids)
            """), {"ids": list(plant["devices"].values())})).scalar_one()
        assert audited == 3

    async def test_a_size_can_be_cleared(self) -> None:
        plant = await _plant_with_inverters()
        device_id = plant["devices"]["INV-01"]
        async with await _login(plant["email"]) as http:
            await http.patch(f"/devices/{device_id}", json={"dc_capacity_kwp": 120})
            cleared = await http.patch(f"/devices/{device_id}",
                                       json={"clear": ["dc_capacity_kwp"]})
            assert cleared.status_code == 200, cleared.text
            assert cleared.json()["dc_capacity_kwp"] is None
            refused = await http.patch(f"/devices/{device_id}", json={"dc_capacity_kwp": 0})
            assert refused.status_code == 422

    async def test_another_clients_plant_is_not_found(self) -> None:
        mine, theirs = await _plant_with_inverters(), await _plant_with_inverters()
        async with await _login(mine["email"]) as http:
            response = await http.get(f"/plants/{theirs['plant_id']}/inverter-ranking",
                                      params=_params(theirs["day"]))
        assert response.status_code == 404

    async def test_a_period_longer_than_a_month_is_refused_with_a_sentence(self) -> None:
        plant = await _plant_with_inverters()
        today = datetime.now(KOLKATA).date()
        async with await _login(plant["email"]) as http:
            response = await http.get(
                f"/plants/{plant['plant_id']}/inverter-ranking",
                params={"period": "custom", "from_date": (today - timedelta(days=40)).isoformat(),
                        "to_date": today.isoformat()})
        assert response.status_code == 422
        assert "31 days" in response.json()["detail"]
