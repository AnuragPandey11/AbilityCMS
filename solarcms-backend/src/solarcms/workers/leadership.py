"""One active copy of each worker, and any number of hot standbys.

docs/CAPACITY_AND_DEPLOYMENT.md §4.6: every worker assumed it was the only one.
Two ingest workers share the broker session identifier and fight over it; two
alarm workers would read one consumer group as one consumer; two schedulers
send every report and escalation twice. The supervisor prevents a second set on
one machine only, and a rolling deploy (or a standby in a second availability
zone) runs two copies by design.

So a worker takes a Postgres **session advisory lock** named after itself before
it does any work. The first copy gets it and works; any other waits as a
standby, retrying every `RETRY_S`, and takes over within seconds of the first
dying — Postgres releases a session lock the moment its connection closes,
whether the process exited cleanly, crashed or lost its host.

⚠ The lock is held on one dedicated connection, and losing that connection
means losing the lock. `watch` checks it every `CHECK_S`; on failure the worker
stops at once rather than carry on as a second active copy beside whichever
standby has just taken over. The supervisor (or ECS) starts it again, as a
standby.

⚠ A session lock needs a session: behind a pooler in transaction mode (§5.6)
the lock connection must go to the database directly — `leader_lock_dsn`,
which defaults to the ingest DSN.

On one laptop nothing changes: the only copy takes the lock at once.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
from typing import Any

import asyncpg
import structlog

from solarcms.config import get_settings
from solarcms.db.session import asyncpg_connect_args

log = structlog.get_logger("leadership")

RETRY_S = 5.0
CHECK_S = 10.0


def lock_key(process: str) -> int:
    """A stable 64-bit advisory-lock key for a process name."""
    digest = hashlib.blake2b(f"solarcms:worker:{process}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


class LeadershipLost(RuntimeError):
    """The connection holding the lock went away; another copy may now be active."""


class Leadership:
    def __init__(self, process: str, heartbeat: Any) -> None:
        self.process = process
        self.key = lock_key(process)
        self.heartbeat = heartbeat
        self._connection: asyncpg.Connection | None = None

    def _dsn(self) -> str:
        settings = get_settings()
        return settings.leader_lock_dsn or settings.asyncpg_dsn

    async def acquire(self, stopping: asyncio.Event) -> bool:
        """Wait until this copy is the active one. False if asked to stop first."""
        settings = get_settings()
        if not settings.leader_lock_enabled:
            self.heartbeat.extra["role"] = "active"
            return True
        announced = False
        while not stopping.is_set():
            try:
                if self._connection is None or self._connection.is_closed():
                    self._connection = await asyncpg.connect(
                        self._dsn(), **asyncpg_connect_args())
                held = await self._connection.fetchval(
                    "SELECT pg_try_advisory_lock($1)", self.key)
            except Exception as exc:
                held = False
                self.heartbeat.extra["role"] = "waiting"
                self.heartbeat.failed(f"cannot reach the database to take the lock: {exc}")
                await self._close()
            if held:
                self.heartbeat.extra["role"] = "active"
                log.info("took the leader lock; working", process=self.process)
                await self.heartbeat.publish()
                return True
            if not announced:
                log.info("another copy is active; standing by", process=self.process)
                announced = True
            self.heartbeat.extra["role"] = "standby"
            # A standby is doing its job by waiting.
            self.heartbeat.cycle()
            await self.heartbeat.publish()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=RETRY_S)
        return False

    async def watch(self, stopping: asyncio.Event) -> None:
        """Stop the worker if the lock's connection is lost. Run as a task."""
        if self._connection is None:
            return
        while not stopping.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=CHECK_S)
            if stopping.is_set():
                return
            try:
                await asyncio.wait_for(self._connection.fetchval("SELECT 1"), timeout=CHECK_S)
            except Exception as exc:
                message = ("lost the leader lock (its database connection dropped); "
                           "stopping so that only one copy works")
                log.error(message, process=self.process, error=str(exc))
                self.heartbeat.crashed(f"{message}: {exc}")
                stopping.set()
                raise LeadershipLost(message) from exc

    async def release(self) -> None:
        if self._connection is not None and not self._connection.is_closed():
            with contextlib.suppress(Exception):
                await self._connection.execute("SELECT pg_advisory_unlock($1)", self.key)
        await self._close()

    async def _close(self) -> None:
        if self._connection is not None:
            with contextlib.suppress(Exception):
                await self._connection.close()
        self._connection = None
