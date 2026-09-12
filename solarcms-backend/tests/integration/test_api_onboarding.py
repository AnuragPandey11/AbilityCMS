"""Phase 3 acceptance (BACKEND_SPEC §13).

    A Plant with 9 Devices can be created via API — once with Blocks, once
    without, both valid.

Both paths matter because a Block is *optional* (MASTER §2.2). A Plant with zero
Blocks attaches Devices directly, and a system that quietly requires one would
force every Client into a hierarchy level they did not ask for.

Driven through the ASGI app rather than the service layer, because the point is
that the **API** can do it — permission guards, RLS context and audit included.
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


async def _admin_client():  # type: ignore[no-untyped-def]
    """A Client Admin with plant.manage, and an httpx client carrying its token.

    Arranged in its own transaction that closes before the API is called: a
    session held open would not have committed, so the login would not see the
    User it just created.
    """
    suffix = uuid.uuid4().hex[:8]
    email = f"onboard-{suffix}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        client_id = (await setup.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:code, :name, 'active')
            RETURNING id
        """), {"code": f"onboard-{suffix}", "name": "Onboarding Test"})).scalar_one()
        user_id = (await setup.execute(text("""
            INSERT INTO users (email, password_hash, full_name)
            VALUES (:email, :hash, 'Onboard Admin') RETURNING id
        """), {"email": email, "hash": hash_password("OnboardPass!123")})).scalar_one()
        await setup.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})

    # The token is minted with a throwaway client so the one handed back is
    # still unopened: httpx refuses to enter `async with` on a client that has
    # already issued a request.
    transport = ASGITransport(app=_app())
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as opener:
        login = await opener.post(
            "/auth/login", json={"email": email, "password": "OnboardPass!123"})
    assert login.status_code == 200, login.text

    http = httpx.AsyncClient(
        transport=ASGITransport(app=_app()), base_url="http://test",
        headers={"Authorization": f"Bearer {login.json()['access_token']}"},
    )
    return http, client_id


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _model_id(type_code: str) -> int:
    """A Device Model of the given Type, created if the catalogue has none."""
    async with scoped_session(SecurityContext.platform(0), role=None) as setup:
        row = (await setup.execute(text("""
            SELECT dm.id FROM device_models dm
              JOIN device_types dt ON dt.id = dm.device_type_id
             WHERE dt.code = :code LIMIT 1
        """), {"code": type_code})).first()
        if row is not None:
            return int(row.id)
        return int((await setup.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code)
            SELECT id, 'Test', :model FROM device_types WHERE code = :code
            RETURNING id
        """), {"model": f"test-{type_code.lower()}", "code": type_code})).scalar_one())


class TestPlantWithNineDevices:
    async def test_plant_with_blocks(self) -> None:
        http, _ = await _admin_client()
        inverter_model = await _model_id("INVERTER")
        meter_model = await _model_id("MFM")

        async with http:
            plant = await http.post("/plants", json={
                "code": "WITH-BLOCKS", "name": "Plant With Blocks",
                "dc_capacity_kwp": 2250, "ac_capacity_kw": 2000,
            })
            assert plant.status_code == 201, plant.text
            plant_id = plant.json()["id"]
            assert plant.json()["status"] == "draft"  # MASTER §6.5

            north = await http.post(f"/plants/{plant_id}/blocks", json={
                "code": "NORTH", "name": "North Zone", "capacity_kwp": 1125})
            south = await http.post(f"/plants/{plant_id}/blocks", json={
                "code": "SOUTH", "name": "South Zone", "capacity_kwp": 1125})
            assert north.status_code == 201 and south.status_code == 201
            north_id, south_id = north.json()["id"], south.json()["id"]

            meter = await http.post(f"/devices?plant_id={plant_id}", json={
                "code": "MFM-01", "name": "Main Meter",
                "device_model_id": meter_model, "expected_interval_s": 5,
                "source_address": f"scms/v1/wb/{plant_id}/plc-01/MFM-01"})
            assert meter.status_code == 201, meter.text
            meter_id = meter.json()["id"]

            # Nine Inverters split across two Blocks, all wired into the meter.
            # Geography and electrical topology deliberately differ: the Block
            # split is 5/4, the electrical parent is one meter for all nine.
            payload = {"devices": [{
                "code": f"INV-{i:02d}", "name": f"Inverter {i}",
                "device_model_id": inverter_model,
                "block_id": north_id if i <= 5 else south_id,
                "parent_device_id": meter_id,
                "reports_via_device_id": meter_id,
                "source_address": f"scms/v1/wb/{plant_id}/plc-01/INV-{i:02d}",
                "expected_interval_s": 5, "rated_capacity_kw": 250,
            } for i in range(1, 10)]}
            imported = await http.post(f"/devices/bulk-import?plant_id={plant_id}",
                                       json=payload)
            assert imported.status_code == 201, imported.text
            assert imported.json()["created"] == 9

            devices = await http.get(f"/plants/{plant_id}/devices")
            assert len(devices.json()) == 10  # 9 inverters + 1 meter

            in_north = await http.get(f"/plants/{plant_id}/devices?block_id={north_id}")
            assert len(in_north.json()) == 5

            blocks = await http.get(f"/plants/{plant_id}/blocks")
            assert {b["code"] for b in blocks.json()} == {"NORTH", "SOUTH"}
            assert sum(b["device_count"] for b in blocks.json()) == 9

            # The SLD is electrical and must ignore Blocks entirely (Guardrail 11).
            sld = await http.get(f"/plants/{plant_id}/sld")
            assert sld.status_code == 200
            roots = sld.json()["roots"]
            assert len(roots) == 1 and roots[0]["code"] == "MFM-01"
            assert len(roots[0]["children"]) == 9

            activated = await http.patch(f"/plants/{plant_id}",
                                         json={"status": "active"})
            assert activated.json()["status"] == "active"

    async def test_plant_without_blocks_is_equally_valid(self) -> None:
        http, _ = await _admin_client()
        inverter_model = await _model_id("INVERTER")
        meter_model = await _model_id("MFM")

        async with http:
            plant = await http.post("/plants", json={
                "code": "NO-BLOCKS", "name": "Plant Without Blocks",
                "dc_capacity_kwp": 2250})
            plant_id = plant.json()["id"]

            meter = await http.post(f"/devices?plant_id={plant_id}", json={
                "code": "MFM-01", "name": "Main Meter",
                "device_model_id": meter_model,
                "source_address": f"scms/v1/nb/{plant_id}/plc-01/MFM-01"})
            meter_id = meter.json()["id"]

            imported = await http.post(f"/devices/bulk-import?plant_id={plant_id}",
                                       json={"devices": [{
                "code": f"INV-{i:02d}", "name": f"Inverter {i}",
                "device_model_id": inverter_model,
                "parent_device_id": meter_id,
                # block_id omitted entirely: a Device with no Block belongs
                # directly to the Plant (§2.2).
                "source_address": f"scms/v1/nb/{plant_id}/plc-01/INV-{i:02d}",
            } for i in range(1, 10)]})
            assert imported.status_code == 201, imported.text
            assert imported.json()["created"] == 9

            blocks = await http.get(f"/plants/{plant_id}/blocks")
            assert blocks.json() == []  # zero Blocks is a valid Plant

            devices = await http.get(f"/plants/{plant_id}/devices")
            assert len(devices.json()) == 10
            assert all(d["block_id"] is None for d in devices.json())

            sld = await http.get(f"/plants/{plant_id}/sld")
            assert sld.json()["device_count"] == 10


class TestOnboardingConstraints:
    async def test_a_device_cannot_parent_across_plants(self) -> None:
        """I-3, enforced by a composite foreign key rather than by a check here."""
        http, _ = await _admin_client()
        model = await _model_id("INVERTER")

        async with http:
            a = (await http.post("/plants", json={"code": "X-A", "name": "A"})).json()
            b = (await http.post("/plants", json={"code": "X-B", "name": "B"})).json()
            parent = await http.post(f"/devices?plant_id={a['id']}", json={
                "code": "P-01", "name": "Parent", "device_model_id": model})
            assert parent.status_code == 201

            orphan = await http.post(f"/devices?plant_id={b['id']}", json={
                "code": "C-01", "name": "Child", "device_model_id": model,
                "parent_device_id": parent.json()["id"]})
            assert orphan.status_code == 409
            assert "different Plant" in orphan.json()["detail"]

    async def test_a_block_with_devices_cannot_be_deleted(self) -> None:
        http, _ = await _admin_client()
        model = await _model_id("INVERTER")

        async with http:
            plant = (await http.post("/plants",
                                     json={"code": "DEL-B", "name": "D"})).json()
            block = (await http.post(f"/plants/{plant['id']}/blocks", json={
                "code": "Z1", "name": "Zone 1", "capacity_kwp": 100})).json()
            await http.post(f"/devices?plant_id={plant['id']}", json={
                "code": "D-01", "name": "D1", "device_model_id": model,
                "block_id": block["id"]})

            refused = await http.delete(f"/blocks/{block['id']}")
            assert refused.status_code == 409
            assert "still in this Block" in refused.json()["detail"]

    async def test_two_devices_cannot_claim_the_same_topic(self) -> None:
        """The topic is the sole authority for origin; two owners is unresolvable."""
        http, _ = await _admin_client()
        model = await _model_id("INVERTER")

        async with http:
            plant = (await http.post("/plants",
                                     json={"code": "DUP-T", "name": "T"})).json()
            topic = f"scms/v1/dup/{plant['id']}/plc/INV-01"
            first = await http.post(f"/devices?plant_id={plant['id']}", json={
                "code": "INV-01", "name": "One", "device_model_id": model,
                "source_address": topic})
            assert first.status_code == 201
            second = await http.post(f"/devices?plant_id={plant['id']}", json={
                "code": "INV-02", "name": "Two", "device_model_id": model,
                "source_address": topic})
            assert second.status_code == 409
            assert "already registered" in second.json()["detail"]
