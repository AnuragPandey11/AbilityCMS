"""Changes that must take effect, and failures that must not lose anything.

8 Oct 2026: a Tag's range edited through the API reached no Device already set
up and was undone by the next `cli seed`; and a notification was sent once,
inside the transaction raising its Alarm, and never retried. These drive the
real database (the RLS, the grants, the casts) — the unit tests cannot.
"""

from __future__ import annotations

import uuid
from typing import Any

import httpx
import pytest
from httpx import ASGITransport
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import scoped_session
from solarcms.services import notifications
from solarcms.services.seed import seed_catalog
from solarcms.services.tag_registry import default_tag_rows
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]


def _app():  # type: ignore[no-untyped-def]
    from solarcms.api.main import create_app
    return create_app()


async def _super_admin() -> httpx.AsyncClient:
    suffix = uuid.uuid4().hex[:8]
    email = f"reliab-{suffix}@test.local"
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name, platform_role)
            VALUES (:e, :h, 'Reliability Admin', 'super_admin')
        """), {"e": email, "h": hash_password("ReliabPass!123")})
    async with httpx.AsyncClient(transport=ASGITransport(app=_app()),
                                 base_url="http://test") as opener:
        login = await opener.post("/auth/login",
                                  json={"email": email, "password": "ReliabPass!123"})
    assert login.status_code == 200, login.text
    return httpx.AsyncClient(
        transport=ASGITransport(app=_app()), base_url="http://test",
        headers={"Authorization": f"Bearer {login.json()['access_token']}"})


async def _two_bound_devices(tag_code: str, *, tuned_max: float) -> dict[str, Any]:
    """Two Devices bound to `tag_code`: one on the Tag's own range, one tuned."""
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Reliability', 'active')
            RETURNING id"""), {"c": f"reliab-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status)
            VALUES (:c, :code, 'R Plant', 'active') RETURNING id
        """), {"c": client_id, "code": f"R-{suffix}"})).scalar_one()
        model_id = (await s.execute(text(
            "SELECT id FROM device_models ORDER BY id LIMIT 1"))).scalar_one()
        tag = (await s.execute(text(
            "SELECT id, valid_min, valid_max FROM tags WHERE code = :c"),
            {"c": tag_code})).one()
        devices = []
        for code, vmax in (("PLAIN", tag.valid_max), ("TUNED", tuned_max)):
            device_id = (await s.execute(text("""
                INSERT INTO devices (client_id, plant_id, device_model_id, code, name)
                VALUES (:c, :p, :m, :code, :name) RETURNING id
            """), {"c": client_id, "p": plant_id, "m": model_id, "code": code,
                   "name": code})).scalar_one()
            await s.execute(text("""
                INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                                 valid_min, valid_max)
                VALUES (:c, :d, :t, 'K', :vmin, :vmax)
            """), {"c": client_id, "d": device_id, "t": tag.id,
                   "vmin": tag.valid_min, "vmax": vmax})
            devices.append(device_id)
    return {"tag_id": tag.id, "plain": devices[0], "tuned": devices[1]}


async def _binding_max(device_id: int, tag_id: int) -> float:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        return float((await s.execute(text("""
            SELECT valid_max FROM device_tag_bindings WHERE device_id = :d AND tag_id = :t
        """), {"d": device_id, "t": tag_id})).scalar_one())


async def _tag(code: str) -> Any:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        return (await s.execute(text(
            "SELECT id, valid_max, edited_fields FROM tags WHERE code = :c"),
            {"c": code})).one()


class TestTagEdits:
    """WIND_DIRECTION: a Tag nothing else in the suite depends on."""

    async def test_a_range_edit_reaches_untuned_devices_and_survives_the_seed(self) -> None:
        code = "WIND_DIRECTION"
        default_max = default_tag_rows()[code]["valid_max"]
        fixture = await _two_bound_devices(code, tuned_max=999.0)
        http = await _super_admin()
        try:
            async with http:
                response = await http.patch(f"/catalog/tags/{fixture['tag_id']}",
                                            json={"valid_max": 720.0})
                assert response.status_code == 200, response.text
                body = response.json()
                assert body["valid_max"] == 720.0
                assert "valid_max" in body["edited_fields"]
                assert body["bindings_kept"] >= 1  # the tuned one, at least

                assert await _binding_max(fixture["plain"], fixture["tag_id"]) == 720.0
                assert await _binding_max(fixture["tuned"], fixture["tag_id"]) == 999.0

                # The upgrade steps run the seed; an edited field must survive it.
                async with scoped_session(SecurityContext.platform(0), role=None) as s:
                    await seed_catalog(s)
                assert (await _tag(code)).valid_max == 720.0

                # Asking for the default back hands the field to the seed again,
                # and the Devices that followed the edit follow it back.
                response = await http.patch(f"/catalog/tags/{fixture['tag_id']}",
                                            json={"reset_fields": ["valid_max"]})
                assert response.status_code == 200, response.text
                assert response.json()["valid_max"] == default_max
                assert "valid_max" not in response.json()["edited_fields"]
                assert await _binding_max(fixture["plain"], fixture["tag_id"]) == default_max
                assert await _binding_max(fixture["tuned"], fixture["tag_id"]) == 999.0
        finally:
            async with scoped_session(SecurityContext.platform(0), role=None) as s:
                await s.execute(text("""
                    UPDATE tags SET valid_max = :m, edited_fields = '{}' WHERE code = :c
                """), {"m": default_max, "c": code})

    async def test_a_required_field_cannot_be_cleared(self) -> None:
        tag = await _tag("WIND_DIRECTION")
        async with await _super_admin() as http:
            response = await http.patch(f"/catalog/tags/{tag.id}", json={"unit": None})
        assert response.status_code == 422


class TestNotificationQueue:
    async def _queued(self, channel: str = "email") -> int:
        suffix = uuid.uuid4().hex[:8]
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            client_id = (await s.execute(text("""
                INSERT INTO clients (code, name, status) VALUES (:c, 'Notify', 'active')
                RETURNING id"""), {"c": f"notify-{suffix}"})).scalar_one()
        async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
            return await notifications.queue_notification(
                s, client_id=client_id, channel=channel,  # type: ignore[arg-type]
                message="test", subject="test")

    async def _row(self, notification_id: int) -> Any:
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            return (await s.execute(text("""
                SELECT delivery_status, attempts, failure_reason, next_attempt_at, sent_at
                  FROM notification_log WHERE id = :id"""), {"id": notification_id})).one()

    async def test_a_failure_that_may_pass_is_retried_later(
            self, monkeypatch: pytest.MonkeyPatch) -> None:
        notification_id = await self._queued()

        async def slow_server(*_a: Any) -> notifications.DeliveryResult:
            return notifications.DeliveryResult(False, "failed", "timed out", retryable=True)

        monkeypatch.setattr(notifications, "dispatch", slow_server)
        await notifications.deliver_due()
        row = await self._row(notification_id)
        assert row.delivery_status == "queued"
        assert row.attempts == 1
        assert row.next_attempt_at is not None and row.sent_at is None

        # Not due again yet: a second pass leaves it alone.
        await notifications.deliver_due()
        assert (await self._row(notification_id)).attempts == 1

    async def test_a_sent_notification_records_when(
            self, monkeypatch: pytest.MonkeyPatch) -> None:
        notification_id = await self._queued()

        async def works(*_a: Any) -> notifications.DeliveryResult:
            return notifications.DeliveryResult(True, "sent")

        monkeypatch.setattr(notifications, "dispatch", works)
        await notifications.deliver_due()
        row = await self._row(notification_id)
        assert row.delivery_status == "sent"
        assert row.sent_at is not None and row.next_attempt_at is None
