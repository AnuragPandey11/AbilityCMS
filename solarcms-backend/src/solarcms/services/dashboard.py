"""Assembles a Plant's dashboard: load the slot catalogue, gather facts, resolve.

The arithmetic is entirely in `domain/slots.py` and `domain/sld_stages.py`, which
are pure. This module does the three things they cannot: read the catalogue from
Postgres, read what the Plant is reporting from Redis, and apply per-Plant
overrides.

**Current values come from Redis, never from `readings`.** Two reasons, and both
are load-bearing. `readings` is a compressed hypertable the API holds no
privilege on at all — a query would fail, which is migration 0008 working as
designed (Guardrail: never query `readings` from request-serving code). And even
where it were permitted, scanning history to learn what a Device is doing *right
now* would be the wrong tool: ingest already maintains exactly that in
`live:device:{id}`.

Isolation is inherited here rather than re-implemented: `devices`,
`device_tag_bindings` and `device_health` all carry RLS, and this runs on the
request session. That is the opposite of `plant_kpi.py`, which runs under the
scheduler's platform privileges and has to carry its own predicates.
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache import live
from solarcms.domain.sld_stages import SLD_STAGES, SldStages, build_stages
from solarcms.domain.slots import (
    DeviceFacts,
    PlantFacts,
    ResolvedSlot,
    SlotCandidate,
    SlotSpec,
    resolve_all,
)

log = structlog.get_logger(__name__)

# Columns on `plants` a `plant_attribute` candidate may read. Mirrors the CHECK
# constraint in migration 0021: the query below selects these by name, so the two
# lists disagreeing would produce a KeyError rather than a wrong number.
PLANT_ATTRIBUTES = ("dc_capacity_kwp", "ac_capacity_kw")


async def load_slot_specs(
    session: AsyncSession, plant_id: int
) -> tuple[list[SlotSpec], dict[str, str]]:
    """Read the catalogue, apply this Plant's overrides, and return specs plus notes.

    An override replaces the *whole* candidate list for one slot rather than
    editing one entry. Splicing a Plant's preference into a shared ordering makes
    the effective order impossible to read off either table, and "which source is
    this tile actually using" is the question the override exists to answer.
    """
    rows = (await session.execute(text("""
        SELECT s.code AS slot_code, s.label, s.panel, s.position, s.unit_hint,
               s.hide_when_unresolved, s.fallback_when_silent,
               c.priority, c.kind, c.aggregate, c.plant_attribute, c.online_only,
               dt.code AS device_type_code, t.code AS tag_code
          FROM dashboard_slots s
          LEFT JOIN dashboard_slot_candidates c ON c.slot_id = s.id
          LEFT JOIN device_types dt ON dt.id = c.device_type_id
          LEFT JOIN tags t          ON t.id  = c.tag_id
         WHERE s.enabled
         ORDER BY s.panel, s.position, c.priority
    """))).all()

    overrides = (await session.execute(text("""
        SELECT s.code AS slot_code, o.kind, o.aggregate, o.plant_attribute,
               o.online_only, o.hidden, o.note,
               dt.code AS device_type_code, t.code AS tag_code
          FROM plant_dashboard_slot_overrides o
          JOIN dashboard_slots s ON s.id = o.slot_id
          LEFT JOIN device_types dt ON dt.id = o.device_type_id
          LEFT JOIN tags t          ON t.id  = o.tag_id
         WHERE o.plant_id = :plant_id
    """), {"plant_id": plant_id})).all()

    by_slot: dict[str, dict[str, Any]] = {}
    candidates: dict[str, list[SlotCandidate]] = {}
    for row in rows:
        by_slot.setdefault(row.slot_code, {
            "label": row.label, "panel": row.panel, "position": row.position,
            "unit_hint": row.unit_hint,
            "hide_when_unresolved": row.hide_when_unresolved,
            "fallback_when_silent": row.fallback_when_silent,
        })
        if row.kind is None:
            continue  # a slot with no candidates yet — the LEFT JOIN's NULL row
        candidates.setdefault(row.slot_code, []).append(
            SlotCandidate(
                kind=row.kind, priority=row.priority,
                device_type_code=row.device_type_code, tag_code=row.tag_code,
                aggregate=row.aggregate, plant_attribute=row.plant_attribute,
                online_only=row.online_only,
            )
        )

    hidden: set[str] = set()
    notes: dict[str, str] = {}
    for row in overrides:
        if row.note:
            notes[row.slot_code] = row.note
        if row.hidden:
            hidden.add(row.slot_code)
            continue
        if row.kind is None:
            continue
        candidates[row.slot_code] = [
            SlotCandidate(
                kind=row.kind, priority=1,
                device_type_code=row.device_type_code, tag_code=row.tag_code,
                aggregate=row.aggregate or "first",
                plant_attribute=row.plant_attribute, online_only=row.online_only,
            )
        ]

    specs = [
        SlotSpec(
            code=code, label=meta["label"], panel=meta["panel"],
            position=meta["position"], unit_hint=meta["unit_hint"],
            hide_when_unresolved=meta["hide_when_unresolved"],
            fallback_when_silent=meta["fallback_when_silent"],
            candidates=tuple(candidates.get(code, ())),
        )
        for code, meta in by_slot.items()
        if code not in hidden
    ]
    return specs, notes


async def gather(
    session: AsyncSession, plant_id: int
) -> tuple[PlantFacts, dict[str, str]]:
    """Everything the resolver needs about one Plant: its Devices, bindings and values.

    `bound_tag_codes` and `values` are gathered separately and kept separate.
    That is what lets a slot distinguish "this Plant has no settlement meter"
    from "the settlement meter has gone quiet" — the same blank tile, and
    entirely different phone calls.
    """
    attributes_sql = ", ".join(f"p.{column}" for column in PLANT_ATTRIBUTES)
    plant = (await session.execute(
        text(f"SELECT {attributes_sql} FROM plants p WHERE p.id = :plant_id"),
        {"plant_id": plant_id},
    )).first()
    attributes: dict[str, float | None] = (
        {column: (None if getattr(plant, column) is None else float(getattr(plant, column)))
         for column in PLANT_ATTRIBUTES}
        if plant is not None else {}
    )

    device_rows = (await session.execute(text("""
        SELECT d.id, d.code, dt.code AS device_type_code, dt.in_power_path,
               d.sld_stage_override,
               COALESCE(h.comm_status, 'unknown') AS comm_status
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
         ORDER BY d.code
    """), {"plant_id": plant_id})).all()
    if not device_rows:
        return PlantFacts(plant_id=plant_id, devices=(), attributes=attributes), {}

    device_ids = [row.id for row in device_rows]

    # One query for every binding on the Plant rather than one per Device: a
    # 40-Inverter Plant would otherwise issue 40 round trips to render one screen.
    binding_rows = (await session.execute(text("""
        SELECT b.device_id, t.code AS tag_code, t.id AS tag_id, t.unit
          FROM device_tag_bindings b
          JOIN tags t ON t.id = b.tag_id
         WHERE b.device_id = ANY(:device_ids) AND b.enabled
    """), {"device_ids": device_ids})).all()

    bound: dict[int, set[str]] = {}
    tag_code_by_id: dict[int, str] = {}
    units: dict[str, str] = {}
    for row in binding_rows:
        bound.setdefault(row.device_id, set()).add(row.tag_code)
        tag_code_by_id[row.tag_id] = row.tag_code
        if row.unit is not None:
            units[row.tag_code] = row.unit

    devices: list[DeviceFacts] = []
    for row in device_rows:
        values: dict[str, float] = {}
        for key, raw in (await live.read_current_values(row.id)).items():
            if key.startswith("_"):
                continue  # `_ts`, the hash's own timestamp
            try:
                tag_id, value = int(key), float(raw)
            except ValueError:
                # A Redis hash is untyped and ingest is not the only thing that
                # could ever write one. Skipping a malformed entry is right;
                # letting it raise would blank a whole dashboard.
                continue
            code = tag_code_by_id.get(tag_id)
            if code is not None:
                values[code] = value
        devices.append(
            DeviceFacts(
                device_id=row.id, code=row.code,
                device_type_code=row.device_type_code,
                bound_tag_codes=frozenset(bound.get(row.id, ())),
                values=values,
                online=row.comm_status == "online",
                in_power_path=row.in_power_path,
                sld_stage_override=row.sld_stage_override,
            )
        )

    # Units are returned beside the facts rather than carried on them: PlantFacts
    # is a pure-domain value and has no business holding a catalogue lookup, and
    # a module-level cache keyed by plant_id would be shared between concurrent
    # requests for the same Plant.
    facts = PlantFacts(plant_id=plant_id, devices=tuple(devices), attributes=attributes)
    return facts, units


async def render(session: AsyncSession, plant_id: int) -> dict[str, Any]:
    """The whole Plant dashboard: panels of resolved slots, plus the four SLD stages."""
    specs, notes = await load_slot_specs(session, plant_id)
    facts, units = await gather(session, plant_id)

    stage_by_type = {
        row.code: row.sld_stage
        for row in (await session.execute(text(
            "SELECT code, sld_stage FROM device_types WHERE sld_stage IS NOT NULL"
        ))).all()
    }

    panel_specs = [s for s in specs if not s.panel.startswith("sld.")]
    stage_specs: dict[str, list[SlotSpec]] = {code: [] for code in SLD_STAGES}
    for spec in specs:
        if spec.panel.startswith("sld."):
            stage = spec.panel.removeprefix("sld.")
            if stage in stage_specs:
                stage_specs[stage].append(spec)

    resolved = resolve_all(panel_specs, facts, units)
    stages = build_stages(facts, stage_specs, stage_by_type, units)

    panels: dict[str, list[dict[str, Any]]] = {}
    for slot in resolved:
        if slot.hidden:
            continue
        panels.setdefault(slot.panel, []).append(_slot_json(slot, notes.get(slot.slot_code)))

    return {
        "plant_id": plant_id,
        "panels": panels,
        "sld": _stages_json(stages),
        "device_count": len(facts.devices),
        "assumptions_note": (
            "Slot resolution chooses a source; it does not define a unit or a "
            "formula. Units come from the Tag catalogue and every KPI definition "
            "remains provisional pending OPEN-15 and OPEN-16."
        ),
    }


def _slot_json(slot: ResolvedSlot, note: str | None = None) -> dict[str, Any]:
    source = slot.source
    return {
        "slot_code": slot.slot_code,
        "label": slot.label,
        "position": slot.position,
        "value": slot.value,
        "unit": slot.unit,
        "undefined_reason": slot.undefined_reason,
        # Provenance travels with the value. A tile reading 6.32 MW is a different
        # claim depending on whether a meter measured it or twelve Inverters were
        # added together, and the person deciding whether to trust it needs both.
        "source": None if source is None else {
            "kind": source.kind,
            "device_type_code": source.device_type_code,
            "tag_code": source.tag_code,
            "aggregate": source.aggregate,
            "device_count": source.device_count,
            "is_aggregated": source.is_aggregated,
            "degraded": source.degraded,
        },
        "override_note": note,
    }


def _stages_json(stages: SldStages) -> dict[str, Any]:
    return {
        "stages": [
            {
                "code": stage.code,
                "label": stage.label,
                "position": stage.position,
                "device_count": stage.device_count,
                "online_count": stage.online_count,
                "instrumented": stage.instrumented,
                "health": stage.health,
                "devices": [
                    {
                        "device_id": d.device_id, "code": d.code,
                        "device_type_code": d.device_type_code, "online": d.online,
                    }
                    for d in stage.devices
                ],
                "slots": [_slot_json(slot) for slot in stage.slots],
            }
            for stage in stages.stages
        ],
        # Power-path Devices whose Type has no stage. Reported rather than
        # dropped: a Type someone added without giving it a stage would otherwise
        # vanish from the diagram with nothing said.
        "unstaged": [
            {"device_id": d.device_id, "code": d.code,
             "device_type_code": d.device_type_code}
            for d in stages.unstaged
        ],
    }
