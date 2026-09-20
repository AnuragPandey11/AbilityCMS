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
from typing import Any, Final, NamedTuple

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.domain.assumptions import (
    ALL_ALARM_RULE_SEEDS,
    ANNUNCIATOR_SIGNAL_COUNT,
    DERIVED_TAG_FORMULAS,
    FORMULA_CONSTANTS,
    MAX_PV_STRINGS,
    MIN_INTERVAL_S_BY_CATEGORY,
    MIN_INTERVAL_S_CUMULATIVE,
    SOURCE_KEY_ALIASES,
    TAG_SPECS,
)
from solarcms.domain.dashboard_spec import (
    DEFAULT_SLOTS,
    DEVICE_TABLE_COLUMNS,
)
from solarcms.domain.dashboard_spec import (
    validate as validate_dashboard_spec,
)
from solarcms.domain.derived import DerivedTag
from solarcms.domain.sld_stages import DEFAULT_STAGE_BY_DEVICE_TYPE

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
    # ── Beyond the client's seventeen ────────────────────────────────────────
    # These three are *not* on the client's Device List. They come from the
    # single-line diagram the operator works from, where the DC and AC
    # distribution boards and the array itself are drawn as their own stages.
    # F-12 makes the catalogue extensible precisely so this is an INSERT rather
    # than a negotiation; if the client's own list later names them differently,
    # renaming a Type is an UPDATE.
    #
    # ⚠ No signal list has been supplied for any of them, so their reference
    # Models carry no Tags — same position as SMB (TAG_CATALOGUE §6). A Device of
    # these Types can be registered and drawn in the diagram today; it decodes
    # nothing until someone says what it publishes.
    #
    # PV_ARRAY is where generation starts, which the schematic view relies on to
    # keep it leftmost even before a Plant is wired.
    ("PV_ARRAY", "PV Array", True, None),
    ("DCDB", "DC Distribution Board", True, None),
    ("ACDB", "AC Distribution Board", True, None),
    # The client's Device List row named DASHBOARD: a panel publishing Plant-level
    # figures — PR, CUF, peak power, start/stop time, functional Inverter count.
    #
    # ⚠ Named PLANT_KPI here, not DASHBOARD. "Dashboard" already names a UI
    # concept in this system — `dashboards`, `dashboard.view`, the per-User
    # dashboard assignment of MASTER §4.2 — and a Device Type sharing the word
    # would make every sentence about it ambiguous, which is precisely what the
    # vocabulary rules exist to prevent (MASTER §1.4). The client's own label is
    # carried in `name` so their sheet remains recognisable.
    #
    # Not in the power path: it measures nothing and carries no current. Every
    # Plant gets exactly one, created with the Plant.
    ("PLANT_KPI", "Plant KPI Panel (client's 'DASHBOARD')", False, None),
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
        "SCMS/V1/{client_code}/{plant_code}/{collector_code}/{device_code}", 11,
        "The canonical contract, uppercased — what the client's broker actually "
        "publishes (observed 17 Sep 2026). MQTT topic levels are case-sensitive "
        "and `TopicPattern.match` compares literal segments exactly, so the "
        "lowercase row above cannot match it. Registered as a second row rather "
        "than by lowercasing topics in code: case-folding a topic would make "
        "`KULAR_GREEN` and `kular_green` the same origin, and Guardrail 5 makes "
        "the topic the sole authority for origin — two Clients whose codes differ "
        "only by case must never merge. Retire once the publisher settles on one "
        "case (B-1).",
    ),
    (
        "scms/v1/{client_code}/{plant_code}/{device_code}", 12,
        "The canonical contract without a Collector. A Collector is a logical "
        "enclosure — an MCR, an ICR, a panel — and plenty of equipment sits in "
        "none: a rooftop Plant's meter publishes straight under the Plant. "
        "Confirmed by the client 19 Sep 2026. Five segments, so it can never "
        "collide with the six-segment rows above — `TopicPattern.match` "
        "compares segment counts first — and a Device matched here is recorded "
        "with collector_code NULL, which is a real answer and not a gap.",
    ),
    (
        "SCMS/V1/{client_code}/{plant_code}/{device_code}", 13,
        "The five-segment shape, uppercased, for the same reason the six-segment "
        "row above is duplicated: MQTT topic levels are case-sensitive and "
        "case-folding a topic would make two Clients whose codes differ only by "
        "case the same origin (Guardrail 5). Retire with its sibling once the "
        "publisher settles on one case (B-1).",
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


class ReferenceModel(NamedTuple):
    """One Model in the catalogue, carrying the client's signal list for it.

    A Model exists per *variant*, not per Device Type, because the variant is
    what decides the signal set: a 3-winding Transformer has a second winding
    temperature a 2-winding one does not, and a Central Inverter is scheduled
    separately from a String Inverter even where the two lists coincide today.
    MASTER §2.3 records the variant as a Model-level fact for exactly this reason.
    """

    device_type: str
    model_code: str
    variant: str | None
    name: str
    tags: tuple[str, ...] = ()
    # A repeating group, as a template per index: ("PV{n}_VOLTAGE", ...). Expanded
    # 1..repeat_max into `device_model_tags` rows carrying `repeat_index`, from
    # which a Device binds as many as its `string_count` says it has.
    repeat_template: tuple[str, ...] = ()
    repeat_max: int = 0
    note: str | None = None


# The MFM and the ABT Meter are row-for-row identical on the client's sheet
# (TAG_CATALOGUE §2.12). That is not a transcription slip — an ABT meter is a
# revenue-grade MFM — and I-11 is enforced by Device Type, never by Tag set.
_METER_SIGNALS: Final[tuple[str, ...]] = (
    "HV_VOLTAGE_RY", "HV_VOLTAGE_YB", "HV_VOLTAGE_BR", "HV_VOLTAGE_AVG",
    "AC_CURRENT_R", "AC_CURRENT_Y", "AC_CURRENT_B",
    "POWER_FACTOR_R", "POWER_FACTOR_Y", "POWER_FACTOR_B",
    "AC_ACTIVE_POWER", "AC_REACTIVE_POWER", "FREQUENCY",
    "ENERGY_EXPORT_TOTAL", "ENERGY_IMPORT_TOTAL",
)

# Both Inverter variants carry the identical list on the third revision of the
# sheet — three-phase AC, the derived aggregates, energy counters, and the
# per-string PV inputs. Kept as one constant so they cannot drift apart by
# accident; if the client differentiates them later, splitting it is one edit.
_INVERTER_SIGNALS: Final[tuple[str, ...]] = (
    "HV_VOLTAGE_RY", "HV_VOLTAGE_YB", "HV_VOLTAGE_BR", "HV_VOLTAGE_AVG",
    "AC_CURRENT_R", "AC_CURRENT_Y", "AC_CURRENT_B", "AC_CURRENT_TOTAL",
    "AC_ACTIVE_POWER", "DC_POWER", "AC_REACTIVE_POWER", "POWER_FACTOR",
    "FREQUENCY", "INVERTER_EFFICIENCY",
    # T-11: "MODULE TEMP." on an Inverter is read as the inverter's own internal
    # temperature, not the PV module (which is a WMS quantity).
    "DEVICE_TEMPERATURE", "ENERGY_TODAY", "SPECIFIC_YIELD", "ENERGY_MONTHLY",
    "ENERGY_CUMULATIVE_MWH", "DEVICE_STATUS",
    "PV_VOLTAGE", "PV_CURRENT", "TODAY_PEAK",
)
_PV_STRING_TEMPLATE: Final[tuple[str, ...]] = (
    "PV{n}_VOLTAGE", "PV{n}_CURRENT", "PV{n}_ACTIVE_POWER",
)

_TRANSFORMER_COMMON: Final[tuple[str, ...]] = (
    "OIL_TEMP_ALARM", "OIL_TEMP_TRIP", "WINDING_TEMP_1_ALARM", "WINDING_TEMP_1_TRIP",
    "BUCHHOLZ_RELAY_ALARM", "BUCHHOLZ_RELAY_TRIP", "MOG_ALARM",
    "OTI_TEMPERATURE", "WTI_1_TEMPERATURE",
)

REFERENCE_MODELS: Final[tuple[ReferenceModel, ...]] = (
    ReferenceModel("VCB", "ref-vcb", None, "Reference VCB", (
        "VCB_ON_FEEDBACK", "VCB_TRIP_FEEDBACK", "VCB_IN_TEST_MODE", "VCB_IN_SERVICE",
        "VCB_SPRING_CHARGE", "VCB_OC_RELAY", "AC_FAIL", "DC_FAIL", "VCB_TC_HEALTHY",
        "VCB_EMERGENCY_PB", "VCB_RELAY_UNHEALTHY", "VCB_REMOTE_SELECTION",
    ), note="Entirely Digital Input — the VCB reports no analogue value at all."),
    ReferenceModel("WMS", "ref-wms", None, "Reference Weather Station", (
        "AMBIENT_TEMPERATURE", "WIND_SPEED", "GTI", "GHI", "GTI_CUMULATIVE",
        "GHI_CUMULATIVE", "GTI_CUMULATIVE_YESTERDAY", "GHI_CUMULATIVE_YESTERDAY",
        "MODULE_TEMPERATURE", "HUMIDITY", "RAIN_GAUGE", "WIND_DIRECTION",
        "DIFFUSE_RADIATION", "DIFFUSE_RADIATION_AVG", "DIRECT_RADIATION",
        "DIRECT_RADIATION_AVG", "CLOUD_COVER",
    ), note="The only Device Type whose valid ranges the client has supplied."),
    ReferenceModel(
        "INVERTER", "ref-inverter-string", "string", "Reference String Inverter",
        _INVERTER_SIGNALS, _PV_STRING_TEMPLATE, MAX_PV_STRINGS,
        note="Set the Device's string count when registering it: only that many "
             "PV inputs are bound.",
    ),
    ReferenceModel(
        "INVERTER", "ref-inverter-central", "central", "Reference Central Inverter",
        _INVERTER_SIGNALS, _PV_STRING_TEMPLATE, MAX_PV_STRINGS,
        note="Identical signal list to the String Inverter on the client's sheet.",
    ),
    ReferenceModel(
        "TRANSFORMER", "ref-transformer-2w", "two_winding",
        "Reference Transformer (2 winding)", _TRANSFORMER_COMMON,
    ),
    ReferenceModel(
        "TRANSFORMER", "ref-transformer-3w", "three_winding",
        "Reference Transformer (3 winding)",
        (*_TRANSFORMER_COMMON, "WINDING_TEMP_2_ALARM", "WINDING_TEMP_2_TRIP",
         "WTI_2_TEMPERATURE"),
        note="The second winding's alarm, trip and temperature are what separate "
             "this from the 2-winding variant.",
    ),
    ReferenceModel("ISOLATOR", "ref-isolator", None, "Reference Isolator",
                   ("ISOLATOR_FEEDBACK",)),
    ReferenceModel("FIRE_SYSTEM", "ref-fire-system", None, "Reference Fire System",
                   ("FIRE_SYSTEM_STATUS", "FIRE_SYSTEM_FAULT"),
                   note="Addressed by the panel's own zone and area, which is not "
                        "a Block — a fire zone and a generation Block are different "
                        "partitions of the same site."),
    ReferenceModel("UPS", "ref-ups", None, "Reference UPS", (
        "UPS_INPUT_VOLTAGE", "UPS_INPUT_FREQUENCY", "UPS_OUTPUT_VOLTAGE",
        "UPS_OUTPUT_FREQUENCY", "UPS_OUTPUT_CURRENT", "UPS_BATTERY_VOLTAGE",
        "UPS_TEMPERATURE",
    ), note="Volts, not kilovolts — an auxiliary LV supply, unlike every other "
           "voltage on the sheet."),
    # ⚠ OPEN-19 / T-8. BATTERY CHARGER appears on the sheet as a signal group but
    # not in the Device List. Seeded as a *Model* of DC_POWER_BANK rather than an
    # eighteenth Device Type: that keeps the client's list of seventeen intact
    # while giving the nine contacts somewhere to live, and promoting it to its
    # own Type later is an INSERT plus an UPDATE of this row.
    ReferenceModel("DC_POWER_BANK", "ref-battery-charger", None,
                   "Reference Battery Charger", (
                       "CHARGER_OVER_CURRENT", "CHARGER_FAILURE",
                       "CHARGER_DC_OVER_VOLTAGE", "CHARGER_DC_EARTH_FAULT",
                       "CHARGER_RECT_FUSE_FAILURE", "BATTERY_OVER_TEMP",
                       "CHARGER_SOURCE1_MCB_TRIP", "CHARGER_SOURCE2_MCB_TRIP",
                       "CHARGER_DC_UNDER_VOLTAGE",
                   ),
                   note="⚠ The client's sheet groups these under BATTERY CHARGER, "
                        "which is not one of the seventeen Device Types (T-8)."),
    ReferenceModel("MFM", "ref-mfm", None, "Reference MFM", _METER_SIGNALS),
    ReferenceModel("ABT_METER", "ref-abt-meter", None, "Reference ABT Meter",
                   _METER_SIGNALS,
                   note="Identical signals to the MFM. What makes this the "
                        "settlement instrument is its Device Type, not its Tags."),
    ReferenceModel("PPC", "ref-ppc", None, "Reference Power Plant Controller", (
        "ACTIVE_POWER_SETPOINT", "ACTIVE_POWER_CONTROL_ENABLE",
        "REACTIVE_POWER_SETPOINT", "REACTIVE_POWER_CONTROL_ENABLE",
        "VOLTAGE_SETPOINT", "VOLTAGE_CONTROL_ENABLE",
        "POWER_FACTOR_SETPOINT", "POWER_FACTOR_CONTROL_ENABLE",
        "FREQUENCY_SETPOINT", "FREQUENCY_CONTROL_ENABLE",
    ), note="A setpoint beside a control-enable flag is what makes Curtailment "
           "separable from a fault."),
    ReferenceModel("MODULE_TRACKER", "ref-module-tracker", None,
                   "Reference Module Tracker", (
                       "TRACKER_TARGET_ANGLE", "TRACKER_ACTUAL_ANGLE",
                       "TRACKER_ANGLE_DEVIATION", "TRACKER_CLEANING_MODE",
                       "TRACKER_TRACKING_MODE", "TRACKER_ZERO_ANGLE_MODE",
                       "TRACKER_BACK_TRACKING_MODE",
                   )),
    # Twenty numbered contacts with no stated meanings — which is what an
    # annunciator is. What SIGNAL7 means at a given Plant is recorded on the
    # binding, which is per-Device and therefore the right place for a
    # Plant-specific label (never a code path, Guardrail 2).
    ReferenceModel("ANNUNCIATOR", "ref-annunciator", None, "Reference Annunciator",
                   (), ("ANNUNCIATOR_SIGNAL_{n}",), ANNUNCIATOR_SIGNAL_COUNT,
                   note="Label each contact on the Device's binding — the sheet "
                        "gives numbers only."),
    ReferenceModel("SLDC_TELEMETRY", "ref-sldc-telemetry", None,
                   "Reference SLDC Telemetry", ("SLDC_TELEMETRY_HEALTHY",),
                   note="⚠ Signal list incomplete — cropped at the sheet boundary "
                        "(T-3)."),
    # The Plant's own KPI panel. Every Tag on it is either derived (PR, CUF, the
    # plant aggregates) or written at the day boundary (the YESTERDAY family), so
    # none of them is ever bound to a source key.
    ReferenceModel("PLANT_KPI", "ref-plant-kpi", None, "Plant KPI Panel", (
        "PERFORMANCE_RATIO", "PERFORMANCE_RATIO_YESTERDAY", "CUF", "CUF_YESTERDAY",
        "TODAY_PEAK_POWER", "TODAY_PEAK_POWER_TIME", "PEAK_POWER_YESTERDAY",
        "PEAK_POWER_TIME_YESTERDAY", "INVERTERS_FUNCTIONAL",
        "PLANT_START_TIME", "PLANT_STOP_TIME",
        "PLANT_ACTIVE_POWER", "PLANT_ENERGY_TODAY",
    ), note="Computed by the scheduler from the Plant's other Devices. Nothing "
           "publishes to it."),
    # ⚠ No signal list supplied (TAG_CATALOGUE §6). The Model exists so a Device
    # of the Type can still be registered and its bindings set by hand; SMB is the
    # one that blocks a confirmed requirement, because String Box monitoring and
    # the String Current Deviation rule both need it (T-3).
    ReferenceModel("SMB", "ref-smb", None, "Reference String Monitoring Box",
                   note="⚠ The client has not yet supplied this signal list. "
                        "Blocks tender §10 (String Box monitoring)."),
    # The three from the operator's diagram rather than the client's Device List.
    # Empty Tag sets on purpose: nothing has stated what they publish, and a
    # Model carrying invented signals would be worse than one carrying none.
    ReferenceModel("PV_ARRAY", "ref-pv-array", None, "Reference PV Array",
                   note="Where generation starts — always the first stage of the "
                        "diagram. ⚠ No signal list supplied."),
    ReferenceModel("DCDB", "ref-dcdb", None, "Reference DC Distribution Board",
                   note="⚠ No signal list supplied."),
    ReferenceModel("ACDB", "ref-acdb", None, "Reference AC Distribution Board",
                   note="⚠ No signal list supplied."),
    ReferenceModel("MCR_SECTION", "ref-mcr-section", None, "Reference MCR Section",
                   note="A switchgear section carries no signals of its own; its "
                        "feeders are the VCBs and MFMs beneath it."),
    ReferenceModel("ICR_SECTION", "ref-icr-section", None, "Reference ICR Section",
                   note="As MCR Section — the feeders beneath it carry the signals."),
)

# Every Device Type must have at least one Model, or no Device of that Type can
# be registered at all. Checked at seed time rather than discovered by an
# administrator halfway through onboarding.
_TYPES_WITH_MODELS = {m.device_type for m in REFERENCE_MODELS}
_TYPES_WITHOUT_MODELS = {code for code, _n, _p, _v in DEVICE_TYPES} - _TYPES_WITH_MODELS
if _TYPES_WITHOUT_MODELS:
    raise ValueError(
        f"Device Types with no reference Model: {sorted(_TYPES_WITHOUT_MODELS)}"
    )


# Every formula is compiled at import, and every name it reads must be a Tag in
# the registry or a declared constant. A formula that references a Tag code
# nobody publishes is not a runtime error — it silently evaluates to "undefined"
# forever, which is the hardest kind of fault to notice. Failing here means it
# cannot be seeded at all.
def _validate_formulas() -> tuple[DerivedTag, ...]:
    validated: list[DerivedTag] = []
    for tag_code, (expression, scope) in DERIVED_TAG_FORMULAS.items():
        if tag_code not in TAG_SPECS:
            raise ValueError(f"formula defined for unknown Tag {tag_code!r}")
        spec = DerivedTag(tag_code=tag_code, expression=expression, scope=scope)
        for name in spec.inputs:
            # `SUM.ENERGY_TODAY` → the Tag is the part after the aggregate.
            bare = name.split(".", 1)[1] if "." in name else name
            if bare in FORMULA_CONSTANTS:
                continue
            # A synthetic input the caller supplies rather than a Tag: the count
            # of Inverters currently online has no Reading of its own.
            if bare in SYNTHETIC_FORMULA_INPUTS:
                continue
            if bare not in TAG_SPECS:
                raise ValueError(
                    f"formula for {tag_code!r} reads {bare!r}, which is not a Tag"
                )
        validated.append(spec)
    return tuple(validated)


# Inputs assembled by the Plant KPI service rather than read from a single Tag.
# PLANT_ENERGY_TODAY and PLANT_ACTIVE_POWER are Tags in their own right *and*
# inputs to PR and CUF, because the service resolves a source precedence the
# formula language deliberately cannot express (assumptions.py).
SYNTHETIC_FORMULA_INPUTS: Final[frozenset[str]] = frozenset({
    "INVERTERS_ONLINE", "PLANT_ENERGY_TODAY", "PLANT_ACTIVE_POWER",
})

DERIVED_TAGS: Final[tuple[DerivedTag, ...]] = _validate_formulas()


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
        INSERT INTO device_types (code, name, in_power_path, variant_set, sld_stage)
        VALUES (:code, :name, :in_power_path, :variant_set, :sld_stage)
        ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name,
                in_power_path = EXCLUDED.in_power_path,
                variant_set = EXCLUDED.variant_set,
                sld_stage = EXCLUDED.sld_stage
        """,
        [
            {
                "code": c, "name": n, "in_power_path": p, "variant_set": v,
                # Which of the four fixed SLD stages the Type folds into. NULL for
                # a Type that carries no current — a Weather Station is real and
                # monitored and still does not belong in an electrical diagram.
                "sld_stage": DEFAULT_STAGE_BY_DEVICE_TYPE.get(c),
            }
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
        formula, scope = DERIVED_TAG_FORMULAS.get(code, (None, None))
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
            "formula": formula,
            "derived_scope": scope,
        })
    counts["tags"] = await _upsert(
        session,
        """
        INSERT INTO tags (code, name, unit, category, rollup_method, scale_default,
                          valid_min, valid_max, min_interval_s, is_cumulative,
                          formula, derived_scope)
        VALUES (:code, :name, :unit, :category, :rollup_method, :scale_default,
                :valid_min, :valid_max, :min_interval_s, :is_cumulative,
                :formula, :derived_scope)
        ON CONFLICT (code) DO UPDATE
            SET unit = EXCLUDED.unit,
                category = EXCLUDED.category,
                rollup_method = EXCLUDED.rollup_method,
                scale_default = EXCLUDED.scale_default,
                valid_min = EXCLUDED.valid_min,
                valid_max = EXCLUDED.valid_max,
                min_interval_s = EXCLUDED.min_interval_s,
                is_cumulative = EXCLUDED.is_cumulative,
                formula = EXCLUDED.formula,
                derived_scope = EXCLUDED.derived_scope
        """,
        tag_rows,
    )

    # Reference Models, one per *variant* rather than per Type. The Tag set is
    # replaced, not merged, so a signal the client withdraws disappears on the
    # next seed rather than lingering as a Tag nothing will ever publish.
    counts["device_models"] = await _upsert(
        session,
        """
        INSERT INTO device_models (device_type_id, manufacturer, model_code, variant)
        SELECT id, :manufacturer, :model_code, :variant
          FROM device_types WHERE code = :type_code
        ON CONFLICT (manufacturer, model_code) DO UPDATE
            SET variant = EXCLUDED.variant
        """,
        [{"type_code": m.device_type, "manufacturer": REFERENCE_MANUFACTURER,
          "model_code": m.model_code, "variant": m.variant} for m in REFERENCE_MODELS],
    )
    await session.execute(text("""
        DELETE FROM device_model_tags
         WHERE device_model_id IN (
             SELECT id FROM device_models WHERE manufacturer = :manufacturer)
    """), {"manufacturer": REFERENCE_MANUFACTURER})

    # The default source key is the first alias observed for that Tag — a
    # starting point for a binding, never its authority (MASTER §5.2).
    default_keys: dict[str, str] = {}
    for source_key, tag_code in SOURCE_KEY_ALIASES.items():
        default_keys.setdefault(tag_code, source_key)

    model_tag_rows: list[dict[str, Any]] = []
    unknown: set[str] = set()
    for model in REFERENCE_MODELS:
        order = 0
        for tag_code in model.tags:
            if tag_code not in TAG_SPECS:
                unknown.add(tag_code)
                continue
            model_tag_rows.append({
                "manufacturer": REFERENCE_MANUFACTURER, "model_code": model.model_code,
                "tag_code": tag_code, "default_source_key": default_keys.get(tag_code),
                "repeat_index": None, "sort_order": order,
            })
            order += 1
        # The repeating group, expanded. The Tag codes already exist in the
        # registry (all 28 strings, all 20 contacts); what the expansion adds is
        # the `repeat_index` a Device slices by when it says how many it has.
        for index in range(1, model.repeat_max + 1):
            for template in model.repeat_template:
                tag_code = template.format(n=index)
                if tag_code not in TAG_SPECS:
                    unknown.add(tag_code)
                    continue
                model_tag_rows.append({
                    "manufacturer": REFERENCE_MANUFACTURER,
                    "model_code": model.model_code, "tag_code": tag_code,
                    "default_source_key": default_keys.get(tag_code),
                    "repeat_index": index, "sort_order": order,
                })
                order += 1
    if unknown:
        raise ValueError(f"reference model binds Tags not in TAG_SPECS: {sorted(unknown)}")

    counts["device_model_tags"] = await _upsert(
        session,
        """
        INSERT INTO device_model_tags (device_model_id, tag_id, default_source_key,
                                       repeat_index, sort_order)
        SELECT dm.id, t.id, :default_source_key, :repeat_index, :sort_order
          FROM device_models dm, tags t
         WHERE dm.manufacturer = :manufacturer AND dm.model_code = :model_code
           AND t.code = :tag_code
        """,
        model_tag_rows,
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

    counts.update(await _seed_dashboard_slots(session))

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


async def _seed_dashboard_slots(session: AsyncSession) -> dict[str, int]:
    """Seed the slot catalogue, its candidates, and the per-Device table columns.

    Slots are upserted by code; **candidates are deleted and rewritten**. The
    difference is deliberate. A slot someone added by hand is theirs to keep, but
    a candidate list that only ever grows would keep resolving through a source
    the catalogue has since dropped — and it would do so silently, because a
    stale candidate is indistinguishable from a deliberate one. Per-Plant
    customisation is not lost by this: it lives in
    `plant_dashboard_slot_overrides`, which this never touches.

    Every candidate names a Device Type and a Tag *by code*, resolved to ids
    here. A code that matches nothing would insert a NULL and then resolve to
    nothing for every Plant forever, so the lookups are checked rather than
    trusted — the same reason `_validate_formulas` refuses to seed a formula that
    reads a Tag nobody publishes.
    """
    validate_dashboard_spec()
    counts: dict[str, int] = {}

    counts["dashboard_slots"] = await _upsert(
        session,
        """
        INSERT INTO dashboard_slots
            (code, label, panel, position, unit_hint,
             hide_when_unresolved, fallback_when_silent)
        VALUES (:code, :label, :panel, :position, :unit_hint,
                :hide_when_unresolved, :fallback_when_silent)
        ON CONFLICT (code) DO UPDATE
            SET label = EXCLUDED.label,
                panel = EXCLUDED.panel,
                position = EXCLUDED.position,
                unit_hint = EXCLUDED.unit_hint,
                hide_when_unresolved = EXCLUDED.hide_when_unresolved,
                fallback_when_silent = EXCLUDED.fallback_when_silent
        """,
        [
            {
                "code": spec.code, "label": spec.label, "panel": spec.panel,
                "position": spec.position, "unit_hint": spec.unit_hint,
                "hide_when_unresolved": spec.hide_when_unresolved,
                "fallback_when_silent": spec.fallback_when_silent,
            }
            for spec in DEFAULT_SLOTS
        ],
    )

    slot_ids = {
        row.code: row.id
        for row in (await session.execute(text("SELECT id, code FROM dashboard_slots"))).all()
    }
    type_ids = {
        row.code: row.id
        for row in (await session.execute(text("SELECT id, code FROM device_types"))).all()
    }
    tag_ids = {
        row.code: row.id
        for row in (await session.execute(text("SELECT id, code FROM tags"))).all()
    }

    candidate_rows: list[dict[str, Any]] = []
    for spec in DEFAULT_SLOTS:
        for candidate in spec.ordered_candidates:
            device_type_id: int | None = None
            tag_id: int | None = None
            if candidate.device_type_code is not None:
                if candidate.device_type_code not in type_ids:
                    raise ValueError(
                        f"slot {spec.code!r} names unknown Device Type "
                        f"{candidate.device_type_code!r}"
                    )
                device_type_id = type_ids[candidate.device_type_code]
            if candidate.tag_code is not None:
                if candidate.tag_code not in tag_ids:
                    raise ValueError(
                        f"slot {spec.code!r} names unknown Tag {candidate.tag_code!r}"
                    )
                tag_id = tag_ids[candidate.tag_code]
            candidate_rows.append({
                "slot_id": slot_ids[spec.code],
                "priority": candidate.priority,
                "kind": candidate.kind,
                "device_type_id": device_type_id,
                "tag_id": tag_id,
                "aggregate": candidate.aggregate,
                "plant_attribute": candidate.plant_attribute,
                "online_only": candidate.online_only,
            })

    seeded_slot_ids = [slot_ids[spec.code] for spec in DEFAULT_SLOTS]
    await session.execute(
        text("DELETE FROM dashboard_slot_candidates WHERE slot_id = ANY(:ids)"),
        {"ids": seeded_slot_ids},
    )
    counts["dashboard_slot_candidates"] = await _upsert(
        session,
        """
        INSERT INTO dashboard_slot_candidates
            (slot_id, priority, kind, device_type_id, tag_id,
             aggregate, plant_attribute, online_only)
        VALUES (:slot_id, :priority, :kind, :device_type_id, :tag_id,
                :aggregate, :plant_attribute, :online_only)
        """,
        candidate_rows,
    )

    column_rows: list[dict[str, Any]] = []
    for device_type_code, tag_codes in sorted(DEVICE_TABLE_COLUMNS.items()):
        if device_type_code not in type_ids:
            raise ValueError(f"device table names unknown Device Type {device_type_code!r}")
        for position, tag_code in enumerate(tag_codes):
            if tag_code not in tag_ids:
                raise ValueError(
                    f"{device_type_code} device table names unknown Tag {tag_code!r}"
                )
            column_rows.append({
                "device_type_id": type_ids[device_type_code],
                "tag_id": tag_ids[tag_code],
                "position": position,
            })

    await session.execute(
        text("DELETE FROM device_table_columns WHERE device_type_id = ANY(:ids)"),
        {"ids": [type_ids[c] for c in DEVICE_TABLE_COLUMNS if c in type_ids]},
    )
    counts["device_table_columns"] = await _upsert(
        session,
        """
        INSERT INTO device_table_columns (device_type_id, tag_id, position)
        VALUES (:device_type_id, :tag_id, :position)
        """,
        column_rows,
    )
    return counts
