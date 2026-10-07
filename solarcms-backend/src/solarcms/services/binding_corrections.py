"""Per-Device binding corrections, applied from a reviewed file.

Which Tag a payload key lands on, and at what scale, is a fact about one Device
(MASTER §5.2, T-1). The same key `VRY` is 11.04 kV from one Client's feeder
meter, 10,200.73 V from another's and 420 V from a third's LT meter, and an
alias keyed by Device Type cannot tell those apart — which is why a binding is
the authority and an alias only seeds it. Where the seed is wrong, the fix is a
correction to that Device's binding: data with its evidence beside it, never a
code path named after a Device (Guardrail 2).

A correction file::

    {"corrections": [
      {"topic": "SCMS/V1/…/ICOG_MFM", "source_key": "VRY",
       "tag": "HV_VOLTAGE_RY", "scale": 0.001,
       "evidence": "sqrt(3) * 10.2 kV * 22.4 A * 0.998 = 395 kW against P 392.7"}
    ]}

Every correction is refused rather than guessed at when its topic is not
registered, its Tag does not exist, or its Tag is already bound on that Device
under another key. Every applied change writes an audit row carrying the
evidence. ⚠ A changed scale applies to future Readings only; `mqtt_raw` keeps
the original payloads, which is the route back for history (MASTER §5.3).
"""

from __future__ import annotations

import json
from typing import Any, Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import TAG_SPECS
from solarcms.services.device_topics import topic_owner

CORRECTIONS_ACTOR: Final = "cli:apply-binding-corrections"


async def apply_corrections(
    session: AsyncSession, corrections: list[dict[str, Any]], *, apply: bool,
) -> list[dict[str, Any]]:
    """Check, and with `apply` write, each correction. Returns one row per entry.

    `status` is one of `unchanged`, `would change` (dry run), `changed`, or
    `refused` — with `detail` saying why, in words.
    """
    results: list[dict[str, Any]] = []
    for entry in corrections:
        topic = str(entry.get("topic", ""))
        key = str(entry.get("source_key", ""))
        result = {"topic": topic, "source_key": key, "status": "refused", "detail": ""}
        results.append(result)

        tag_code = entry.get("tag")
        scale = entry.get("scale", 1.0)
        evidence = entry.get("evidence")
        if not topic or not key or not isinstance(tag_code, str):
            result["detail"] = "each correction needs topic, source_key and tag"
            continue
        if not isinstance(scale, int | float) or scale == 0:
            result["detail"] = f"scale must be a non-zero number, not {scale!r}"
            continue
        if not evidence:
            result["detail"] = "a correction without its evidence cannot be reviewed"
            continue
        spec = TAG_SPECS.get(tag_code)
        tag_id = (await session.execute(text(
            "SELECT id FROM tags WHERE code = :code"), {"code": tag_code})).scalar()
        if spec is None or tag_id is None:
            result["detail"] = f"there is no Tag {tag_code!r}"
            continue

        owner = await topic_owner(session, topic)
        if owner is None:
            result["detail"] = ("no Device is registered on this topic yet; "
                                "commission it first")
            continue
        device = (await session.execute(text(
            "SELECT id, code, client_id FROM devices WHERE id = :id"
        ), {"id": owner.device_id})).one()

        current = (await session.execute(text("""
            SELECT b.id, b.tag_id, t.code AS tag_code, b.scale
              FROM device_tag_bindings b JOIN tags t ON t.id = b.tag_id
             WHERE b.device_id = :device_id AND b.source_key = :key
        """), {"device_id": device.id, "key": key})).first()
        clash = (await session.execute(text("""
            SELECT source_key FROM device_tag_bindings
             WHERE device_id = :device_id AND tag_id = :tag_id AND source_key <> :key
        """), {"device_id": device.id, "tag_id": tag_id, "key": key})).scalar()
        if clash is not None:
            result["detail"] = (f"{device.code} already binds {tag_code} to key "
                                f"{clash!r}; one Tag cannot come from two keys")
            continue

        before = (None if current is None
                  else f"{current.tag_code} x{current.scale:g}")
        after = f"{tag_code} x{float(scale):g}"
        if current is not None and current.tag_id == tag_id and current.scale == scale:
            result.update(status="unchanged", detail=f"{device.code}: already {after}")
            continue
        result.update(status="changed" if apply else "would change",
                      detail=f"{device.code}: {before or 'unbound'} -> {after}")
        if not apply:
            continue

        if current is None:
            binding_id = (await session.execute(text("""
                INSERT INTO device_tag_bindings (client_id, device_id, tag_id, source_key,
                                                 scale, value_offset, valid_min, valid_max)
                VALUES (:client_id, :device_id, :tag_id, :key, :scale, 0.0,
                        :valid_min, :valid_max)
                RETURNING id
            """), {"client_id": device.client_id, "device_id": device.id,
                   "tag_id": tag_id, "key": key, "scale": float(scale),
                   "valid_min": spec.valid_min, "valid_max": spec.valid_max,
                   })).scalar_one()
        else:
            binding_id = current.id
            # The bounds are the Tag's, in the Tag's unit. A new Tag brings its
            # own; a new scale on the same Tag leaves them where they were,
            # since they are compared against the value *after* scaling.
            await session.execute(text("""
                UPDATE device_tag_bindings
                   SET tag_id = CAST(:tag_id AS bigint), scale = :scale,
                       valid_min = CASE WHEN tag_id = CAST(:tag_id AS bigint)
                                        THEN valid_min ELSE :valid_min END,
                       valid_max = CASE WHEN tag_id = CAST(:tag_id AS bigint)
                                        THEN valid_max ELSE :valid_max END
                 WHERE id = :id
            """), {"tag_id": tag_id, "scale": float(scale), "id": current.id,
                   "valid_min": spec.valid_min, "valid_max": spec.valid_max})

        await session.execute(text("""
            INSERT INTO audit_log (client_id, actor_email, action, entity_type,
                                   entity_id, before, after)
            VALUES (:client_id, :actor, 'device.binding.correct',
                    'device_tag_bindings', :entity_id,
                    CAST(:before AS jsonb), CAST(:after AS jsonb))
        """), {"client_id": device.client_id, "actor": CORRECTIONS_ACTOR,
               "entity_id": binding_id,
               "before": json.dumps({"device": device.code, "topic": topic,
                                     "source_key": key, "binding": before}),
               "after": json.dumps({"device": device.code, "topic": topic,
                                    "source_key": key, "binding": after,
                                    "evidence": evidence})})
    return results
