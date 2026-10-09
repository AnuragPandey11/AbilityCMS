"""Ingest acknowledges a QoS 1 message only after the batch holding it commits.

paho acknowledged on arrival and ingest saved up to two seconds later, so a
crash — or a database error, which ended the process — lost what was buffered,
and the broker had been told it was delivered. These pin the rules that
replaced it: acknowledge after commit and in arrival order, keep the buffer and
the acknowledgements on a failed write, never send an old connection's message
ids, and store once what the broker resends after a reconnect.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

from solarcms.config import get_settings
from solarcms.workers import ingest as ingest_module
from solarcms.workers.delivery import PendingAck, RedeliveryFilter, fingerprint
from solarcms.workers.ingest import Batch, IngestWorker
from tests.unit.test_ingest_flush import FakeHeartbeat, FakePool


class FakePaho:
    def __init__(self, connected: bool = True) -> None:
        self.acked: list[int] = []
        self.connected = connected

    def ack(self, mid: int, qos: int) -> int:
        if not self.connected:
            return 4  # MQTT_ERR_NO_CONN
        self.acked.append(mid)
        return 0


@pytest.fixture
def worker(monkeypatch: pytest.MonkeyPatch) -> tuple[IngestWorker, FakePool, FakePaho]:
    published: list[list[dict[str, Any]]] = []

    async def stream(entries: list[dict[str, Any]]) -> None:
        published.append(entries)

    monkeypatch.setattr(ingest_module.live, "publish_to_alarm_stream", stream)
    w = IngestWorker.__new__(IngestWorker)
    w.settings = get_settings()
    w.batch = Batch()
    w._flush_lock = asyncio.Lock()
    w._stopping = asyncio.Event()
    w.stats = {"stored": 0, "flushes": 0, "acknowledged": 0, "retries": 0}
    w.heartbeat = FakeHeartbeat()  # type: ignore[assignment]
    paho = FakePaho()
    w._mqtt = paho
    w._generation = 1
    w._redelivery = RedeliveryFilter()
    w._stream_backlog = []
    pool = FakePool()
    w._pool = pool  # type: ignore[assignment]
    return w, pool, paho


def receive(w: IngestWorker, mid: int, *, rows: bool = True) -> None:
    if rows:
        w.batch.readings.append((mid,))
        w.batch.raw.append((mid,))
    w.batch.acks.append(PendingAck(w._generation, mid, 1, fingerprint("t", str(mid).encode())))


class TestAcknowledgeAfterCommit:
    async def test_nothing_is_acknowledged_before_the_commit(self, worker: Any) -> None:
        w, pool, paho = worker
        receive(w, 1)
        receive(w, 2)
        assert paho.acked == []
        await w.flush()
        assert pool.written["readings"] == [(1,), (2,)]
        assert paho.acked == [1, 2]

    async def test_a_message_that_wrote_nothing_is_still_acknowledged_in_order(
            self, worker: Any) -> None:
        w, _pool, paho = worker
        receive(w, 1)
        receive(w, 2, rows=False)  # every Tag throttled
        receive(w, 3)
        await w.flush()
        assert paho.acked == [1, 2, 3]

    async def test_a_failed_write_acknowledges_nothing_and_keeps_everything(
            self, worker: Any) -> None:
        w, pool, paho = worker
        receive(w, 1)
        pool.fail = True
        with pytest.raises(ConnectionError):
            await w.flush()
        assert paho.acked == []
        assert [a.mid for a in w.batch.acks] == [1]
        pool.fail = False
        await w.flush()
        assert paho.acked == [1]
        assert pool.written["readings"] == [(1,)]

    async def test_flush_with_retry_waits_out_the_database(
            self, worker: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        w, pool, paho = worker
        receive(w, 1)
        pool.fail = True
        calls = 0

        real_sleep = asyncio.sleep

        async def no_sleep(seconds: float) -> None:
            nonlocal calls
            if seconds == 0:  # the fake COPY's own yields
                await real_sleep(0)
                return
            calls += 1
            if calls == 2:
                pool.fail = False

        monkeypatch.setattr(ingest_module.asyncio, "sleep", no_sleep)
        await w._flush_with_retry()
        assert pool.written["readings"] == [(1,)]
        assert paho.acked == [1]
        assert w.stats["retries"] == 2

    def test_a_full_window_of_unacknowledged_messages_forces_a_flush(
            self, worker: Any) -> None:
        w, _pool, _paho = worker
        settings = get_settings()
        for mid in range(settings.ingest_max_unacked - 1):
            receive(w, mid, rows=False)
        assert not w.batch.should_flush(settings, w.batch.opened_at)
        receive(w, 999, rows=False)
        assert w.batch.should_flush(settings, w.batch.opened_at)


class TestReconnect:
    async def test_buffered_rows_survive_a_lost_connection(self, worker: Any) -> None:
        w, pool, paho = worker
        receive(w, 1)
        w._connection_lost()
        assert w.batch.acks == []  # those ids mean nothing on the next connection
        await w.flush()
        assert pool.written["readings"] == [(1,)]  # QoS 0 or not, never thrown away
        assert paho.acked == []

    async def test_the_resend_of_a_buffered_message_is_not_stored_twice(
            self, worker: Any) -> None:
        w, _pool, _paho = worker
        receive(w, 7)
        w._connection_lost()
        resend = fingerprint("t", b"7")
        assert w._redelivery.is_resend(resend, time.monotonic())
        assert not w._redelivery.is_resend(resend, time.monotonic()), "only once"

    async def test_an_acknowledgement_that_cannot_be_sent_expects_a_resend(
            self, worker: Any) -> None:
        w, _pool, paho = worker
        paho.connected = False
        receive(w, 5)
        await w.flush()
        assert w._redelivery.is_resend(fingerprint("t", b"5"), time.monotonic())

    async def test_an_old_connections_ids_are_never_sent_on_a_new_one(
            self, worker: Any) -> None:
        w, _pool, paho = worker
        receive(w, 5)
        taken = w.batch.take()
        w._generation = 2  # reconnected while that batch was being written
        w._acknowledge(taken.acks)
        assert paho.acked == []
        assert w._redelivery.is_resend(fingerprint("t", b"5"), time.monotonic())


class TestRedeliveryFilter:
    def test_the_expectation_lapses(self) -> None:
        f = RedeliveryFilter(window_s=10)
        pending = PendingAck(1, 1, 1, b"x")
        f.connection_lost([pending], now=100.0)
        assert not f.is_resend(b"x", now=111.0)
        assert f.expected == 0

    def test_two_identical_messages_buffered_expect_two_resends(self) -> None:
        f = RedeliveryFilter()
        f.connection_lost([PendingAck(1, 1, 1, b"x"), PendingAck(1, 2, 1, b"x")], now=0.0)
        assert f.is_resend(b"x", now=1.0)
        assert f.is_resend(b"x", now=1.0)
        assert not f.is_resend(b"x", now=1.0)

    def test_a_message_never_buffered_is_not_a_resend(self) -> None:
        f = RedeliveryFilter()
        f.connection_lost([PendingAck(1, 1, 1, b"x")], now=0.0)
        assert not f.is_resend(b"y", now=1.0)


class TestAlarmEntriesAfterCommit:
    async def test_redis_away_holds_entries_and_never_rewrites_rows(
            self, worker: Any, monkeypatch: pytest.MonkeyPatch) -> None:
        w, pool, paho = worker
        down = True
        sent: list[dict[str, Any]] = []

        async def stream(entries: list[dict[str, Any]]) -> None:
            if down:
                raise ConnectionError("redis away")
            sent.extend(entries)

        monkeypatch.setattr(ingest_module.live, "publish_to_alarm_stream", stream)
        receive(w, 1)
        w.batch.stream_entries.append({"n": 1})
        await w.flush()
        assert paho.acked == [1]
        assert w._stream_backlog == [{"n": 1}]
        down = False
        receive(w, 2)
        w.batch.stream_entries.append({"n": 2})
        await w.flush()
        assert sent == [{"n": 1}, {"n": 2}]
        assert pool.written["readings"] == [(1,), (2,)], "no row written twice"
