"""Live WebSocket. Client- and Plant-scoped rooms only.

I-8 / Guardrail 4: broadcasting live data to every connected socket is
prohibited. A socket joins exactly the rooms its token entitles it to, and the
Redis fan-out message carries `client_id` and `plant_id` so the receiving process
can route it — the room key is what enforces the boundary on delivery.

`ws:fanout` is not optional. With more than one API process, a socket held by
process A never sees a Reading received by the ingest worker without it
(BACKEND_SPEC §7).

Two failure rules (8 Oct 2026):

* **One slow browser cannot hold up the others.** Each socket has its own
  bounded queue and its own writer; the relay only enqueues. A socket whose
  queue fills, or whose send stalls, is closed with 1013 (try again later) —
  the page reconnects with backoff and re-seeds its values from stored
  Readings, so nothing it shows is lost. The relay used to await every send in
  turn, so one stalled socket froze live data for everyone on this process.
* **A Redis restart is recovered, and said.** The relay resubscribes with
  backoff. While it is down, open sockets are closed and new ones refused with
  1013, so every page shows itself disconnected and polls at its faster
  cadence. It used to die silently: sockets stayed open, received nothing, and
  pages kept the slow 30-second backstop while looking live.
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

#: Frames a socket may have waiting. A Device frame is a few hundred bytes and
#: a Plant sends a few a second, so this is about a minute of a busy Plant — a
#: browser that far behind is better off reconnecting and re-reading.
SOCKET_QUEUE_MAX = 256
#: A single send taking longer than this means the browser is not reading.
SEND_TIMEOUT_S = 10.0
#: How long a new socket waits for the relay to come up before being told to retry.
RELAY_READY_WAIT_S = 3.0
TRY_AGAIN_LATER = 1013


def room_key(client_id: int, plant_id: int) -> str:
    return f"{client_id}:{plant_id}"


class _Subscriber:
    """One socket, with a bounded outbox and a writer that drains it."""

    def __init__(self, socket: WebSocket) -> None:
        self.socket = socket
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=SOCKET_QUEUE_MAX)
        self.closing = False
        self.writer = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        try:
            while True:
                message = await self.queue.get()
                await asyncio.wait_for(self.socket.send_text(message), SEND_TIMEOUT_S)
        except TimeoutError:
            log.warning("socket not reading; closed")
            await self.close(TRY_AGAIN_LATER, "too slow to keep up; reconnect")
        except (WebSocketDisconnect, RuntimeError):
            pass  # gone; the handler's finally removes it

    def offer(self, message: str) -> None:
        if self.closing:
            return
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            log.warning("socket queue full; closed")
            asyncio.get_running_loop().create_task(
                self.close(TRY_AGAIN_LATER, "too slow to keep up; reconnect"))

    async def close(self, code: int, reason: str) -> None:
        if self.closing:
            return
        self.closing = True
        with contextlib.suppress(Exception):
            await self.socket.close(code=code, reason=reason)

    async def stop(self) -> None:
        self.writer.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await self.writer


class RoomRegistry:
    """Sockets held by *this* process, indexed by room."""

    def __init__(self) -> None:
        self._rooms: dict[str, set[_Subscriber]] = defaultdict(set)
        self._by_socket: dict[WebSocket, _Subscriber] = {}

    def join(self, socket: WebSocket, rooms: list[str]) -> _Subscriber:
        subscriber = _Subscriber(socket)
        self._by_socket[socket] = subscriber
        for room in rooms:
            self._rooms[room].add(subscriber)
        return subscriber

    async def leave(self, socket: WebSocket) -> None:
        subscriber = self._by_socket.pop(socket, None)
        if subscriber is None:
            return
        for members in self._rooms.values():
            members.discard(subscriber)
        await subscriber.stop()

    def deliver(self, room: str, message: str) -> None:
        """Enqueue for every socket in the room. Never waits on a socket."""
        for subscriber in list(self._rooms.get(room, ())):
            subscriber.offer(message)

    async def close_all(self, code: int, reason: str) -> None:
        await asyncio.gather(*(s.close(code, reason) for s in list(self._by_socket.values())),
                             return_exceptions=True)

    @property
    def socket_count(self) -> int:
        return len(self._by_socket)


registry = RoomRegistry()
_fanout_task: asyncio.Task[None] | None = None
_relay_ready = asyncio.Event()


async def _relay_once() -> None:
    """Subscribe and relay until the connection fails."""
    pubsub = get_redis().pubsub()
    try:
        await pubsub.subscribe(keys.WS_FANOUT)
        _relay_ready.set()
        log.info("live relay subscribed")
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            try:
                payload = json.loads(message["data"])
                room = room_key(payload["client_id"], payload["plant_id"])
            except (json.JSONDecodeError, KeyError, TypeError):
                log.warning("undeliverable fanout message")
                continue
            registry.deliver(room, message["data"])
    finally:
        _relay_ready.clear()
        with contextlib.suppress(Exception):
            await pubsub.aclose()  # type: ignore[no-untyped-call]


async def _fanout_loop() -> None:
    """Relay Redis pub/sub into this process's rooms, for as long as the process runs."""
    delay = 1.0
    while True:
        try:
            await _relay_once()
            delay = 1.0
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("live relay lost; reconnecting", error=str(exc), retry_in_s=delay)
            # Sockets that will receive nothing are closed, so each page says it
            # is disconnected and polls faster until the relay is back.
            await registry.close_all(TRY_AGAIN_LATER, "live updates interrupted; reconnect")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)


def _ensure_relay() -> None:
    global _fanout_task
    if _fanout_task is None or _fanout_task.done():
        _fanout_task = asyncio.create_task(_fanout_loop())


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

    # A socket that would receive nothing is refused rather than left looking
    # live: the page then shows itself disconnected and polls faster.
    _ensure_relay()
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(_relay_ready.wait(), RELAY_READY_WAIT_S)
    if not _relay_ready.is_set():
        await websocket.close(code=TRY_AGAIN_LATER, reason="live updates unavailable")
        return

    log.info("socket joined", user_id=user_id, rooms=len(rooms))
    await websocket.send_json({"type": "subscribed", "rooms": rooms})
    registry.join(websocket, rooms)

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
