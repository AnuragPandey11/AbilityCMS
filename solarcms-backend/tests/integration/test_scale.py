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
