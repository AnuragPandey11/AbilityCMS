"""Client → Plant → Device → binding → commissioning → active.

MASTER §6.5. A Plant in `draft` or `commissioning` is excluded from Portfolio
aggregates, so a half-mapped Plant never drags fleet PR down.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Final

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import DEFAULT_PUBLISH_INTERVAL_S, TAG_SPECS, alias_for
from solarcms.domain.commissioning import match_device_type, string_topic_owner
from solarcms.services.device_topics import TopicRefused, attach_topic

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
        "collector_code": fields.get("collector_code"),
        "source_address": fields.get("source_address"),
        "expected_interval_s": fields.get("expected_interval_s", 60),
        "rated_capacity_kw": fields.get("rated_capacity_kw"),
        "status": fields.get("status", "active"),
    }
    return await _scalar_id(session, """
        INSERT INTO devices (client_id, plant_id, device_model_id, code, name, block_id,
                             parent_device_id, reports_via_device_id, collector_code,
                             source_address,
                             expected_interval_s, rated_capacity_kw, status)
        VALUES (:client_id, :plant_id, :device_model_id, :code, :name, :block_id,
                :parent_device_id, :reports_via_device_id, :collector_code,
                :source_address,
                :expected_interval_s, :rated_capacity_kw, :status)
        ON CONFLICT (plant_id, code) DO UPDATE
            SET name = EXCLUDED.name,
                source_address = EXCLUDED.source_address,
                expected_interval_s = EXCLUDED.expected_interval_s,
                reports_via_device_id = EXCLUDED.reports_via_device_id,
                collector_code = EXCLUDED.collector_code,
                block_id = EXCLUDED.block_id
        RETURNING id
    """, params)


async def bind_tags(
    session: AsyncSession, client_id: int, device_id: int, source_keys: list[str],
    device_type_code: str | None = None, *, overwrite: bool = True,
) -> dict[str, int]:
    """Create per-Device Tag bindings from observed payload keys.

    Bindings are per-Device, never per-Model: the Model's Tag list is a template,
    and field wiring never matches the datasheet (MASTER §3.5). The scale seeded
    here is the Tag's assumed default — the authoritative value is whatever the
    client eventually supplies per Device (OPEN-15 / T-1).

    `device_type_code` selects the Type-specific alias where one exists
    (`SOURCE_KEY_ALIASES_BY_DEVICE_TYPE`). Omitting it falls back to the global
    table, which is correct for most keys and wrong by 1000x for a few.

    Returns {bound, unmapped, kept}. An unmapped key is not an error: it means
    the Device reports something the registry has no canonical Tag for yet,
    which is exactly the signal that commissioning is incomplete.

    `overwrite=False` adds only what is missing and leaves every existing
    binding exactly as it is — its source key, and above all its scale, which
    may be a per-Device correction somebody made by hand. That is the mode for
    a Device already in service; `kept` counts the keys whose Tag was already
    bound. `overwrite=True` is the repair a rebuild of the test Plant relies on.
    """
    bound, unmapped, kept = 0, 0, 0
    conflict = (
        "DO UPDATE SET source_key = EXCLUDED.source_key, scale = EXCLUDED.scale"
        if overwrite else "DO NOTHING"
    )
    for source_key in source_keys:
        # ⚠ Type-aware, not a flat lookup. The client's broker sends `VRY` from
        # both an Inverter (800 V, LT terminals) and an MFM (11.037, an 11 kV
        # feeder); resolving both to HV_VOLTAGE_RY would store "799.9 kV" and two
        # of the three phases would pass the range check while doing it.
        tag_code = alias_for(source_key, device_type_code)
        if tag_code is None or tag_code not in TAG_SPECS:
            log.warning("no canonical Tag for source key",
                        source_key=source_key, device_id=device_id)
            unmapped += 1
            continue
        spec = TAG_SPECS[tag_code]
        written = (await session.execute(text(f"""
            INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                             scale, value_offset, valid_min, valid_max)
            SELECT :client_id, :device_id, t.id, :source_key,
                   :scale, 0.0, :valid_min, :valid_max
              FROM tags t WHERE t.code = :tag_code
            ON CONFLICT (device_id, tag_id) {conflict}
            RETURNING id
        """), {
            "client_id": client_id, "device_id": device_id, "source_key": source_key,
            "tag_code": tag_code,
            # ⚠ 1.0, not spec.scale. The client's broker publishes values already
            # in engineering units (VoltageRY 11.37 against the schedule's kV), so
            # applying a decode scale would be wrong by that factor. This is an
            # observation about one Plant, not a rule — hence per-Device (T-1).
            "scale": 1.0,
            "valid_min": spec.valid_min, "valid_max": spec.valid_max,
        })).first()
        if written is None:
            kept += 1
        else:
            bound += 1
    return {"bound": bound, "unmapped": unmapped, "kept": kept}


async def bind_from_model(
    session: AsyncSession, client_id: int, device_id: int, *, replace: bool = False,
) -> dict[str, int]:
    """Seed a Device's bindings from its Model's signal schedule.

    This is the step that turns "I picked Reference String Inverter" into a
    working decode: every Tag on the Model's list gets a binding carrying the
    default source key the client's own sheet uses. It is a *starting point* —
    the commissioning engineer corrects it against what the Device really sends,
    because field wiring never matches the datasheet (MASTER §5.2).

    Two rules decide what is bound:

    * **Repeating groups are sliced by `devices.string_count`.** A Model lists
      PV1..PV28; a 12-string Inverter binds twelve. With no string count
      recorded, none of the group is bound rather than all 28 — twenty-eight
      Tags that never report look exactly like a broken Device to the health
      sweep and to anyone reading the screen.
    * **A derived Tag is never bound.** It has no source key because nothing
      publishes it; `tags.formula` is what produces it, and binding it would
      create a Tag waiting forever for a key that will never arrive.
    """
    device = (await session.execute(text("""
        SELECT device_model_id, string_count FROM devices WHERE id = :id
    """), {"id": device_id})).first()
    if device is None:
        raise ValueError(f"device {device_id} does not exist")

    if replace:
        await session.execute(
            text("DELETE FROM device_tag_bindings WHERE device_id = :id"),
            {"id": device_id},
        )

    rows = (await session.execute(text("""
        SELECT t.id AS tag_id, t.code, t.scale_default, t.valid_min, t.valid_max,
               mt.default_source_key, mt.repeat_index
          FROM device_model_tags mt
          JOIN tags t ON t.id = mt.tag_id
         WHERE mt.device_model_id = :model_id
           AND t.formula IS NULL
           AND (mt.repeat_index IS NULL
                OR mt.repeat_index <= COALESCE(:string_count, 0))
         ORDER BY mt.sort_order
    """), {"model_id": device.device_model_id,
           "string_count": device.string_count})).all()

    bound = 0
    for row in rows:
        # The Tag code is the fallback source key. A publisher that has adopted
        # the canonical contract sends exactly these names, so a Device with no
        # observed keys still decodes rather than landing wholly unmapped.
        source_key = row.default_source_key or row.code
        await session.execute(text("""
            INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                             scale, value_offset, valid_min, valid_max)
            VALUES (:client_id, :device_id, :tag_id, :source_key, 1.0, 0.0,
                    :valid_min, :valid_max)
            ON CONFLICT (device_id, tag_id) DO NOTHING
        """), {
            "client_id": client_id, "device_id": device_id, "tag_id": row.tag_id,
            "source_key": source_key,
            "valid_min": row.valid_min, "valid_max": row.valid_max,
        })
        bound += 1
    return {"bound": bound, "strings": device.string_count or 0}


async def ensure_plant_kpi_device(
    session: AsyncSession, client_id: int, plant_id: int, plant_code: str,
) -> int | None:
    """Give a Plant the KPI panel its own figures are written to.

    The client's Device List has a row for this — their `DASHBOARD` — and PR,
    CUF, peak power and the start/stop times are Readings on it. Created with the
    Plant rather than asked for, because a Plant without one silently has no KPIs
    at all and the omission looks like a fault in the formulas.

    Not in the power path, so it never appears in the Single Line Diagram.
    """
    model_id = (await session.execute(text("""
        SELECT dm.id FROM device_models dm
          JOIN device_types dt ON dt.id = dm.device_type_id
         WHERE dt.code = 'PLANT_KPI'
         ORDER BY dm.id LIMIT 1
    """))).scalar()
    if model_id is None:
        # The catalogue has not been seeded. Onboarding a Plant must not fail for
        # it — the KPI Device is added by the next seed run instead.
        log.warning("no PLANT_KPI model in the catalogue; skipping KPI Device",
                    plant_id=plant_id)
        return None

    return await _scalar_id(session, """
        INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                             expected_interval_s, status)
        VALUES (:client_id, :plant_id, :model_id, :code, :name, 60, 'active')
        ON CONFLICT (plant_id, code) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
    """, {"client_id": client_id, "plant_id": plant_id, "model_id": model_id,
          # Derived from the Plant's code, not from its name: a code is stable
          # and a name is edited. Still not a code path — no Plant name appears
          # anywhere in the source (Guardrail 2).
          "code": f"{plant_code}-KPI", "name": "Plant KPI Panel"})


async def backfill_plant_kpi_devices(session: AsyncSession) -> int:
    """Give every existing Plant a KPI panel. Idempotent; run from the seed.

    Plants created before the KPI Device existed would otherwise show empty PR
    and CUF tiles forever, with nothing to indicate why.
    """
    plants = (await session.execute(text("""
        SELECT p.id, p.client_id, p.code FROM plants p
         WHERE NOT EXISTS (
            SELECT 1 FROM devices d
              JOIN device_models dm ON dm.id = d.device_model_id
              JOIN device_types dt  ON dt.id = dm.device_type_id
             WHERE d.plant_id = p.id AND dt.code = 'PLANT_KPI')
    """))).all()
    created = 0
    for plant in plants:
        if await ensure_plant_kpi_device(session, plant.client_id, plant.id, plant.code):
            created += 1
    if created:
        log.info("plant KPI devices created", count=created)
    return created


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

# ⚠ **This list tracks a moving target.** The client's broker renamed its payload
# keys wholesale between 10 and 16 September 2026, and moved its weather topic
# (`MMS` → `WMS`) at the same time — see BROKER_OBSERVATIONS.md §7. The keys below
# are the ones it is *currently* observed to publish, verified against live
# traffic on 16 Sep. If a rebuild of this Plant produces Devices that decode
# nothing, re-observe the broker before assuming this file is right: the earlier
# revision of this list was correct when written and silently wrong a week later.
#
# The retired long-form keys (`VoltageRY`, `AverageGHI`, …) are still carried in
# `SOURCE_KEY_ALIASES`, so a publisher that reverts still decodes.
_TEST_BROKER_DEVICES: Final[tuple[tuple[str, str, str, str, tuple[str, ...]], ...]] = (
    (
        # Short codes since 16 Sep. Previously VoltageRY / CurrentR /
        # AvgPowerFactor / Frequency, which this Device decoded nothing under
        # once the broker changed and nobody noticed for days — the Device kept
        # reading as *online*, because it was still publishing perfectly on
        # schedule. Only the content had changed.
        "MFM-01", "Feeder Meter", "MFM", "KULAR_GREEN/DATA",
        ("VRY", "VYB", "VBR", "IR", "IY", "IB", "PF", "Hz"),
    ),
    (
        # ⚠ Registered as MFM, not ABT_METER, deliberately. Which meter is
        # commercially binding is OPEN-14 / B-6, and I-11 forbids computing
        # Financial Reports from an MFM. Labelling it MFM means a Financial Report
        # refuses to run; labelling it ABT_METER on a guess would mean invoices
        # computed from an operational meter. The safe failure is the honest one.
        #
        # This Device's keys are the only ones that did *not* change in the 16 Sep
        # revision, which is why it kept decoding while the other two went dark.
        "MFM-MAIN", "Main Generation Meter", "MFM", "KULAR_GREEN/GENERATION",
        ("ActivePower", "ReactivePower", "ApparentPower", "TodayExport", "TodayImport",
         "Import", "Export"),
    ),
    (
        # Topic moved MMS → WMS, and the signal set grew from seven to thirteen:
        # GHI/GTI (instantaneous) now arrive *alongside* AGHI/AGTI (cumulative),
        # which is the first time this broker has distinguished the two — the
        # distinction TAG_CATALOGUE §2.2 records and BROKER_OBSERVATIONS §4.1
        # had to infer.
        #
        # ⚠ `PerformanceRatio` is deliberately absent: the broker stopped sending
        # it in the same revision. It stays in SOURCE_KEY_ALIASES against its own
        # Tag (REPORTED_PERFORMANCE_RATIO) so that if it returns it decodes
        # immediately — binding it now would only create a Tag that never
        # reports, which is indistinguishable from a failed sensor on every screen.
        "WMS-01", "Weather Station", "WMS", "KULAR_GREEN/WMS",
        ("GHI", "GTI", "AGHI", "AGTI", "WD", "WS", "AT", "MT",
         "DIF", "DIFA", "DIR", "DA", "CC"),
    ),
)

# Observed median 2.78 s across all three topics, min 2.37, max 3.12. Rounded up
# so the health sweeper's x2 degraded threshold does not trip on normal jitter.
_TEST_BROKER_INTERVAL_S: Final = 3


async def onboard_test_plant(session: AsyncSession) -> dict[str, Any]:
    """Register the client's test broker as a Client, Plant and three Devices.

    This Plant is the one that does **not** follow the canonical topic contract:
    its broker publishes `{PLANT}/{CATEGORY}` with no Device segment at all, so
    each category is registered as the instrument it actually is and matched by
    `devices.source_address` — an exact topic string — rather than by parsing a
    Device code out of the topic. Nothing downstream knows the difference: once a
    Reading is resolved it carries the same `(client, plant, device, tag)` as any
    other, so the dashboards, the SLD and the KPI writer treat this Plant exactly
    as they treat a canonical one.

    Idempotent: every statement is an upsert keyed on a natural code, so re-running
    this after the broker changes its keys *repairs* the bindings in place rather
    than duplicating anything.

    ⚠ Several values here are inferences recorded in docs/BROKER_OBSERVATIONS.md,
    not client statements:
      * whether KULAR_GREEN is a Client or a Plant is unanswered (B-8), so it is
        used as the Plant code under a Client of the same name;
      * the ~5,600 kWp capacity is derived arithmetic (§4.1), not a stated figure;
      * the AC capacity is not set here at all, because nothing has ever stated
        it — CUF stays undefined until someone does.
    Each is one UPDATE to correct.
    """
    region_id = await upsert_region(session, "IN-UNKNOWN", "Region Not Yet Stated")
    # ⚠ The Client code must be **exactly what the publisher puts in the topic**,
    # which is `KULAR_GREEN`. It was `kular-green` until 19 Sep 2026, and the
    # mismatch was invisible: every registered Device resolves by an exact match
    # on `devices.source_address`, which never compares the Client code at all.
    # Only the *pattern* path does — the path a newly-appeared Device takes — so
    # the first new Device the client added would have been quarantined as
    # "no Device registered for this topic" while its topic was perfectly valid.
    client_id = await upsert_client(session, "KULAR_GREEN", "Kular Green (provisional)")
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


# ════════════════════════════════════════════════════════════════════════════
# Commissioning a Plant from what the broker is actually publishing.
#
# The gap this closes: a publisher changes its topic shape or adds equipment,
# and the platform silently stores nothing. That is not hypothetical — the
# client's broker moved from a flat two-level shape to the canonical six-level
# one and grew from 3 Devices to 20, and the only symptom was an empty chart.
#
# ⚠ This does **not** violate Guardrail 5. That rule forbids inferring a
# Client from *payload contents* at ingest, where a wrong guess silently merges
# two Clients' histories and nothing downstream can detect it. This runs at
# commissioning, proposes a plan, prints it, and writes nothing without
# `apply=True` — a human reads the proposal and accepts it. The topic remains the
# sole authority for origin at runtime.
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True, slots=True)
class ObservedDevice:
    """One topic seen on the broker, with the payload keys it carried."""

    topic: str
    plant_code: str
    device_code: str
    source_keys: tuple[str, ...]
    client_code: str | None = None
    collector_code: str | None = None
    # Measured, never assumed: health detection multiplies this column, so a
    # Device publishing every 3 s but registered at 60 s can sit silent for ten
    # minutes and still read as healthy.
    interval_s: int | None = None


# Who commissioning writes as in `audit_log`. It runs from the CLI with no User,
# and an audit row with no actor at all would read as a gap in the trail.
COMMISSIONING_ACTOR: Final = "cli:commission-from-broker"


async def infer_device_type(session: AsyncSession, device_code: str) -> str | None:
    """Match a Device code against the Device Type catalogue.

    Driven by the seeded catalogue rather than a list in code, so a Client who
    adds a Type gets it for free and no Plant or Client name ever reaches a
    code path (Guardrail 2). The rules are `domain/commissioning.
    match_device_type`'s. Returns None when nothing matches, which is a question
    for the operator rather than a default to fall back on.
    """
    codes = [str(r.code) for r in (await session.execute(
        text("SELECT code FROM device_types"))).all()]
    return match_device_type(device_code, codes)


async def _find_plant(session: AsyncSession, item: ObservedDevice) -> Any:
    """The Plant a topic names — under the Client it names, when it names one.

    `plants.code` is unique per Client, not globally (`uq_plants_client_id_code`),
    so two Clients may both own a Plant called `MAIN`. Matching on the Plant
    code alone picked whichever row sorted first, and registered the second
    Client's equipment under the first — the one mistake multi-tenancy exists
    to make impossible, made by the tool that onboards the tenants. When the
    topic carries a Client code (every canonical shape does) it is part of the
    lookup; only the legacy two-segment shape, which names no Client, falls
    back to the Plant code by itself.

    Both codes are matched case-insensitively here and here only, because a
    human is about to read this plan and confirm it. At runtime the topic is
    matched exactly — case-folding an origin would merge two Clients whose
    codes differ only by case (Guardrail 5).
    """
    if item.client_code is not None:
        return (await session.execute(text("""
            SELECT p.id, p.client_id
              FROM plants p JOIN clients c ON c.id = p.client_id
             WHERE upper(p.code) = upper(:plant_code)
               AND upper(c.code) = upper(:client_code)
        """), {"plant_code": item.plant_code,
               "client_code": item.client_code})).first()
    return (await session.execute(text(
        "SELECT id, client_id FROM plants WHERE upper(code) = upper(:code)"
    ), {"code": item.plant_code})).first()


_DEVICE_COLUMNS: Final = """
    d.id, d.code, d.plant_id, d.client_id, d.collector_code, d.source_address,
    d.expected_interval_s, dt.code AS type_code
"""


async def _registered_on(session: AsyncSession, topic: str) -> Any:
    """The Device this exact topic is registered to, primary or extra, or None."""
    return (await session.execute(text(f"""
        SELECT {_DEVICE_COLUMNS}, rt.is_primary
          FROM registered_topics rt
          JOIN devices d        ON d.id = rt.device_id
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
         WHERE rt.topic = :topic
         ORDER BY rt.is_primary DESC
         LIMIT 1
    """), {"topic": topic})).first()


async def _device_by_code(session: AsyncSession, plant_id: int, code: str) -> Any:
    return (await session.execute(text(f"""
        SELECT {_DEVICE_COLUMNS}
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
         WHERE d.plant_id = :plant_id AND d.code = :code
    """), {"plant_id": plant_id, "code": code})).first()


async def _bound_source_keys(session: AsyncSession, device_id: int) -> set[str]:
    return {str(r.source_key) for r in (await session.execute(text(
        "SELECT source_key FROM device_tag_bindings WHERE device_id = :id"
    ), {"id": device_id})).all()}


def _split_keys(
    keys: tuple[str, ...], device_type: str | None
) -> tuple[list[str], list[str]]:
    mapped: list[str] = []
    unmapped: list[str] = []
    for key in keys:
        tag = alias_for(key, device_type)
        (mapped if tag and tag in TAG_SPECS else unmapped).append(key)
    return mapped, unmapped


async def plan_commissioning(
    session: AsyncSession, observed: list[ObservedDevice], *,
    create_missing: bool = False,
) -> list[dict[str, Any]]:
    """Work out what would be done for each observed topic, writing nothing.

    Every row gets one `action`:

    * **refresh** — the topic is already registered (as a Device's primary or
      as one of its extras). Only two things may change: the Device's
      `expected_interval_s`, when this is its primary topic and the measured
      interval differs, and bindings for keys that are not bound yet. Its name,
      Block, Collector, wiring and every existing binding's scale are left
      exactly as they are — they may be corrections a person made.
    * **attach** — a `…_STRING*` topic (`domain/commissioning.
      string_topic_owner`): the PV strings of a Device, recorded as one of that
      Device's extra topics rather than as a Device of its own.
    * **register** — equipment nobody has registered. When it is a string
      topic whose owner publishes nothing else (an SMB known only by its
      strings), the owner is registered with this topic as its primary.
    * **blocked** — with the reason. Never resolved by guessing.

    `create_missing` lets a topic whose Client or Plant does not exist yet
    propose creating them, from the codes the topic carries.
    """
    plan: list[dict[str, Any]] = []
    # Codes this run will register from their own topic, so a string topic in
    # the same window attaches to its owner rather than creating it.
    publishing = {
        (o.client_code, o.plant_code, o.device_code)
        for o in observed if string_topic_owner(o.device_code) is None
    }
    owners_from_strings: set[tuple[str | None, str, str]] = set()
    # Codes registered by this run. `devices` is unique on (plant, code), so a
    # second topic carrying the same code — an `MFM` inside the MCR and another
    # outside it — must be a question, not an INSERT that aborts the whole run.
    registering: dict[tuple[str | None, str, str], str] = {}

    for item in sorted(observed, key=lambda o: o.topic):
        owner_code = string_topic_owner(item.device_code)
        row: dict[str, Any] = {
            "topic": item.topic,
            "device_code": item.device_code,
            "target_code": owner_code or item.device_code,
            "client_code": item.client_code,
            "plant_code": item.plant_code,
            # Shown in the plan so the operator can see the enclosure being
            # recorded — and see that no Device is being created for it.
            "collector_code": item.collector_code,
            "interval_s": item.interval_s,
            "device_type": None, "device_id": None,
            "plant_id": None, "client_id": None,
            "action": "blocked", "reason": None, "blocked": True,
            "mapped_keys": 0, "unmapped_keys": [], "new_keys": [],
            "interval_change": None, "creates_client": False, "creates_plant": False,
        }
        plan.append(row)

        def block(reason: str, row: dict[str, Any] = row) -> None:
            row["action"], row["reason"], row["blocked"] = "blocked", reason, True

        registered = await _registered_on(session, item.topic)
        if registered is not None:
            mapped, unmapped = _split_keys(item.source_keys, registered.type_code)
            bound = await _bound_source_keys(session, registered.id)
            change = None
            if (registered.is_primary and item.interval_s
                    and item.interval_s != registered.expected_interval_s):
                change = (registered.expected_interval_s, item.interval_s)
            row.update(
                action="refresh", blocked=False, target_code=registered.code,
                device_id=registered.id, device_type=registered.type_code,
                plant_id=registered.plant_id, client_id=registered.client_id,
                mapped_keys=len(mapped), unmapped_keys=unmapped,
                new_keys=[k for k in mapped if k not in bound],
                interval_change=change,
            )
            continue

        plant = await _find_plant(session, item)
        if plant is None:
            if not (create_missing and item.client_code):
                block("no such Plant" + (
                    "; --create-missing would create it" if item.client_code else ""))
                continue
            client = (await session.execute(text(
                "SELECT id, code FROM clients WHERE upper(code) = upper(:code)"
            ), {"code": item.client_code})).first()
            if client is not None and client.code != item.client_code:
                # `kular-green` against `KULAR_GREEN` registers cleanly and then
                # quarantines every new Device: the pattern path compares the
                # Client code exactly. Fix the code, never fold it.
                block(f"Client {client.code!r} differs from the topic's "
                      f"{item.client_code!r} only by case; correct the Client's "
                      f"code rather than create a second one")
                continue
            row.update(creates_client=client is None, creates_plant=True,
                       client_id=None if client is None else client.id)
        else:
            row.update(plant_id=plant.id, client_id=plant.client_id)

        target = (None if plant is None
                  else await _device_by_code(session, plant.id, row["target_code"]))
        if owner_code is not None:
            if target is not None:
                device_type = target.type_code
                row["device_id"] = target.id
                if target.collector_code != item.collector_code:
                    block(f"{target.code} is in collector {target.collector_code!r} "
                          f"but this topic publishes from {item.collector_code!r}; "
                          f"a Device's topics cannot disagree about where it is")
                    continue
                row["action"] = "attach"
            else:
                device_type = await infer_device_type(session, owner_code)
                key = (item.client_code, item.plant_code, owner_code)
                if key in publishing or key in owners_from_strings:
                    row["action"] = "attach"
                else:
                    owners_from_strings.add(key)
                    row["action"] = "register"
        else:
            device_type = await infer_device_type(session, item.device_code)
            if target is not None:
                # Registered under this code, on a different topic: the client
                # renamed a topic, or two topics claim one Device. Either way a
                # person decides — repointing it here would silently move the
                # Device's history onto whatever this topic turns out to be.
                block(f"{target.code} is already registered on "
                      f"{target.source_address!r}; if the topic was renamed, "
                      f"see topic-migrations and change it there")
                continue
            row["action"] = "register"

        if device_type is None:
            block("no matching Device Type")
            continue
        if row["action"] == "register":
            key = (item.client_code.upper() if item.client_code else None,
                   item.plant_code.upper(), row["target_code"])
            if key in registering:
                block(f"{row['target_code']} is also published on "
                      f"{registering[key]!r}; one Plant cannot hold two Devices "
                      f"with one code, so a person must say which is which")
                continue
            registering[key] = item.topic
        mapped, unmapped = _split_keys(item.source_keys, device_type)
        row.update(device_type=device_type, blocked=False, mapped_keys=len(mapped),
                   unmapped_keys=unmapped, new_keys=mapped)
    return plan


async def _placeholder_model(session: AsyncSession, device_type: str) -> int:
    """The `REF-{type}` Model a broker-registered Device starts on.

    Looked up before it is inserted, never upserted: an upsert would rewrite
    the variant of a Model somebody may since have corrected.
    """
    found = (await session.execute(text("""
        SELECT id FROM device_models
         WHERE manufacturer = 'Unspecified' AND model_code = :code
    """), {"code": f"REF-{device_type}"})).scalar()
    if found is not None:
        return int(found)
    return await upsert_device_model(session, device_type, "Unspecified",
                                     f"REF-{device_type}")


async def _audit(
    session: AsyncSession, client_id: int | None, action: str, entity_type: str,
    entity_id: int, *, before: dict[str, Any] | None = None,
    after: dict[str, Any] | None = None,
) -> None:
    await session.execute(text("""
        INSERT INTO audit_log (client_id, actor_email, action, entity_type,
                               entity_id, before, after)
        VALUES (:client_id, :actor, :action, :entity_type, :entity_id,
                CAST(:before AS jsonb), CAST(:after AS jsonb))
    """), {"client_id": client_id, "actor": COMMISSIONING_ACTOR, "action": action,
           "entity_type": entity_type, "entity_id": entity_id,
           "before": None if before is None else json.dumps(before, default=str),
           "after": None if after is None else json.dumps(after, default=str)})


async def _ensure_client_and_plant(
    session: AsyncSession, client_code: str, plant_code: str, summary: dict[str, Any],
) -> tuple[int, int]:
    """Create the Client and Plant a topic names, if they do not exist yet.

    Insert-only: an existing Client or Plant is returned untouched. Created as
    `onboarding` / `commissioning`, so the Plant is excluded from Portfolio
    figures until somebody has looked at its data, with provisional names and
    no capacity — nothing has stated one, and CUF stays undefined until it is.
    ⚠ The timezone is the platform default (Asia/Kolkata), which is an
    assumption about where the Plant is, and one UPDATE to correct.
    """
    client_id = (await session.execute(text(
        "SELECT id FROM clients WHERE code = :code"), {"code": client_code})).scalar()
    if client_id is None:
        client_id = (await session.execute(text("""
            INSERT INTO clients (code, name, status, is_demo)
            VALUES (:code, :name, 'onboarding', false)
            RETURNING id
        """), {"code": client_code,
               "name": f"{client_code.replace('_', ' ')} (provisional)"})).scalar_one()
        summary["clients_created"].append(client_code)
        await _audit(session, client_id, "client.create", "clients", client_id,
                     after={"code": client_code, "source": "broker topic"})

    plant_id = (await session.execute(text(
        "SELECT id FROM plants WHERE client_id = :client_id AND code = :code"
    ), {"client_id": client_id, "code": plant_code})).scalar()
    if plant_id is None:
        # The region the test Plant was filed under, if this database has it;
        # otherwise none. Nothing here has stated a region either way.
        region_id = (await session.execute(text(
            "SELECT id FROM regions WHERE code = 'IN-UNKNOWN'"))).scalar()
        plant_id = (await session.execute(text("""
            INSERT INTO plants (client_id, region_id, code, name, status, timezone)
            VALUES (:client_id, :region_id, :code, :name, 'commissioning', 'Asia/Kolkata')
            RETURNING id
        """), {"client_id": client_id, "region_id": region_id, "code": plant_code,
               "name": f"{plant_code.replace('_', ' ')} (provisional)"})).scalar_one()
        await ensure_plant_kpi_device(session, client_id, plant_id, plant_code)
        summary["plants_created"].append(f"{client_code}/{plant_code}")
        await _audit(session, client_id, "plant.create", "plants", plant_id,
                     after={"code": plant_code, "status": "commissioning",
                            "source": "broker topic"})
    return int(client_id), int(plant_id)


async def commission_observed_devices(
    session: AsyncSession, observed: list[ObservedDevice], *,
    create_missing: bool = False,
) -> dict[str, Any]:
    """Carry out `plan_commissioning`, in an order that cannot clobber anything.

    1. **Clients and Plants** the topics name, only with `create_missing`.
    2. **register** — a plain INSERT, never an upsert. The plan has already
       established nothing holds the code; were that to change underneath it,
       failing loudly beats overwriting a Device somebody edited.
    3. **attach** — the string topic becomes one of its owner's extra topics
       (migration 0030), after step 2 so an owner registered in this same run
       exists to attach to.
    4. **refresh** — the measured interval on a Device's primary topic, and
       bindings for keys not yet bound. Nothing else about the Device changes.

    Three choices carried over from the original:

    * **`source_address` is the exact topic.** That is the resolver's *first*
      path — an exact match, before any pattern is tried — so it is immune to
      the case and shape problems that pattern matching has to care about.
    * **The Collector is recorded on the Device, and is never registered as a
      Device itself** (migration 0022). `{collector_code}` names the enclosure
      the equipment sits in. Devices registered by the pre-0022 path are
      repaired by `python -m solarcms.cli collectors-from-topics`.
    * **`parent_device_id` is left NULL.** The topic says where a Device *sits*,
      never what it is *wired into* (I-10). The hierarchy editor is where the
      wiring is said.
    """
    plan = await plan_commissioning(session, observed, create_missing=create_missing)
    items = {o.topic: o for o in observed}
    summary: dict[str, Any] = {
        "devices": 0, "attached": 0, "refreshed": 0, "intervals": 0,
        "bound": 0, "kept": 0, "unmapped": 0, "collectors": 0,
        "clients_created": [], "plants_created": [], "skipped": [],
    }
    seen_collectors: set[tuple[int, str]] = set()

    def skip(row: dict[str, Any], reason: str) -> None:
        summary["skipped"].append({"topic": row["topic"], "reason": reason})

    for row in plan:
        if row["blocked"]:
            skip(row, row["reason"])
        elif row["creates_plant"]:
            row["client_id"], row["plant_id"] = await _ensure_client_and_plant(
                session, str(row["client_code"]), row["plant_code"], summary)

    for row in (r for r in plan if r["action"] == "register"):
        item = items[row["topic"]]
        model_id = await _placeholder_model(session, row["device_type"])
        device_id = (await session.execute(text("""
            INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                 collector_code, source_address, expected_interval_s,
                                 status)
            VALUES (:client_id, :plant_id, :model_id, :code, :name,
                    :collector_code, :topic, :interval_s, 'active')
            RETURNING id
        """), {"client_id": row["client_id"], "plant_id": row["plant_id"],
               "model_id": model_id, "code": row["target_code"],
               "name": row["target_code"].replace("_", " ").title(),
               "collector_code": item.collector_code, "topic": item.topic,
               "interval_s": item.interval_s or DEFAULT_PUBLISH_INTERVAL_S,
               })).scalar_one()
        counts = await bind_tags(session, row["client_id"], device_id,
                                 list(item.source_keys), row["device_type"],
                                 overwrite=False)
        await _audit(session, row["client_id"], "device.create", "devices", device_id,
                     after={"code": row["target_code"], "topic": item.topic,
                            "type": row["device_type"], **counts})
        if item.collector_code and (row["plant_id"], item.collector_code) not in seen_collectors:
            seen_collectors.add((row["plant_id"], item.collector_code))
            summary["collectors"] += 1
        summary["devices"] += 1
        summary["bound"] += counts["bound"]
        summary["unmapped"] += counts["unmapped"]

    for row in (r for r in plan if r["action"] == "attach"):
        item = items[row["topic"]]
        owner = await _device_by_code(session, row["plant_id"], row["target_code"])
        if owner is None:
            skip(row, f"{row['target_code']} was not registered, so there is "
                      f"nothing to attach its strings to")
            continue
        try:
            await attach_topic(session, owner.id, item.topic,
                               note=f"PV strings of {owner.code}, seen on the broker")
        except TopicRefused as exc:
            skip(row, str(exc))
            continue
        counts = await bind_tags(session, owner.client_id, owner.id,
                                 list(item.source_keys), owner.type_code,
                                 overwrite=False)
        await _audit(session, owner.client_id, "device.topic.add", "devices", owner.id,
                     after={"topic": item.topic, **counts})
        summary["attached"] += 1
        summary["bound"] += counts["bound"]
        summary["kept"] += counts["kept"]
        summary["unmapped"] += counts["unmapped"]

    for row in (r for r in plan if r["action"] == "refresh"):
        touched = False
        if row["interval_change"]:
            old, new = row["interval_change"]
            await session.execute(text(
                "UPDATE devices SET expected_interval_s = :new WHERE id = :id"
            ), {"new": new, "id": row["device_id"]})
            await _audit(session, row["client_id"], "device.update", "devices",
                         row["device_id"], before={"expected_interval_s": old},
                         after={"expected_interval_s": new, "source": "measured"})
            summary["intervals"] += 1
            touched = True
        if row["new_keys"]:
            counts = await bind_tags(session, row["client_id"], row["device_id"],
                                     row["new_keys"], row["device_type"],
                                     overwrite=False)
            await _audit(session, row["client_id"], "device.bindings.add", "devices",
                         row["device_id"], after={"keys": row["new_keys"], **counts})
            summary["bound"] += counts["bound"]
            summary["kept"] += counts["kept"]
            touched = True
        if touched:
            summary["refreshed"] += 1
    return summary


async def devices_without_string_count(
    session: AsyncSession, device_ids: list[int]
) -> list[str]:
    """Devices bound to PV-string Tags but with no string count recorded.

    String Analysis draws strings only up to `devices.string_count`, which a
    person sets in Tag Mapping: a register map publishes every input it has,
    and an unused one reads zero exactly like a dead string. So bindings alone
    never set it — this only names who still needs it.
    """
    if not device_ids:
        return []
    # Named with Client and Plant: Device codes repeat across Plants, and a
    # bare `INVERTER_1` would stand for every Client's first Inverter at once.
    rows = (await session.execute(text("""
        SELECT DISTINCT c.code AS client_code, p.code AS plant_code, d.code
          FROM devices d
          JOIN plants p  ON p.id = d.plant_id
          JOIN clients c ON c.id = p.client_id
          JOIN device_tag_bindings b ON b.device_id = d.id
          JOIN tags t ON t.id = b.tag_id
         WHERE d.id = ANY(:ids) AND d.string_count IS NULL
           AND t.code ~ '^PV[0-9]+_CURRENT$'
         ORDER BY 1, 2, 3
    """), {"ids": device_ids})).all()
    return [f"{r.client_code}/{r.plant_code}/{r.code}" for r in rows]
