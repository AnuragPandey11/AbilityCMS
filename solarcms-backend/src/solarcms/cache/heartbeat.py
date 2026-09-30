"""Each long-running process says it is alive — and, separately, whether it works.

A heartbeat alone proves only that a process exists. The failure that has
actually hurt this project is a process that exists, runs its loop, catches the
exception its work raises, logs it and sleeps: nothing written for days while
every liveness check passed (CLAUDE.md, "Things that surprised the build" — four
times). So a process records three things beside the beat:

* **cycle** — a unit of work completed *without* an error. Ingest's flush tick,
  one batch of the alarm stream, one sweep, one scheduler tick.
* **wrote** — that unit actually wrote something, and what. "Ran" and "saved"
  are different claims, and only the second is what anyone relies on.
* **failed** — a unit raised, with the message. A process whose latest unit
  failed is *failing* however alive it is.

The beat runs on its own task, so a process whose work is hung still beats and
reads *stalled* rather than *down* — the two need different fixes. Writing a
heartbeat never takes a process down: Redis being unreachable is logged and the
work carries on. Status is judged by the API at read time
(`domain/system_health.py`), never by the process about itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
from collections import deque
from datetime import UTC, datetime, timedelta
from typing import Any

import structlog

from solarcms.cache import keys
from solarcms.cache.live import get_redis
from solarcms.domain.assumptions import HEARTBEAT_INTERVAL_S, PROCESS_RECENT_ERROR_WINDOW_S

log = structlog.get_logger("heartbeat")

#: The processes the System Health page expects to hear from, in the order it
#: shows them. The API is not among them: it is answering the request.
PROCESSES: tuple[str, ...] = ("ingest", "alarm", "health_sweeper", "scheduler")
SUPERVISOR = "supervisor"


def _iso(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment else None


class Heartbeat:
    def __init__(self, process: str, **extra: Any) -> None:
        self.process = process
        self.pid = os.getpid()
        self.host = socket.gethostname()
        self.started_at = datetime.now(UTC)
        self.stopped_at: datetime | None = None
        # Set when the process is exiting because of an error, so its last word
        # reads "exited after an error", never "shut down cleanly".
        self.crashed_at: datetime | None = None
        self.last_cycle_at: datetime | None = None
        self.cycles = 0
        self.last_write_at: datetime | None = None
        self.last_write: str | None = None
        self.last_error_at: datetime | None = None
        self.last_error: str | None = None
        self.errors = 0
        # Enough to count the last window's errors; a process failing faster
        # than this is failing, and the count saying "1000+" is still true.
        self._error_times: deque[datetime] = deque(maxlen=1000)
        #: Process-specific facts — ingest's broker connection, for one.
        self.extra: dict[str, Any] = dict(extra)

    # ── what the process reports ─────────────────────────────────────────────

    def cycle(self) -> None:
        """A unit of work completed without an error."""
        self.last_cycle_at = datetime.now(UTC)
        self.cycles += 1

    def wrote(self, what: str) -> None:
        """That unit wrote something — say what, in a few words."""
        self.last_write_at = datetime.now(UTC)
        self.last_write = what

    def failed(self, error: BaseException | str) -> None:
        now = datetime.now(UTC)
        self.last_error_at = now
        text = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
        # One line and bounded: this is shown on a page, and a traceback is in
        # the log already.
        self.last_error = " ".join(text.split())[:500]
        self.errors += 1
        self._error_times.append(now)

    def crashed(self, error: BaseException | str) -> None:
        """The process is exiting because of `error`."""
        self.failed(error)
        self.crashed_at = self.last_error_at

    # ── what is written ──────────────────────────────────────────────────────

    def snapshot(self, now: datetime | None = None) -> dict[str, Any]:
        moment = now or datetime.now(UTC)
        window = moment - timedelta(seconds=PROCESS_RECENT_ERROR_WINDOW_S)
        return {
            "process": self.process,
            "pid": self.pid,
            "host": self.host,
            "started_at": _iso(self.started_at),
            "stopped_at": _iso(self.stopped_at),
            "crashed_at": _iso(self.crashed_at),
            "beat_at": _iso(moment),
            "last_cycle_at": _iso(self.last_cycle_at),
            "cycles": self.cycles,
            "last_write_at": _iso(self.last_write_at),
            "last_write": self.last_write,
            "last_error_at": _iso(self.last_error_at),
            "last_error": self.last_error,
            "errors": self.errors,
            "recent_errors": sum(1 for at in self._error_times if at >= window),
            "extra": {
                key: _iso(value) if isinstance(value, datetime) else value
                for key, value in self.extra.items()
            },
        }

    async def publish(self) -> None:
        """Write the heartbeat now. Never raises: a monitor must not be a fault."""
        try:
            await get_redis().set(
                keys.HEARTBEAT.format(process=self.process),
                json.dumps(self.snapshot()),
                ex=keys.HEARTBEAT_TTL_S,
            )
        except Exception as exc:
            log.warning("heartbeat not written", process=self.process, error=str(exc))

    async def run(self, stopping: asyncio.Event) -> None:
        """Beat until `stopping` is set, then say the process stopped cleanly."""
        while not stopping.is_set():
            await self.publish()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stopping.wait(), timeout=HEARTBEAT_INTERVAL_S)
        if self.crashed_at is None:
            self.stopped_at = datetime.now(UTC)
        await self.publish()

    def start(self, stopping: asyncio.Event) -> asyncio.Task[None]:
        return asyncio.create_task(self.run(stopping), name=f"heartbeat:{self.process}")


async def read_heartbeats(names: tuple[str, ...]) -> dict[str, dict[str, Any] | None]:
    """Each named process's last heartbeat, or None where there is none."""
    raw = await get_redis().mget([keys.HEARTBEAT.format(process=name) for name in names])
    out: dict[str, dict[str, Any] | None] = {}
    for name, value in zip(names, raw, strict=True):
        try:
            out[name] = json.loads(value) if value else None
        except (TypeError, json.JSONDecodeError):
            out[name] = None
    return out
