"""Phase 8 acceptance: escalation fires on a timer, gated by severity.

    Threshold breach opens exactly one Alarm; escalates on timer.

The "exactly one Alarm" half is asserted in `test_alarming.py` and by the partial
unique index. This covers the timer half, which the scheduler owns.

⚠ Escalation is driven by named people (`notify_user_id`). Tender §23's example
escalates Operator → Plant Manager → Management, but the CONFIRMED four-role model
(F-7) has only Admin and Employee client-side, so three levels cannot be expressed
by role alone (MASTER §3.6, OPEN-2). `notify_role_id` remains a coarse fallback and
is covered here too.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.workers.scheduler import fire_due_escalations
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]


async def _alarm_awaiting_escalation(
    *, severity: str = "high", min_severity: str = "high",
    opened_minutes_ago: int = 30, use_role: bool = False,
) -> tuple[int, int, int]:
    """An active, unacknowledged Alarm with a 3-step policy attached.

    Returns (client_id, alarm_id, user_id).
    """
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:code, 'Esc', 'active')
            RETURNING id
        """), {"code": f"esc-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status)
            VALUES (:c, :code, 'Esc Plant', 'active') RETURNING id
        """), {"c": client_id, "code": f"ESC-{suffix}"})).scalar_one()
        user_id = (await s.execute(text("""
            INSERT INTO users (email, password_hash, full_name)
            VALUES (:e, 'x', 'Escalation Target') RETURNING id
        """), {"e": f"esc-{suffix}@test.local"})).scalar_one()
        role_id = (await s.execute(
            text("SELECT id FROM roles WHERE code = 'admin'"))).scalar_one()
        await s.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            VALUES (:u, :c, :r)
        """), {"u": user_id, "c": client_id, "r": role_id})

        rule_id = (await s.execute(text("""
            INSERT INTO alarm_rules (client_id, code, name, scope_type, operator,
                                     threshold, duration_s, severity)
            VALUES (:c, 'ESC_TEST', 'Escalation Test', 'global', 'gt', 1, 0, :sev)
            RETURNING id
        """), {"c": client_id, "sev": severity})).scalar_one()

        opened_at = datetime.now(UTC) - timedelta(minutes=opened_minutes_ago)
        alarm_id = (await s.execute(text("""
            INSERT INTO alarms (client_id, rule_id, plant_id, state, severity,
                                opened_at, message, escalation_level)
            VALUES (:c, :r, :p, 'active', :sev, :opened, 'test breach', 0)
            RETURNING id
        """), {"c": client_id, "r": rule_id, "p": plant_id, "sev": severity,
               "opened": opened_at})).scalar_one()

        policy_id = (await s.execute(text("""
            INSERT INTO escalation_policies (client_id, name, scope_type, min_severity,
                                             enabled)
            VALUES (:c, 'Test Policy', 'client', :min_sev, true) RETURNING id
        """), {"c": client_id, "min_sev": min_severity})).scalar_one()
        # Tender §23's own example: immediate, then 10 minutes, then 20.
        for level, delay in ((1, 0), (2, 10), (3, 20)):
            await s.execute(text("""
                INSERT INTO escalation_steps (policy_id, level, delay_minutes,
                                              notify_user_id, notify_role_id, channel)
                VALUES (:p, :level, :delay, :user_id, :role_id, 'email')
            """), {"p": policy_id, "level": level, "delay": delay,
                   "user_id": None if use_role else user_id,
                   "role_id": role_id if use_role else None})
    return client_id, alarm_id, user_id


async def _alarm_level(alarm_id: int) -> int:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        return int((await s.execute(
            text("SELECT escalation_level FROM alarms WHERE id = :id"),
            {"id": alarm_id})).scalar_one())


async def _notifications_for(alarm_id: int) -> list[tuple[int | None, str, str | None]]:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        rows = (await s.execute(text("""
            SELECT escalation_level, delivery_status, failure_reason
              FROM notification_log WHERE alarm_id = :id ORDER BY id
        """), {"id": alarm_id})).all()
    return [(r.escalation_level, r.delivery_status, r.failure_reason) for r in rows]


class TestEscalationTimer:
    async def test_an_unacknowledged_alarm_escalates_one_level_per_run(self) -> None:
        _client, alarm_id, _user = await _alarm_awaiting_escalation(
            opened_minutes_ago=30)

        assert await _alarm_level(alarm_id) == 0
        assert await fire_due_escalations() >= 1
        assert await _alarm_level(alarm_id) == 1, "level 1 (delay 0) should have fired"

        # One level per run, not a jump straight to the top: each rung is a
        # separate notification with its own recipient.
        await fire_due_escalations()
        assert await _alarm_level(alarm_id) == 2
        await fire_due_escalations()
        assert await _alarm_level(alarm_id) == 3

    async def test_a_recent_alarm_does_not_skip_ahead(self) -> None:
        """Only steps whose delay has elapsed fire."""
        _client, alarm_id, _user = await _alarm_awaiting_escalation(
            opened_minutes_ago=1)
        await fire_due_escalations()
        assert await _alarm_level(alarm_id) == 1  # delay 0 is due
        await fire_due_escalations()
        # Level 2 needs 10 minutes; the Alarm is 1 minute old.
        assert await _alarm_level(alarm_id) == 1

    async def test_a_low_severity_alarm_never_escalates(self) -> None:
        """Gated by min_severity, however long it sits (MASTER §6.4)."""
        _client, alarm_id, _user = await _alarm_awaiting_escalation(
            severity="low", min_severity="high", opened_minutes_ago=600)
        await fire_due_escalations()
        assert await _alarm_level(alarm_id) == 0
        assert await _notifications_for(alarm_id) == []

    async def test_an_acknowledged_alarm_stops_escalating(self) -> None:
        _client, alarm_id, _user = await _alarm_awaiting_escalation(
            opened_minutes_ago=60)
        await fire_due_escalations()
        assert await _alarm_level(alarm_id) == 1

        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            await s.execute(text("""
                UPDATE alarms SET state = 'acknowledged', acknowledged_at = now()
                 WHERE id = :id
            """), {"id": alarm_id})

        await fire_due_escalations()
        assert await _alarm_level(alarm_id) == 1, (
            "an acknowledged Alarm must not keep escalating"
        )


class TestEscalationRecipients:
    async def test_each_step_writes_a_notification_record(self) -> None:
        """Tender §24: one row per delivery attempt, per recipient, per channel."""
        _client, alarm_id, _user = await _alarm_awaiting_escalation(
            opened_minutes_ago=30)
        await fire_due_escalations()
        records = await _notifications_for(alarm_id)
        assert len(records) == 1
        level, status, reason = records[0]
        assert level == 1
        # No SMTP is configured in the test environment, so the honest outcome is
        # a recorded failure — not a row claiming the mail went out.
        assert status == "failed"
        assert reason is not None and "SMTP" in reason

    async def test_a_role_step_notifies_every_holder_of_that_role(self) -> None:
        """The coarse fallback when a Step names a role rather than a person."""
        _client, alarm_id, _user = await _alarm_awaiting_escalation(
            opened_minutes_ago=30, use_role=True)
        await fire_due_escalations()
        assert len(await _notifications_for(alarm_id)) >= 1
