"""Periodic Device Health sweep.

    python -m solarcms.workers.health_sweeper

A Device that stops transmitting generates no message and therefore triggers
nothing. **This sweep is the only mechanism that detects a silent Device**
(MASTER §6.3) — every other check in the system is driven by data arriving.
"""

from __future__ import annotations

import asyncio
import contextlib
import signal
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache import live
from solarcms.cache.live import close_redis
from solarcms.config import get_settings
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.absence import (
    RULE_PLANT_SILENT,
    AbsenceCondition,
    DeviceAbsenceInput,
    ObservedTopicInput,
    assess_plant_silence,
    plan_device_absence,
    plan_unregistered_publishing,
)
from solarcms.domain.assumptions import (
    FROZEN_VALUE_READING_COUNT,
    HEALTH_SWEEP_INTERVAL_S,
    PLANT_SILENCE_WINDOW_S,
)
from solarcms.domain.decoding import parse_topic
from solarcms.domain.health_logic import (
    CollectorKey,
    DeviceHealthInput,
    assess,
    correlate_collector_failures,
)
from solarcms.logging import configure_logging
from solarcms.services.absence import reconcile
from solarcms.workers.resolver import load_topic_patterns

log = structlog.get_logger("health")


@dataclass(frozen=True, slots=True)
class _Suppression:
    """What a maintenance window currently covers.

    Two sets rather than one: a window with `device_id` NULL covers a whole
    Plant, and expanding it to Device ids here would silently miss a Device
    registered after the window was opened.
    """

    devices: frozenset[int]
    plants: frozenset[int]


async def _suppressed(session: AsyncSession, now: datetime) -> _Suppression:
    """Devices and Plants under planned work right now.

    Planned work must raise nothing. A scheduled outage that pages an engineer
    at 2am trains everyone to ignore the alarm, and — worse — is recorded as
    downtime against the availability figure a performance guarantee is paid on.
    """
    rows = (await session.execute(text("""
        SELECT plant_id, device_id FROM maintenance_windows
         WHERE starts_at <= :now AND (ends_at IS NULL OR ends_at > :now)
    """), {"now": now})).all()
    return _Suppression(
        devices=frozenset(r.device_id for r in rows if r.device_id is not None),
        plants=frozenset(r.plant_id for r in rows if r.device_id is None),
    )


async def _unregistered_conditions(
    session: AsyncSession, now: datetime
) -> list[AbsenceCondition]:
    """Topics publishing now with no Device registered for them.

    ⚠ Reads `mqtt_raw_v`, never the broker: Guardrail 3 forbids ingestion
    outside the ingest process, and a second subscriber would compete for the
    same messages. The consequence is honest — this reports what ingest has
    *received*, so if ingest is down this is empty, which is a different failure
    and the Plant heartbeat's job to catch.

    The interval is derived from the topic's own gaps so liveness is judged
    against its cadence rather than a fixed clock.
    """
    rows = (await session.execute(text("""
        SELECT m.topic,
               max(m.time) AS last_seen,
               count(*)    AS messages,
               EXTRACT(EPOCH FROM (max(m.time) - min(m.time))) AS span_s,
               bool_or(d.id IS NOT NULL) AS registered,
               bool_or(i.topic IS NOT NULL) AS ignored
          FROM mqtt_raw_v m
          LEFT JOIN devices d ON d.source_address = m.topic
          LEFT JOIN discovery_ignored_topics i ON i.topic = m.topic
         WHERE m.time > now() - interval '24 hours'
         GROUP BY m.topic
    """))).all()
    if not rows:
        return []

    patterns = await load_topic_patterns(session)
    plants = {
        (r.client_code, r.plant_code): (r.client_id, r.plant_id)
        for r in (await session.execute(text("""
            SELECT c.code AS client_code, p.code AS plant_code,
                   c.id AS client_id, p.id AS plant_id
              FROM plants p JOIN clients c ON c.id = p.client_id
        """))).all()
    }
    clients = {
        r.code: r.id for r in (await session.execute(text(
            "SELECT id, code FROM clients"))).all()
    }

    observed: list[ObservedTopicInput] = []
    for row in rows:
        captured = parse_topic(row.topic, patterns)
        if captured is None:
            # Unmatched by every pattern. Quarantined and never attributed by
            # inference (Guardrail 5), so there is no Client to alarm to.
            continue
        client_code = captured.get("client_code")
        plant_code = captured.get("plant_code")
        client_id, plant_id = None, None
        if client_code and plant_code and (client_code, plant_code) in plants:
            client_id, plant_id = plants[(client_code, plant_code)]
        elif client_code:
            client_id = clients.get(client_code)
        # Mean gap, not median: one query over a day of topics, and the choice
        # only has to separate "every 86 s" from "nothing for two days".
        interval = (
            row.span_s / (row.messages - 1)
            if row.messages > 1 and row.span_s else None
        )
        observed.append(ObservedTopicInput(
            topic=row.topic, plant_id=plant_id, client_id=client_id,
            last_seen_at=row.last_seen, observed_interval_s=interval,
            registered=bool(row.registered), ignored=bool(row.ignored),
            # How long it has been talking to nobody, within the window looked
            # at. Debounces the engineer who registers a Device a minute after
            # the equipment first speaks.
            publishing_for_s=row.span_s,
        ))
    return plan_unregistered_publishing(observed, now)


async def _plant_silence_conditions(
    session: AsyncSession, devices: Sequence[Any], suppressed: _Suppression,
) -> list[AbsenceCondition]:
    """Plants that have delivered nothing at all.

    No per-Device rule can find this. When a subscription filter matches
    nothing, or the broker is unreachable, nothing is delivered — so nothing is
    quarantined and every per-Device check sits waiting on data that is not
    coming. That looked exactly like a quiet plant for 27 hours once.
    """
    by_plant: dict[int, list[Any]] = {}
    for device in devices:
        if device.source_address:
            by_plant.setdefault(device.plant_id, []).append(device)
    if not by_plant:
        return []

    counts = {
        r.plant_id: r.messages for r in (await session.execute(text("""
            SELECT d.plant_id, count(*) AS messages
              FROM mqtt_raw_v m JOIN devices d ON d.source_address = m.topic
             WHERE m.time > now() - make_interval(secs => :window)
             GROUP BY d.plant_id
        """), {"window": PLANT_SILENCE_WINDOW_S})).all()
    }

    conditions: list[AbsenceCondition] = []
    for plant_id, plant_devices in by_plant.items():
        if plant_id in suppressed.plants:
            continue
        if not assess_plant_silence(
            [d.expected_interval_s for d in plant_devices],
            counts.get(plant_id, 0), PLANT_SILENCE_WINDOW_S,
        ):
            continue
        conditions.append(AbsenceCondition(
            rule_code=RULE_PLANT_SILENT,
            client_id=plant_devices[0].client_id,
            plant_id=plant_id,
            device_id=None,
            subject=f"plant:{plant_id}",
            message=(
                f"No data at all from this Plant for over "
                f"{PLANT_SILENCE_WINDOW_S // 60} minutes, across "
                f"{len(plant_devices)} publishing Devices."
            ),
        ))
    return conditions


async def sweep_once() -> dict[str, int]:
    now = datetime.now(UTC)
    stats = {"devices": 0, "transitions": 0, "collector_alarms": 0}

    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as session:
        # `readings_v`, never `readings`: the hypertable is compressed and so
        # carries no RLS, and no role but ingest may touch it (0008/0010). Every
        # other process reads through the security_barrier view. This sweep runs
        # in the platform context, under which the view returns every row —
        # which is exactly what a fleet-wide staleness check needs.
        #
        # `last_stored` from the view is the *fallback* liveness signal, not the
        # primary one: throttling stores nothing from most messages, so a Device
        # publishing every 3 s on 300 s-throttled Tags would look silent for 57 of
        # every 60 s. The primary signal is the last-heard key ingest touches in
        # Redis on every accepted message, throttled or not.
        devices = (await session.execute(text("""
            SELECT d.id, d.code, d.client_id, d.plant_id, d.expected_interval_s,
                   d.reports_via_device_id, d.collector_code, d.source_address,
                   h.comm_status AS previous_status,
                   (SELECT max(time) FROM readings_v r WHERE r.device_id = d.id) AS last_stored,
                   (SELECT count(*) FROM readings_v r
                     WHERE r.device_id = d.id AND r.time > now() - interval '24 hours'
                   ) AS readings_24h
              FROM devices d
              LEFT JOIN device_health h ON h.device_id = d.id
             WHERE d.status = 'active'
        """))).all()

        heard = await live.read_device_seen([device.id for device in devices])

        assessments = []
        # The communication grouping in whichever form this Device has it.
        # Since migration 0022 a Collector is normally the *name* of an
        # enclosure rather than a Device, but a genuine datalogger relaying
        # another Device is still a Device — and is the more specific claim, so
        # it wins where both are recorded.
        collector_of: dict[int, CollectorKey | None] = {}
        for device in devices:
            stats["devices"] += 1
            # Whichever is later. After a Redis flush the key is absent and the
            # stored time carries one sweep; a Device whose every Tag is
            # throttled has a heard time well ahead of its stored one.
            candidates = [t for t in (heard.get(device.id), device.last_stored) if t]
            last_seen = max(candidates) if candidates else None
            assessment = assess(
                DeviceHealthInput(
                    device_id=device.id, plant_id=device.plant_id,
                    client_id=device.client_id,
                    expected_interval_s=device.expected_interval_s,
                    last_seen_at=last_seen,
                    readings_last_24h=device.readings_24h or 0,
                    reports_via_device_id=device.reports_via_device_id,
                ),
                now, frozen_threshold=FROZEN_VALUE_READING_COUNT,
            )
            assessments.append(assessment)
            collector_of[device.id] = (
                device.reports_via_device_id
                if device.reports_via_device_id is not None
                # Namespaced by Plant: two Plants may each have an "MCR", and
                # correlating across them would report one failure where there
                # are two, at two sites, with two engineers to send.
                else f"{device.plant_id}:{device.collector_code}"
                if device.collector_code
                else None
            )

            await session.execute(text("""
                INSERT INTO device_health (device_id, client_id, plant_id, comm_status,
                                           last_seen_at, frozen_tag_count,
                                           completeness_24h, updated_at)
                VALUES (:device_id, :client_id, :plant_id, :comm_status, :last_seen,
                        :frozen, :completeness, :now)
                ON CONFLICT (device_id) DO UPDATE
                    SET comm_status = EXCLUDED.comm_status,
                        last_seen_at = EXCLUDED.last_seen_at,
                        frozen_tag_count = EXCLUDED.frozen_tag_count,
                        completeness_24h = EXCLUDED.completeness_24h,
                        updated_at = EXCLUDED.updated_at
            """), {
                "device_id": device.id, "client_id": device.client_id,
                "plant_id": device.plant_id, "comm_status": assessment.comm_status,
                "last_seen": last_seen,
                "frozen": assessment.frozen_tag_count,
                "completeness": assessment.completeness_24h, "now": now,
            })

            if device.previous_status != assessment.comm_status:
                # Every transition is recorded, because availability is computed
                # time-weighted from this table and never from current state.
                await session.execute(text("""
                    INSERT INTO device_health_events (client_id, device_id, plant_id,
                                                      from_status, to_status, occurred_at)
                    VALUES (:client_id, :device_id, :plant_id, :from_status, :to_status,
                            :now)
                """), {
                    "client_id": device.client_id, "device_id": device.id,
                    "plant_id": device.plant_id, "from_status": device.previous_status,
                    "to_status": assessment.comm_status, "now": now,
                })
                stats["transitions"] += 1
                log.info("health transition", device_id=device.id,
                         **{"from": device.previous_status, "to": assessment.comm_status})

        # ⚠ Several Devices sharing a Collector going silent together is ONE
        # failure, not many. Raising an Alarm per Device would both bury the
        # cause and — worse — record a communication failure as generation
        # downtime, corrupting availability (MASTER §3.4). This is the reason
        # reports_via_device_id exists.
        correlations, absorbed = correlate_collector_failures(assessments, collector_of)
        for correlation in correlations:
            stats["collector_alarms"] += 1
            log.warning("collector failure correlated",
                        collector=correlation.collector,
                        kind="enclosure" if correlation.is_enclosure else "device",
                        silent_devices=len(correlation.silent_device_ids),
                        classification=correlation.classification)
        if absorbed:
            log.info("device silences absorbed into collector alarms",
                     count=len(absorbed))

        # ── Absence, raised as Alarms rather than only logged ───────────────
        # Until this existed the sweep knew every one of these facts and told
        # nobody: it wrote comm_status and logged a correlation, and no Alarm
        # was ever raised for a Device, a Collector or a Plant going quiet.
        suppressed = await _suppressed(session, now)
        by_id = {a.device_id: a for a in assessments}
        conditions = plan_device_absence(
            [
                DeviceAbsenceInput(
                    device_id=d.id, client_id=d.client_id, plant_id=d.plant_id,
                    code=d.code,
                    comm_status=by_id[d.id].comm_status if d.id in by_id else "unknown",
                    collector=collector_of.get(d.id),
                    silent_for_s=by_id[d.id].silent_for_s if d.id in by_id else None,
                    suppressed=d.id in suppressed.devices
                    or d.plant_id in suppressed.plants,
                )
                for d in devices
            ],
            correlations, absorbed,
        )
        conditions += await _unregistered_conditions(session, now)
        conditions += await _plant_silence_conditions(session, devices, suppressed)

        written = await reconcile(session, conditions, now)
        stats["alarms_opened"] = written["opened"]
        stats["alarms_cleared"] = written["cleared"]
        stats["notified"] = written["notified"]

    return stats


async def run() -> None:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopping.set)

    log.info("health sweeper started", interval_s=HEALTH_SWEEP_INTERVAL_S)
    while not stopping.is_set():
        try:
            stats = await sweep_once()
            log.debug("sweep complete", **stats)
        except Exception as exc:
            log.error("sweep failed", error=str(exc))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stopping.wait(), timeout=HEALTH_SWEEP_INTERVAL_S)

    await close_redis()
    await dispose_engine()
    log.info("health sweeper stopped")


if __name__ == "__main__":
    asyncio.run(run())
