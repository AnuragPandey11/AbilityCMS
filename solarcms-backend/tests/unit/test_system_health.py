"""The platform's own health — `domain/system_health`, the heartbeat, the supervisor.

The case these exist for happened four times: a process alive, looping, logging
its own failure and carrying on, with nothing written for days while every
liveness check passed.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from solarcms.cache.heartbeat import Heartbeat
from solarcms.domain.assumptions import (
    BROKER_QUIET_AFTER_S,
    PROCESS_DOWN_AFTER_S,
    PROCESS_STALLED_AFTER_S,
    SUPERVISOR_MAX_BACKOFF_S,
    SUPERVISOR_STABLE_AFTER_S,
)
from solarcms.domain.system_health import (
    Verdict,
    ago,
    assess_broker,
    assess_process,
    assess_supervisor,
    overall,
)
from solarcms.supervisor import next_backoff

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)


def _iso(seconds_ago: float | None) -> str | None:
    return None if seconds_ago is None else (NOW - timedelta(seconds=seconds_ago)).isoformat()


def beat(*, beat_ago: float = 5, started_ago: float = 3600, cycle_ago: float | None = 5,
         error_ago: float | None = None, error: str | None = None, recent_errors: int = 0,
         stopped: bool = False, crashed: bool = False, **extra: Any) -> dict[str, Any]:
    return {
        "beat_at": _iso(beat_ago), "started_at": _iso(started_ago),
        "last_cycle_at": _iso(cycle_ago), "last_error_at": _iso(error_ago),
        "last_error": error, "recent_errors": recent_errors,
        "stopped_at": _iso(beat_ago) if stopped else None,
        "crashed_at": _iso(beat_ago) if crashed else None,
        "extra": extra,
    }


# ── One process ─────────────────────────────────────────────────────────────

def test_a_healthy_process_is_working() -> None:
    assert assess_process("scheduler", beat(), NOW).state == "working"


def test_never_heard_from_is_not_seen() -> None:
    verdict = assess_process("ingest", None, NOW)
    assert (verdict.state, verdict.tone) == ("not_seen", "bad")


def test_silence_past_the_threshold_is_down() -> None:
    assert assess_process("alarm", beat(beat_ago=PROCESS_DOWN_AFTER_S + 1), NOW).state == "down"
    assert assess_process("alarm", beat(beat_ago=PROCESS_DOWN_AFTER_S - 1), NOW).state == "working"


def test_a_clean_stop_and_a_crash_say_different_things() -> None:
    stopped = assess_process("scheduler", beat(stopped=True), NOW)
    crashed = assess_process("scheduler", beat(crashed=True, error="OperationalError: gone"), NOW)
    assert stopped.state == "stopped" and "cleanly" in stopped.reason
    assert crashed.state == "down" and "OperationalError" in crashed.reason


def test_alive_but_its_latest_work_failed_is_failing() -> None:
    # The case this module exists for: beating, looping, and failing every time.
    verdict = assess_process(
        "health_sweeper",
        beat(cycle_ago=600, error_ago=20, error="InsufficientPrivilege: permission denied"),
        NOW)
    assert (verdict.state, verdict.tone) == ("failing", "bad")
    assert "permission denied" in verdict.reason


def test_failing_even_if_it_never_once_succeeded() -> None:
    assert assess_process("alarm", beat(cycle_ago=None, error_ago=3, error="x"), NOW).state \
        == "failing"


def test_alive_with_no_work_completed_is_stalled() -> None:
    stall = PROCESS_STALLED_AFTER_S["scheduler"]
    assert assess_process("scheduler", beat(cycle_ago=stall + 10), NOW).state == "stalled"
    assert assess_process("scheduler", beat(cycle_ago=stall - 10), NOW).state == "working"


def test_a_fresh_start_is_starting_not_stalled() -> None:
    assert assess_process("ingest", beat(started_ago=10, cycle_ago=None), NOW).state \
        == "starting"
    assert assess_process("ingest", beat(started_ago=3600, cycle_ago=None), NOW).state \
        == "stalled"


def test_recent_errors_after_a_success_are_degraded() -> None:
    verdict = assess_process(
        "alarm", beat(cycle_ago=2, error_ago=300, error="boom", recent_errors=3), NOW)
    assert (verdict.state, verdict.tone) == ("degraded", "warn")
    assert "3 unit(s)" in verdict.reason


# ── The broker, as ingest sees it ───────────────────────────────────────────

def _broker(ingest: dict[str, Any] | None) -> Verdict:
    return assess_broker(ingest, assess_process("ingest", ingest, NOW), NOW)


def test_no_ingest_means_nobody_is_listening() -> None:
    assert _broker(None).state == "unknown"


def test_disconnected_says_why() -> None:
    verdict = _broker(beat(broker="localhost:1883", broker_connected=False,
                           broker_error="Connection refused"))
    assert verdict.state == "disconnected" and "Connection refused" in verdict.reason


def test_connected_and_delivering() -> None:
    verdict = _broker(beat(broker="localhost:1883", broker_connected=True, topics=["scms/v1/#"],
                           connected_at=_iso(3600), last_message_at=_iso(3)))
    assert (verdict.state, verdict.tone) == ("connected", "ok")


def test_connected_but_silent_names_both_explanations() -> None:
    # The 27-hour failure: a filter matching nothing delivers nothing, and
    # nothing is quarantined — from here it is identical to every Plant quiet.
    verdict = _broker(beat(broker="localhost:1883", broker_connected=True,
                           topics=["KULAR_GREEN/#"], connected_at=_iso(90_000),
                           last_message_at=_iso(BROKER_QUIET_AFTER_S + 60)))
    assert (verdict.state, verdict.tone) == ("quiet", "warn")
    assert "another broker" in verdict.reason and "KULAR_GREEN/#" in verdict.reason


def test_never_a_message_since_connecting_long_ago_is_quiet() -> None:
    verdict = _broker(beat(broker_connected=True, connected_at=_iso(BROKER_QUIET_AFTER_S * 2)))
    assert verdict.state == "quiet"


# ── The supervisor, and the whole ───────────────────────────────────────────

def test_no_supervisor_is_a_warning_not_an_outage() -> None:
    verdict = assess_supervisor(None, NOW)
    assert (verdict.state, verdict.tone) == ("absent", "warn")
    assert "nothing restarts" in verdict.reason


def test_the_worst_verdict_is_the_whole() -> None:
    ok, warn, bad = (Verdict("working", t, "") for t in ("ok", "warn", "bad"))
    assert overall([ok, ok]) == "ok"
    assert overall([ok, warn]) == "warn"
    assert overall([warn, bad, ok]) == "bad"


def test_spans_read_at_a_glance() -> None:
    spans = [ago(40), ago(12 * 60), ago(3 * 3600), ago(3 * 86400)]
    assert spans == ["40 s", "12 min", "3 h", "3 d"]


# ── The heartbeat's own bookkeeping ─────────────────────────────────────────

def test_a_heartbeat_records_work_writes_and_failures_separately() -> None:
    heartbeat = Heartbeat("scheduler")
    heartbeat.cycle()
    heartbeat.wrote("12 Plant KPI value(s)")
    heartbeat.failed(PermissionError("permission denied for table alarms\n  more"))
    snap = heartbeat.snapshot()
    assert snap["cycles"] == 1 and snap["last_write"] == "12 Plant KPI value(s)"
    # One line, bounded — it is shown on a page.
    assert snap["last_error"] == "PermissionError: permission denied for table alarms more"
    assert snap["errors"] == 1 and snap["recent_errors"] == 1
    assert snap["crashed_at"] is None


def test_a_crash_is_never_recorded_as_a_clean_stop() -> None:
    heartbeat = Heartbeat("ingest", broker_connected=True)
    heartbeat.crashed(RuntimeError("pool closed"))
    snap = heartbeat.snapshot()
    assert snap["crashed_at"] is not None and snap["stopped_at"] is None
    assert snap["extra"]["broker_connected"] is True


# ── Restart backoff ─────────────────────────────────────────────────────────

def test_a_crash_loop_backs_off_to_the_ceiling() -> None:
    delays = []
    delay = 1.0
    for _ in range(10):
        delay = next_backoff(delay, ran_for_s=2)
        delays.append(delay)
    assert delays[:4] == [2.0, 4.0, 8.0, 16.0]
    assert max(delays) == SUPERVISOR_MAX_BACKOFF_S


def test_a_process_that_stayed_up_restarts_at_once() -> None:
    assert next_backoff(SUPERVISOR_MAX_BACKOFF_S, ran_for_s=SUPERVISOR_STABLE_AFTER_S) == 1.0
