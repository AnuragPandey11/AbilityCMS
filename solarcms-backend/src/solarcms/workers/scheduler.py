"""Cron-like work: escalation timers, report schedules, aggregate verification.

    python -m solarcms.workers.scheduler

Everything here is periodic and none of it is driven by arriving data — which is
exactly why it cannot live in the ingest or alarm worker.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import signal
from datetime import UTC, datetime

import structlog
from sqlalchemy import text

from solarcms.cache.live import close_redis
from solarcms.config import get_settings
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.alarm_logic import should_escalate
from solarcms.logging import configure_logging
from solarcms.services.notifications import record_and_send
from solarcms.services.reporting import (
    FinancialSourceUnavailable,
    gather,
    render_pdf,
    render_xlsx,
)
from solarcms.services.storage import artifact_key, get_store

log = structlog.get_logger("scheduler")

TICK_SECONDS = 60


async def fire_due_escalations() -> int:
    """Escalate Alarms left unacknowledged past a Step's delay.

    Gated by `min_severity`: a Low-severity Alarm never escalates, however long
    it sits. ⚠ Driven by `notify_user_id` — named people — because tender §23's
    three levels cannot be expressed by role under the CONFIRMED four-role model
    (MASTER §3.6, OPEN-2).
    """
    fired = 0
    now = datetime.now(UTC)
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as session:
        due = (await session.execute(text("""
            SELECT a.id AS alarm_id, a.client_id, a.severity, a.escalation_level,
                   s.id AS step_id, s.level, s.channel, s.notify_user_id,
                   s.notify_role_id, p.min_severity
              FROM alarms a
              JOIN escalation_policies p
                ON p.client_id = a.client_id AND p.enabled
               AND (p.scope_type = 'client'
                    OR (p.scope_type = 'plant' AND p.scope_id = a.plant_id))
              JOIN escalation_steps s
                ON s.policy_id = p.id AND s.level = a.escalation_level + 1
             WHERE a.state = 'active'
               AND a.opened_at + (s.delay_minutes || ' minutes')::interval <= :now
        """), {"now": now})).all()

        for row in due:
            if not should_escalate(row.severity, row.min_severity):
                continue
            # ⚠ notify_user_id is preferred; notify_role_id is the coarse
            # fallback, because tender §23's three levels cannot be expressed by
            # role under the CONFIRMED four-role model (OPEN-2). When a Step names
            # a role rather than a person, every holder of that role is notified.
            recipients: list[int | None] = []
            if row.notify_user_id is not None:
                recipients.append(row.notify_user_id)
            elif row.notify_role_id is not None:
                members = (await session.execute(text("""
                    SELECT m.user_id FROM memberships m
                     WHERE m.client_id = :client_id AND m.role_id = :role_id
                """), {"client_id": row.client_id,
                       "role_id": row.notify_role_id})).all()
                recipients.extend(m.user_id for m in members)
            if not recipients:
                recipients.append(None)

            for recipient in recipients:
                await record_and_send(
                    session, client_id=row.client_id, channel=row.channel,
                    message=f"Escalation level {row.level}: alarm {row.alarm_id} "
                            f"is still unacknowledged",
                    recipient_user_id=recipient, alarm_id=row.alarm_id,
                    escalation_level=row.level,
                    subject=f"[ESCALATION L{row.level}] SolarCMS alarm {row.alarm_id}",
                )
            await session.execute(
                text("UPDATE alarms SET escalation_level = :level WHERE id = :id"),
                {"level": row.level, "id": row.alarm_id},
            )
            fired += 1
            log.info("escalated", alarm_id=row.alarm_id, level=row.level,
                     channel=row.channel)
    return fired


async def run_queued_reports(limit: int = 5) -> int:
    """Render Reports that are queued, oldest first.

    Claimed with `FOR UPDATE SKIP LOCKED` so that two scheduler processes never
    render the same run twice — the state column alone would race.
    """
    rendered = 0
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        claimed = (await s.execute(text("""
            UPDATE report_runs SET state = 'running'
             WHERE id IN (
                SELECT id FROM report_runs WHERE state = 'queued'
                 ORDER BY created_at LIMIT :limit FOR UPDATE SKIP LOCKED)
            RETURNING id, client_id, definition_id, period_start, period_end
        """), {"limit": limit})).all()

    for run in claimed:
        try:
            async with scoped_session(
                SecurityContext.platform(0), role=SCHEDULER_ROLE
            ) as s:
                data = await gather(
                    s, definition_id=run.definition_id,
                    period_start=run.period_start, period_end=run.period_end,
                    client_id=run.client_id,
                )
                store = get_store()
                artifacts: dict[str, str] = {}

                xlsx_key = artifact_key(run.client_id, run.id, "xlsx")
                await store.put(xlsx_key, render_xlsx(data),
                                "application/vnd.openxmlformats-officedocument."
                                "spreadsheetml.sheet")
                artifacts["xlsx"] = await store.signed_url(xlsx_key)

                pdf = render_pdf(data)
                if pdf is not None:
                    pdf_key = artifact_key(run.client_id, run.id, "pdf")
                    await store.put(pdf_key, pdf, "application/pdf")
                    artifacts["pdf"] = await store.signed_url(pdf_key)
                else:
                    # Recorded rather than silently omitted, so a missing PDF is
                    # traceable to the absent optional dependency.
                    artifacts["pdf_unavailable"] = (
                        "weasyprint is not installed; install the 'reports' extra"
                    )

                await s.execute(text("""
                    UPDATE report_runs
                       SET state = 'succeeded', completed_at = now(),
                           row_count = :rows, artifact_urls = CAST(:urls AS jsonb)
                     WHERE id = :id
                """), {"id": run.id, "rows": len(data.rows),
                       "urls": json.dumps(artifacts)})
            rendered += 1
            log.info("report rendered", run_id=run.id, rows=len(data.rows),
                     formats=sorted(artifacts))
        except FinancialSourceUnavailable as exc:
            # I-11 refusing to compute from an MFM is a correct outcome, not a
            # crash: the run fails with a reason a person can act on.
            await _fail_run(run.id, str(exc))
            log.warning("financial report refused", run_id=run.id, reason=str(exc))
        except Exception as exc:
            await _fail_run(run.id, str(exc))
            log.error("report failed", run_id=run.id, error=str(exc))
    return rendered


async def _fail_run(run_id: int, error: str) -> None:
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        await s.execute(text("""
            UPDATE report_runs SET state = 'failed', completed_at = now(), error = :err
             WHERE id = :id
        """), {"id": run_id, "err": error[:2000]})


async def verify_aggregates() -> list[str]:
    """Alarm if a continuous aggregate has stopped refreshing.

    A stalled aggregate is invisible everywhere else: raw data keeps arriving and
    only the tier serving week and month views quietly stops advancing.
    """
    stalled: list[str] = []
    async with scoped_session(SecurityContext.platform(0), role=None) as session:
        rows = (await session.execute(text("""
            SELECT j.hypertable_name, js.last_successful_finish
              FROM timescaledb_information.jobs j
              JOIN timescaledb_information.job_stats js USING (job_id)
             WHERE j.proc_name = 'policy_refresh_continuous_aggregate'
        """))).all()
        for row in rows:
            if row.last_successful_finish is None:
                continue
            age = (datetime.now(UTC) - row.last_successful_finish).total_seconds()
            # Two hours: comfortably beyond the slowest configured refresh (1h)
            # without alarming on a single missed run.
            if age > 7200:
                stalled.append(row.hypertable_name)
                log.error("continuous aggregate stalled",
                          hypertable=row.hypertable_name, age_seconds=age)
    return stalled


async def run() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopping.set)

    log.info("scheduler started", tick_seconds=TICK_SECONDS)
    while not stopping.is_set():
        try:
            escalated = await fire_due_escalations()
            rendered = await run_queued_reports()
            stalled = await verify_aggregates()
            if escalated or rendered or stalled:
                log.info("tick", escalated=escalated, rendered=rendered,
                         stalled=stalled)
        except Exception as exc:
            log.error("scheduler tick failed", error=str(exc))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stopping.wait(), timeout=TICK_SECONDS)

    await close_redis()
    await dispose_engine()
    log.info("scheduler stopped")


if __name__ == "__main__":
    asyncio.run(run())
