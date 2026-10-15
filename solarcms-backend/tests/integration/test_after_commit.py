"""`db/session.after_commit`: a follow-up that runs only once a change is visible.

It exists for the snapshot set-aside (migration 0042) but is general, and each
of its promises is one a caller relies on without checking: that the step sees
the committed change, that a rolled-back edit runs nothing, that a route
editing several rows registers once, and that a failing step never reports a
saved edit as a failed one. Against the real database, because "after the
commit" is a claim about Postgres, not about the code's order of lines.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import text

from solarcms.db import session as session_module
from solarcms.db.rls import API_ROLE, SecurityContext
from solarcms.db.session import after_commit, scoped_session
from tests.conftest import requires_db
from tests.integration.test_scale import _client_with_plant

pytestmark = [pytest.mark.asyncio, requires_db]

PLATFORM = SecurityContext.platform(0)


async def _plant_name(plant_id: int) -> str:
    async with scoped_session(PLATFORM, role=None) as s:
        return str((await s.execute(text("SELECT name FROM plants WHERE id = :p"),
                                    {"p": plant_id})).scalar_one())


class TestAfterCommit:
    async def test_the_step_sees_the_committed_change(self) -> None:
        # Its whole point: run between the statement and the commit, a reader
        # could see the old rows and record them as current.
        plant = await _client_with_plant()
        seen: list[str] = []

        async def read_back(context: SecurityContext, role: str | None) -> None:
            seen.append(await _plant_name(plant["plant_id"]))

        async with scoped_session(PLATFORM, role=None) as s:
            await s.execute(text("UPDATE plants SET name = 'Renamed' WHERE id = :p"),
                            {"p": plant["plant_id"]})
            after_commit(s, "read-back", read_back)
            assert seen == [], "a step ran before the transaction ended"
        assert seen == ["Renamed"]

    async def test_the_step_is_given_the_transactions_context_and_role(self) -> None:
        given: list[tuple[SecurityContext, str | None]] = []

        async def record(context: SecurityContext, role: str | None) -> None:
            given.append((context, role))

        async with scoped_session(PLATFORM, role=API_ROLE) as s:
            after_commit(s, "record", record)
        assert given == [(PLATFORM, API_ROLE)]

    async def test_a_rolled_back_transaction_runs_nothing(self) -> None:
        plant = await _client_with_plant()
        ran: list[str] = []

        async def step(context: SecurityContext, role: str | None) -> None:
            ran.append("ran")

        with pytest.raises(RuntimeError, match="refused"):
            async with scoped_session(PLATFORM, role=None) as s:
                await s.execute(text("UPDATE plants SET name = 'Never' WHERE id = :p"),
                                {"p": plant["plant_id"]})
                after_commit(s, "step", step)
                raise RuntimeError("refused")
        assert ran == []
        assert await _plant_name(plant["plant_id"]) == "Scale Plant"

    async def test_one_key_runs_once_and_the_first_registration_wins(self) -> None:
        ran: list[str] = []

        def step(name: str) -> Any:
            async def run(context: SecurityContext, role: str | None) -> None:
                ran.append(name)
            return run

        async with scoped_session(PLATFORM, role=None) as s:
            after_commit(s, "a", step("a-first"))
            after_commit(s, "b", step("b"))
            after_commit(s, "a", step("a-second"))
        assert ran == ["a-first", "b"]

    async def test_a_failing_step_is_logged_and_never_raised(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # The edit it follows is already committed: raising now would tell the
        # browser a saved edit failed. The steps after it still run.
        plant = await _client_with_plant()
        logged: list[tuple[str, dict[str, Any]]] = []

        class Recorder:
            def error(self, event: str, **fields: Any) -> None:
                logged.append((event, fields))

        monkeypatch.setattr(session_module, "log", Recorder())
        ran: list[str] = []

        async def broken(context: SecurityContext, role: str | None) -> None:
            raise ValueError("permission denied")

        async def fine(context: SecurityContext, role: str | None) -> None:
            ran.append("fine")

        async with scoped_session(PLATFORM, role=None) as s:
            await s.execute(text("UPDATE plants SET name = 'Kept' WHERE id = :p"),
                            {"p": plant["plant_id"]})
            after_commit(s, "broken", broken)
            after_commit(s, "fine", fine)

        assert await _plant_name(plant["plant_id"]) == "Kept"
        assert ran == ["fine"]
        assert len(logged) == 1
        event, fields = logged[0]
        assert event == "after-commit step failed"
        assert fields["step"] == "broken"
        assert "permission denied" in fields["error"]

    async def test_a_step_belongs_to_its_own_transaction(self) -> None:
        ran: list[str] = []

        async def step(context: SecurityContext, role: str | None) -> None:
            ran.append("ran")

        async with scoped_session(PLATFORM, role=None) as s:
            after_commit(s, "step", step)
        async with scoped_session(PLATFORM, role=None):
            pass
        assert ran == ["ran"]
