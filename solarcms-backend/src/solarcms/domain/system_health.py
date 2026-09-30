"""Is the platform itself working? Heartbeats in, verdicts out. Pure — no I/O.

Every other screen answers questions about Plants. This one answers whether the
software answering them is running, which no Plant reading can say: a silent
Plant and a dead ingest worker look identical on every dashboard.

One verdict per process, from its heartbeat (`cache/heartbeat.py`), in the order
a reader should care:

* **not seen** — no heartbeat at all: never started since heartbeats existed, or
  Redis lost it (the next beat restores it).
* **stopped** — it said goodbye: a clean shutdown, and nothing running now.
* **down** — no beat for `PROCESS_DOWN_AFTER_S`: exited without saying so, or
  frozen solid.
* **failing** — alive, and its latest unit of work raised. The case this module
  exists for: a process that catches its own failure and carries on.
* **stalled** — alive, but nothing has completed for its own stall threshold:
  work hung, or a loop that never gets round.
* **degraded** — working now, but it failed within the recent window. The
  intermittent failure, otherwise invisible because the next success hides it.
* **starting** — up for less than its stall threshold, no work completed yet.
* **working** — none of the above.

Plus the broker, as ingest sees it, and the supervisor. ⚠ The broker's *quiet*
verdict cannot tell "every Plant is silent" from "ingest is listening in the
wrong place" — it says both, because the second happened here for 27 hours
and looked exactly like the first.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from solarcms.domain.assumptions import (
    BROKER_QUIET_AFTER_S,
    PROCESS_DOWN_AFTER_S,
    PROCESS_RECENT_ERROR_WINDOW_S,
    PROCESS_STALLED_AFTER_S,
)

State = Literal[
    "not_seen", "stopped", "down", "failing", "stalled", "degraded", "starting",
    "working", "connected", "quiet", "disconnected", "unknown", "absent",
]
Tone = Literal["ok", "warn", "bad"]

_TONE_ORDER: dict[Tone, int] = {"ok": 0, "warn": 1, "bad": 2}


@dataclass(frozen=True)
class Verdict:
    state: State
    tone: Tone
    reason: str


def ago(seconds: float) -> str:
    """A span in words a reader takes in at a glance: 40 s, 12 min, 3 h, 2 d."""
    s = max(0, int(seconds))
    if s < 90:
        return f"{s} s"
    if s < 90 * 60:
        return f"{round(s / 60)} min"
    if s < 36 * 3600:
        return f"{round(s / 3600)} h"
    return f"{round(s / 86400)} d"


def _at(beat: Mapping[str, Any], field: str) -> datetime | None:
    value = beat.get(field)
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _since(moment: datetime | None, now: datetime) -> float | None:
    return None if moment is None else (now - moment).total_seconds()


def assess_process(name: str, beat: Mapping[str, Any] | None, now: datetime) -> Verdict:
    if beat is None:
        return Verdict("not_seen", "bad",
                       "Never heard from: not running, or not started since heartbeats "
                       "were added.")
    beat_age = _since(_at(beat, "beat_at"), now)
    if _at(beat, "crashed_at") is not None:
        return Verdict("down", "bad",
                       f"Exited after an error {ago(beat_age or 0)} ago: "
                       f"{beat.get('last_error') or 'no message'}")
    if _at(beat, "stopped_at") is not None:
        return Verdict("stopped", "bad",
                       f"Shut down cleanly {ago(beat_age or 0)} ago, and not running since.")
    if beat_age is None or beat_age > PROCESS_DOWN_AFTER_S:
        return Verdict("down", "bad",
                       f"No heartbeat for {ago(beat_age or 0)}: the process has exited or "
                       f"is frozen.")

    last_cycle = _at(beat, "last_cycle_at")
    last_error = _at(beat, "last_error_at")
    error_text = beat.get("last_error") or "an error"
    if last_error is not None and (last_cycle is None or last_error > last_cycle):
        failed_ago = ago(_since(last_error, now) or 0)
        return Verdict("failing", "bad",
                       f"Running, but its latest unit of work failed {failed_ago} ago: "
                       f"{error_text}")

    stall_after = PROCESS_STALLED_AFTER_S.get(name, 300)
    uptime = _since(_at(beat, "started_at"), now) or 0.0
    if last_cycle is None:
        if uptime > stall_after:
            return Verdict("stalled", "bad",
                           f"Running for {ago(uptime)} without completing any work.")
        return Verdict("starting", "ok", f"Started {ago(uptime)} ago; no work completed yet.")
    cycle_age = _since(last_cycle, now) or 0.0
    if cycle_age > stall_after:
        return Verdict("stalled", "bad",
                       f"Running, but nothing has completed for {ago(cycle_age)} — its work "
                       f"is hung or its loop has stopped going round.")

    recent = int(beat.get("recent_errors") or 0)
    if recent > 0:
        window = ago(PROCESS_RECENT_ERROR_WINDOW_S)
        return Verdict("degraded", "warn",
                       f"Working now, but {recent} unit(s) of work failed in the last {window}; "
                       f"the most recent: {error_text}")
    return Verdict("working", "ok", "Working.")


def assess_broker(ingest: Mapping[str, Any] | None, ingest_verdict: Verdict,
                  now: datetime) -> Verdict:
    """The broker as ingest sees it — the only view of it the platform has."""
    if ingest is None or ingest_verdict.state in ("not_seen", "stopped", "down"):
        return Verdict("unknown", "bad",
                       "Ingest is not running, so nothing is listening to the broker and "
                       "every message is waiting there, or lost.")
    extra = ingest.get("extra") or {}
    broker = extra.get("broker") or "the broker"
    topics = ", ".join(extra.get("topics") or []) or "no topics"
    if not extra.get("broker_connected"):
        error = extra.get("broker_error")
        return Verdict("disconnected", "bad",
                       f"Not connected to {broker}" + (f": {error}" if error else ".")
                       + " Ingest retries every few seconds.")
    last_message = _at(extra, "last_message_at")
    connected_at = _at(extra, "connected_at")
    quiet_for = _since(last_message or connected_at, now)
    if quiet_for is not None and quiet_for > BROKER_QUIET_AFTER_S:
        return Verdict("quiet", "warn",
                       f"Connected to {broker} and subscribed to {topics}, but nothing has "
                       f"arrived for {ago(quiet_for)}. Either every Plant is silent, or the "
                       f"equipment is publishing to another broker or on topics outside "
                       f"those filters — the two look identical from here.")
    if last_message is None:
        return Verdict("connected", "ok",
                       f"Connected to {broker}, subscribed to {topics}; no message yet.")
    return Verdict("connected", "ok",
                   f"Connected to {broker}, subscribed to {topics}; last message "
                   f"{ago(quiet_for or 0)} ago.")


def assess_supervisor(beat: Mapping[str, Any] | None, now: datetime) -> Verdict:
    if beat is None:
        return Verdict("absent", "warn",
                       "No supervisor: the processes were started by hand, and nothing "
                       "restarts one that crashes.")
    beat_age = _since(_at(beat, "beat_at"), now)
    if _at(beat, "stopped_at") is not None:
        return Verdict("stopped", "warn",
                       f"Stopped {ago(beat_age or 0)} ago. Nothing restarts a process that "
                       f"crashes until it runs again.")
    if beat_age is None or beat_age > PROCESS_DOWN_AFTER_S:
        return Verdict("down", "bad",
                       f"No heartbeat for {ago(beat_age or 0)}: the supervisor is not running, "
                       f"so nothing restarts a process that crashes.")
    return Verdict("working", "ok", "Running; restarts any process that exits.")


def overall(verdicts: Iterable[Verdict]) -> Tone:
    worst: Tone = "ok"
    for verdict in verdicts:
        if _TONE_ORDER[verdict.tone] > _TONE_ORDER[worst]:
            worst = verdict.tone
    return worst
