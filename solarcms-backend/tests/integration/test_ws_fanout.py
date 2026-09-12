"""Phase 5 acceptance: a Reading reaches a socket held by another process.

    Two API processes; a Reading reaches a socket on the other one.

This is what `ws:fanout` exists for. With more than one API process, a WebSocket
held by process A never sees a Reading received by the ingest worker — which is a
third process again — unless the Reading is republished through Redis and each
API process relays it to its own rooms (BACKEND_SPEC §7).

The test models exactly that separation: the publisher never touches the socket
registry, and the "other process" is a fresh `RoomRegistry` plus its own fan-out
listener, which is what a second uvicorn worker actually is.

I-8 is asserted alongside: delivery is per Client+Plant room, never a broadcast.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import pytest

from solarcms.api import ws as ws_module
from solarcms.cache import keys
from solarcms.cache.live import close_redis, get_redis, publish_live
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]


class FakeSocket:
    """Stands in for a connected WebSocket. Records what it was sent."""

    def __init__(self) -> None:
        self.received: list[dict[str, Any]] = []

    async def send_text(self, message: str) -> None:
        self.received.append(json.loads(message))


async def _listener_for(registry: ws_module.RoomRegistry) -> asyncio.Task[None]:
    """A fan-out relay bound to one registry — i.e. one API process."""
    redis = get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe(keys.WS_FANOUT)

    async def relay() -> None:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            payload = json.loads(message["data"])
            room = ws_module.room_key(payload["client_id"], payload["plant_id"])
            await registry.deliver(room, message["data"])

    return asyncio.create_task(relay())


async def _settle(seconds: float = 1.5) -> None:
    await asyncio.sleep(seconds)


class TestCrossProcessFanout:
    async def test_a_reading_published_elsewhere_reaches_a_local_socket(self) -> None:
        # "Process B": its own registry and its own relay, sharing only Redis.
        registry_b = ws_module.RoomRegistry()
        socket_b = FakeSocket()
        client_id, plant_id = 4242, 77
        await registry_b.join(socket_b, [ws_module.room_key(client_id, plant_id)])
        listener = await _listener_for(registry_b)

        try:
            await _settle(0.5)
            # "Process A" — here, the ingest worker — publishes and knows nothing
            # about process B's sockets.
            await publish_live(client_id, plant_id,
                               {"device_id": 1, "values": {"1": 123.4}})
            await _settle()

            assert socket_b.received, "the socket on the other process saw nothing"
            assert socket_b.received[0]["values"] == {"1": 123.4}
            assert socket_b.received[0]["plant_id"] == plant_id
        finally:
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)
            await close_redis()

    async def test_delivery_is_room_scoped_never_broadcast(self) -> None:
        """I-8 / Guardrail 4: a socket must not receive another Plant's data."""
        registry = ws_module.RoomRegistry()
        mine, theirs = FakeSocket(), FakeSocket()
        client_id = 5150
        await registry.join(mine, [ws_module.room_key(client_id, 1)])
        await registry.join(theirs, [ws_module.room_key(client_id, 2)])
        listener = await _listener_for(registry)

        try:
            await _settle(0.5)
            await publish_live(client_id, 1, {"device_id": 9, "values": {"1": 1.0}})
            await _settle()

            assert len(mine.received) == 1
            assert theirs.received == [], (
                "a socket subscribed to another Plant received this Reading"
            )
        finally:
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)
            await close_redis()

    async def test_a_socket_that_left_stops_receiving(self) -> None:
        registry = ws_module.RoomRegistry()
        socket = FakeSocket()
        client_id, plant_id = 6060, 3
        await registry.join(socket, [ws_module.room_key(client_id, plant_id)])
        listener = await _listener_for(registry)

        try:
            await _settle(0.5)
            await publish_live(client_id, plant_id, {"device_id": 1, "values": {}})
            await _settle()
            assert len(socket.received) == 1

            await registry.leave(socket)
            await publish_live(client_id, plant_id, {"device_id": 1, "values": {}})
            await _settle()
            assert len(socket.received) == 1, "a departed socket still received data"
        finally:
            listener.cancel()
            await asyncio.gather(listener, return_exceptions=True)
            await close_redis()


class TestRoomKeys:
    async def test_room_key_separates_clients_sharing_a_plant_id(self) -> None:
        # Plant ids are globally unique, but the room key includes client_id so
        # that a future id collision cannot merge two Clients' streams.
        assert ws_module.room_key(1, 5) != ws_module.room_key(2, 5)

    async def test_registry_counts_unique_sockets_not_memberships(self) -> None:
        registry = ws_module.RoomRegistry()
        socket = FakeSocket()
        suffix = uuid.uuid4().int % 1000
        await registry.join(socket, [ws_module.room_key(suffix, 1),
                                     ws_module.room_key(suffix, 2)])
        assert registry.socket_count == 1
