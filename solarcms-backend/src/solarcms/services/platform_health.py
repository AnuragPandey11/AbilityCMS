"""The platform's own health, from the processes' heartbeats — System Health.

Redis only, no database: cheap enough for the header to ask every few seconds,
and still answerable when Postgres is the thing that is down — which is exactly
when the answer matters. The verdicts are `domain/system_health.py`'s; this
module only gathers the heartbeats and lays them side by side.
"""

from __future__ import annotations

import os
import socket
from datetime import UTC, datetime
from typing import Any

from solarcms.cache.heartbeat import PROCESSES, SUPERVISOR, read_heartbeats
from solarcms.domain.system_health import (
    Verdict,
    assess_broker,
    assess_process,
    assess_supervisor,
    overall,
)

#: What each process is for, in the words the page uses.
PURPOSE: dict[str, str] = {
    "api": "Serves every screen and the live socket.",
    "ingest": "Receives every message from the broker, decodes it and saves it.",
    "alarm": "Checks each saved reading against the Alarm Rules and raises Alarms.",
    "health_sweeper": "Every minute: which Devices are reporting, and absence Alarms.",
    "scheduler": "Plant KPIs, reports and Alarm escalations, every minute.",
}

_BEAT_FIELDS = (
    "pid", "host", "started_at", "beat_at", "last_cycle_at", "cycles", "last_write_at",
    "last_write", "last_error_at", "last_error", "errors", "recent_errors",
)


def _row(name: str, verdict: Verdict, beat: dict[str, Any] | None,
         supervised: dict[str, Any] | None) -> dict[str, Any]:
    return {
        "name": name,
        "purpose": PURPOSE.get(name, ""),
        "state": verdict.state,
        "tone": verdict.tone,
        "reason": verdict.reason,
        **{field: (beat or {}).get(field) for field in _BEAT_FIELDS},
        # What the supervisor knows of it: restarts and the last exit. None when
        # it is not supervised, which the page says rather than leaving blank.
        "supervised": supervised,
        # Every copy heard from recently — the working one and any standbys
        # (workers/leadership.py, §4.6/§4.7). The verdict above is the working
        # copy's.
        "instances": (beat or {}).get("instances") or [],
        "role": ((beat or {}).get("extra") or {}).get("role"),
        "passes": ((beat or {}).get("extra") or {}).get("passes") or {},
    }


async def platform_health(now: datetime | None = None) -> dict[str, Any]:
    moment = now or datetime.now(UTC)
    try:
        beats = await read_heartbeats((*PROCESSES, SUPERVISOR))
    except Exception as exc:
        # Every heartbeat lives in Redis, so with Redis gone none can be judged
        # — and the live values, the socket and the alarm stream are gone too.
        return {
            "as_of": moment, "overall": "bad",
            "redis": {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
            "processes": [], "broker": None, "supervisor": None,
        }

    supervisor_beat = beats[SUPERVISOR]
    supervisor = assess_supervisor(supervisor_beat, moment)
    # A dead supervisor's list of children is history, not the present.
    children: dict[str, Any] = (
        (supervisor_beat or {}).get("extra", {}).get("children", {})
        if supervisor.state == "working" else {}
    )

    verdicts: list[Verdict] = []
    processes: list[dict[str, Any]] = []
    # The API is answering this request, so it is running by definition; what is
    # worth showing is whether the supervisor has had to restart it.
    api = Verdict("working", "ok", "Running: it is serving this page.")
    processes.append({
        **_row("api", api, {"pid": os.getpid(), "host": socket.gethostname()},
               children.get("api")),
    })
    for name in PROCESSES:
        verdict = assess_process(name, beats[name], moment)
        verdicts.append(verdict)
        processes.append(_row(name, verdict, beats[name], children.get(name)))

    ingest_beat = beats["ingest"]
    ingest_verdict = next(v for n, v in zip(PROCESSES, verdicts, strict=True) if n == "ingest")
    broker = assess_broker(ingest_beat, ingest_verdict, moment)
    extra = (ingest_beat or {}).get("extra", {})

    return {
        "as_of": moment,
        "overall": overall([*verdicts, broker, supervisor]),
        "redis": {"ok": True, "error": None},
        "processes": processes,
        "broker": {
            "state": broker.state, "tone": broker.tone, "reason": broker.reason,
            "broker": extra.get("broker"), "topics": extra.get("topics") or [],
            "connected": bool(extra.get("broker_connected")),
            "connected_at": extra.get("connected_at"),
            "last_message_at": extra.get("last_message_at"),
            "messages": extra.get("messages"),
            "error": extra.get("broker_error"),
        },
        "supervisor": {
            "state": supervisor.state, "tone": supervisor.tone, "reason": supervisor.reason,
            **{field: (supervisor_beat or {}).get(field)
               for field in ("pid", "host", "started_at", "beat_at")},
            "log_dir": (supervisor_beat or {}).get("extra", {}).get("log_dir"),
        },
    }
