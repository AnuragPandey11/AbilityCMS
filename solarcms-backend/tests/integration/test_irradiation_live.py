"""A Plant whose weather stations' daily totals are stuck, against a real database.

The shape of VARDHMAN_GROUP's SPINNING_AND_GENERAL_MILLS on 15 Oct 2026: two
stations, `WMS` and `WMS_WEST`, sending their daily total (`AGHI`) and their
tilted sensor (`GTI`) as 0 while their live `GHI` reads the sun. The Plant
showed "No irradiation in period" and no PR. Through the real routes: the KPIs,
the Weather and Monthly Plant reports, and the dashboard's Irradiance tile —
which reads the aggregate views (`read_live_irradiance`) and Redis.
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
from solarcms.cache.live import write_current_values
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

KOLKATA = ZoneInfo("Asia/Kolkata")
PASSWORD = "SunPass!123"
DC_KWP = 610.0
# Live GHI per station, constant over three hours.
GHI = {"WMS": 500.0, "WMS_WEST": 520.0}


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _plant() -> dict[str, Any]:
    """A meter and two stations over 10:30 to 13:30 in Kolkata two days ago.

    05:00 to 08:00 UTC: whole buckets on every tier, including the hourly one,
    whose buckets begin at :30 on Kolkata's clock — so each tier integrates
    exactly three hours and the figures below do not depend on which is read.
    """
    suffix = uuid.uuid4().hex[:8]
    day = datetime.now(KOLKATA).date() - timedelta(days=2)
    start = datetime(day.year, day.month, day.day, 10, 30, tzinfo=KOLKATA).astimezone(UTC)
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Sun', 'active') RETURNING id
        """), {"c": f"sun-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone,
                                dc_capacity_kwp, ac_capacity_kw)
            VALUES (:c, :code, 'Sun Plant', 'active', 'Asia/Kolkata', :dc, 500)
            RETURNING id
        """), {"c": client_id, "code": f"S-{suffix}", "dc": DC_KWP})).scalar_one()
        email = f"sun-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Sun')
            RETURNING id
        """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
        models = {
            type_code: (await s.execute(text("""
                INSERT INTO device_models (device_type_id, manufacturer, model_code)
                SELECT id, 'Sun', :m FROM device_types WHERE code = :t RETURNING id
            """), {"m": f"sun-{type_code}-{suffix}", "t": type_code})).scalar_one()
            for type_code in ("MFM", "WMS")
        }
        tags = {row.code: row.id for row in (await s.execute(text("""
            SELECT id, code FROM tags
             WHERE code IN ('ENERGY_EXPORT_TOTAL', 'GHI', 'GTI', 'GHI_CUMULATIVE')
        """))).all()}

        devices: dict[str, int] = {}
        bound = {"MFM": ("MFM", ["ENERGY_EXPORT_TOTAL"]),
                 "WMS": ("WMS", ["GHI", "GTI", "GHI_CUMULATIVE"]),
                 "WMS_WEST": ("WMS", ["GHI", "GTI", "GHI_CUMULATIVE"])}
        for code, (type_code, tag_codes) in bound.items():
            devices[code] = (await s.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                     expected_interval_s, source_address)
                VALUES (:c, :p, :m, CAST(:code AS varchar(64)), CAST(:code AS text), 60, :topic)
                RETURNING id
            """), {"c": client_id, "p": plant_id, "m": models[type_code], "code": code,
                   # A lifetime begins at the first reading of a Device with a topic.
                   "topic": f"SCMS/V1/SUN_{suffix}/S_{suffix}/{code}"})).scalar_one()
            for tag_code in tag_codes:
                await s.execute(text("""
                    INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                                     scale, value_offset, enabled)
                    VALUES (:c, :d, :t, :k, 1.0, 0.0, true)
                """), {"c": client_id, "d": devices[code], "t": tags[tag_code],
                       "k": tag_code})

        rows = []
        for minute in range(180):
            at = start + timedelta(minutes=minute)

            def reading(code: str, tag: str, value: float, at: datetime = at) -> dict[str, Any]:
                return {"t": at, "c": client_id, "d": devices[code], "tag": tags[tag],
                        "v": value}

            rows.append(reading("MFM", "ENERGY_EXPORT_TOTAL", 100_000.0 + 5.0 * minute))
            for station, ghi in GHI.items():
                rows.append(reading(station, "GHI", ghi))
                rows.append(reading(station, "GTI", 0.0))
                rows.append(reading(station, "GHI_CUMULATIVE", 0.0))
        await s.execute(text("""
            INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
            VALUES (:t, :c, :d, :tag, :v, 0)
        """), rows)

    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        await s.execute(text("COMMIT"))
        for view in ("agg_1m", "agg_15m", "agg_1h", "agg_1d"):
            await s.execute(text(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)"))
    return {"plant_id": plant_id, "email": email, "devices": devices, "tags": tags,
            "day": day}


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


# Three hours at each station's GHI, in kWh/m², and their mean.
EXPECTED = {code: ghi * 3.0 / 1000.0 for code, ghi in GHI.items()}
MEAN = sum(EXPECTED.values()) / len(EXPECTED)


class TestStuckDailyTotals:
    async def test_pr_divides_by_the_stations_live_ghi_and_says_so(self) -> None:
        plant = await _plant()
        async with await _login(plant["email"]) as http:
            response = await http.get(f"/plants/{plant['plant_id']}/kpis",
                                      params={"period": "lifetime"})
        assert response.status_code == 200, response.text
        body = response.json()
        sun = body["irradiation_kwh_m2"]
        assert sun["value"] == pytest.approx(MEAN, rel=1e-6)
        assert sun["from_live_ghi"] is True
        assert {s["device_code"]: s["source"] for s in sun["stations"]} == {
            "WMS": "live_ghi", "WMS_WEST": "live_ghi"}
        assert all(s["register_kwh_m2"] == 0.0 for s in sun["stations"])
        assert sun["spread"] is None
        # PR is defined at last — energy over DC capacity over that sunlight.
        pr = body["performance_ratio"]["value"]
        assert pr == pytest.approx(body["energy_kwh"] / DC_KWP / MEAN, rel=1e-6)

    async def test_the_weather_and_monthly_reports_agree_and_say_where_it_came_from(
        self,
    ) -> None:
        plant = await _plant()
        params = {"plant_id": plant["plant_id"], "period": "custom",
                  "from_date": plant["day"].isoformat(), "to_date": plant["day"].isoformat()}
        async with await _login(plant["email"]) as http:
            weather = await http.get("/reports/tables/weather", params=params)
            monthly = await http.get("/reports/tables/monthly_plant", params=params)
        assert weather.status_code == 200, weather.text
        assert monthly.status_code == 200, monthly.text
        weather_body, monthly_body = weather.json(), monthly.json()
        assert weather_body["rows"][0]["ghi_kwh_m2"] == pytest.approx(MEAN, rel=1e-6)
        assert monthly_body["rows"][0]["irradiation_kwh_m2"] == pytest.approx(MEAN, rel=1e-6)
        assert monthly_body["rows"][0]["performance_ratio"] is not None
        for body in (weather_body, monthly_body):
            assert any("live GHI" in note and "WMS" in note for note in body["notes"])

    async def test_the_irradiance_tile_falls_back_from_a_dead_gti_to_ghi(self) -> None:
        plant = await _plant()
        tags, devices = plant["tags"], plant["devices"]
        now = datetime.now(UTC)
        for station, ghi in (("WMS", 95.2), ("WMS_WEST", 96.4)):
            await write_current_values(devices[station], {
                tags["GHI"]: ghi, tags["GTI"]: 0.0, tags["GHI_CUMULATIVE"]: 0.0}, now)
        async with await _login(plant["email"]) as http:
            response = await http.get(f"/plants/{plant['plant_id']}/dashboard")
        assert response.status_code == 200, response.text
        body = response.json()
        tile = next(slot for slots in body["panels"].values() for slot in slots
                    if slot["slot_code"] == "env.irradiance")
        assert tile["value"] == pytest.approx((95.2 + 96.4) / 2)
        assert tile["source"]["tag_code"] == "GHI"
        assert tile["source"]["degraded"] is True, "GHI is the fallback, and says so"
        withheld = sorted((r["device_code"], r["tag_code"]) for r in body["withheld_readings"])
        assert withheld == [("WMS", "GTI"), ("WMS_WEST", "GTI")]
        # The tile names them itself, so the rail can say why it fell back.
        assert sorted(r["device_code"] for r in tile["withheld"]) == ["WMS", "WMS_WEST"]
