"""An Alarm that fails to save is retried, never forgotten.

The worker used to move a rule's state to "open" *before* writing the Alarm.
One failed write — a database restart, a lost connection — left the worker
believing the Alarm existed, so it never tried again, and nobody was told.
The state now moves only after the write, and an entry is retried until it is
handled. No database here: the write is a fake that fails, then succeeds.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest
import sqlalchemy.exc

from solarcms.domain.alarm_logic import Action, AlarmRuleSpec
from solarcms.workers import alarm as alarm_module
from solarcms.workers.alarm import AlarmWorker, readings_were_trimmed
from solarcms.workers.transient import is_transient

TRIP = AlarmRuleSpec(
    rule_id=1, code="VCB_TRIP", tag_id=10, operator="is_true", threshold=None,
    threshold_high=None, clear_threshold=None, duration_s=0, severity="high",
    scope_type="global", scope_id=None, classification="equipment", client_id=None,
)


def entry(value: float) -> dict[str, str]:
    return {"device_id": "5", "tag_id": "10", "value": str(value), "quality": "0",
            "client_id": "1", "plant_id": "2", "at": datetime.now(UTC).isoformat()}


@pytest.fixture
def worker(monkeypatch: pytest.MonkeyPatch) -> AlarmWorker:
    w = AlarmWorker()

    async def rules(_device_id: int) -> list[AlarmRuleSpec]:
        return [TRIP]

    monkeypatch.setattr(w, "_rules_for", rules)
    return w


def database_restarting() -> Exception:
    return sqlalchemy.exc.OperationalError("INSERT", {}, ConnectionResetError("reset"))


async def test_a_failed_write_leaves_the_state_where_it_was(worker: AlarmWorker,
                                                            monkeypatch: Any) -> None:
    async def failing(*_a: Any, **_k: Any) -> str | None:
        raise database_restarting()

    monkeypatch.setattr(worker, "_apply", failing)
    with pytest.raises(sqlalchemy.exc.OperationalError):
        await worker.handle_entry(entry(1.0))
    assert not worker._state.get((1, 5), alarm_module.RuleState()).is_open


async def test_the_retry_raises_the_alarm_the_failure_missed(worker: AlarmWorker,
                                                             monkeypatch: Any) -> None:
    calls: list[Action] = []

    async def flaky(action: Any, *_a: Any) -> str | None:
        calls.append(action.action)
        if len(calls) == 1:
            raise database_restarting()
        return "Alarm opened (VCB_TRIP)"

    async def no_wait(waited: Any, *_a: Any, **_k: Any) -> None:
        waited.close()  # the backoff is not what is under test

    monkeypatch.setattr(worker, "_apply", flaky)
    monkeypatch.setattr(alarm_module.asyncio, "wait_for", no_wait)
    assert await worker._handle_with_retry("1-0", entry(1.0))
    assert calls == [Action.OPEN, Action.OPEN], "the second attempt must open it again"
    assert worker._state[(1, 5)].is_open
    assert worker.stats["retries"] == 1


async def test_an_entry_that_fails_on_its_own_is_skipped(worker: AlarmWorker,
                                                         monkeypatch: Any) -> None:
    async def broken(*_a: Any, **_k: Any) -> str | None:
        raise ValueError("a bug, not an outage")

    monkeypatch.setattr(worker, "_apply", broken)
    assert await worker._handle_with_retry("1-0", entry(1.0))
    assert worker.stats["skipped"] == 1


async def test_stopping_mid_retry_leaves_the_entry_pending(worker: AlarmWorker,
                                                           monkeypatch: Any) -> None:
    async def failing(*_a: Any, **_k: Any) -> str | None:
        raise database_restarting()

    monkeypatch.setattr(worker, "_apply", failing)
    worker._stopping.set()
    assert not await worker._handle_with_retry("1-0", entry(1.0))


class TestTransient:
    def test_infrastructure_failures_are_transient(self) -> None:
        assert is_transient(ConnectionRefusedError())
        assert is_transient(TimeoutError())
        assert is_transient(database_restarting())

    def test_a_wrapped_cause_is_followed(self) -> None:
        try:
            try:
                raise ConnectionResetError("peer reset")
            except ConnectionResetError as inner:
                raise RuntimeError("while writing") from inner
        except RuntimeError as outer:
            assert is_transient(outer)

    def test_a_bug_is_not_transient(self) -> None:
        assert not is_transient(ValueError("bad"))
        assert not is_transient(KeyError("device_id"))


class TestTrimmed:
    def test_a_position_before_the_oldest_entry_lost_readings(self) -> None:
        assert readings_were_trimmed("1700000000000-5", "1700000100000-0")

    def test_a_position_inside_the_stream_lost_nothing(self) -> None:
        assert not readings_were_trimmed("1700000200000-0", "1700000100000-0")

    def test_a_group_that_never_read_lost_nothing_it_knew_of(self) -> None:
        assert not readings_were_trimmed("0-0", "1700000100000-0")
        assert not readings_were_trimmed(None, None)
