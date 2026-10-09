"""Changing a Tag so that the change actually takes effect, and stays.

Three rules, decided by the user on 8 Oct 2026:

* **Devices follow unless hand-tuned.** Every binding copies the Tag's range
  and scale when the Device is registered, and ingest checks the binding's
  copy — so editing the Tag changed nothing for a single Device already set
  up (it took migration 0034 to widen DEVICE_STATUS). Now a binding still
  holding the Tag's *old* value takes the new one; a binding somebody set
  differently (a per-Device unit correction, a hand-widened range) keeps its
  own, and the caller is told how many of each.
* **Edited fields win over the code.** A field changed through the API is
  listed in `tags.edited_fields`, and `cli seed` leaves it alone while still
  updating every other field from `domain/assumptions.py`.
* **It applies now.** Ingest caches each topic's resolution, bindings and all,
  for five minutes; after a change every cached resolution is cleared.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Final

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.cache.keys import RESOLVE_TOPIC
from solarcms.cache.live import announce_all_resolutions_invalid, get_redis
from solarcms.domain.assumptions import (
    DERIVED_TAG_FORMULAS,
    MIN_INTERVAL_S_BY_CATEGORY,
    MIN_INTERVAL_S_CUMULATIVE,
    TAG_SPECS,
)

log = structlog.get_logger(__name__)

#: The fields `cli seed` writes, and so the ones whose edits it must respect.
TRACKED_FIELDS: Final = (
    "unit", "category", "rollup_method", "scale_default", "valid_min", "valid_max",
    "min_interval_s", "is_cumulative", "formula", "derived_scope",
)
#: Tag field → the binding column holding each Device's own copy of it.
BINDING_COPIES: Final = {"valid_min": "valid_min", "valid_max": "valid_max",
                         "scale_default": "scale"}
#: Columns that may never be NULL, so a PATCH cannot clear them.
NOT_NULL_FIELDS: Final = frozenset({
    "unit", "category", "rollup_method", "scale_default", "min_interval_s", "is_cumulative",
})


def default_tag_rows() -> dict[str, dict[str, Any]]:
    """Every Tag as `domain/assumptions.py` defines it — what `cli seed` writes."""
    rows: dict[str, dict[str, Any]] = {}
    for code, spec in sorted(TAG_SPECS.items()):
        # Cumulative counters are throttled harder than instantaneous values:
        # they are monotonic, so sampling loses nothing. Status Tags are never
        # throttled at all (Guardrail 11) — the category map carries the 0.
        if spec.category == "status":
            min_interval = 0
        elif spec.cumulative:
            min_interval = MIN_INTERVAL_S_CUMULATIVE
        else:
            min_interval = MIN_INTERVAL_S_BY_CATEGORY.get(spec.category, 60)
        formula, scope = DERIVED_TAG_FORMULAS.get(code, (None, None))
        rows[code] = {
            "code": code,
            "name": code.replace("_", " ").title(),
            "unit": spec.unit,
            "category": spec.category,
            "rollup_method": spec.rollup_method,
            "scale_default": spec.scale,
            "valid_min": spec.valid_min,
            "valid_max": spec.valid_max,
            "min_interval_s": min_interval,
            "is_cumulative": spec.cumulative,
            "formula": formula,
            "derived_scope": scope,
        }
    return rows


@dataclass
class FollowResult:
    """What a Tag change did to the Devices bound to it."""

    followed: set[int] = field(default_factory=set)  # binding ids updated
    kept: set[int] = field(default_factory=set)  # binding ids with their own value
    device_ids: set[int] = field(default_factory=set)

    def merge(self, other: FollowResult) -> None:
        self.followed |= other.followed
        self.kept |= other.kept
        self.device_ids |= other.device_ids


async def follow_on_bindings(
    session: AsyncSession, tag_id: int, changes: dict[str, tuple[Any, Any]],
) -> FollowResult:
    """Carry a Tag's changed range or scale to the bindings still on the old value.

    `changes` maps a Tag field to (old, new). A binding whose copy equals the
    old value never diverged from the Tag, so it follows; one that differs was
    set on purpose and is kept. Fields with no binding copy are ignored.
    """
    result = FollowResult()
    for tag_field, (old, new) in changes.items():
        column = BINDING_COPIES.get(tag_field)
        if column is None or old == new:
            continue
        # The column comes from the literal map above, never from a request.
        updated = (await session.execute(text(f"""
            UPDATE device_tag_bindings
               SET {column} = CAST(:new AS double precision)
             WHERE tag_id = :tag_id
               AND {column} IS NOT DISTINCT FROM CAST(:old AS double precision)
            RETURNING id, device_id
        """), {"tag_id": tag_id, "old": old, "new": new})).all()
        kept = (await session.execute(text(f"""
            SELECT id FROM device_tag_bindings
             WHERE tag_id = :tag_id
               AND {column} IS DISTINCT FROM CAST(:new AS double precision)
        """), {"tag_id": tag_id, "new": new})).all()
        result.followed |= {r.id for r in updated}
        result.device_ids |= {r.device_id for r in updated}
        result.kept |= {r.id for r in kept}
    result.kept -= result.followed
    return result


async def clear_cached_resolutions() -> int:
    """Clear every topic resolution ingest has cached, so a change applies now.

    Best effort: a Redis that cannot be reached leaves the cache to expire on
    its own (`RESOLVE_TOPIC_TTL_S`), which is how long a change took before.
    """
    pattern = RESOLVE_TOPIC.format(topic="*")
    cleared = 0
    try:
        client = get_redis()
        batch: list[str] = []
        async for key in client.scan_iter(match=pattern, count=500):
            batch.append(key)
            if len(batch) >= 500:
                cleared += await client.delete(*batch)
                batch = []
        if batch:
            cleared += await client.delete(*batch)
        # Ingest keeps resolutions in memory too (§4.5): tell it to drop them.
        await announce_all_resolutions_invalid()
    except Exception as exc:
        log.warning("cached resolutions not cleared; they expire on their own",
                    error=str(exc))
    return cleared
