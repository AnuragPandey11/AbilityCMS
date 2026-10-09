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
        self.instance = f"{self.host}:{self.pid}"
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

    def timed(self, name: str, took_s: float, every_s: float) -> None:
        """Record how long one pass of a periodic job took, against its interval.

        A periodic job that takes longer than its interval falls further behind
        with every pass while every other sign says it is working — the load
        test's health sweep ran 107 s per 60 s pass and was reported `working`
        throughout (docs/CAPACITY_AND_DEPLOYMENT.md §4.10). The verdict reads
        these (`domain/system_health.assess_process`).
        """
        passes = self.extra.setdefault("passes", {})
        passes[name] = {"took_s": round(took_s, 3), "every_s": every_s}

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
            "instance": self.instance,
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
                keys.HEARTBEAT_INSTANCE.format(process=self.process, instance=self.instance),
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


#: Copies older than this are history, not worth listing beside the live ones.
INSTANCE_LISTED_FOR_S = 600


def _beat_time(beat: dict[str, Any]) -> datetime:
    try:
        return datetime.fromisoformat(str(beat.get("beat_at")))
    except (TypeError, ValueError):
        return datetime.min.replace(tzinfo=UTC)


def instance_role(beat: dict[str, Any]) -> str:
    """active, standby, or stopped — a copy that has exited is history, not a copy.

    A restart leaves the previous process's last heartbeat behind for a while;
    counted as a copy it read "2 working" on a machine running one.
    """
    if beat.get("stopped_at") or beat.get("crashed_at"):
        return "stopped"
    return str((beat.get("extra") or {}).get("role") or "active")


def choose_active(beats: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The copy whose heartbeat speaks for the process.

    The newest copy that is not a standby — the one doing the work. Only when
    every copy is a standby (the active one just died and none has taken over
    yet) is a standby's heartbeat the process's, which then reads as such.
    """
    if not beats:
        return None
    working = [b for b in beats if (b.get("extra") or {}).get("role") != "standby"]
    return max(working or beats, key=_beat_time)


async def read_heartbeat_instances(name: str) -> list[dict[str, Any]]:
    """Every copy's last heartbeat for one process, the pre-instance key included."""
    client = get_redis()
    found = [key async for key in client.scan_iter(
        match=keys.HEARTBEAT_INSTANCE.format(process=name, instance="*"), count=200)]
    legacy = keys.HEARTBEAT.format(process=name)
    raw = await client.mget([*found, legacy]) if found else [await client.get(legacy)]
    beats = []
    for value in raw:
        try:
            if value:
                beats.append(json.loads(value))
        except (TypeError, json.JSONDecodeError):
            continue
    return beats


async def read_heartbeats(names: tuple[str, ...]) -> dict[str, dict[str, Any] | None]:
    """Each named process's active heartbeat, or None where there is none.

    Each carries `instances`: every copy heard from in the last ten minutes,
    with its role, so the page can say "one working, one standing by".
    """
    out: dict[str, dict[str, Any] | None] = {}
    now = datetime.now(UTC)
    for name in names:
        beats = await read_heartbeat_instances(name)
        chosen = choose_active(beats)
        if chosen is None:
            out[name] = None
            continue
        recent = [b for b in beats
                  if (now - _beat_time(b)).total_seconds() <= INSTANCE_LISTED_FOR_S
                  or b is chosen]
        out[name] = {**chosen, "instances": [
            {"instance": b.get("instance") or f"{b.get('host')}:{b.get('pid')}",
             "role": instance_role(b),
             "beat_at": b.get("beat_at"), "stopped_at": b.get("stopped_at"),
             "crashed_at": b.get("crashed_at")}
            for b in sorted(recent, key=_beat_time, reverse=True)
        ]}
    return out
