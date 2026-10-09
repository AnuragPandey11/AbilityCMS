"""Cron-like work: escalation timers, notification delivery, report schedules,
aggregate verification, Plant KPIs.

    python -m solarcms.workers.scheduler

Everything here is periodic and none of it is driven by arriving data — which is
exactly why it cannot live in the ingest or alarm worker.

**Three loops, independent of one another** (8 Oct 2026). They used to be one
60-second tick run in sequence, so a slow report delayed every escalation and
the Plant KPIs behind it, and one failing step skipped the rest of the tick:

* the core tick — escalations, aggregate checks, Plant KPIs — each step on its
  own, so one failing does not cost the others their turn;
* notification delivery, every few seconds (`services/notifications.deliver_due`);
* report rendering, off the event loop in a thread, since a large PDF is CPU;
* Plant snapshots — every Plant's dashboard every 15 s and its KPIs once a
  minute, stored for the screens to read (`services/snapshots.py`, §4.4).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import signal
from datetime import UTC, datetime

import structlog
from sqlalchemy import text

from solarcms.cache.heartbeat import Heartbeat
from solarcms.cache.live import close_redis
from solarcms.config import get_settings
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.alarm_logic import should_escalate
from solarcms.logging import configure_logging
from solarcms.services import snapshots
from solarcms.services.notifications import deliver_due, queue_notification
from solarcms.services.plant_kpi import compute as compute_plant_kpis
from solarcms.services.reporting import (
    FinancialSourceUnavailable,
    gather,
    render_pdf,
    render_xlsx,
)
from solarcms.services.seed import DERIVED_TAGS
from solarcms.services.storage import artifact_key, get_store
from solarcms.workers.leadership import Leadership

log = structlog.get_logger("scheduler")

TICK_SECONDS = 60
#: How often queued notifications are looked for. An Alarm's message waits at
#: most this long after the Alarm is raised.
NOTIFY_POLL_SECONDS = 2
REPORT_POLL_SECONDS = 15


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

            # Queued with the escalation in one transaction, and sent by the
            # delivery loop: a slow mail server cannot hold up the next one.
            for recipient in recipients:
                await queue_notification(
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

                # Rendering is CPU work: in a thread, so the delivery loop and
                # the escalation timer keep running while a large report renders.
                xlsx_key = artifact_key(run.client_id, run.id, "xlsx")
                await store.put(xlsx_key, await asyncio.to_thread(render_xlsx, data),
                                "application/vnd.openxmlformats-officedocument."
                                "spreadsheetml.sheet")
                artifacts["xlsx"] = await store.signed_url(xlsx_key)

                pdf = await asyncio.to_thread(render_pdf, data)
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


async def run_plant_kpis() -> dict[str, int]:
    """Compute each Plant's own figures — PR, CUF, peak, start and stop times.

    Runs on the scheduler because it is the only process that sees a whole Plant
    at once: ingest sees one Device's message, and a Plant's PR needs its meters
    and its Weather Station together.

    ⚠ A worker that catches and logs its own main loop needs a test that asserts
    a row was written — migration 0015 created a policy without the matching
    GRANT and every health sweep failed silently for weeks (CLAUDE.md). The
    integration suite asserts a Reading appears on the KPI Device.
    """
    async with scoped_session(
        SecurityContext.platform(0), role=SCHEDULER_ROLE
    ) as session:
        return await compute_plant_kpis(session, list(DERIVED_TAGS),
                                        tick_seconds=TICK_SECONDS)


async def _wait(stopping: asyncio.Event, seconds: float) -> None:
    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(stopping.wait(), timeout=seconds)


async def _core_loop(stopping: asyncio.Event, heartbeat: Heartbeat) -> None:
    """Escalations, aggregate checks and Plant KPIs, each step on its own."""
    loop = asyncio.get_running_loop()
    while not stopping.is_set():
        began = loop.time()
        escalated = rendered_kpis = 0
        failed = False
        stalled: list[str] = []
        try:
            escalated = await fire_due_escalations()
        except Exception as exc:
            failed = True
            log.error("escalations failed", error=str(exc))
            heartbeat.failed(exc)
        try:
            stalled = await verify_aggregates()
            # A stalled aggregate is the scheduler reporting a fault it found,
            # not one it has — kept beside its heartbeat so the page can say.
            heartbeat.extra["stalled_aggregates"] = list(stalled)
        except Exception as exc:
            failed = True
            log.error("aggregate check failed", error=str(exc))
            heartbeat.failed(exc)
        try:
            rendered_kpis = (await run_plant_kpis()).get("values", 0)
        except Exception as exc:
            failed = True
            log.error("plant kpis failed", error=str(exc))
            heartbeat.failed(exc)
        if escalated or stalled:
            log.info("tick", escalated=escalated, stalled=stalled, kpi_values=rendered_kpis)
        if not failed:
            heartbeat.cycle()
        heartbeat.wrote(f"{rendered_kpis} Plant KPI value(s), {escalated} escalation(s)")
        took = loop.time() - began
        heartbeat.timed("core", took, TICK_SECONDS)
        await _wait(stopping, max(0.0, TICK_SECONDS - took))


async def _delivery_loop(stopping: asyncio.Event, heartbeat: Heartbeat) -> None:
    """Send queued notifications — Alarms, absence Alarms, escalations."""
    while not stopping.is_set():
        try:
            counts = await deliver_due()
            if counts:
                heartbeat.extra["notifications"] = counts
                if counts.get("sent"):
                    heartbeat.wrote(f"{counts['sent']} notification(s) sent")
        except Exception as exc:
            log.error("notification delivery failed", error=str(exc))
            heartbeat.failed(exc)
        await _wait(stopping, NOTIFY_POLL_SECONDS)


async def _report_loop(stopping: asyncio.Event, heartbeat: Heartbeat) -> None:
    while not stopping.is_set():
        try:
            rendered = await run_queued_reports()
            if rendered:
                heartbeat.wrote(f"{rendered} report(s) rendered")
        except Exception as exc:
            log.error("report loop failed", error=str(exc))
            heartbeat.failed(exc)
        await _wait(stopping, REPORT_POLL_SECONDS)


async def _snapshot_loop(stopping: asyncio.Event, heartbeat: Heartbeat) -> None:
    """Keep every Plant's stored dashboard and KPIs fresh (`services/snapshots`).

    A pass that overruns its interval starts the next at once rather than
    drifting further behind, and the pass time is on the heartbeat so System
    Health can say when the fleet has outgrown the interval (§4.10).
    """
    last_kpis = 0.0
    loop = asyncio.get_running_loop()
    while not stopping.is_set():
        began = loop.time()
        kpis_due = began - last_kpis >= snapshots.KPI_INTERVAL_S
        try:
            stats = await snapshots.refresh_all(
                kpis=kpis_due,
                on_error=lambda plant_id, exc: heartbeat.failed(
                    f"snapshot of Plant {plant_id}: {type(exc).__name__}: {exc}"),
            )
            if kpis_due:
                last_kpis = began
            heartbeat.extra["snapshots"] = stats
            if stats["stored"]:
                heartbeat.wrote(f"{stats['stored']} Plant snapshot(s)")
        except Exception as exc:
            log.error("snapshot pass failed", error=str(exc))
            heartbeat.failed(exc)
        took = loop.time() - began
        heartbeat.timed("snapshots", took, snapshots.DASHBOARD_INTERVAL_S)
        await _wait(stopping, max(0.0, snapshots.DASHBOARD_INTERVAL_S - took))


async def run() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopping.set)

    log.info("scheduler started", tick_seconds=TICK_SECONDS)
    heartbeat = Heartbeat("scheduler")
    beat = heartbeat.start(stopping)
    # One active scheduler: two would send every report and escalation twice
    # (§4.6). A second copy waits here as a standby.
    leadership = Leadership("scheduler", heartbeat)
    if not await leadership.acquire(stopping):
        stopping.set()
        await beat
        await leadership.release()
        await close_redis()
        await dispose_engine()
        return
    loops = [
        asyncio.create_task(leadership.watch(stopping), name="leadership"),
        asyncio.create_task(_core_loop(stopping, heartbeat), name="core"),
        asyncio.create_task(_delivery_loop(stopping, heartbeat), name="delivery"),
        asyncio.create_task(_report_loop(stopping, heartbeat), name="reports"),
        asyncio.create_task(_snapshot_loop(stopping, heartbeat), name="snapshots"),
    ]
    try:
        # Each loop catches its own failures; one ending early is a bug, and the
        # process exits so the supervisor restarts it rather than running on
        # with a loop missing.
        done, _ = await asyncio.wait(loops, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if not stopping.is_set() and task.exception() is not None:
                raise task.exception()  # type: ignore[misc]
    except Exception as exc:
        heartbeat.crashed(exc)
        raise
    finally:
        stopping.set()
        for task in loops:
            task.cancel()
        await asyncio.gather(*loops, return_exceptions=True)
        await leadership.release()
        await beat

    await close_redis()
    await dispose_engine()
    log.info("scheduler stopped")


if __name__ == "__main__":
    asyncio.run(run())
