"""Client → Plant → Device → binding → commissioning → active.

MASTER §6.5. A Plant in `draft` or `commissioning` is excluded from Portfolio
aggregates, so a half-mapped Plant never drags fleet PR down.
"""

from __future__ import annotations

from typing import Any, Final

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import SOURCE_KEY_ALIASES, TAG_SPECS

log = structlog.get_logger(__name__)


async def _scalar_id(session: AsyncSession, sql: str, params: dict[str, Any]) -> int:
    """Run a RETURNING id statement and hand back the id.

    `scalar_one` rather than `scalar`: every caller here upserts exactly one row,
    and a silent None would surface much later as a foreign-key violation with no
    indication of which upsert failed.
    """
    return int((await session.execute(text(sql), params)).scalar_one())


async def upsert_region(
    session: AsyncSession, code: str, name: str, *,
    country: str = "IN", grid_factor: float | None = None,
) -> int:
    return await _scalar_id(session, """
        INSERT INTO regions (code, name, country, grid_emission_factor_kg_per_kwh)
        VALUES (:code, :name, :country, :grid_factor)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
    """, {"code": code, "name": name, "country": country, "grid_factor": grid_factor})


async def upsert_client(
    session: AsyncSession, code: str, name: str, *,
    status: str = "onboarding", is_demo: bool = False,
) -> int:
    return await _scalar_id(session, """
        INSERT INTO clients (code, name, status, is_demo)
        VALUES (:code, :name, :status, :is_demo)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status
        RETURNING id
    """, {"code": code, "name": name, "status": status, "is_demo": is_demo})


async def upsert_plant(
    session: AsyncSession, client_id: int, code: str, name: str, **fields: Any
) -> int:
    params = {
        "client_id": client_id, "code": code, "name": name,
        "region_id": fields.get("region_id"),
        "status": fields.get("status", "draft"),
        "ac_capacity_kw": fields.get("ac_capacity_kw"),
        "dc_capacity_kwp": fields.get("dc_capacity_kwp"),
        "timezone": fields.get("timezone", "Asia/Kolkata"),
    }
    return await _scalar_id(session, """
        INSERT INTO plants (client_id, region_id, code, name, status,
                            ac_capacity_kw, dc_capacity_kwp, timezone)
        VALUES (:client_id, :region_id, :code, :name, :status,
                :ac_capacity_kw, :dc_capacity_kwp, :timezone)
        ON CONFLICT (client_id, code) DO UPDATE
            SET name = EXCLUDED.name, status = EXCLUDED.status,
                region_id = EXCLUDED.region_id,
                ac_capacity_kw = EXCLUDED.ac_capacity_kw,
                dc_capacity_kwp = EXCLUDED.dc_capacity_kwp
        RETURNING id
    """, params)


async def upsert_device_model(
    session: AsyncSession, device_type_code: str, manufacturer: str, model_code: str,
    *, variant: str | None = None,
) -> int:
    return await _scalar_id(session, """
        INSERT INTO device_models (device_type_id, manufacturer, model_code, variant)
        SELECT id, :manufacturer, :model_code, :variant
          FROM device_types WHERE code = :device_type_code
        ON CONFLICT (manufacturer, model_code) DO UPDATE SET variant = EXCLUDED.variant
        RETURNING id
    """, {"device_type_code": device_type_code, "manufacturer": manufacturer,
          "model_code": model_code, "variant": variant})


async def upsert_device(
    session: AsyncSession, client_id: int, plant_id: int, device_model_id: int,
    code: str, name: str, **fields: Any,
) -> int:
    """Register a Device.

    `expected_interval_s` must be set from observation at commissioning, never
    left at the assumed 60 s: health detection multiplies this column, so a Device
    publishing every 2.78 s but registered at 60 s could sit silent for ten
    minutes while still reading as healthy.
    """
    params = {
        "client_id": client_id, "plant_id": plant_id, "device_model_id": device_model_id,
        "code": code, "name": name,
        "block_id": fields.get("block_id"),
        "parent_device_id": fields.get("parent_device_id"),
        "reports_via_device_id": fields.get("reports_via_device_id"),
        "source_address": fields.get("source_address"),
        "expected_interval_s": fields.get("expected_interval_s", 60),
        "rated_capacity_kw": fields.get("rated_capacity_kw"),
        "status": fields.get("status", "active"),
    }
    return await _scalar_id(session, """
        INSERT INTO devices (client_id, plant_id, device_model_id, code, name, block_id,
                             parent_device_id, reports_via_device_id, source_address,
                             expected_interval_s, rated_capacity_kw, status)
        VALUES (:client_id, :plant_id, :device_model_id, :code, :name, :block_id,
                :parent_device_id, :reports_via_device_id, :source_address,
                :expected_interval_s, :rated_capacity_kw, :status)
        ON CONFLICT (plant_id, code) DO UPDATE
            SET name = EXCLUDED.name,
                source_address = EXCLUDED.source_address,
                expected_interval_s = EXCLUDED.expected_interval_s,
                reports_via_device_id = EXCLUDED.reports_via_device_id,
                block_id = EXCLUDED.block_id
        RETURNING id
    """, params)


async def bind_tags(
    session: AsyncSession, client_id: int, device_id: int, source_keys: list[str],
) -> dict[str, int]:
    """Create per-Device Tag bindings from observed payload keys.

    Bindings are per-Device, never per-Model: the Model's Tag list is a template,
    and field wiring never matches the datasheet (MASTER §3.5). The scale seeded
    here is the Tag's assumed default — the authoritative value is whatever the
    client eventually supplies per Device (OPEN-15 / T-1).

    Returns {bound, unmapped}. An unmapped key is not an error: it means the
    Device reports something the registry has no canonical Tag for yet, which is
    exactly the signal that commissioning is incomplete.
    """
    bound, unmapped = 0, 0
    for source_key in source_keys:
        tag_code = SOURCE_KEY_ALIASES.get(source_key)
        if tag_code is None or tag_code not in TAG_SPECS:
            log.warning("no canonical Tag for source key",
                        source_key=source_key, device_id=device_id)
            unmapped += 1
            continue
        spec = TAG_SPECS[tag_code]
        await session.execute(text("""
            INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                             scale, value_offset, valid_min, valid_max)
            SELECT :client_id, :device_id, t.id, :source_key,
                   :scale, 0.0, :valid_min, :valid_max
              FROM tags t WHERE t.code = :tag_code
            ON CONFLICT (device_id, tag_id) DO UPDATE
                SET source_key = EXCLUDED.source_key, scale = EXCLUDED.scale
        """), {
            "client_id": client_id, "device_id": device_id, "source_key": source_key,
            "tag_code": tag_code,
            # ⚠ 1.0, not spec.scale. The client's broker publishes values already
            # in engineering units (VoltageRY 11.37 against the schedule's kV), so
            # applying a decode scale would be wrong by that factor. This is an
            # observation about one Plant, not a rule — hence per-Device (T-1).
            "scale": 1.0,
            "valid_min": spec.valid_min, "valid_max": spec.valid_max,
        })
        bound += 1
    return {"bound": bound, "unmapped": unmapped}


async def set_plant_status(session: AsyncSession, plant_id: int, status: str) -> None:
    await session.execute(
        text("UPDATE plants SET status = :status WHERE id = :plant_id"),
        {"status": status, "plant_id": plant_id},
    )


# ════════════════════════════════════════════════════════════════════════════
# The client's test broker, registered as real assets.
#
# Its topics are `{PLANT}/{CATEGORY}` with no Device segment, so each category is
# registered as the instrument it actually is: two meters and a weather station
# reporting Plant-level totals. That is accurate rather than a workaround, and it
# means nothing downstream needs a special case for "Plant-level" Readings.
# ════════════════════════════════════════════════════════════════════════════

_TEST_BROKER_DEVICES: Final[tuple[tuple[str, str, str, str, tuple[str, ...]], ...]] = (
    (
        "MFM-01", "Feeder Meter", "MFM", "KULAR_GREEN/DATA",
        ("VoltageRY", "VoltageYB", "VoltageBR", "CurrentR", "CurrentY", "CurrentB",
         "AvgPowerFactor", "Frequency"),
    ),
    (
        # ⚠ Registered as MFM, not ABT_METER, deliberately. Which meter is
        # commercially binding is OPEN-14 / B-6, and I-11 forbids computing
        # Financial Reports from an MFM. Labelling it MFM means a Financial Report
        # refuses to run; labelling it ABT_METER on a guess would mean invoices
        # computed from an operational meter. The safe failure is the honest one.
        "MFM-MAIN", "Main Generation Meter", "MFM", "KULAR_GREEN/GENERATION",
        ("ActivePower", "ReactivePower", "ApparentPower", "TodayExport", "TodayImport",
         "Import", "Export"),
    ),
    (
        "WMS-01", "Weather Station", "WMS", "KULAR_GREEN/MMS",
        ("AverageGHI", "AverageGTI", "WindDirection", "WindSpeed", "AmbientTemp",
         "ModuleTemp", "PerformanceRatio"),
    ),
)

# Observed median 2.78 s across all three topics, min 2.37, max 3.12. Rounded up
# so the health sweeper's x2 degraded threshold does not trip on normal jitter.
_TEST_BROKER_INTERVAL_S: Final = 3


async def onboard_test_plant(session: AsyncSession) -> dict[str, Any]:
    """Register the client's test broker as a Client, Plant and three Devices.

    ⚠ Several values here are inferences recorded in docs/BROKER_OBSERVATIONS.md,
    not client statements:
      * whether KULAR_GREEN is a Client or a Plant is unanswered (B-8), so it is
        used as the Plant code under a Client of the same name;
      * the ~5,600 kWp capacity is derived arithmetic (§4.1), not a stated figure.
    Both are one UPDATE to correct.
    """
    region_id = await upsert_region(session, "IN-UNKNOWN", "Region Not Yet Stated")
    client_id = await upsert_client(session, "kular-green", "Kular Green (provisional)")
    plant_id = await upsert_plant(
        session, client_id, "KULAR_GREEN", "Kular Green Solar",
        region_id=region_id,
        # commissioning, not active: the Plant is excluded from Portfolio totals
        # until its data is validated, which is exactly what this Plant needs
        # while units and scaling are unconfirmed.
        status="commissioning",
        dc_capacity_kwp=5600.0,
    )

    summary: dict[str, Any] = {"client_id": client_id, "plant_id": plant_id, "devices": {}}
    for code, name, type_code, topic, keys in _TEST_BROKER_DEVICES:
        model_id = await upsert_device_model(
            session, type_code, "Unknown", f"generic-{type_code.lower()}"
        )
        device_id = await upsert_device(
            session, client_id, plant_id, model_id, code, name,
            source_address=topic,
            expected_interval_s=_TEST_BROKER_INTERVAL_S,
        )
        binding_counts = await bind_tags(session, client_id, device_id, list(keys))
        summary["devices"][code] = {"device_id": device_id, "topic": topic,
                                    **binding_counts}
    return summary
