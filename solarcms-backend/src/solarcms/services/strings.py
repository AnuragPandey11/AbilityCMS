"""Every PV string of every Inverter on a Plant, with a verdict — String Analysis.

One request for the whole Plant, because the screen is a grid of every string
at once: the per-Device readings endpoint would need a request per Inverter to
stay under its point cap, and each would still leave the verdict to the browser,
where an assumed threshold may not live (Guardrail 6). The rule is
`domain/strings.py`; this module only finds its inputs.

Three reads, all through the `*_v` barrier views (the API holds no privilege on
the telemetry relations, and the views scope every row to Plants this session
can see):

* the Plant's Inverters, with `string_count` — how many PV inputs this machine
  has, a property of the Device and never of its Model;
* which `PVn_CURRENT` Tags each is bound to, so an unbound string says so
  instead of reading as a silent one (Guardrail 26);
* the latest good one-minute value of each `PVn_*` Tag in the last thirty
  minutes — the window the Inverter view uses, so a string opened from here
  shows the same figure — and how many flagged buckets there were.

Whether each Inverter is generating comes from `services/operating`, the same
rule the Inverter view states, so a string called "no current" here is on an
Inverter that view calls running.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import (
    HEALTH_DEGRADED_MULTIPLIER,
    STRING_DEVIATION_FRACTION,
    STRING_LOW_MIN_MEDIAN_A,
)
from solarcms.domain.strings import (
    StringReading,
    classify_strings,
    count_states,
)
from solarcms.services.operating import device_states

# The Device Type whose PV inputs are listed. A catalogue row, not a Client,
# Plant or Device (Guardrail 2) — the way Inverter Monitoring filters on it.
INVERTER_TYPE_CODE = "INVERTER"

# As far back as a "latest" value may come from: the Inverter view's window
# (`DEVICE_LOOKBACK_MINUTES` in the frontend), so both screens agree.
LOOKBACK = timedelta(minutes=30)

_PV_TAG = re.compile(r"^PV(\d+)_(CURRENT|VOLTAGE|ACTIVE_POWER)$")
_PV_TAG_SQL = r"^PV[0-9]+_(CURRENT|VOLTAGE|ACTIVE_POWER)$"
_MEASURE = {"CURRENT": "current", "VOLTAGE": "voltage", "ACTIVE_POWER": "power"}


def _pv(code: str) -> tuple[int, str] | None:
    """`PV12_CURRENT` → (12, "current")."""
    match = _PV_TAG.match(code)
    return (int(match.group(1)), _MEASURE[match.group(2)]) if match else None


def _uncounted_reason(bound_inputs: int) -> str:
    """Why an Inverter with no string count has no strings drawn.

    ⚠ Bound PV inputs are not a count. A Device commissioned from the broker is
    bound to every key it publishes, and an Inverter with a fixed register map
    publishes all 28 inputs whether or not a string is connected — an unused
    input reads zero, and drawing it would paint a dead string that does not
    exist. Only the recorded count says which inputs are real.
    """
    if bound_inputs:
        return (
            f"No string count is recorded for this Inverter. {bound_inputs} PV inputs "
            "are bound, but how many of them have a string connected is not known — "
            "an unused input reads zero and would be drawn as a dead string. Record "
            "the count under Tag Mapping."
        )
    return (
        "No string count is recorded for this Inverter and none of its PV inputs is "
        "bound. Record the count under Tag Mapping, and bind its PV keys there — from "
        "the Model, or from the keys it publishes."
    )


async def plant_strings(
    session: AsyncSession, plant_id: int, timezone: str | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    moment = now or datetime.now(UTC)
    inverters = (await session.execute(text("""
        SELECT d.id, d.code, d.name, d.string_count, d.expected_interval_s,
               dm.variant, COALESCE(h.comm_status, 'unknown') AS comm_status
          FROM devices d
          JOIN device_models dm ON dm.id = d.device_model_id
          JOIN device_types dt  ON dt.id = dm.device_type_id
          LEFT JOIN device_health h ON h.device_id = d.id
         WHERE d.plant_id = :plant_id AND d.status <> 'decommissioned'
           AND dt.code = :type_code
         ORDER BY d.code
    """), {"plant_id": plant_id, "type_code": INVERTER_TYPE_CODE})).all()
    ids = [row.id for row in inverters]

    units = {
        _MEASURE[code.split("_", 1)[1]]: unit
        for code, unit in (await session.execute(text("""
            SELECT code, unit FROM tags
             WHERE code IN ('PV1_CURRENT', 'PV1_VOLTAGE', 'PV1_ACTIVE_POWER')
        """))).all()
    }
    current_unit = units.get("current") or "A"

    bound: dict[int, set[int]] = {}
    # How often each Inverter's PV Tags are stored when all is well: its cycle
    # or the Tags' throttle, whichever is longer — what the hold is built on.
    stored_every: dict[int, int] = {}
    if ids:
        for row in (await session.execute(text("""
            SELECT b.device_id, t.code, t.min_interval_s
              FROM device_tag_bindings b JOIN tags t ON t.id = b.tag_id
             WHERE b.device_id = ANY(:ids) AND b.enabled AND t.code ~ :pattern
        """), {"ids": ids, "pattern": _PV_TAG_SQL})).all():
            parsed = _pv(row.code)
            if parsed is None:
                continue
            n, measure = parsed
            if measure == "current":
                bound.setdefault(row.device_id, set()).add(n)
            stored_every[row.device_id] = max(
                stored_every.get(row.device_id, 0), row.min_interval_s or 0)

    latest: dict[tuple[int, int], dict[str, Any]] = {}
    flagged: dict[tuple[int, int], int] = {}
    if ids:
        start = moment - LOOKBACK
        for row in (await session.execute(text("""
            SELECT DISTINCT ON (a.device_id, a.tag_id)
                   a.device_id, t.code, a.bucket,
                   CASE t.rollup_method
                        WHEN 'last' THEN a.last_value
                        WHEN 'max'  THEN a.max_value
                        ELSE             a.avg_value
                   END AS value
              FROM agg_1m_v a JOIN tags t ON t.id = a.tag_id
             WHERE a.device_id = ANY(:ids) AND t.code ~ :pattern
               AND a.bucket >= :start AND a.bucket <= :now
               AND coalesce(a.worst_quality, 0) = 0
               AND CASE t.rollup_method
                        WHEN 'last' THEN a.last_value
                        WHEN 'max'  THEN a.max_value
                        ELSE             a.avg_value
                   END IS NOT NULL
             ORDER BY a.device_id, a.tag_id, a.bucket DESC
        """), {"ids": ids, "pattern": _PV_TAG_SQL, "start": start, "now": moment})).all():
            parsed = _pv(row.code)
            if parsed is None:
                continue
            n, measure = parsed
            slot = latest.setdefault((row.device_id, n), {})
            slot[measure] = float(row.value)
            if measure == "current":
                slot["at"] = row.bucket
        for row in (await session.execute(text("""
            SELECT a.device_id, t.code, count(*) AS flagged
              FROM agg_1m_v a JOIN tags t ON t.id = a.tag_id
             WHERE a.device_id = ANY(:ids) AND t.code ~ '^PV[0-9]+_CURRENT$'
               AND a.bucket >= :start AND a.bucket <= :now
               AND coalesce(a.worst_quality, 0) <> 0
             GROUP BY a.device_id, t.code
        """), {"ids": ids, "start": start, "now": moment})).all():
            parsed = _pv(row.code)
            if parsed is not None:
                flagged[(row.device_id, parsed[0])] = int(row.flagged)

    states = await device_states(session, plant_id, timezone, moment) if ids else {}

    out: list[dict[str, Any]] = []
    totals = count_states([])
    for inverter in inverters:
        state, state_reason = states.get(
            inverter.id, (None, "this Inverter is not bound to AC_ACTIVE_POWER"))
        generating = state == "running"
        count = inverter.string_count or 0
        hold = timedelta(seconds=HEALTH_DEGRADED_MULTIPLIER * max(
            inverter.expected_interval_s or 0, stored_every.get(inverter.id, 0), 60))
        readings = [
            StringReading(
                n=n,
                bound=n in bound.get(inverter.id, set()),
                current=latest.get((inverter.id, n), {}).get("current"),
                at=latest.get((inverter.id, n), {}).get("at"),
                flagged=flagged.get((inverter.id, n), 0),
            )
            for n in range(1, count + 1)
        ]
        verdicts, reference = classify_strings(
            readings, generating=generating,
            generating_known=state in ("running", "stopped", "not_started"),
            now=moment, hold=hold, unit=current_unit,
        )
        counts = count_states(verdicts)
        for key, value in counts.items():
            totals[key] += value
        out.append({
            "device_id": inverter.id,
            "code": inverter.code,
            "name": inverter.name,
            "variant": inverter.variant,
            "comm_status": inverter.comm_status,
            "string_count": inverter.string_count,
            # Guardrail 26: a row with no strings says why, and what fixes it.
            "undefined_reason": None if inverter.string_count else _uncounted_reason(
                len(bound.get(inverter.id, set()))),
            "operating": {"state": state, "undefined_reason": state_reason},
            "median_current": reference,
            "counts": counts,
            "strings": [
                {
                    "n": verdict.n,
                    "state": verdict.state,
                    "reason": verdict.reason,
                    "current": verdict.current,
                    "voltage": latest.get((inverter.id, verdict.n), {}).get("voltage"),
                    "power": latest.get((inverter.id, verdict.n), {}).get("power"),
                    "at": latest.get((inverter.id, verdict.n), {}).get("at"),
                    "flagged": flagged.get((inverter.id, verdict.n), 0),
                }
                for verdict in verdicts
            ],
        })

    return {
        "plant_id": plant_id,
        "as_of": moment,
        "units": {"current": current_unit, "voltage": units.get("voltage"),
                  "power": units.get("power")},
        # Echoed so the screen can say what "low" meant, and that it is a
        # proposal rather than the client's rule.
        "rule": {
            "measure": "PVn_CURRENT",
            "low_below_median_fraction": STRING_DEVIATION_FRACTION,
            "min_median": STRING_LOW_MIN_MEDIAN_A,
            "lookback_minutes": int(LOOKBACK.total_seconds() // 60),
            "status": "PROPOSED",
        },
        "counts": totals,
        "inverters": out,
    }
