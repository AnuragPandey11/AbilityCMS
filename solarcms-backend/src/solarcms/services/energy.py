"""Read cumulative registers from an aggregate tier, for `domain/counters`.

The I/O half of the energy calculation: one query per call, returning each
Device's readings of the requested (Device Type, Tag) pairs in time order. The
arithmetic — which steps count, which Type answers — is `domain/counters`, so
the KPI endpoint, the Block endpoint and the Reports all reach the same figure
from the same rule.

⚠ `client_id` is **required** from the scheduler. It reads with platform
privileges, so the barrier views do not scope it (`app_is_platform_admin()` is
true); without the predicate a Report would include another Client's meters.
The API passes none — RLS on `devices` already scopes every row it can see.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.counters import CounterSample, DeviceSeries, PlantEnergy
from solarcms.domain.tiering import TIERS, Tier


async def read_counter_series(
    session: AsyncSession,
    *,
    tier: Tier,
    pairs: Sequence[tuple[str, str]],
    start: datetime,
    end: datetime | None = None,
    plant_ids: Sequence[int] | None = None,
    block_id: int | None = None,
    client_id: int | None = None,
) -> dict[int, list[DeviceSeries]]:
    """Per Plant, every Device's series for the given pairs, from `tier`.

    Reads the tier's `_v` barrier view — the API holds no privilege on the
    telemetry relations themselves (migrations 0008/0010). The relation name is
    interpolated rather than bound because no driver can parameterise a table
    name; it comes from the `Tier` enum, never from a caller's input.
    """
    if plant_ids is None and block_id is None:
        raise ValueError("read_counter_series needs plant_ids or block_id")
    scope = []
    params: dict[str, Any] = {
        "start": start, "end": end,
        "pairs": [f"{type_code}:{tag_code}" for type_code, tag_code in pairs],
    }
    if plant_ids is not None:
        scope.append("d.plant_id = ANY(:plant_ids)")
        params["plant_ids"] = list(plant_ids)
    if block_id is not None:
        scope.append("d.block_id = :block_id")
        params["block_id"] = block_id
    if client_id is not None:
        scope.append("d.client_id = :client_id")
        params["client_id"] = client_id

    rows = (await session.execute(text(f"""
        SELECT d.plant_id, d.id AS device_id, d.code AS device_code,
               dt.code AS type_code, t.code AS tag_code, d.rated_capacity_kw,
               a.bucket, a.last_value
          FROM {tier.value}_v a
          JOIN devices d        ON d.id = a.device_id
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          JOIN tags t           ON t.id = a.tag_id
         WHERE {" AND ".join(scope)}
           AND a.bucket >= :start
           AND (CAST(:end AS timestamptz) IS NULL OR a.bucket < CAST(:end AS timestamptz))
           AND (dt.code || ':' || t.code) = ANY(:pairs)
           AND a.last_value IS NOT NULL
         ORDER BY d.id, t.code, a.bucket
    """), params)).all()

    # A bucket's `last_value` is the last reading *in* it, taken near its end,
    # so the sample is stamped at the bucket's end. Stamping it at the start
    # would attribute every hour's energy to the hour before — and a Report's
    # daily totals to the wrong local day around midnight.
    # Capped at now: the bucket still filling has not reached its end.
    resolution = next(spec.resolution for spec in TIERS if spec.tier == tier)
    now = datetime.now(UTC)
    grouped: dict[tuple[int, int, str], dict[str, Any]] = {}
    for row in rows:
        key = (row.plant_id, row.device_id, row.tag_code)
        entry = grouped.setdefault(key, {
            "plant_id": row.plant_id, "device_id": row.device_id,
            "device_code": row.device_code, "type_code": row.type_code,
            "tag_code": row.tag_code,
            "rated": float(row.rated_capacity_kw) if row.rated_capacity_kw else None,
            "samples": [],
        })
        entry["samples"].append(
            CounterSample(min(row.bucket + resolution, now), float(row.last_value)))

    result: dict[int, list[DeviceSeries]] = {}
    for entry in grouped.values():
        result.setdefault(entry["plant_id"], []).append(DeviceSeries(
            device_id=entry["device_id"], device_code=entry["device_code"],
            device_type_code=entry["type_code"], tag_code=entry["tag_code"],
            samples=tuple(entry["samples"]), rated_capacity_kw=entry["rated"],
        ))
    return result


def split_by_pair(
    series: Sequence[DeviceSeries], pair: tuple[str, str],
) -> tuple[list[DeviceSeries], list[DeviceSeries]]:
    """(the series for `pair`, everything else)."""
    matching = [s for s in series if (s.device_type_code, s.tag_code) == pair]
    rest = [s for s in series if (s.device_type_code, s.tag_code) != pair]
    return matching, rest


def energy_source_payload(energy: PlantEnergy) -> dict[str, Any]:
    """Which meter answered, and why the ones before it did not.

    Travels with the figure for the reason a dashboard slot's provenance does:
    energy off the settlement meter and energy summed from twelve Inverters are
    different claims, and which one this is must be answerable from the
    response alone.
    """
    return {
        "device_type_code": energy.device_type_code,
        "tag_code": energy.tag_code,
        "device_count": len(energy.devices),
        "devices": [device.series.device_code for device in energy.devices],
        # False when no capacity was recorded: impossible jumps could not be
        # caught, and a figure that skipped a check should say so.
        "jump_check": energy.jump_check,
        "passed_over": [
            {"device_type_code": p.device_type_code, "reason": p.reason}
            for p in energy.passed_over
        ],
        "undefined_reason": energy.undefined_reason,
    }


def counter_anomalies_payload(energy: PlantEnergy) -> list[dict[str, Any]]:
    """Every step refused as generation, for the response and the Report.

    ⚠ Read beside the figure: each one is energy the total does not contain,
    because a counter that went backwards or jumped cannot say how much was
    really produced across the gap.
    """
    return [
        {
            "device_code": series.device_code,
            "tag_code": series.tag_code,
            "kind": anomaly.kind,
            "previous_at": anomaly.previous_at.isoformat(),
            "at": anomaly.at.isoformat(),
            "from_value": anomaly.from_value,
            "to_value": anomaly.to_value,
            "limit": anomaly.limit,
        }
        for series, anomaly in energy.anomalies
    ]
