"""Ingest's buffer: every row written exactly once, however flushes overlap.

Two callers flush — the 2 s timer and the per-message check — and a flush
awaits its COPY. Copying the buffer, awaiting, then clearing it wrote the same
rows twice when the two overlapped, and cleared rows buffered during the await
without writing them. Measured on 7 Oct 2026: one raw row in five on
KULAR_GREEN stored twice, same microsecond, same `seq`. No database here — the
connection is a fake that yields mid-COPY, which is all the race needs.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from solarcms.workers import ingest as ingest_module
from solarcms.workers.ingest import Batch, IngestWorker


class FakeConnection:
    def __init__(self, written: dict[str, list[tuple[Any, ...]]], fail: bool) -> None:
        self.written = written
        self.fail = fail

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[None]:
        yield

    async def copy_records_to_table(
        self, table: str, *, records: list[tuple[Any, ...]], columns: list[str],
    ) -> None:
        # Yield mid-write, as a real COPY does: this is where the race lived.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        if self.fail:
            raise ConnectionError("database went away")
        self.written.setdefault(table, []).extend(records)


class FakePool:
    def __init__(self) -> None:
        self.written: dict[str, list[tuple[Any, ...]]] = {}
        self.fail = False

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[FakeConnection]:
        yield FakeConnection(self.written, self.fail)


class FakeHeartbeat:
    def wrote(self, _what: str) -> None: ...

    def failed(self, _exc: Exception) -> None: ...


@pytest.fixture
def worker(monkeypatch: pytest.MonkeyPatch) -> tuple[IngestWorker, FakePool]:
    async def no_stream(_entries: list[dict[str, Any]]) -> None:
        return None

    monkeypatch.setattr(ingest_module.live, "publish_to_alarm_stream", no_stream)
    # Built without __init__: flushing needs only the buffer, the lock and a pool.
    w = IngestWorker.__new__(IngestWorker)
    w.batch = Batch()
    w._flush_lock = asyncio.Lock()
    w.stats = {"stored": 0, "flushes": 0}
    w.heartbeat = FakeHeartbeat()  # type: ignore[assignment]
    pool = FakePool()
    w._pool = pool  # type: ignore[assignment]
    return w, pool


def buffer(w: IngestWorker, n: int) -> None:
    w.batch.readings.append((n,))
    w.batch.raw.append((n,))


class TestBatch:
    def test_take_hands_everything_over_and_starts_empty(self) -> None:
        batch = Batch(readings=[(1,)], raw=[(1,)], stream_entries=[{"v": 1}])
        taken = batch.take()
        assert taken.readings == [(1,)] and taken.raw == [(1,)]
        assert batch.is_empty and batch.stream_entries == []
        batch.readings.append((2,))
        assert taken.readings == [(1,)], "a row buffered after take() is not in it"

    def test_restore_puts_a_failed_batch_back_in_front(self) -> None:
        batch = Batch(readings=[(1,)], raw=[(1,)])
        taken = batch.take()
        batch.readings.append((2,))
        batch.restore(taken)
        assert batch.readings == [(1,), (2,)]


class TestFlush:
    def test_overlapping_flushes_write_each_row_once(
        self, worker: tuple[IngestWorker, FakePool],
    ) -> None:
        w, pool = worker

        async def scenario() -> None:
            buffer(w, 1)
            buffer(w, 2)
            first = asyncio.create_task(w.flush())
            await asyncio.sleep(0)       # the first flush is now mid-COPY
            buffer(w, 3)                 # a message arrives during it
            second = asyncio.create_task(w.flush())
            await asyncio.gather(first, second)

        asyncio.run(scenario())
        assert sorted(pool.written["readings"]) == [(1,), (2,), (3,)]
        assert sorted(pool.written["mqtt_raw"]) == [(1,), (2,), (3,)]
        assert w.batch.is_empty

    def test_a_failed_write_keeps_its_rows_for_the_next_flush(
        self, worker: tuple[IngestWorker, FakePool],
    ) -> None:
        w, pool = worker

        async def scenario() -> None:
            buffer(w, 1)
            pool.fail = True
            with pytest.raises(ConnectionError):
                await w.flush()
            buffer(w, 2)
            pool.fail = False
            await w.flush()

        asyncio.run(scenario())
        assert pool.written["readings"] == [(1,), (2,)], "retried, in order, once"
        assert w.batch.is_empty
