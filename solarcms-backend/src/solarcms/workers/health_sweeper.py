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
from datetime import UTC, datetime

import structlog
from sqlalchemy import text

from solarcms.cache import live
from solarcms.cache.live import close_redis
from solarcms.config import get_settings
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import dispose_engine, scoped_session
from solarcms.domain.assumptions import (
    FROZEN_VALUE_READING_COUNT,
    HEALTH_SWEEP_INTERVAL_S,
)
from solarcms.domain.health_logic import (
    DeviceHealthInput,
    assess,
    correlate_collector_failures,
)
from solarcms.logging import configure_logging

log = structlog.get_logger("health")


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
            SELECT d.id, d.client_id, d.plant_id, d.expected_interval_s,
                   d.reports_via_device_id,
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
        reports_via: dict[int, int | None] = {}
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
            reports_via[device.id] = device.reports_via_device_id

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
        correlations, absorbed = correlate_collector_failures(assessments, reports_via)
        for correlation in correlations:
            stats["collector_alarms"] += 1
            log.warning("collector failure correlated",
                        collector=correlation.collector_device_id,
                        silent_devices=len(correlation.silent_device_ids),
                        classification=correlation.classification)
        if absorbed:
            log.info("device silences absorbed into collector alarms",
                     count=len(absorbed))

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
