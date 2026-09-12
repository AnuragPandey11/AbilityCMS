"""Idempotent seed of the platform catalogue.

BACKEND_SPEC §13 Phase 3. Everything here is **global, platform-owned reference
data**: Device Types, the Tag registry, roles, permissions, dashboards, the
ingress topic patterns, and the default Alarm Rules. No Client, Plant, or Device
is created — those are onboarding, not seeding (MASTER §6.5).

Every row is an upsert keyed on its natural code, so running this repeatedly is
safe and an upgrade only adds what is new. Values that are still assumptions come
from `domain/assumptions.py` and nowhere else: when the client supplies real
units, scales or thresholds, editing that one module and re-running this is the
entire change.
"""

from __future__ import annotations

import json
from typing import Any, Final

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import (
    ALL_ALARM_RULE_SEEDS,
    MIN_INTERVAL_S_BY_CATEGORY,
    MIN_INTERVAL_S_CUMULATIVE,
    SOURCE_KEY_ALIASES,
    TAG_SPECS,
)

log = structlog.get_logger(__name__)

# ── Device Types — CONFIRMED (MASTER §2.3), re-confirmed by the client's own
# Device List on 10 Sep 2026 (docs/TAG_CATALOGUE.md §1).
#
# `in_power_path` decides Single Line Diagram membership. A Device outside the
# power path is real and monitored, but electricity does not flow through it and
# placing it in the electrical tree would corrupt the diagram.
DEVICE_TYPES: Final[tuple[tuple[str, str, bool, list[str] | None], ...]] = (
    ("VCB", "Vacuum Circuit Breaker", True, None),
    ("ISOLATOR", "Isolator / Disconnector", True, None),
    ("INVERTER", "Inverter", True, ["central", "string"]),
    ("SMB", "String Monitoring Box", True, None),
    ("TRANSFORMER", "Transformer", True, ["two_winding", "three_winding"]),
    ("MFM", "Multi-Function Meter", True, None),
    ("ABT_METER", "Availability Based Tariff Meter", True, None),
    ("WMS", "Weather Monitoring Station", False, None),
    ("PPC", "Power Plant Controller", False, None),
    ("MODULE_TRACKER", "Module Tracker", False, None),
    ("UPS", "Uninterruptible Power Supply", False, None),
    ("DC_POWER_BANK", "DC Power Bank", False, None),
    ("FIRE_SYSTEM", "Fire Detection / Suppression System", False, None),
    ("ANNUNCIATOR", "Annunciator Panel", False, None),
    ("SLDC_TELEMETRY", "SLDC Telemetry Unit", False, None),
    # ⚠ OPEN-12. Seeded in the power path on the strength of the client's signal
    # schedule: they appear in a *Device* List, and VCBs and MFMs are scheduled
    # against IC-1/OG-2 feeder positions within them, which makes them switchgear
    # sections carrying feeders. Awaiting written confirmation (T-9); if the
    # answer is "rooms", this is one UPDATE and they become Blocks instead.
    ("MCR_SECTION", "Main Control Room Section", True, None),
    ("ICR_SECTION", "Inverter Control Room Section", True, None),
)

# ── Permissions — MASTER §4.3.
PERMISSIONS: Final[tuple[tuple[str, str], ...]] = (
    ("dashboard.view", "Open an assigned dashboard"),
    ("alarm.acknowledge", "Acknowledge or clear an Alarm"),
    ("data.export", "Export data as CSV or Excel"),
    ("report.generate", "Run or schedule a Report"),
    ("config.modify", "Change Plant, Device, or Tag configuration"),
    ("user.manage", "Create and edit Users, assign Roles"),
    ("plant.manage", "Onboard, edit, or decommission a Plant"),
    ("system.admin", "Platform-level administration"),
)

# ── Roles — CONFIRMED four-role model (F-7, F-10, F-11).
#
# ⚠ OPEN-2: the tender names five roles (Administrator, Operator, Management,
# Read-Only). The client's four-role model is CONFIRMED and more recent, and is
# what is seeded. `roles` is a table rather than an enum, so if the tender text
# governs instead, the difference is rows, not a migration (tender §29).
ROLES: Final[tuple[tuple[str, str, tuple[str, ...]], ...]] = (
    ("super_admin", "Super Admin", tuple(code for code, _ in PERMISSIONS)),
    ("admin", "Client Admin", (
        "dashboard.view", "alarm.acknowledge", "data.export", "report.generate",
        # plant.manage is held by a Client Admin per F-15 — they may create Plants
        # and Devices, and therefore issue broker credentials, scoped to their own
        # Client only (I-9).
        "config.modify", "user.manage", "plant.manage",
    )),
    ("employee", "Client Employee", (
        "dashboard.view", "alarm.acknowledge", "data.export", "report.generate",
    )),
    # A Guest may only ever reach a Client flagged for demonstration (I-6),
    # enforced by the clients_visibility policy in migration 0008, not here.
    ("guest", "Guest", ("dashboard.view",)),
)

# ── Dashboards — tender §7. Which *types* a User may open (dimension A-3).
DASHBOARDS: Final[tuple[tuple[str, str, int], ...]] = (
    ("portfolio", "Portfolio", 10),
    ("plant_overview", "Plant Overview", 20),
    ("plant_list", "Plant List", 30),
    ("single_plant", "Single Plant", 40),
    ("sld", "Single Line Diagram", 50),
    ("inverter_monitoring", "Inverter Monitoring", 60),
    ("alarms", "Alarms", 70),
    ("reports", "Reports", 80),
)

# ── Ingress topic patterns (§5.1 and docs/BROKER_OBSERVATIONS.md §3).
#
# Kept as data so that a Client publishing a different shape is an INSERT rather
# than a deployment, and so no Client's name ever becomes a code path (I-1).
TOPIC_PATTERNS: Final[tuple[tuple[str, int, str], ...]] = (
    (
        "scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}", 10,
        "Canonical contract (MASTER §5.1). Lowest priority number, so it is "
        "matched ahead of any legacy shape that would also fit.",
    ),
    (
        "{plant_code}/{category}", 90,
        "Legacy shape observed on the client's test broker: two segments, no "
        "collector and no device. Each category is one physical instrument "
        "reporting Plant-level totals, registered as its own Device. Retire this "
        "row once publishing moves to the canonical format (B-1).",
    ),
)


# ── Report definitions — tender §25. Generic by design: the catalogue is rows,
# not code, so adding a Report is an INSERT.
#
# ⚠ `is_financial` is not a label. I-11 makes it an input constraint: a Report
# marked financial is computed from ABT Meter Readings and refuses to run when
# none exist, rather than silently falling back to an MFM.
REPORT_DEFINITIONS: Final[tuple[tuple[str, str, str, bool, dict[str, Any]], ...]] = (
    ("daily_generation", "Daily Generation",
     "Per-Device export over a day, with PR, CUF and CO2 avoided.", False,
     {"energy_tag": "ENERGY_EXPORT_TOTAL", "granularity": "hour"}),
    ("monthly_performance", "Monthly Performance",
     "Per-Plant monthly performance summary from the daily tier.", False,
     {"energy_tag": "ENERGY_EXPORT_TOTAL", "granularity": "day"}),
    ("monthly_settlement", "Monthly Settlement",
     "Revenue-grade export for invoicing. ABT Meter Readings only (I-11).", True,
     {"energy_tag": "ENERGY_EXPORT_TOTAL", "granularity": "day"}),
    ("device_availability", "Device Availability",
     "Time-weighted availability per Device, from health transitions.", False,
     {"source": "device_health_events"}),
)


# ── Reference Device Models — one per Device Type, carrying the client's own
# signal schedule (docs/TAG_CATALOGUE.md §2). The client has named no
# manufacturers or model numbers, so these are the Models a Device is registered
# against until real ones are known; every Type must have at least one Model or
# it cannot appear in onboarding at all (a Device requires a Model). Types whose
# signal list the client has not supplied (§6) get a Model with no Tags — the
# Device can still be registered and its bindings set by hand.
#
# `MFM` and `ABT_METER` carry the identical list: the sheet gives both the same
# fifteen rows. That is not a copy error — an ABT meter is a revenue-grade MFM —
# and I-11 is enforced by Device Type, not by Tag set.
REFERENCE_MANUFACTURER: Final = "Reference"
_MFM_SIGNALS: Final[tuple[str, ...]] = (
    "HV_VOLTAGE_RY", "HV_VOLTAGE_YB", "HV_VOLTAGE_BR", "HV_VOLTAGE_AVG",
    "AC_CURRENT_R", "AC_CURRENT_Y", "AC_CURRENT_B",
    "POWER_FACTOR_R", "POWER_FACTOR_Y", "POWER_FACTOR_B",
    "AC_ACTIVE_POWER", "AC_REACTIVE_POWER", "FREQUENCY",
    "ENERGY_EXPORT_TOTAL", "ENERGY_IMPORT_TOTAL",
)
REFERENCE_MODEL_TAGS: Final[dict[str, tuple[str, ...]]] = {
    "VCB": (
        "VCB_ON_FEEDBACK", "VCB_TRIP_FEEDBACK", "VCB_IN_TEST_MODE", "VCB_IN_SERVICE",
        "VCB_SPRING_CHARGE", "VCB_OC_RELAY", "AC_FAIL", "DC_FAIL", "VCB_TC_HEALTHY",
        "VCB_EMERGENCY_PB", "VCB_RELAY_UNHEALTHY", "VCB_REMOTE_SELECTION",
    ),
    "WMS": (
        "AMBIENT_TEMPERATURE", "WIND_SPEED", "GTI", "GHI", "GTI_CUMULATIVE",
        "GHI_CUMULATIVE", "GTI_CUMULATIVE_YESTERDAY", "GHI_CUMULATIVE_YESTERDAY",
        "MODULE_TEMPERATURE", "HUMIDITY", "RAIN_GAUGE", "WIND_DIRECTION",
        "DIFFUSE_RADIATION", "DIFFUSE_RADIATION_AVG", "DIRECT_RADIATION",
        "DIRECT_RADIATION_AVG", "CLOUD_COVER",
    ),
    "INVERTER": (
        "HV_VOLTAGE_AVG", "AC_CURRENT_AVG", "AC_ACTIVE_POWER", "DC_POWER",
        "AC_REACTIVE_POWER", "POWER_FACTOR", "FREQUENCY", "INVERTER_EFFICIENCY",
        # T-11: "MODULE TEMP." on an Inverter is read as the inverter's own
        # internal temperature, not the PV module (a WMS quantity).
        "DEVICE_TEMPERATURE", "ENERGY_TODAY", "SPECIFIC_YIELD", "ENERGY_MONTHLY",
        "ENERGY_CUMULATIVE_MWH", "DEVICE_STATUS", "PV_VOLTAGE", "PV_CURRENT",
        "TODAY_PEAK",
    ),
    "TRANSFORMER": (
        "OIL_TEMP_ALARM", "OIL_TEMP_TRIP", "WINDING_TEMP_1_ALARM", "WINDING_TEMP_1_TRIP",
        "WINDING_TEMP_2_ALARM", "WINDING_TEMP_2_TRIP", "BUCHHOLZ_RELAY_ALARM",
        "BUCHHOLZ_RELAY_TRIP", "MOG_ALARM",
        "OTI_TEMPERATURE", "WTI_1_TEMPERATURE", "WTI_2_TEMPERATURE",
    ),
    "ISOLATOR": ("ISOLATOR_FEEDBACK",),
    "FIRE_SYSTEM": ("FIRE_SYSTEM_STATUS", "FIRE_SYSTEM_FAULT"),
    "UPS": (
        "UPS_INPUT_VOLTAGE", "UPS_INPUT_FREQUENCY", "UPS_OUTPUT_VOLTAGE",
        "UPS_OUTPUT_FREQUENCY", "UPS_OUTPUT_CURRENT", "UPS_BATTERY_VOLTAGE",
        "UPS_TEMPERATURE",
    ),
    "MFM": _MFM_SIGNALS,
    "ABT_METER": _MFM_SIGNALS,
    "PPC": (
        "ACTIVE_POWER_SETPOINT", "ACTIVE_POWER_CONTROL_ENABLE",
        "REACTIVE_POWER_SETPOINT", "REACTIVE_POWER_CONTROL_ENABLE",
        "VOLTAGE_SETPOINT", "VOLTAGE_CONTROL_ENABLE",
        "POWER_FACTOR_SETPOINT", "POWER_FACTOR_CONTROL_ENABLE",
        "FREQUENCY_SETPOINT", "FREQUENCY_CONTROL_ENABLE",
    ),
    "MODULE_TRACKER": (
        "TRACKER_TARGET_ANGLE", "TRACKER_ACTUAL_ANGLE", "TRACKER_ANGLE_DEVIATION",
        "TRACKER_CLEANING_MODE", "TRACKER_TRACKING_MODE", "TRACKER_ZERO_ANGLE_MODE",
        "TRACKER_BACK_TRACKING_MODE",
    ),
    "SLDC_TELEMETRY": ("SLDC_TELEMETRY_HEALTHY",),
    # No signal list supplied (TAG_CATALOGUE §6): SMB, DC_POWER_BANK, ANNUNCIATOR
    # (four blank rows on the sheet), MCR_SECTION, ICR_SECTION.
    "SMB": (),
    "DC_POWER_BANK": (),
    "ANNUNCIATOR": (),
    "MCR_SECTION": (),
    "ICR_SECTION": (),
}


async def _upsert(session: AsyncSession, sql: str, rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    await session.execute(text(sql), rows)
    return len(rows)


async def seed_catalog(session: AsyncSession) -> dict[str, int]:
    """Seed every global table. Idempotent. Returns a per-table row count."""
    counts: dict[str, int] = {}

    counts["device_types"] = await _upsert(
        session,
        """
        INSERT INTO device_types (code, name, in_power_path, variant_set)
        VALUES (:code, :name, :in_power_path, :variant_set)
        ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                in_power_path = EXCLUDED.in_power_path,
                variant_set = EXCLUDED.variant_set
        """,
        [
            {"code": c, "name": n, "in_power_path": p, "variant_set": v}
            for c, n, p, v in DEVICE_TYPES
        ],
    )

    # The Tag registry. Adding a metric is an INSERT here — never a column (I-2).
    tag_rows: list[dict[str, Any]] = []
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
        tag_rows.append({
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
        })
    counts["tags"] = await _upsert(
        session,
        """
        INSERT INTO tags (code, name, unit, category, rollup_method, scale_default,
                          valid_min, valid_max, min_interval_s, is_cumulative)
        VALUES (:code, :name, :unit, :category, :rollup_method, :scale_default,
                :valid_min, :valid_max, :min_interval_s, :is_cumulative)
        ON CONFLICT (code) DO UPDATE
            SET unit = EXCLUDED.unit,
                category = EXCLUDED.category,
                rollup_method = EXCLUDED.rollup_method,
                scale_default = EXCLUDED.scale_default,
                valid_min = EXCLUDED.valid_min,
                valid_max = EXCLUDED.valid_max,
                min_interval_s = EXCLUDED.min_interval_s,
                is_cumulative = EXCLUDED.is_cumulative
        """,
        tag_rows,
    )

    # One reference Model per Type, and its Tag set. The Tag set is replaced,
    # not merged, so a signal the client withdraws disappears on the next seed.
    model_rows = [
        {"type_code": type_code, "manufacturer": REFERENCE_MANUFACTURER,
         "model_code": f"ref-{type_code.lower().replace('_', '-')}"}
        for type_code, _n, _p, _v in DEVICE_TYPES
    ]
    counts["device_models"] = await _upsert(
        session,
        """
        INSERT INTO device_models (device_type_id, manufacturer, model_code)
        SELECT id, :manufacturer, :model_code FROM device_types WHERE code = :type_code
        ON CONFLICT (manufacturer, model_code) DO NOTHING
        """,
        model_rows,
    )
    await session.execute(text("""
        DELETE FROM device_model_tags
         WHERE device_model_id IN (
             SELECT id FROM device_models WHERE manufacturer = :manufacturer)
    """), {"manufacturer": REFERENCE_MANUFACTURER})
    unknown = {
        tag for tags in REFERENCE_MODEL_TAGS.values() for tag in tags
        if tag not in TAG_SPECS
    }
    if unknown:
        raise ValueError(f"reference model binds Tags not in TAG_SPECS: {sorted(unknown)}")
    # The default source key is the first alias observed for that Tag on the
    # client's broker — a starting point for the binding, never its authority.
    default_keys: dict[str, str] = {}
    for source_key, tag_code in SOURCE_KEY_ALIASES.items():
        default_keys.setdefault(tag_code, source_key)
    counts["device_model_tags"] = await _upsert(
        session,
        """
        INSERT INTO device_model_tags (device_model_id, tag_id, default_source_key)
        SELECT dm.id, t.id, :default_source_key
          FROM device_models dm, tags t
         WHERE dm.manufacturer = :manufacturer AND dm.model_code = :model_code
           AND t.code = :tag_code
        """,
        [
            {"manufacturer": REFERENCE_MANUFACTURER,
             "model_code": f"ref-{type_code.lower().replace('_', '-')}",
             "tag_code": tag_code, "default_source_key": default_keys.get(tag_code)}
            for type_code, tag_codes in REFERENCE_MODEL_TAGS.items()
            for tag_code in tag_codes
        ],
    )

    counts["permissions"] = await _upsert(
        session,
        """
        INSERT INTO permissions (code, description) VALUES (:code, :description)
        ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description
        """,
        [{"code": c, "description": d} for c, d in PERMISSIONS],
    )

    counts["roles"] = await _upsert(
        session,
        """
        INSERT INTO roles (code, name, is_system) VALUES (:code, :name, true)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
        """,
        [{"code": c, "name": n} for c, n, _ in ROLES],
    )

    grants = [
        {"role_code": role_code, "permission_code": permission_code}
        for role_code, _, permission_codes in ROLES
        for permission_code in permission_codes
    ]
    counts["role_permissions"] = await _upsert(
        session,
        """
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM roles r, permissions p
         WHERE r.code = :role_code AND p.code = :permission_code
        ON CONFLICT DO NOTHING
        """,
        grants,
    )

    counts["dashboards"] = await _upsert(
        session,
        """
        INSERT INTO dashboards (code, name, sort_order)
        VALUES (:code, :name, :sort_order)
        ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
        """,
        [{"code": c, "name": n, "sort_order": o} for c, n, o in DASHBOARDS],
    )

    counts["topic_patterns"] = await _upsert(
        session,
        """
        INSERT INTO topic_patterns (client_id, pattern, priority, description)
        VALUES (NULL, :pattern, :priority, :description)
        ON CONFLICT (pattern) DO UPDATE
            SET priority = EXCLUDED.priority, description = EXCLUDED.description
        """,
        [{"pattern": p, "priority": pr, "description": d} for p, pr, d in TOPIC_PATTERNS],
    )

    # Platform-default Alarm Rules: client_id NULL, inherited by every Client
    # until something more specific overrides them (BACKEND_SPEC §10.1).
    rule_rows: list[dict[str, Any]] = []
    for seed in ALL_ALARM_RULE_SEEDS:
        scope_type = "global" if seed.scope == "global" else "device_type"
        rule_rows.append({
            "code": seed.code,
            "name": seed.name,
            "scope_type": scope_type,
            "device_type_code": None if scope_type == "global" else seed.scope,
            "tag_code": seed.tag_code,
            "operator": seed.operator,
            "threshold": seed.threshold,
            "threshold_high": seed.threshold_high,
            "duration_s": seed.duration_s,
            "severity": seed.severity,
        })
    counts["alarm_rules"] = await _upsert(
        session,
        """
        INSERT INTO alarm_rules (client_id, code, name, scope_type, scope_id, tag_id,
                                 operator, threshold, threshold_high, duration_s, severity)
        SELECT NULL, :code, :name, :scope_type,
               (SELECT id FROM device_types WHERE code = :device_type_code),
               (SELECT id FROM tags WHERE code = :tag_code),
               :operator, :threshold, :threshold_high, :duration_s, :severity
        ON CONFLICT (client_id, code, scope_type, scope_id) DO UPDATE
            SET name = EXCLUDED.name,
                tag_id = EXCLUDED.tag_id,
                operator = EXCLUDED.operator,
                threshold = EXCLUDED.threshold,
                threshold_high = EXCLUDED.threshold_high,
                duration_s = EXCLUDED.duration_s,
                severity = EXCLUDED.severity
        """,
        rule_rows,
    )

    counts["report_definitions"] = await _upsert(
        session,
        """
        INSERT INTO report_definitions (client_id, code, name, description,
                                        query_spec, is_financial)
        VALUES (NULL, :code, :name, :description, CAST(:query_spec AS jsonb),
                :is_financial)
        ON CONFLICT (client_id, code) DO UPDATE
            SET name = EXCLUDED.name,
                description = EXCLUDED.description,
                query_spec = EXCLUDED.query_spec,
                is_financial = EXCLUDED.is_financial
        """,
        [{"code": c, "name": n, "description": d, "is_financial": f,
          "query_spec": json.dumps(q)} for c, n, d, f, q in REPORT_DEFINITIONS],
    )

    log.info("catalog seeded", **counts)
    return counts
