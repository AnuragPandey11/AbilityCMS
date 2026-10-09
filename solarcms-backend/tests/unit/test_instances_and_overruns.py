"""Several copies of a worker, and a periodic job that falls behind.

docs/CAPACITY_AND_DEPLOYMENT.md §4.6, §4.7, §4.10: two copies overwrote one
heartbeat key, and a sweep taking 107 s per 60 s pass was reported `working`.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.cache.heartbeat import choose_active
from solarcms.domain.system_health import assess_process
from solarcms.workers.leadership import lock_key

NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)


def beat(role: str, seconds_ago: float, **extra: object) -> dict[str, object]:
    at = (NOW - timedelta(seconds=seconds_ago)).isoformat()
    return {"instance": f"host:{role}", "beat_at": at, "started_at": at,
            "last_cycle_at": at, "extra": {"role": role, **extra}}


def test_the_working_copy_speaks_for_the_process_over_a_newer_standby() -> None:
    active, standby = beat("active", 10), beat("standby", 1)
    assert choose_active([standby, active]) is active


def test_with_only_standbys_left_the_newest_one_is_shown() -> None:
    older, newer = beat("standby", 20), beat("standby", 2)
    assert choose_active([older, newer]) is newer


def test_a_pass_slower_than_its_interval_is_degraded() -> None:
    sweep = beat("active", 5, passes={"sweep": {"took_s": 107.0, "every_s": 60}})
    verdict = assess_process("health_sweeper", sweep, NOW)
    assert verdict.state == "degraded"
    assert "107 s against a 60 s interval" in verdict.reason


def test_a_pass_within_its_interval_is_working() -> None:
    sweep = beat("active", 5, passes={"sweep": {"took_s": 0.4, "every_s": 60}})
    assert assess_process("health_sweeper", sweep, NOW).state == "working"


def test_lock_keys_are_stable_and_distinct() -> None:
    assert lock_key("ingest") == lock_key("ingest")
    assert len({lock_key(p) for p in ("ingest", "alarm", "health_sweeper", "scheduler")}) == 4
