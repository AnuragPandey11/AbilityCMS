"""One slow browser must not hold up live data for everyone else.

The relay used to `await` each socket's send in turn, so a browser that stopped
reading froze live updates for every socket on the same API process. Each
socket now has its own bounded queue and writer; the relay only enqueues.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from solarcms.api import ws as ws_module

pytestmark = pytest.mark.asyncio


class FastSocket:
    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []
        self.closed: int | None = None

    async def send_text(self, message: str) -> None:
        self.received.append(json.loads(message))

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = code


class StalledSocket(FastSocket):
    """A browser tab that has stopped reading: every send waits for ever."""

    async def send_text(self, message: str) -> None:
        await asyncio.Event().wait()


def _frame(n: int) -> str:
    return json.dumps({"client_id": 1, "plant_id": 1, "device_id": n, "values": {}})


async def test_a_stalled_socket_does_not_delay_the_others() -> None:
    registry = ws_module.RoomRegistry()
    room = ws_module.room_key(1, 1)
    stalled, fast = StalledSocket(), FastSocket()
    registry.join(stalled, [room])  # type: ignore[arg-type]
    registry.join(fast, [room])  # type: ignore[arg-type]
    try:
        for n in range(20):
            registry.deliver(room, _frame(n))
        await asyncio.sleep(0.05)
        assert [m["device_id"] for m in fast.received] == list(range(20))
    finally:
        await registry.leave(stalled)  # type: ignore[arg-type]
        await registry.leave(fast)  # type: ignore[arg-type]


async def test_a_socket_that_cannot_keep_up_is_told_to_reconnect() -> None:
    registry = ws_module.RoomRegistry()
    room = ws_module.room_key(1, 1)
    stalled = StalledSocket()
    registry.join(stalled, [room])  # type: ignore[arg-type]
    try:
        # One in the writer's hands, the queue full behind it, then one more.
        for n in range(ws_module.SOCKET_QUEUE_MAX + 2):
            registry.deliver(room, _frame(n))
        await asyncio.sleep(0.05)
        assert stalled.closed == ws_module.TRY_AGAIN_LATER
    finally:
        await registry.leave(stalled)  # type: ignore[arg-type]


async def test_closing_every_socket_reaches_each_one() -> None:
    registry = ws_module.RoomRegistry()
    sockets = [FastSocket(), FastSocket()]
    for socket in sockets:
        registry.join(socket, [ws_module.room_key(1, 1)])  # type: ignore[arg-type]
    await registry.close_all(ws_module.TRY_AGAIN_LATER, "relay lost")
    assert [s.closed for s in sockets] == [ws_module.TRY_AGAIN_LATER] * 2
    for socket in sockets:
        await registry.leave(socket)  # type: ignore[arg-type]
