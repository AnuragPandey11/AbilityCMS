"""Alarm email subscriptions: the screen's API, and who the sender emails.

Two halves, because the rule is enforced twice. The API refuses a subscription
that would email someone about a Plant they cannot see; the sender
(`queue_alarm_notifications`, run as the scheduler role exactly as the alarm
worker and health sweep run it) re-checks at sending time, because access
changes after a subscription is made and rows can still be inserted by hand.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.config import get_settings
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import scoped_session
from solarcms.services.notifications import queue_alarm_notifications
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]

PASSWORD = "AlarmEmails!12345"


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


@dataclass
class Fleet:
    client_id: int
    other_client_id: int
    plant_1: int
    plant_2: int
    admin: int
    admin_email: str
    employee: int
    other_admin: int
    other_admin_email: str


async def _user(s, email: str, client_id: int, role: str) -> int:  # type: ignore[no-untyped-def]
    user_id = int((await s.execute(text("""
        INSERT INTO users (email, password_hash, full_name)
        VALUES (:e, :h, :n) RETURNING id
    """), {"e": email, "h": hash_password(PASSWORD), "n": email})).scalar_one())
    await s.execute(text("""
        INSERT INTO memberships (user_id, client_id, role_id)
        SELECT :u, :c, id FROM roles WHERE code = :r
    """), {"u": user_id, "c": client_id, "r": role})
    return user_id


async def _fleet() -> Fleet:
    """A Client with two Plants, its admin, an Employee assigned Plant 1 only,
    and a second Client with an admin of its own."""
    sfx = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        clients: list[int] = []
        for n in (1, 2):
            clients.append(int((await s.execute(text("""
                INSERT INTO clients (code, name, status) VALUES (:c, :n, 'active')
                RETURNING id"""), {"c": f"mail-{sfx}-{n}", "n": f"Mail {n}"})).scalar_one()))
        client_id, other = clients
        plants: list[int] = []
        for n in (1, 2):
            plants.append(int((await s.execute(text("""
                INSERT INTO plants (client_id, code, name, status)
                VALUES (:c, :code, :name, 'active') RETURNING id
            """), {"c": client_id, "code": f"MAIL-{sfx}-P{n}",
                   "name": f"Mail Plant {n}"})).scalar_one()))
        plant_1, plant_2 = plants
        admin_email = f"mail-admin-{sfx}@test.local"
        admin = await _user(s, admin_email, client_id, "admin")
        employee = await _user(s, f"mail-emp-{sfx}@test.local", client_id, "employee")
        await s.execute(text("""
            INSERT INTO user_plant_access (membership_id, plant_id)
            SELECT m.id, :p FROM memberships m WHERE m.user_id = :u AND m.client_id = :c
        """), {"p": plant_1, "u": employee, "c": client_id})
        other_email = f"mail-other-{sfx}@test.local"
        other_admin = await _user(s, other_email, other, "admin")
    return Fleet(client_id, other, plant_1, plant_2, admin, admin_email, employee,
                 other_admin, other_email)


@asynccontextmanager
async def _http(email: str) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as http:
        token = (await http.post("/auth/login",
                                 json={"email": email, "password": PASSWORD})).json()
        http.headers["Authorization"] = f"Bearer {token['access_token']}"
        yield http


async def test_a_client_admin_manages_subscriptions_within_what_each_user_can_see() -> None:
    f = await _fleet()
    async with _http(f.admin_email) as http:
        options = (await http.get("/notification-subscriptions/options")).json()
        members = {m["user_id"]: m for m in options["members"]}
        assert members[f.admin]["sees_every_plant"] is True
        assert members[f.employee]["plant_ids"] == [f.plant_1]
        assert [c["code"] for c in options["channels"] if c["available"]] == ["email"]

        # Every Plant, for someone who can see one: refused, with the reason.
        r = await http.post("/notification-subscriptions",
                            json={"user_id": f.employee, "plant_id": None})
        assert r.status_code == 422 and "Plants they cannot see" in r.text
        r = await http.post("/notification-subscriptions",
                            json={"user_id": f.employee, "plant_id": f.plant_2})
        assert r.status_code == 422 and "cannot see that Plant" in r.text
        # Another Client's User is not ours to subscribe.
        r = await http.post("/notification-subscriptions",
                            json={"user_id": f.other_admin})
        assert r.status_code == 422 and "not a member" in r.text

        emp = await http.post("/notification-subscriptions", json={
            "user_id": f.employee, "plant_id": f.plant_1, "min_severity": "high"})
        assert emp.status_code == 201, emp.text
        everything = await http.post("/notification-subscriptions",
                                     json={"user_id": f.admin})
        assert everything.status_code == 201, everything.text
        again = await http.post("/notification-subscriptions",
                                json={"user_id": f.admin})
        assert again.status_code == 409

        rows = (await http.get("/notification-subscriptions")).json()
        assert {r["id"] for r in rows} == {emp.json()["id"], everything.json()["id"]}
        assert all(r["sending"] for r in rows)
        high = next(r for r in rows if r["id"] == emp.json()["id"])
        assert high["receives"] == ["high", "critical"]

        paused = await http.patch(f"/notification-subscriptions/{emp.json()['id']}",
                                  json={"enabled": False})
        assert paused.status_code == 200 and paused.json()["enabled"] is False
        row = next(r for r in (await http.get("/notification-subscriptions")).json()
                   if r["id"] == emp.json()["id"])
        assert row["sending"] is False and row["not_sent_reason"] == "Paused."
        cleared = await http.patch(f"/notification-subscriptions/{emp.json()['id']}",
                                   json={"min_severity": None})
        assert cleared.status_code == 422

    # Another Client's admin can neither see nor touch them.
    async with _http(f.other_admin_email) as http:
        assert (await http.get("/notification-subscriptions")).json() == []
        target = f"/notification-subscriptions/{everything.json()['id']}"
        assert (await http.patch(target, json={"enabled": False})).status_code == 404
        assert (await http.delete(target)).status_code == 404

    async with _http(f.admin_email) as http:
        gone = await http.delete(f"/notification-subscriptions/{everything.json()['id']}")
        assert gone.status_code == 204

    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        actions = (await s.execute(text("""
            SELECT action FROM audit_log
             WHERE client_id = :c AND entity_type = 'notification_subscriptions'
        """), {"c": f.client_id})).scalars().all()
    assert sorted(set(actions)) == ["notification_subscription.create",
                                    "notification_subscription.delete",
                                    "notification_subscription.update"]


async def _alarm(s, client_id: int, plant_id: int | None) -> int:  # type: ignore[no-untyped-def]
    rule_id = (await s.execute(text("""
        INSERT INTO alarm_rules (client_id, code, name, scope_type, operator,
                                 threshold, duration_s, severity)
        VALUES (:c, :code, 'Mail test', 'global', 'gt', 1, 0, 'high') RETURNING id
    """), {"c": client_id, "code": f"MAIL_{uuid.uuid4().hex[:6]}"})).scalar_one()
    return int((await s.execute(text("""
        INSERT INTO alarms (client_id, rule_id, plant_id, state, severity, message,
                            opened_at)
        VALUES (:c, :r, :p, 'active', 'high', 'mail test', now()) RETURNING id
    """), {"c": client_id, "r": rule_id, "p": plant_id})).scalar_one())


async def _recipients(client_id: int, plant_id: int | None) -> set[int]:
    """Who the sender queues an email for, run as the alarm worker runs it."""
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        alarm_id = await _alarm(s, client_id, plant_id)
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        await queue_alarm_notifications(s, alarm_id=alarm_id, client_id=client_id,
                                        plant_id=plant_id, severity="high",
                                        message="mail test")
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        return set((await s.execute(text(
            "SELECT recipient_user_id FROM notification_log WHERE alarm_id = :a"
        ), {"a": alarm_id})).scalars().all())


async def test_the_sender_emails_nobody_about_a_plant_they_cannot_see() -> None:
    f = await _fleet()
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        leaver = await _user(s, f"mail-leaver-{uuid.uuid4().hex[:6]}@test.local",
                             f.client_id, "admin")
        disabled = await _user(s, f"mail-off-{uuid.uuid4().hex[:6]}@test.local",
                               f.client_id, "admin")
        # Inserted by hand, as a database administrator would have: Client-wide
        # for everyone, including the Employee the API would have refused.
        for user_id in (f.admin, f.employee, leaver, disabled):
            await s.execute(text("""
                INSERT INTO notification_subscriptions (client_id, user_id, channel,
                                                        min_severity)
                VALUES (:c, :u, 'email', 'medium')
            """), {"c": f.client_id, "u": user_id})
        await s.execute(text(
            "DELETE FROM memberships WHERE user_id = :u AND client_id = :c"
        ), {"u": leaver, "c": f.client_id})
        await s.execute(text("UPDATE users SET is_active = false WHERE id = :u"),
                        {"u": disabled})

    # Plant 1: the admin, and the Employee who is assigned it.
    assert await _recipients(f.client_id, f.plant_1) == {f.admin, f.employee}
    # Plant 2: the admin only — never the Employee, whatever the row says.
    assert await _recipients(f.client_id, f.plant_2) == {f.admin}
    # No Plant at all: only those who see every Plant.
    assert await _recipients(f.client_id, None) == {f.admin}


async def test_a_test_email_goes_through_the_real_queue(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    f = await _fleet()
    async with _http(f.admin_email) as http:
        sub = (await http.post("/notification-subscriptions",
                               json={"user_id": f.admin})).json()
        target = f"/notification-subscriptions/{sub['id']}/test"

        monkeypatch.setattr(get_settings(), "smtp_url", None)
        refused = await http.post(target)
        assert refused.status_code == 409 and "No email server" in refused.text

        monkeypatch.setattr(get_settings(), "smtp_url", "smtp://mail.test.local:587")
        sent = await http.post(target)
        assert sent.status_code == 200, sent.text
        row = next(r for r in (await http.get("/notification-subscriptions")).json()
                   if r["id"] == sub["id"])
        assert row["last_notification"]["status"] == "queued"
        assert row["last_notification"]["subject"] == "[TEST] SolarCMS alarm email"
