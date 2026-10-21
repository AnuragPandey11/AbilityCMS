"""Every route that changes what a Plant's figures are worked out from sets the
Plant's stored copies aside (migration 0042).

`test_scale.TestSetAsideOnEdit` proves the mechanism end to end on two routes.
This file holds the rest of the list, one test per route, because the failure
it guards against is a route *forgetting* the call: nothing errors, the edit
saves, and the screen goes on serving figures from the old settings for up to
two and a half minutes. Each test runs the route as a Client Admin, so the mark
is made by the API role under the caller's RLS, as in production.

What a test reads is the column itself (`plant_edited_at` against
`computed_at`), not a served response: whether a set-aside copy is served is
`TestSetAsideOnEdit`'s job, and computing a dashboard per assertion would only
make this slower.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import pytest
from sqlalchemy import text

from solarcms.db.rls import API_ROLE, SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import scoped_session
from solarcms.services import snapshots
from tests.conftest import requires_db
from tests.integration.test_scale import _app, _client_with_plant, _login

pytestmark = [pytest.mark.asyncio, requires_db]


async def _scheduler_pass(plant: dict[str, Any]) -> None:
    """The scheduler's pass over one Plant, so a copy is stored and fresh.

    `_work` rather than `refresh_all`: the scratch database accumulates every
    run's fixtures, and the dashboard copy is all a set-aside needs to touch.
    """
    await snapshots._work(plant["plant_id"], plant["client_id"], kpis=False)


async def _copies(plant_id: int) -> str:
    """'set aside', 'served' or 'mixed' — what the API would make of the copies."""
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        row = (await s.execute(text("""
            SELECT count(*) AS total,
                   count(*) FILTER (WHERE plant_edited_at IS NOT NULL
                                      AND computed_at <= plant_edited_at) AS aside
              FROM plant_snapshots WHERE plant_id = :p
        """), {"p": plant_id})).one()
    assert row.total > 0, "the scheduler pass stored nothing to set aside"
    if row.aside == row.total:
        return "set aside"
    return "served" if row.aside == 0 else "mixed"


async def _inverter(plant: dict[str, Any], code: str = "INV-1", *,
                    collector_code: str | None = None) -> int:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        return int((await s.execute(text("""
            INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                 collector_code)
            SELECT :c, :p, dm.id, :code, :name, :collector
              FROM device_models dm JOIN device_types dt ON dt.id = dm.device_type_id
             WHERE dt.code = 'INVERTER' ORDER BY dm.id LIMIT 1
            RETURNING id
        """), {"c": plant["client_id"], "p": plant["plant_id"], "code": code,
               "name": code, "collector": collector_code})).scalar_one())


async def _inverter_model() -> int:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        return int((await s.execute(text("""
            SELECT dm.id FROM device_models dm
              JOIN device_types dt ON dt.id = dm.device_type_id
             WHERE dt.code = 'INVERTER' ORDER BY dm.id LIMIT 1
        """))).scalar_one())


async def _second_plant(plant: dict[str, Any]) -> dict[str, Any]:
    """Another Plant of the same Client, visible to the same login."""
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone)
            VALUES (:c, :code, 'Second Plant', 'active', 'Asia/Kolkata') RETURNING id
        """), {"c": plant["client_id"], "code": f"S2-{uuid.uuid4().hex[:8]}"})).scalar_one()
    return {**plant, "plant_id": plant_id}


class TestDeviceRoutes:
    async def test_registering_a_device(self) -> None:
        mine = await _client_with_plant()
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            made = await http.post("/devices", params={"plant_id": mine["plant_id"]},
                                   json={"code": "INV-NEW", "name": "INV-NEW",
                                         "device_model_id": await _inverter_model(),
                                         "bind_from_model": False})
            assert made.status_code == 201, made.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_a_bulk_import(self) -> None:
        mine = await _client_with_plant()
        await _scheduler_pass(mine)
        model = await _inverter_model()
        async with await _login(mine["email"]) as http:
            made = await http.post(
                "/devices/bulk-import", params={"plant_id": mine["plant_id"]},
                json={"devices": [{"code": f"INV-{n}", "name": f"INV-{n}",
                                   "device_model_id": model, "bind_from_model": False}
                                  for n in (1, 2)]})
            assert made.status_code == 201, made.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_editing_a_device(self) -> None:
        mine = await _client_with_plant()
        device_id = await _inverter(mine)
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            edit = await http.patch(f"/devices/{device_id}", json={"dc_capacity_kwp": 110})
            assert edit.status_code == 200, edit.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_deleting_a_device_finds_its_plant_without_it(self) -> None:
        # After the commit there is no Device row to find the Plant from, which
        # is why the route names the Plant rather than the Device.
        mine = await _client_with_plant()
        device_id = await _inverter(mine)
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            gone = await http.delete(f"/devices/{device_id}")
            assert gone.status_code == 200, gone.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_a_refused_device_edit_leaves_the_copies_in_place(self) -> None:
        mine = await _client_with_plant()
        device_id = await _inverter(mine)
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            refused = await http.put(f"/devices/{device_id}/bindings", json={
                "bindings": [{"source_key": "PAC", "tag_code": "NO_SUCH_TAG"}]})
            assert refused.status_code == 422, refused.text
        assert await _copies(mine["plant_id"]) == "served"

    async def test_a_device_edit_leaves_the_clients_other_plants_alone(self) -> None:
        # `device_edited` finds the Plant through the Device; it must find that
        # one Plant, not every Plant the session can see.
        mine = await _client_with_plant()
        other = await _second_plant(mine)
        device_id = await _inverter(mine)
        await _scheduler_pass(mine)
        await _scheduler_pass(other)
        async with await _login(mine["email"]) as http:
            rebound = await http.post(f"/devices/{device_id}/bindings/from-model")
            assert rebound.status_code == 200, rebound.text
        assert await _copies(mine["plant_id"]) == "set aside"
        assert await _copies(other["plant_id"]) == "served"


class TestBindingRoutes:
    async def test_replacing_the_bindings(self) -> None:
        mine = await _client_with_plant()
        device_id = await _inverter(mine)
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            done = await http.put(f"/devices/{device_id}/bindings", json={
                "bindings": [{"source_key": "PAC", "tag_code": "AC_ACTIVE_POWER"}]})
            assert done.status_code == 200, done.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_adding_one_binding(self) -> None:
        mine = await _client_with_plant()
        device_id = await _inverter(mine)
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            added = await http.post(f"/devices/{device_id}/bindings",
                                    json={"source_key": "PAC", "tag_code": "AC_ACTIVE_POWER"})
            assert added.status_code == 201, added.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_editing_one_binding(self) -> None:
        mine = await _client_with_plant()
        device_id = await _inverter(mine)
        async with await _login(mine["email"]) as http:
            added = await http.post(f"/devices/{device_id}/bindings",
                                    json={"source_key": "PAC", "tag_code": "AC_ACTIVE_POWER"})
            assert added.status_code == 201, added.text
            # Stored after the add, so only the edit can set this copy aside.
            await _scheduler_pass(mine)
            assert await _copies(mine["plant_id"]) == "served"
            edit = await http.patch(f"/devices/{device_id}/bindings/{added.json()['id']}",
                                    json={"scale": 0.001})
            assert edit.status_code == 200, edit.text
        assert await _copies(mine["plant_id"]) == "set aside"


class TestPlantRoutes:
    async def test_wiring_a_collector(self) -> None:
        mine = await _client_with_plant()
        await _inverter(mine, collector_code="MCR")
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            wired = await http.put(f"/plants/{mine['plant_id']}/collectors/MCR",
                                   json={"parent_device_id": None, "note": "nothing yet"})
            assert wired.status_code == 200, wired.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_a_status_change(self) -> None:
        mine = await _client_with_plant()
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            moved = await http.post(f"/plants/{mine['plant_id']}/status",
                                    json={"status": "commissioning"})
            assert moved.status_code == 200, moved.text
        assert await _copies(mine["plant_id"]) == "set aside"

    async def test_a_status_change_to_the_same_status_changes_nothing(self) -> None:
        mine = await _client_with_plant()
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            same = await http.post(f"/plants/{mine['plant_id']}/status",
                                   json={"status": "active"})
            assert same.status_code == 200, same.text
            assert same.json()["changed"] is False
        assert await _copies(mine["plant_id"]) == "served"


class TestMaintenanceRoutes:
    async def test_opening_and_closing_a_window(self) -> None:
        # Planned work is left out of coverage, so both ends change the figures.
        mine = await _client_with_plant()
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            opened = await http.post("/operations/maintenance",
                                     json={"plant_id": mine["plant_id"], "reason": "wash"})
            assert opened.status_code == 201, opened.text
            assert await _copies(mine["plant_id"]) == "set aside"

            await _scheduler_pass(mine)
            assert await _copies(mine["plant_id"]) == "served"
            closed = await http.post(f"/operations/maintenance/{opened.json()['id']}/close")
            assert closed.status_code == 200, closed.text
        assert await _copies(mine["plant_id"]) == "set aside"


class TestOneTransaction:
    async def test_every_plant_a_transaction_edited_is_set_aside_together(self) -> None:
        # One mark per transaction gathers every Plant and Device named in it.
        # Under the API role, so the column GRANT is what is being exercised.
        first = await _client_with_plant()
        second = await _second_plant(first)
        third = await _second_plant(first)
        untouched = await _second_plant(first)
        device_in_third = await _inverter(third)
        for plant in (first, second, third, untouched):
            await _scheduler_pass(plant)
        async with scoped_session(SecurityContext.platform(0), role=API_ROLE) as s:
            snapshots.plant_edited(s, first["plant_id"])
            snapshots.plant_edited(s, second["plant_id"])
            snapshots.plant_edited(s, first["plant_id"])
            snapshots.device_edited(s, device_in_third)
        assert [await _copies(p["plant_id"]) for p in (first, second, third, untouched)] == [
            "set aside", "set aside", "set aside", "served"]


class TestBeforeTheResponse:
    async def test_the_copies_are_set_aside_before_the_browser_hears_the_edit_saved(
        self,
    ) -> None:
        # The browser re-reads the moment its write succeeds. If the set-aside
        # ran after the response began — as dependency teardown does on some
        # FastAPI versions — that re-read could still be served the old copy.
        # httpx's ASGITransport waits for the whole app, so it cannot see this;
        # a bare ASGI call can, by looking when the response starts.
        mine = await _client_with_plant()
        await _scheduler_pass(mine)
        async with await _login(mine["email"]) as http:
            authorization = http.headers["Authorization"]

        body = json.dumps({"dc_capacity_kwp": 1500}).encode()
        path = f"/plants/{mine['plant_id']}"
        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": "PATCH", "scheme": "http", "path": path,
            "raw_path": path.encode(), "query_string": b"", "root_path": "",
            "headers": [(b"host", b"test"), (b"content-type", b"application/json"),
                        (b"authorization", authorization.encode())],
            "server": ("test", 80), "client": ("127.0.0.1", 50000),
        }
        sent_body = False
        finished = asyncio.Event()

        async def receive() -> dict[str, Any]:
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": body, "more_body": False}
            await finished.wait()
            return {"type": "http.disconnect"}

        at_start: list[tuple[int, str]] = []

        async def send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                at_start.append((message["status"], await _copies(mine["plant_id"])))
            elif message["type"] == "http.response.body" and not message.get("more_body"):
                finished.set()

        await _app()(scope, receive, send)
        assert at_start == [(200, "set aside")]


class TestNoDeadlockWithTheScheduler:
    async def test_a_set_aside_waits_its_turn_instead_of_deadlocking(self) -> None:
        """22 Oct 2026, OASIS_2MW and its Devices decommissioned one after
        another: a scheduler pass held the Plant's dashboard copy and reached for
        a KPI copy while an edit's set-aside, scanning the rows in the order
        they lay on disk, held the KPI copies and waited for the dashboard's.
        Postgres broke the circle by cancelling the pass. Both now lock in
        (plant, kind) order, so the set-aside queues behind the pass instead.
        """
        plant = await _client_with_plant()
        plant_id, client_id = plant["plant_id"], plant["client_id"]
        # The KPI copies first, so a scan in disk order meets them before the
        # dashboard's — the order that deadlocked.
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            for kind in ("kpis:today", "kpis:month", "kpis:year", "kpis:lifetime", "dashboard"):
                await s.execute(text("""
                    INSERT INTO plant_snapshots (plant_id, client_id, kind, computed_at, payload)
                    VALUES (:p, :c, :k, now() - interval '1 minute', '{}'::jsonb)
                """), {"p": plant_id, "c": client_id, "k": kind})

        edited = snapshots._Edited()
        edited.plants.add(plant_id)
        async with scoped_session(SecurityContext.platform(0),
                                  role=SCHEDULER_ROLE) as writer:
            began = (await writer.execute(text("SELECT clock_timestamp()"))).scalar_one()
            # The pass holds the dashboard copy…
            await snapshots._store(writer, plant_id, client_id, "dashboard", began, {})
            # …an edit commits and sets the Plant aside, as the API does…
            aside = asyncio.create_task(
                edited.set_aside(SecurityContext.platform(0), API_ROLE))
            await asyncio.sleep(0.5)
            # …and the pass reaches for a KPI copy. Before the fix: deadlock.
            await asyncio.wait_for(snapshots._store(
                writer, plant_id, client_id, "kpis:today", began, {}), timeout=10)
        await asyncio.wait_for(aside, timeout=10)
        assert await _copies(plant_id) == "set aside"
