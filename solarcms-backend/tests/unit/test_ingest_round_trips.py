"""Ingest's round trips per message (docs/CAPACITY_AND_DEPLOYMENT.md §4.5).

About fifteen network round trips per message capped ingest at ~31 messages/s
across availability zones, against the 95/s fifty Plants publish. These pin
what replaced them: a cached topic never opens a database session; per-Device
state comes from memory after the first message; everything a message changes
in Redis goes in one pipeline; and a failed write changes nothing, so the
retry decides exactly the same again. No Redis or database here.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import pytest

from solarcms.cache import keys
from solarcms.config import get_settings
from solarcms.domain.decoding import DeviceResolution, TagBinding
from solarcms.workers import ingest as ingest_module
from solarcms.workers.delivery import RedeliveryFilter
from solarcms.workers.ingest import Batch, DeviceMemory, IngestWorker
from tests.unit.test_ingest_flush import FakeHeartbeat

RESOLUTION = DeviceResolution(
    device_id=7, client_id=1, plant_id=2, expected_interval_s=30,
    bindings={
        "PAC": TagBinding(source_key="PAC", tag_id=10, tag_code="AC_ACTIVE_POWER"),
        "TE": TagBinding(source_key="TE", tag_id=11, tag_code="ENERGY_TOTAL", cumulative=True),
    },
)


class Calls:
    def __init__(self) -> None:
        self.sessions = 0
        self.redis_reads = 0
        self.pipelines: list[dict[str, Any]] = []
        self.fail_next_write = False
        self.arrivals: list[dict[str, list[datetime]]] = []
        self.fail_arrivals = False


@pytest.fixture
def worker(monkeypatch: pytest.MonkeyPatch) -> tuple[IngestWorker, Calls]:
    calls = Calls()

    async def cached(_topic: str) -> DeviceResolution:
        calls.redis_reads += 1
        return RESOLUTION

    @asynccontextmanager
    async def session(*_a: Any, **_k: Any):  # type: ignore[no-untyped-def]
        calls.sessions += 1
        yield None

    async def read_state(*_a: Any, **_k: Any) -> dict[Any, Any]:
        calls.redis_reads += 1
        return {}

    async def write_state(**kwargs: Any) -> None:
        if calls.fail_next_write:
            calls.fail_next_write = False
            raise ConnectionError("redis went away")
        calls.pipelines.append(kwargs)

    async def record_arrivals(arrivals: dict[str, list[datetime]]) -> None:
        if calls.fail_arrivals:
            raise ConnectionError("redis went away")
        calls.arrivals.append({topic: list(times) for topic, times in arrivals.items()})

    monkeypatch.setattr(ingest_module, "resolve_cached", cached)
    monkeypatch.setattr(ingest_module.live, "record_topic_arrivals", record_arrivals)
    monkeypatch.setattr(ingest_module, "scoped_session", session)
    monkeypatch.setattr(ingest_module.live, "read_current_values", read_state)
    monkeypatch.setattr(ingest_module.live, "read_throttle_state", read_state)
    monkeypatch.setattr(ingest_module.live, "read_counter_values", read_state)
    monkeypatch.setattr(ingest_module.live, "write_message_state", write_state)

    w = IngestWorker.__new__(IngestWorker)
    w.settings = get_settings()
    w.batch = Batch()
    w._flush_lock = asyncio.Lock()
    w._stopping = asyncio.Event()
    w._seq = 0
    w.patterns = []
    w.stats = {k: 0 for k in ("received", "stored", "quarantined", "throttled", "unmapped",
                              "suspect_counters", "flushes", "acknowledged",
                              "resends_skipped", "retries")}
    w.heartbeat = FakeHeartbeat()  # type: ignore[assignment]
    w.heartbeat.extra["messages"] = 0
    w._mqtt = None
    w._generation = 1
    w._redelivery = RedeliveryFilter()
    w._stream_backlog = []
    w._topics = {}
    w._devices = {}
    w._seen = {}
    w._arrivals = {}
    return w, calls


def message(power: float, energy: float) -> bytes:
    return json.dumps({"PAC": power, "TE": energy}).encode()


async def test_a_cached_topic_never_opens_a_database_session(worker: Any) -> None:
    w, calls = worker
    await w.handle("scms/v1/C/P/M/INV1", message(10, 100))
    await w.handle("scms/v1/C/P/M/INV1", message(11, 101))
    assert calls.sessions == 0


async def test_device_state_is_read_from_redis_once_then_held(worker: Any) -> None:
    w, calls = worker
    await w.handle("scms/v1/C/P/M/INV1", message(10, 100))
    first = calls.redis_reads
    await w.handle("scms/v1/C/P/M/INV1", message(11, 101))
    assert calls.redis_reads == first, "the second message read Redis again"


async def test_one_pipeline_per_message_with_only_what_is_read_back(worker: Any) -> None:
    w, calls = worker
    await w.handle("scms/v1/C/P/M/INV1", message(10, 100))
    [written] = calls.pipelines
    assert written["current"] == {10: 10.0, 11: 100.0}
    assert written["counters"] == {11: 100.0}, "only registers are read back as counters"
    assert sorted(written["throttled_now"]) == [10, 11]


async def test_a_failed_write_changes_nothing_so_the_retry_decides_the_same(
        worker: Any) -> None:
    w, calls = worker
    calls.fail_next_write = True
    with pytest.raises(ConnectionError):
        await w.handle("scms/v1/C/P/M/INV1", message(10, 100))
    assert w.batch.readings == []
    assert w._devices[7].throttle == {}, "throttle advanced although nothing was written"
    await w.handle("scms/v1/C/P/M/INV1", message(10, 100))
    assert len(w.batch.readings) == 2


async def test_last_heard_is_written_with_the_next_tick(
        worker: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    w, _calls = worker
    touched: list[dict[int, datetime]] = []

    async def touch(seen: dict[int, datetime]) -> None:
        touched.append(dict(seen))

    monkeypatch.setattr(ingest_module.live, "touch_devices_seen", touch)
    await w.handle("scms/v1/C/P/M/INV1", message(10, 100))
    assert touched == []
    await w._write_seen()
    assert list(touched[0]) == [7]
    await w._write_seen()
    assert len(touched) == 1, "nothing new was heard, so nothing is written"


async def test_a_message_the_throttle_stores_nothing_from_still_counts_as_an_arrival(
        worker: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    # OASIS_2MW's meters, 30 Oct 2026: sent every 30 s, every Tag throttled to
    # 60 s, so only every third message left a raw row — and the gaps between
    # raw rows were reported as the meter sending every ~90 s.
    w, calls = worker
    throttled = DeviceResolution(
        device_id=7, client_id=1, plant_id=2, expected_interval_s=30,
        bindings={"P": TagBinding(source_key="P", tag_id=10, tag_code="AC_ACTIVE_POWER",
                                  min_interval_s=60)},
    )

    async def cached(_topic: str) -> DeviceResolution:
        return throttled

    monkeypatch.setattr(ingest_module, "resolve_cached", cached)
    topic = "scms/v1/C/P/M/MFM"
    await w.handle(topic, json.dumps({"P": 1.0}).encode())
    await w.handle(topic, json.dumps({"P": 2.0}).encode())
    assert len(w.batch.raw) == 1, "the second message is inside the throttle"
    await w._write_seen()
    [written] = calls.arrivals
    assert len(written[topic]) == 2, "both messages arrived"
    await w._write_seen()
    assert len(calls.arrivals) == 1, "nothing new arrived, so nothing is written"


async def test_arrivals_not_written_are_kept_for_the_next_tick_and_bounded(
        worker: Any) -> None:
    w, calls = worker
    topic = "scms/v1/C/P/M/INV1"
    base = datetime(2026, 10, 30, 12, tzinfo=UTC)
    sent = [base.replace(second=s) for s in range(keys.TOPIC_ARRIVALS_KEPT + 5)]
    w._arrivals = {topic: list(sent)}
    calls.fail_arrivals = True
    await w._write_seen()
    assert w._arrivals[topic] == sent[-keys.TOPIC_ARRIVALS_KEPT:], "the newest are kept"
    calls.fail_arrivals = False
    await w._write_seen()
    assert calls.arrivals == [{topic: sent[-keys.TOPIC_ARRIVALS_KEPT:]}]
    assert w._arrivals == {}


async def test_an_announced_change_drops_the_remembered_resolution(worker: Any) -> None:
    w, calls = worker
    await w.handle("scms/v1/C/P/M/INV1", message(10, 100))
    reads = calls.redis_reads
    w.forget_resolution("scms/v1/C/P/M/INV1")
    await w.handle("scms/v1/C/P/M/INV1", message(11, 101))
    assert calls.redis_reads == reads + 1
    w.forget_resolution(keys.RESOLVE_INVALIDATE_ALL)
    assert w._topics == {}


def test_memory_holds_what_redis_held() -> None:
    memory = DeviceMemory(throttle={1: datetime.now(UTC)}, counters={2: 5.0}, current={3: 1.0})
    assert memory.counters[2] == 5.0


async def test_a_refused_reading_is_written_as_a_refusal_not_a_value(
        worker: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    # UNIT1's Inverter sends an efficiency of -1 (22 Oct 2026). It is stored and
    # throttled like any reading; it is not the Tag's current value, and the
    # accepted value from before it does not stay standing in its place.
    w, calls = worker
    ranged = DeviceResolution(
        device_id=7, client_id=1, plant_id=2, expected_interval_s=30,
        bindings={"EFF": TagBinding(source_key="EFF", tag_id=12, tag_code="INVERTER_EFFICIENCY",
                                    valid_min=0.0, valid_max=100.0)},
    )

    async def cached(_topic: str) -> DeviceResolution:
        return ranged

    monkeypatch.setattr(ingest_module, "resolve_cached", cached)
    await w.handle("scms/v1/C/P/M/INV1", json.dumps({"EFF": 98.5}).encode())
    assert w._devices[7].current == {12: 98.5}
    await w.handle("scms/v1/C/P/M/INV1", json.dumps({"EFF": -1}).encode())
    written = calls.pipelines[-1]
    assert written["current"] == {}
    assert written["rejected"][12]["value"] == -1.0
    assert written["rejected"][12]["source_key"] == "EFF"
    assert written["throttled_now"] == [12]
    assert w._devices[7].current == {}, "98.5 is not the efficiency now"
    assert len(w.batch.readings) == 2, "both are stored"
