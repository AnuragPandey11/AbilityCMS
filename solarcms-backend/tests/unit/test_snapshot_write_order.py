"""A scheduler pass writes a Plant's copies in the order an edit's set-aside
locks them (`services/snapshots`), so the two can never deadlock.

22 Oct 2026: the pass wrote dashboard, today, month, year, lifetime as it
worked each out, inside one long transaction, and an edit's set-aside — a plain
UPDATE, locking in disk order — met it from the other end.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

import pytest

from solarcms.services import snapshots


class _Recorder:
    def __init__(self) -> None:
        self.kinds: list[str] = []

    async def execute(self, _statement: Any, params: dict[str, Any]) -> None:
        self.kinds.append(params["kind"])


@pytest.mark.asyncio
async def test_copies_are_written_in_the_order_the_set_aside_locks_them() -> None:
    session = _Recorder()
    worked_out = [("dashboard", {}), ("kpis:today", {}), ("kpis:month", {}),
                  ("kpis:year", {}), ("kpis:lifetime", {})]
    await snapshots._store_all(session, 1, 1, datetime.now(UTC), worked_out)  # type: ignore[arg-type]
    # Byte order, as the set-aside's `ORDER BY plant_id, kind COLLATE "C"`.
    assert session.kinds == ["dashboard", "kpis:lifetime", "kpis:month",
                             "kpis:today", "kpis:year"]
    assert session.kinds == sorted(session.kinds, key=lambda kind: kind.encode())
