"""Quick reports (pinned saved custom reports), against a real database.

`PUT /reports/custom/pins` writes `custom_report_pins` as the API role under
FORCE RLS. A policy is not a grant — three workers in this project failed
silently for exactly that — so the test proves a pin is *written and listed*,
not only that the wrong pins are refused: one User's pins are invisible to
another, the cap is a sentence, another Client's report cannot be pinned, and a
deleted report leaves the row.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.schemas.reports import CUSTOM_REPORT_PIN_LIMIT
from tests.conftest import requires_db
from tests.integration.access import grant_admin_tabs

pytestmark = [pytest.mark.asyncio, requires_db]

PASSWORD = "PinsPass!123"

DEFINITION: dict[str, Any] = {
    "plant_ids": [],
    "series": [{"device_id": 1, "tag_code": "AC_ACTIVE_POWER"}],
    "interval_minutes": 15,
    "aggregation": "auto",
    "period": "last_7_days",
}


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _client_with_users(count: int) -> list[str]:
    """A Client and `count` Client Admins in it; returns their emails."""
    suffix = uuid.uuid4().hex[:8]
    emails = []
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Pins', 'active') RETURNING id
        """), {"c": f"pins-{suffix}"})).scalar_one()
        for n in range(count):
            email = f"pins-{suffix}-{n}@test.local"
            user_id = (await s.execute(text("""
                INSERT INTO users (email, password_hash, full_name) VALUES (:e, :h, 'Pins')
                RETURNING id
            """), {"e": email, "h": hash_password(PASSWORD)})).scalar_one()
            await s.execute(text("""
                INSERT INTO memberships (user_id, client_id, role_id)
                SELECT :u, :c, id FROM roles WHERE code = 'admin'
            """), {"u": user_id, "c": client_id})
            emails.append(email)
        await grant_admin_tabs(s)
    return emails


async def _login(email: str) -> httpx.AsyncClient:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test",
                             headers={"Authorization": f"Bearer {login.json()['access_token']}"})


async def _save(http: httpx.AsyncClient, name: str) -> int:
    saved = await http.post("/reports/custom/saved",
                            json={"name": name, "definition": DEFINITION})
    assert saved.status_code == 201, saved.text
    return int(saved.json()["id"])


async def _pins(http: httpx.AsyncClient) -> list[int]:
    listed = await http.get("/reports/custom/saved")
    assert listed.status_code == 200, listed.text
    pinned = [r for r in listed.json() if r["pin_position"] is not None]
    return [r["id"] for r in sorted(pinned, key=lambda r: r["pin_position"])]


class TestQuickReports:
    async def test_a_pin_is_written_listed_in_order_and_audited(self) -> None:
        first, second = await _client_with_users(2)
        async with await _login(first) as http:
            ids = [await _save(http, f"Report {n}") for n in range(3)]
            put = await http.put("/reports/custom/pins", json={"report_ids": [ids[2], ids[0]]})
            assert put.status_code == 200, put.text
            assert put.json() == {"limit": CUSTOM_REPORT_PIN_LIMIT,
                                  "report_ids": [ids[2], ids[0]]}
            assert await _pins(http) == [ids[2], ids[0]]

            # Reordering and replacing are the same single write.
            put = await http.put("/reports/custom/pins", json={"report_ids": [ids[1], ids[2]]})
            assert put.status_code == 200, put.text
            assert await _pins(http) == [ids[1], ids[2]]

        # Shared reports, separate rows: the colleague sees the reports, unpinned.
        async with await _login(second) as http:
            listed = (await http.get("/reports/custom/saved")).json()
            assert {r["id"] for r in listed} >= set(ids)
            assert await _pins(http) == []

        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            audited = (await s.execute(text("""
                SELECT count(*) FROM audit_log a JOIN users u ON u.id = a.user_id
                 WHERE a.action = 'custom_report.pins' AND u.email = :e
            """), {"e": first})).scalar_one()
        assert audited == 2

    async def test_the_cap_and_duplicates_are_refused_with_a_sentence(self) -> None:
        (email,) = await _client_with_users(1)
        async with await _login(email) as http:
            ids = [await _save(http, f"Report {n}")
                   for n in range(CUSTOM_REPORT_PIN_LIMIT + 1)]
            over = await http.put("/reports/custom/pins", json={"report_ids": ids})
            assert over.status_code == 422
            assert f"At most {CUSTOM_REPORT_PIN_LIMIT}" in over.text
            twice = await http.put("/reports/custom/pins",
                                   json={"report_ids": [ids[0], ids[0]]})
            assert twice.status_code == 422
            full = await http.put("/reports/custom/pins",
                                  json={"report_ids": ids[:CUSTOM_REPORT_PIN_LIMIT]})
            assert full.status_code == 200, full.text
            assert await _pins(http) == ids[:CUSTOM_REPORT_PIN_LIMIT]

    async def test_another_clients_report_cannot_be_pinned(self) -> None:
        (owner,) = await _client_with_users(1)
        (stranger,) = await _client_with_users(1)
        async with await _login(owner) as http:
            report_id = await _save(http, "Mine")
        async with await _login(stranger) as http:
            refused = await http.put("/reports/custom/pins", json={"report_ids": [report_id]})
            assert refused.status_code == 422
            assert await _pins(http) == []

    async def test_deleting_a_report_takes_it_out_of_the_row(self) -> None:
        (email,) = await _client_with_users(1)
        async with await _login(email) as http:
            kept, gone = await _save(http, "Kept"), await _save(http, "Gone")
            assert (await http.put("/reports/custom/pins",
                                   json={"report_ids": [gone, kept]})).status_code == 200
            assert (await http.delete(f"/reports/custom/saved/{gone}")).status_code == 204
            assert await _pins(http) == [kept]
            cleared = await http.put("/reports/custom/pins", json={"report_ids": []})
            assert cleared.status_code == 200, cleared.text
            assert await _pins(http) == []
