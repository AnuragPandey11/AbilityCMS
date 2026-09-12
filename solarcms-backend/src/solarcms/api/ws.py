"""Live WebSocket. Client- and Plant-scoped rooms only.

I-8 / Guardrail 4: broadcasting live data to every connected socket is
prohibited. A socket joins exactly the rooms its token entitles it to, and the
Redis fan-out message carries `client_id` and `plant_id` so the receiving process
can route it — the room key is what enforces the boundary on delivery.

`ws:fanout` is not optional. With more than one API process, a socket held by
process A never sees a Reading received by the ingest worker without it
(BACKEND_SPEC §7).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections import defaultdict

import structlog
from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status
from sqlalchemy import text

from solarcms.api.auth import AuthError, decode_token
from solarcms.cache import keys
from solarcms.cache.live import get_redis
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session

log = structlog.get_logger("ws")
router = APIRouter()


def room_key(client_id: int, plant_id: int) -> str:
    return f"{client_id}:{plant_id}"


class RoomRegistry:
    """Sockets held by *this* process, indexed by room."""

    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = defaultdict(set)
        self._lock = asyncio.Lock()

    async def join(self, socket: WebSocket, rooms: list[str]) -> None:
        async with self._lock:
            for room in rooms:
                self._rooms[room].add(socket)

    async def leave(self, socket: WebSocket) -> None:
        async with self._lock:
            for members in self._rooms.values():
                members.discard(socket)

    async def deliver(self, room: str, message: str) -> None:
        async with self._lock:
            targets = list(self._rooms.get(room, ()))
        for socket in targets:
            try:
                await socket.send_text(message)
            except (WebSocketDisconnect, RuntimeError):
                # A socket that died between the snapshot and the send is normal;
                # the disconnect handler removes it.
                await self.leave(socket)

    @property
    def socket_count(self) -> int:
        return len({s for members in self._rooms.values() for s in members})


registry = RoomRegistry()
_fanout_task: asyncio.Task[None] | None = None


async def _fanout_loop() -> None:
    """Relay Redis pub/sub into this process's rooms."""
    pubsub = get_redis().pubsub()
    await pubsub.subscribe(keys.WS_FANOUT)
    async for message in pubsub.listen():
        if message.get("type") != "message":
            continue
        try:
            payload = json.loads(message["data"])
            room = room_key(payload["client_id"], payload["plant_id"])
        except (json.JSONDecodeError, KeyError, TypeError):
            log.warning("undeliverable fanout message")
            continue
        await registry.deliver(room, message["data"])


async def _authorised_rooms(token: str) -> tuple[int, list[str]]:
    """Rooms this token may join: one per visible Plant, scoped to its Client.

    The Plant list comes from an RLS-filtered query rather than from the token, so
    an Employee's rooms are exactly their assignments and zero assignments means
    zero rooms (I-5).
    """
    claims = decode_token(token, expect="access")
    context = SecurityContext(
        user_id=claims.user_id, client_id=claims.client_id,
        role_code=claims.role_code, is_platform_admin=claims.is_platform_admin,
    )
    async with scoped_session(context) as session:
        rows = (await session.execute(text("SELECT id, client_id FROM plants"))).all()
    return claims.user_id, [room_key(r.client_id, r.id) for r in rows]


@router.websocket("/ws/live")
async def live(websocket: WebSocket, token: str = "") -> None:
    global _fanout_task

    if not token:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    try:
        user_id, rooms = await _authorised_rooms(token)
    except AuthError:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    if not rooms:
        # Connected but entitled to nothing. Said explicitly rather than left as a
        # silent socket that never receives anything.
        await websocket.send_json({"type": "no_rooms",
                                   "detail": "no Plants are visible to this user"})

    await registry.join(websocket, rooms)
    if _fanout_task is None or _fanout_task.done():
        _fanout_task = asyncio.create_task(_fanout_loop())

    log.info("socket joined", user_id=user_id, rooms=len(rooms))
    await websocket.send_json({"type": "subscribed", "rooms": rooms})

    try:
        while True:
            # The client sends nothing meaningful; this is the disconnect detector.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await registry.leave(websocket)
        log.info("socket left", user_id=user_id)


async def shutdown_fanout() -> None:
    if _fanout_task is not None:
        _fanout_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _fanout_task
