"""Performance History and the Alarms' new `until`, against a real database.

`GET /plants/{id}/history` reads the barrier views through the caller's own
RLS session: the route must succeed for whoever may see the Plant (a route
that writes nothing still needs a test that it *answers*, not only that it
refuses), find nothing of another Client's, and refuse a period the Reports
would refuse. `GET /alarms?until=` must bound a past period at its end.
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
from tests.conftest import requires_db
from tests.integration.access import grant_admin_tabs

pytestmark = [pytest.mark.asyncio, requires_db]

KOLKATA = ZoneInfo("Asia/Kolkata")
PASSWORD = "HistoryPass!123"


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _plant() -> dict[str, Any]:
    """Two Inverters making 60 kW each for two hours of a day three days ago."""
    suffix = uuid.uuid4().hex[:8]
    day = datetime.now(KOLKATA).date() - timedelta(days=3)
    start = datetime(day.year, day.month, day.day, 11, 30, tzinfo=KOLKATA).astimezone(UTC)
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Hist', 'active') RETURNING id
        """), {"c": f"hist-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone, dc_capacity_kwp)
            VALUES (:c, :code, 'History Plant', 'active', 'Asia/Kolkata', 240)
            RETURNING id
        """), {"c": client_id, "code": f"H-{suffix}"})).scalar_one()
        email = f"hist-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Hist')
            RETURNING id
        """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
        await grant_admin_tabs(s)
        model_id = (await s.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code, variant)
            SELECT id, 'Hist', :m, 'string' FROM device_types WHERE code = 'INVERTER'
            RETURNING id
        """), {"m": f"hist-{suffix}"})).scalar_one()
        tags = {row.code: row.id for row in (await s.execute(text("""
            SELECT id, code FROM tags WHERE code IN ('AC_ACTIVE_POWER', 'ENERGY_TOTAL')
        """))).all()}
        rows = []
        device_ids = []
        for n in (1, 2):
            device_id = (await s.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                     expected_interval_s)
                VALUES (:c, :p, :m, CAST(:code AS varchar(64)), CAST(:code AS text), 60)
                RETURNING id
            """), {"c": client_id, "p": plant_id, "m": model_id,
                   "code": f"INV-0{n}"})).scalar_one()
            device_ids.append(device_id)
            for tag_code, key in (("AC_ACTIVE_POWER", "PAC"), ("ENERGY_TOTAL", "ETOT")):
                await s.execute(text("""
                    INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                                     scale, value_offset, enabled)
                    VALUES (:c, :d, :t, :k, 1.0, 0.0, true)
                """), {"c": client_id, "d": device_id, "t": tags[tag_code], "k": key})
            energy = 5_000.0
            for minute in range(121):
                at = start + timedelta(minutes=minute)
                rows.append({"t": at, "c": client_id, "d": device_id,
                             "tag": tags["AC_ACTIVE_POWER"], "v": 60.0})
                rows.append({"t": at, "c": client_id, "d": device_id,
                             "tag": tags["ENERGY_TOTAL"], "v": energy})
                energy += 1.0  # 60 kW for a minute
        await s.execute(text("""
            INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
            VALUES (:t, :c, :d, :tag, :v, 0)
        """), rows)
        rule_id = (await s.execute(text("""
            INSERT INTO alarm_rules (client_id, code, name, scope_type, operator,
                                     threshold, duration_s, severity)
            VALUES (:c, 'HIST_TEST', 'History Test', 'global', 'gt', 1, 0, 'high')
            RETURNING id
        """), {"c": client_id})).scalar_one()
        # One Alarm inside the day, one after it.
        for opened in (start + timedelta(minutes=30), start + timedelta(days=2)):
            await s.execute(text("""
                INSERT INTO alarms (client_id, rule_id, plant_id, state, severity,
                                    opened_at, message, escalation_level)
                VALUES (:c, :r, :p, 'resolved', 'high', :opened, 'test', 0)
            """), {"c": client_id, "r": rule_id, "p": plant_id, "opened": opened})

    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        await s.execute(text("COMMIT"))
        for view in ("agg_1m", "agg_15m", "agg_1h", "agg_1d"):
            await s.execute(text(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)"))
    return {"plant_id": plant_id, "email": email, "day": day, "start": start}


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


class TestPerformanceHistory:
    async def test_a_days_energy_yield_and_peak(self) -> None:
        plant = await _plant()
        first = plant["day"] - timedelta(days=1)
        async with await _login(plant["email"]) as http:
            response = await http.get(
                f"/plants/{plant['plant_id']}/history",
                params={"from_date": first.isoformat(), "to_date": plant["day"].isoformat()})
        assert response.status_code == 200, response.text
        body = response.json()
        assert [d["date"] for d in body["days"]] == [first.isoformat(), plant["day"].isoformat()]
        quiet, worked = body["days"]
        assert quiet["energy_kwh"] is None
        # Two registers, 120 kWh each.
        assert worked["energy_kwh"] == pytest.approx(240.0, abs=1.0)
        assert worked["specific_yield"] == pytest.approx(1.0, abs=0.01)
        assert worked["peak_power_kw"] == pytest.approx(120.0, abs=1.0)
        assert worked["coverage"] is not None and worked["coverage"] > 0
        assert body["months"]
        assert body["totals"]["energy_kwh"] == pytest.approx(240.0, abs=1.0)
        assert body["totals"]["days_with_energy"] == 1

    async def test_another_clients_plant_is_not_found(self) -> None:
        mine, theirs = await _plant(), await _plant()
        async with await _login(mine["email"]) as http:
            response = await http.get(
                f"/plants/{theirs['plant_id']}/history",
                params={"from_date": theirs["day"].isoformat(),
                        "to_date": theirs["day"].isoformat()})
        assert response.status_code == 404

    async def test_a_period_over_a_year_is_refused_with_a_sentence(self) -> None:
        plant = await _plant()
        today = datetime.now(KOLKATA).date()
        async with await _login(plant["email"]) as http:
            response = await http.get(
                f"/plants/{plant['plant_id']}/history",
                params={"from_date": (today - timedelta(days=400)).isoformat(),
                        "to_date": today.isoformat()})
        assert response.status_code == 422
        assert "366 days" in response.json()["detail"]

    async def test_alarms_can_be_bounded_at_a_periods_end(self) -> None:
        plant = await _plant()
        day_end = plant["start"] + timedelta(hours=12)
        async with await _login(plant["email"]) as http:
            bounded = await http.get("/alarms", params={
                "plant_id": plant["plant_id"], "since": plant["start"].isoformat(),
                "until": day_end.isoformat()})
            open_ended = await http.get("/alarms", params={
                "plant_id": plant["plant_id"], "since": plant["start"].isoformat()})
        assert bounded.status_code == 200, bounded.text
        assert len(bounded.json()) == 1
        assert len(open_ended.json()) == 2
