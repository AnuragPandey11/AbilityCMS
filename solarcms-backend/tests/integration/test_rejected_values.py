"""A refused reading, end to end against a real database and Redis: written by
the ingest path as a refusal, served by the dashboard as one, reported by Data
Issues as the cause, and a Tag Mapping save audited by what it changed.

The case is UNIT1's Inverter (22 Oct 2026): `EFF` arrives as -1 for "not
available" while the machine makes ~500 kW. The dashboard showed -1.00 % as a
reading and DC Power, worked out from it, as -49,410 kW.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.cache import live
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.domain.decoding import (
    DerivedBinding,
    DeviceResolution,
    TagBinding,
    current_state,
    decode,
)
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

PASSWORD = "RefusedPass!123"


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


async def _plant_with_an_inverter() -> dict[str, Any]:
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Refused', 'active') RETURNING id
        """), {"c": f"REFUSED-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone, dc_capacity_kwp,
                                ac_capacity_kw)
            VALUES (:c, :code, 'Refused Plant', 'active', 'Asia/Kolkata', 1313, 1010)
            RETURNING id
        """), {"c": client_id, "code": f"R-{suffix}"})).scalar_one()
        email = f"refused-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Refused')
            RETURNING id
        """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
        model_id = (await s.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code)
            SELECT id, 'Refused', :m FROM device_types WHERE code = 'INVERTER' RETURNING id
        """), {"m": f"refused-{suffix}"})).scalar_one()
        topic = f"SCMS/V1/REFUSED-{suffix}/R-{suffix}/INVERTER1"
        device_id = (await s.execute(text("""
            INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                 expected_interval_s, source_address)
            VALUES (:c, :p, :m, 'INVERTER1', 'INVERTER1', 30, :topic) RETURNING id
        """), {"c": client_id, "p": plant_id, "m": model_id, "topic": topic})).scalar_one()
        tags = {row.code: row for row in (await s.execute(text("""
            SELECT id, code, formula, valid_min, valid_max FROM tags
             WHERE code IN ('AC_ACTIVE_POWER', 'INVERTER_EFFICIENCY', 'DC_POWER')
        """))).all()}
        for key, code in (("PAC", "AC_ACTIVE_POWER"), ("EFF", "INVERTER_EFFICIENCY")):
            await s.execute(text("""
                INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                                 scale, value_offset, valid_min, valid_max,
                                                 enabled)
                VALUES (:c, :d, :t, :k, 1.0, 0.0, :lo, :hi, true)
            """), {"c": client_id, "d": device_id, "t": tags[code].id, "k": key,
                   "lo": tags[code].valid_min, "hi": tags[code].valid_max})
    return {"plant_id": plant_id, "client_id": client_id, "email": email,
            "device_id": device_id, "topic": topic, "tags": tags}


def _resolution(plant: dict[str, Any]) -> DeviceResolution:
    tags = plant["tags"]
    return DeviceResolution(
        device_id=plant["device_id"], client_id=plant["client_id"], plant_id=plant["plant_id"],
        expected_interval_s=30,
        bindings={
            "PAC": TagBinding(source_key="PAC", tag_id=tags["AC_ACTIVE_POWER"].id,
                              tag_code="AC_ACTIVE_POWER",
                              valid_min=tags["AC_ACTIVE_POWER"].valid_min,
                              valid_max=tags["AC_ACTIVE_POWER"].valid_max),
            "EFF": TagBinding(source_key="EFF", tag_id=tags["INVERTER_EFFICIENCY"].id,
                              tag_code="INVERTER_EFFICIENCY", valid_min=0.0, valid_max=100.0),
        },
        derived=(DerivedBinding(
            tag_id=tags["DC_POWER"].id, tag_code="DC_POWER", expression=tags["DC_POWER"].formula,
            valid_min=tags["DC_POWER"].valid_min, valid_max=tags["DC_POWER"].valid_max),),
    )


async def _ingest(plant: dict[str, Any], payload: dict[str, Any]) -> None:
    """The ingest path's Redis write for one message, as `_accept` makes it."""
    now = datetime.now(UTC)
    resolution = _resolution(plant)
    result = decode(plant["topic"], payload, resolution, now)
    state = current_state(result.readings, result.unresolved_derived, resolution)
    await live.write_message_state(
        device_id=plant["device_id"], client_id=plant["client_id"], plant_id=plant["plant_id"],
        at=now, current=state.accepted, counters={}, throttled_now=[], unmapped=[],
        rejected=state.rejected, cleared=state.cleared,
    )


def _slot(body: dict[str, Any], code: str) -> dict[str, Any]:
    for stage in body["sld"]["stages"]:
        for slot in stage["slots"]:
            if slot["slot_code"] == code:
                return slot
    raise AssertionError(f"{code} not on the schematic")


class TestARefusedValueOnTheDashboard:
    async def test_it_is_listed_as_refused_and_never_used(self) -> None:
        plant = await _plant_with_an_inverter()
        try:
            await _ingest(plant, {"PAC": "490", "EFF": "98"})
            await _ingest(plant, {"PAC": "498.8", "EFF": "-1"})
            async with await _login(plant["email"]) as http:
                body = (await http.get(f"/plants/{plant['plant_id']}/dashboard")).json()
        finally:
            await live.close_redis()

        efficiency = _slot(body, "sld.inv.efficiency")
        assert efficiency["value"] is None, "98 from the message before is not the value now"
        assert efficiency["undefined_reason"] == "no_value"
        [refused] = efficiency["rejected"]
        assert refused["value"] == -1.0
        assert refused["source_key"] == "EFF"
        assert (refused["valid_min"], refused["valid_max"]) == (0.0, 100.0)

        dc_power = _slot(body, "sld.inv.dc_power")
        assert dc_power["value"] is None, "-49,880 kW is our arithmetic, not a reading"
        assert dc_power["rejected"][0]["because"] == "INVERTER_EFFICIENCY"

        assert _slot(body, "sld.inv.ac_power")["value"] == pytest.approx(498.8)

    async def test_an_accepted_value_takes_its_place_again(self) -> None:
        plant = await _plant_with_an_inverter()
        try:
            await _ingest(plant, {"PAC": "498.8", "EFF": "-1"})
            await _ingest(plant, {"PAC": "490", "EFF": "98"})
            async with await _login(plant["email"]) as http:
                body = (await http.get(f"/plants/{plant['plant_id']}/dashboard")).json()
        finally:
            await live.close_redis()
        assert _slot(body, "sld.inv.efficiency")["value"] == pytest.approx(98.0)
        assert _slot(body, "sld.inv.efficiency")["rejected"] == []
        assert _slot(body, "sld.inv.dc_power")["value"] == pytest.approx(500.0)


class TestDataIssuesNamesTheCause:
    async def test_a_zero_sent_while_producing_is_reported(self) -> None:
        plant = await _plant_with_an_inverter()
        tags = plant["tags"]
        now = datetime.now(UTC)
        rows = []
        for minute in range(1, 31):
            at = now - timedelta(minutes=minute)
            rows.append({"t": at, "c": plant["client_id"], "d": plant["device_id"],
                         "tag": tags["AC_ACTIVE_POWER"].id, "v": 500.0, "q": 0})
            rows.append({"t": at, "c": plant["client_id"], "d": plant["device_id"],
                         "tag": tags["INVERTER_EFFICIENCY"].id, "v": -1.0, "q": 1})
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            await s.execute(text("""
                INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
                VALUES (:t, :c, :d, :tag, :v, :q)
            """), rows)
        try:
            async with await _login(plant["email"]) as http:
                response = await http.get(f"/plants/{plant['plant_id']}/data-issues")
        finally:
            await live.close_redis()
        assert response.status_code == 200, response.text
        [issue] = [i for i in response.json()["issues"]
                   if i["kind"] == "values_rejected"
                   and i["facts"]["tag_code"] == "INVERTER_EFFICIENCY"]
        assert issue["facts"]["producing_kw"] == pytest.approx(500.0)


class TestATagMappingSaveIsAuditedByWhatChanged:
    async def test_a_changed_scale_is_in_the_audit(self) -> None:
        plant = await _plant_with_an_inverter()
        bindings = [
            {"source_key": "PAC", "tag_code": "AC_ACTIVE_POWER", "scale": 1.0,
             "value_offset": 0.0, "valid_min": plant["tags"]["AC_ACTIVE_POWER"].valid_min,
             "valid_max": plant["tags"]["AC_ACTIVE_POWER"].valid_max, "enabled": True},
            {"source_key": "EFF", "tag_code": "INVERTER_EFFICIENCY", "scale": 10.0,
             "value_offset": 0.0, "valid_min": 0.0, "valid_max": 100.0, "enabled": True},
        ]
        try:
            async with await _login(plant["email"]) as http:
                saved = await http.put(f"/devices/{plant['device_id']}/bindings",
                                       json={"bindings": bindings})
        finally:
            await live.close_redis()
        assert saved.status_code == 200, saved.text
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            after = (await s.execute(text("""
                SELECT after FROM audit_log
                 WHERE action = 'device.bindings.replace' AND entity_id = :d
                 ORDER BY id DESC LIMIT 1
            """), {"d": plant["device_id"]})).scalar_one()
        assert after["count"] == 2
        assert after["changed"] == [{"source_key": "EFF", "tag_code": "INVERTER_EFFICIENCY",
                                     "fields": {"scale": [1.0, 10.0]}}]
