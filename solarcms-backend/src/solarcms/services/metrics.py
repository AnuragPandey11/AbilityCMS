"""Process health as Prometheus text, for `GET /health/metrics` (§6.6).

docs/CAPACITY_AND_DEPLOYMENT.md §6.6: "process health exported (queue depth,
flush time, sweep duration, stream backlog), so a slow decline is seen before
it becomes an outage". System Health shows the same facts to a person; this
gives them to a monitoring agent (Prometheus, Grafana Agent, the CloudWatch
agent's Prometheus scraper), which can draw a trend and raise an alarm from
outside the app — the one thing the app cannot do for itself when it is down.

From the heartbeats in Redis only, like `/health/processes`. Every name is
`solarcms_*`; every process series carries `process` and `instance` labels.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from solarcms.cache import keys
from solarcms.cache.heartbeat import (
    PROCESSES,
    SUPERVISOR,
    instance_role,
    read_heartbeat_instances,
)
from solarcms.cache.live import get_redis
from solarcms.domain.system_health import assess_process, assess_supervisor

#: Heartbeat extras exported as gauges, by process.
GAUGES: dict[str, tuple[tuple[str, str], ...]] = {
    "ingest": (
        ("incoming_queue", "Messages received from the broker and not yet handled."),
        ("buffered_rows", "Readings decoded and waiting for the next save."),
        ("unacknowledged", "QoS 1 messages saved-pending; the broker still holds them."),
        ("last_flush_s", "How long the latest save took, in seconds."),
        ("last_flush_rows", "Readings written by the latest save."),
        ("messages", "Messages received since the process started."),
    ),
}


def _label(value: Any) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _seconds_since(value: Any, now: datetime) -> float | None:
    if not value:
        return None
    try:
        return (now - datetime.fromisoformat(str(value))).total_seconds()
    except ValueError:
        return None


async def render_metrics(now: datetime | None = None) -> str:
    moment = now or datetime.now(UTC)
    lines: list[str] = []

    def metric(name: str, help_text: str, kind: str = "gauge") -> None:
        lines.append(f"# HELP solarcms_{name} {help_text}")
        lines.append(f"# TYPE solarcms_{name} {kind}")

    rows: list[tuple[str, dict[str, Any]]] = []
    for process in (*PROCESSES, SUPERVISOR):
        for beat in await read_heartbeat_instances(process):
            if (_seconds_since(beat.get("beat_at"), moment) or 1e9) <= 600:
                rows.append((process, beat))

    def labels(process: str, beat: dict[str, Any], **more: Any) -> str:
        pairs = {"process": process,
                 "instance": beat.get("instance") or f"{beat.get('host')}:{beat.get('pid')}",
                 "role": instance_role(beat), **more}
        return "{" + ",".join(f'{k}="{_label(v)}"' for k, v in pairs.items()) + "}"

    metric("process_working", "1 when the process's own verdict is working, else 0.")
    for process, beat in rows:
        verdict = (assess_supervisor(beat, moment) if process == SUPERVISOR
                   else assess_process(process, beat, moment))
        lines.append(f"solarcms_process_working{labels(process, beat, state=verdict.state)} "
                     f"{1 if verdict.state == 'working' else 0}")

    metric("heartbeat_age_seconds", "Seconds since the process last beat.")
    for process, beat in rows:
        age = _seconds_since(beat.get("beat_at"), moment)
        if age is not None:
            lines.append(f"solarcms_heartbeat_age_seconds{labels(process, beat)} {age:.1f}")

    metric("last_cycle_age_seconds", "Seconds since the process last completed a unit of work.")
    for process, beat in rows:
        age = _seconds_since(beat.get("last_cycle_at"), moment)
        if age is not None:
            lines.append(f"solarcms_last_cycle_age_seconds{labels(process, beat)} {age:.1f}")

    metric("recent_errors", "Units of work that failed within the recent window.")
    for process, beat in rows:
        lines.append(f"solarcms_recent_errors{labels(process, beat)} "
                     f"{int(beat.get('recent_errors') or 0)}")

    metric("pass_seconds", "How long a periodic job's latest pass took.")
    metric("pass_interval_seconds", "The interval that pass is meant to fit within.")
    for process, beat in rows:
        for job, timing in ((beat.get("extra") or {}).get("passes") or {}).items():
            lab = labels(process, beat, job=job)
            lines.append(f"solarcms_pass_seconds{lab} {float(timing.get('took_s') or 0):.3f}")
            lines.append(f"solarcms_pass_interval_seconds{lab} "
                         f"{float(timing.get('every_s') or 0):.0f}")

    for process, gauges in GAUGES.items():
        for name, help_text in gauges:
            metric(f"{process}_{name}", help_text)
            for row_process, beat in rows:
                if row_process != process:
                    continue
                value = (beat.get("extra") or {}).get(name)
                if isinstance(value, int | float):
                    lines.append(f"solarcms_{process}_{name}{labels(process, beat)} {value}")

    # The alarm worker's backlog: entries not yet delivered plus delivered and
    # not acknowledged — what is actually waiting to be checked.
    metric("alarm_backlog", "Readings waiting for the alarm worker.")
    try:
        for group in await get_redis().xinfo_groups(keys.STREAM_READINGS):
            if group.get("name") == keys.STREAM_READINGS_GROUP and group.get("lag") is not None:
                backlog = int(group["lag"]) + int(group.get("pending") or 0)
                lines.append(f"solarcms_alarm_backlog {backlog}")
    except Exception:
        pass

    return "\n".join(lines) + "\n"
