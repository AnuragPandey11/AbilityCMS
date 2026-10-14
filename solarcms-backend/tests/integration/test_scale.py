"""The scale work against a real database (docs/CAPACITY_AND_DEPLOYMENT.md).

What only Postgres can prove: the roles' grants and RLS policies on the new
table, the views the scheduler now reads, the leader lock, and the aggregate
refresh. Each of these failing would fail *quietly* inside a worker that
catches and logs — the failure this project keeps meeting — so each asserts
that something was actually written or refused.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import scoped_session
from solarcms.services import snapshots
from solarcms.services.backfill import refresh_aggregates
from solarcms.workers.leadership import Leadership
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _client_with_plant() -> dict[str, Any]:
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Scale', 'active') RETURNING id
        """), {"c": f"scale-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, timezone)
            VALUES (:c, :code, 'Scale Plant', 'active', 'Asia/Kolkata') RETURNING id
        """), {"c": client_id, "code": f"S-{suffix}"})).scalar_one()
        email = f"scale-{suffix}@test.local"
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Scale')
            RETURNING id
        """), {"e": email, "h": hash_password("ScalePass!123")})).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            SELECT :u, :c, id FROM roles WHERE code = 'admin'
        """), {"u": user_id, "c": client_id})
    return {"client_id": client_id, "plant_id": plant_id, "email": email}


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login",
                                  json={"email": email, "password": "ScalePass!123"})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


class TestSnapshots:
    async def test_the_scheduler_writes_and_the_api_serves_the_stored_copy(self) -> None:
        mine = await _client_with_plant()
        stats = await snapshots.refresh_all(kpis=True)
        assert stats["stored"] > 0 and stats["failed"] == 0, stats
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            kinds = {row.kind for row in (await s.execute(text(
                "SELECT kind FROM plant_snapshots WHERE plant_id = :p"),
                {"p": mine["plant_id"]})).all()}
        assert kinds == {"dashboard", "kpis:today", "kpis:month", "kpis:year", "kpis:lifetime"}

        async with await _login(mine["email"]) as http:
            kpis = (await http.get(f"/plants/{mine['plant_id']}/kpis")).json()
            assert kpis["computed_at"] is not None
            assert kpis["previous"] is None, "no comparison unless asked"
            compared = (await http.get(f"/plants/{mine['plant_id']}/kpis",
                                       params={"compare": "true"})).json()
            assert "previous" in compared
            fleet = (await http.get("/plants/snapshots")).json()
            assert [row["plant_id"] for row in fleet["plants"]] == [mine["plant_id"]]
            assert fleet["plants"][0]["kpis"] is not None
            assert fleet["plants"][0]["dashboard"] is not None

    async def test_another_clients_snapshot_is_invisible(self) -> None:
        mine, theirs = await _client_with_plant(), await _client_with_plant()
        await snapshots.refresh_all(kpis=False)
        async with await _login(mine["email"]) as http:
            fleet = (await http.get("/plants/snapshots")).json()
            assert theirs["plant_id"] not in [row["plant_id"] for row in fleet["plants"]]
            assert (await http.get(f"/plants/{theirs['plant_id']}/dashboard")).status_code == 404

    async def test_a_stale_copy_is_not_served(self) -> None:
        mine = await _client_with_plant()
        await snapshots.refresh_all(kpis=True)
        async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
            await s.execute(text("""
                UPDATE plant_snapshots SET computed_at = now() - interval '1 hour',
                       payload = jsonb_set(payload, '{computed_at}', '"stale"')
                 WHERE plant_id = :p
            """), {"p": mine["plant_id"]})
        async with await _login(mine["email"]) as http:
            kpis = (await http.get(f"/plants/{mine['plant_id']}/kpis")).json()
            assert kpis["computed_at"] != "stale", "a stale copy was served as current"


async def _tag_stored_copies(plant_id: int) -> None:
    """Mark the stored bodies, so a response can say whether it was one."""
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        await s.execute(text("""
            UPDATE plant_snapshots
               SET payload = jsonb_set(payload, '{stored_copy}', 'true')
             WHERE plant_id = :p
        """), {"p": plant_id})


async def _served_stored(http: httpx.AsyncClient, plant_id: int) -> dict[str, bool]:
    kpis = (await http.get(f"/plants/{plant_id}/kpis")).json()
    board = (await http.get(f"/plants/{plant_id}/dashboard")).json()
    return {"kpis": kpis.get("stored_copy") is True,
            "dashboard": board.get("stored_copy") is True}


class TestSetAsideOnEdit:
    """An edit sets the Plant's stored figures aside (migration 0042).

    Each of these runs the mark as the API role, under the caller's RLS — so a
    missing GRANT shows here as a copy still being served, not as a log line.
    """

    async def test_an_edit_to_the_plant_sets_its_copies_aside(self) -> None:
        mine = await _client_with_plant()
        await snapshots.refresh_all(kpis=True)
        await _tag_stored_copies(mine["plant_id"])
        async with await _login(mine["email"]) as http:
            assert await _served_stored(http, mine["plant_id"]) == {
                "kpis": True, "dashboard": True}
            edit = await http.patch(f"/plants/{mine['plant_id']}",
                                    json={"dc_capacity_kwp": 1200})
            assert edit.status_code == 200, edit.text
            # The very next read computes afresh, from the new capacity.
            assert await _served_stored(http, mine["plant_id"]) == {
                "kpis": False, "dashboard": False}

        # The scheduler's next pass began after the edit, so it is served again.
        await snapshots.refresh_all(kpis=True)
        await _tag_stored_copies(mine["plant_id"])
        async with await _login(mine["email"]) as http:
            assert await _served_stored(http, mine["plant_id"]) == {
                "kpis": True, "dashboard": True}

    async def test_a_pass_that_began_before_the_edit_is_not_served(self) -> None:
        # The race the column exists for: a pass already under way when the
        # edit lands stores figures worked out from the old settings.
        mine = await _client_with_plant()
        await snapshots.refresh_all(kpis=True)
        await _tag_stored_copies(mine["plant_id"])
        async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
            await s.execute(text("""
                UPDATE plant_snapshots SET plant_edited_at = computed_at + interval '1 second'
                 WHERE plant_id = :p
            """), {"p": mine["plant_id"]})
        async with await _login(mine["email"]) as http:
            assert await _served_stored(http, mine["plant_id"]) == {
                "kpis": False, "dashboard": False}
            fleet = (await http.get("/plants/snapshots")).json()
            row = next(r for r in fleet["plants"] if r["plant_id"] == mine["plant_id"])
            assert row["kpis"].get("stored_copy") is not True
            assert row["dashboard"].get("stored_copy") is not True

    async def test_a_refused_edit_leaves_the_copies_in_place(self) -> None:
        mine = await _client_with_plant()
        await snapshots.refresh_all(kpis=True)
        await _tag_stored_copies(mine["plant_id"])
        async with await _login(mine["email"]) as http:
            refused = await http.patch(f"/plants/{mine['plant_id']}",
                                       json={"region_code": "NO-SUCH-REGION"})
            assert refused.status_code == 422, refused.text
            assert await _served_stored(http, mine["plant_id"]) == {
                "kpis": True, "dashboard": True}

    async def test_an_edit_to_a_devices_bindings_finds_its_plant(self) -> None:
        mine = await _client_with_plant()
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            device_id = (await s.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name)
                SELECT :c, :p, dm.id, 'INV-1', 'INV-1'
                  FROM device_models dm JOIN device_types dt ON dt.id = dm.device_type_id
                 WHERE dt.code = 'INVERTER' ORDER BY dm.id LIMIT 1
                RETURNING id
            """), {"c": mine["client_id"], "p": mine["plant_id"]})).scalar_one()
        await snapshots.refresh_all(kpis=True)
        await _tag_stored_copies(mine["plant_id"])
        async with await _login(mine["email"]) as http:
            rebound = await http.post(f"/devices/{device_id}/bindings/from-model")
            assert rebound.status_code == 200, rebound.text
            assert await _served_stored(http, mine["plant_id"]) == {
                "kpis": False, "dashboard": False}

    async def test_another_plants_copies_are_left_alone(self) -> None:
        mine, theirs = await _client_with_plant(), await _client_with_plant()
        await snapshots.refresh_all(kpis=True)
        await _tag_stored_copies(theirs["plant_id"])
        async with await _login(mine["email"]) as http:
            edit = await http.patch(f"/plants/{mine['plant_id']}",
                                    json={"dc_capacity_kwp": 900})
            assert edit.status_code == 200, edit.text
        async with await _login(theirs["email"]) as http:
            assert await _served_stored(http, theirs["plant_id"]) == {
                "kpis": True, "dashboard": True}


class TestSchedulerReads:
    async def test_the_scheduler_role_may_read_the_minute_tiers(self) -> None:
        # The health sweep now sums agg_15m; without 0037 this was "permission
        # denied" inside a worker that logs and carries on.
        async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
            await s.execute(text("SELECT count(*) FROM agg_15m_v WHERE false"))
            await s.execute(text("SELECT count(*) FROM agg_1m_v WHERE false"))


class TestLeaderLock:
    async def test_a_second_copy_waits_until_the_first_lets_go(self) -> None:
        class Beat:
            def __init__(self) -> None:
                self.extra: dict[str, Any] = {}

            def cycle(self) -> None: ...
            def failed(self, _e: object) -> None: ...
            async def publish(self) -> None: ...

        name = f"test-{uuid.uuid4().hex[:6]}"
        first, second = Leadership(name, Beat()), Leadership(name, Beat())
        stop = asyncio.Event()
        assert await first.acquire(stop)
        waiting = asyncio.create_task(second.acquire(stop))
        await asyncio.sleep(0.5)
        assert not waiting.done(), "the second copy took a lock the first still holds"
        assert second.heartbeat.extra["role"] == "standby"
        await first.release()
        assert await asyncio.wait_for(waiting, timeout=10)
        assert second.heartbeat.extra["role"] == "active"
        await second.release()


class TestAggregateRefresh:
    async def test_a_reading_added_to_a_materialised_minute_is_aggregated(self) -> None:
        at = (datetime.now(UTC) - timedelta(days=3)).replace(second=0, microsecond=0)
        device_id = 900_000_000 + uuid.uuid4().int % 1_000_000
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            await s.execute(text("""
                INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
                VALUES (:t, 1, :d, 1, 42.0, 0)
            """), {"t": at, "d": device_id})
        await refresh_aggregates(at - timedelta(hours=1), at + timedelta(hours=1))
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            count = (await s.execute(text("""
                SELECT sum(sample_count) FROM agg_1m WHERE device_id = :d
            """), {"d": device_id})).scalar()
        assert count == 1
