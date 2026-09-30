"""Start the five SolarCMS processes and restart any that exits.

    .venv/bin/python -m solarcms.supervisor --reload --log-dir /private/tmp/solarcms-logs

Until this existed nothing restarted a crashed worker: the API and the four
workers were started by hand, one per terminal or `nohup`, and a scheduler that
died at 02:00 stayed dead until somebody noticed a Plant KPI had stopped moving.
This is deliberately small — no dependency, no configuration file — because in
production the same job belongs to systemd or the container runtime, and this
is the development machine's stand-in with the same policy:

* **Restart on any exit**, clean or not, with a backoff of 1 s doubling to
  `SUPERVISOR_MAX_BACKOFF_S`, reset once a process has stayed up for
  `SUPERVISOR_STABLE_AFTER_S` — so a crash loop cannot spin a CPU, and a
  process that crashes once a day restarts at once.
* **One set only.** Two ingest workers share the broker session identifier and
  fight over it; two schedulers double-write every Plant KPI tick. So it
  refuses to start while any SolarCMS process is already running (`--force` to
  override, knowingly). This happened on 28 Sep 2026, by hand.
* **Its own session per child**, so Ctrl+C in a terminal reaches the supervisor
  alone, which then stops each child with SIGTERM — ingest flushes its buffer
  on SIGTERM — and only kills what has not gone after 15 s.
* **Says what it is doing** — each child's pid, state, restarts and last exit —
  in its own heartbeat (`cache/heartbeat.py`), which the System Health page
  reads beside the children's.

Each child's output is appended to `<log-dir>/<name>.log` with a line marking
every start and exit, so a crash is findable in the file it would be looked for.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import signal
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, BinaryIO

from solarcms.cache.heartbeat import SUPERVISOR, Heartbeat
from solarcms.cache.live import close_redis
from solarcms.domain.assumptions import SUPERVISOR_MAX_BACKOFF_S, SUPERVISOR_STABLE_AFTER_S

BACKEND_DIR = Path(__file__).resolve().parents[2]
DEFAULT_LOG_DIR = BACKEND_DIR.parent / ".dev-run" / "logs"
STOP_GRACE_S = 15.0

#: What each child runs, and the text that identifies one already running.
PROGRAMS: dict[str, tuple[list[str], str]] = {
    "api": (["-m", "uvicorn", "solarcms.api.main:app"], "solarcms.api.main:app"),
    "ingest": (["-m", "solarcms.workers.ingest"], "solarcms.workers.ingest"),
    "alarm": (["-m", "solarcms.workers.alarm"], "solarcms.workers.alarm"),
    "health_sweeper": (["-m", "solarcms.workers.health_sweeper"],
                       "solarcms.workers.health_sweeper"),
    "scheduler": (["-m", "solarcms.workers.scheduler"], "solarcms.workers.scheduler"),
}


def next_backoff(previous_s: float, ran_for_s: float) -> float:
    """How long to wait before restarting a process that ran for `ran_for_s`."""
    if ran_for_s >= SUPERVISOR_STABLE_AFTER_S:
        return 1.0
    return float(min(SUPERVISOR_MAX_BACKOFF_S, max(1.0, previous_s * 2)))


def _stamp() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


@dataclass
class Child:
    name: str
    argv: list[str]
    process: asyncio.subprocess.Process | None = None
    state: str = "starting"
    started_at: datetime | None = None
    restarts: int = 0
    last_exit_code: int | None = None
    last_exit_at: datetime | None = None
    last_ran_for_s: float | None = None
    next_start_at: datetime | None = None
    history: list[str] = field(default_factory=list)

    def snapshot(self) -> dict[str, Any]:
        return {
            "pid": self.process.pid if self.process and self.state == "running" else None,
            "state": self.state,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "restarts": self.restarts,
            "last_exit_code": self.last_exit_code,
            "last_exit_at": self.last_exit_at.isoformat() if self.last_exit_at else None,
            "last_ran_for_s": self.last_ran_for_s,
            "next_start_at": self.next_start_at.isoformat() if self.next_start_at else None,
        }


class Supervisor:
    def __init__(self, children: list[Child], log_dir: Path) -> None:
        self.children = children
        self.log_dir = log_dir
        self.stopping = asyncio.Event()
        self.heartbeat = Heartbeat(SUPERVISOR, children={}, log_dir=str(log_dir))

    async def _report(self) -> None:
        self.heartbeat.extra["children"] = {c.name: c.snapshot() for c in self.children}
        self.heartbeat.cycle()
        await self.heartbeat.publish()

    def _note(self, log: BinaryIO, line: str) -> None:
        log.write(f"--- supervisor {_stamp()}: {line}\n".encode())
        log.flush()
        print(f"supervisor: {line}", file=sys.stderr, flush=True)

    async def _stop_child(self, child: Child) -> None:
        process = child.process
        if process is None or process.returncode is not None:
            return
        with contextlib.suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=STOP_GRACE_S)
        except TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                process.kill()
            await process.wait()

    async def _supervise(self, child: Child) -> None:
        backoff = 1.0
        while not self.stopping.is_set():
            # A local append-only file opened once per start: not worth a thread.
            with open(self.log_dir / f"{child.name}.log", "ab") as log:  # noqa: ASYNC230
                self._note(log, f"starting {child.name}")
                child.process = await asyncio.create_subprocess_exec(
                    sys.executable, *child.argv,
                    cwd=BACKEND_DIR, stdout=log, stderr=subprocess.STDOUT,
                    # Its own session: Ctrl+C reaches the supervisor only.
                    start_new_session=True,
                )
                child.state = "running"
                child.started_at = datetime.now(UTC)
                child.next_start_at = None
                await self._report()

                exited = asyncio.create_task(child.process.wait())
                stop = asyncio.create_task(self.stopping.wait())
                await asyncio.wait({exited, stop}, return_when=asyncio.FIRST_COMPLETED)
                if self.stopping.is_set():
                    exited.cancel()
                    await self._stop_child(child)
                    child.state = "stopped"
                    self._note(log, f"stopped {child.name} (supervisor shutting down)")
                    await self._report()
                    return
                stop.cancel()

                ran_for = (datetime.now(UTC) - child.started_at).total_seconds()
                code = child.process.returncode
                backoff = next_backoff(backoff, ran_for)
                child.state = "restarting"
                child.restarts += 1
                child.last_exit_code = code
                child.last_exit_at = datetime.now(UTC)
                child.last_ran_for_s = round(ran_for, 1)
                child.next_start_at = datetime.fromtimestamp(
                    datetime.now(UTC).timestamp() + backoff, UTC)
                self._note(log, f"{child.name} exited with code {code} after {ran_for:.1f} s; "
                                f"restarting in {backoff:g} s")
                await self._report()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.stopping.wait(), timeout=backoff)

    async def run(self) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        beat = self.heartbeat.start(self.stopping)
        try:
            await asyncio.gather(*(self._supervise(child) for child in self.children))
        except Exception as exc:
            self.heartbeat.crashed(exc)
            raise
        finally:
            self.stopping.set()
            await asyncio.gather(*(self._stop_child(c) for c in self.children))
            await beat
            await close_redis()


def already_running(patterns: list[str]) -> list[str]:
    """SolarCMS processes already alive on this machine, as "pid command" lines.

    Only Python processes count: the shell that launched this one carries the
    same text in its command line and is not a second supervisor.
    """
    found: list[str] = []
    ours = {os.getpid(), os.getppid()}
    for pattern in patterns:
        result = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True,
                                check=False)
        for pid_text in result.stdout.split():
            pid = int(pid_text)
            if pid in ours:
                continue
            command = subprocess.run(["ps", "-o", "command=", "-p", str(pid)],
                                     capture_output=True, text=True, check=False).stdout.strip()
            program = Path(command.split(" ", 1)[0]).name.lower() if command else ""
            if "python" in program or "uvicorn" in program:
                found.append(f"{pid} {command}")
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--log-dir", default=str(DEFAULT_LOG_DIR),
                        help=f"where each process's log is appended (default {DEFAULT_LOG_DIR})")
    parser.add_argument("--reload", action="store_true",
                        help="run the API with uvicorn --reload (development)")
    parser.add_argument("--no-api", action="store_true",
                        help="supervise the four workers only")
    parser.add_argument("--force", action="store_true",
                        help="start even though SolarCMS processes are already running")
    args = parser.parse_args()

    os.chdir(BACKEND_DIR)
    names = [n for n in PROGRAMS if not (args.no_api and n == "api")]
    if not args.force:
        running = already_running(["solarcms.supervisor", *(PROGRAMS[n][1] for n in names)])
        if running:
            print("SolarCMS processes are already running — a second set would fight the "
                  "first over the broker session and double-write every scheduler tick:",
                  file=sys.stderr)
            for line in running:
                print(f"  {line}", file=sys.stderr)
            print("Stop them first (kill -TERM <pid>), or pass --force knowingly.",
                  file=sys.stderr)
            return 1

    children = []
    for name in names:
        argv = list(PROGRAMS[name][0])
        if name == "api" and args.reload:
            argv.append("--reload")
        children.append(Child(name, argv))
    supervisor = Supervisor(children, Path(args.log_dir))

    async def _run() -> None:
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, supervisor.stopping.set)
        await supervisor.run()

    asyncio.run(_run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
