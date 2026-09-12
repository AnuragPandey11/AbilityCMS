"""⚠ EVERY assumed value in the system. Nothing else belongs in this module.

BACKEND_SPEC §0.3 — the most important rule in the specification:

    Several inputs are not yet known: units per Tag, the client's PR/CUF/
    Availability formulas, alarm thresholds, and polling intervals. This
    specification supplies placeholder values so that work can proceed.
    Every one of them is wrong until the client confirms it.

Replacing an assumption must therefore be a single-file edit, never a search
across the project. No assumed constant, threshold, unit, or formula
coefficient may appear anywhere else in the codebase.

Each block names the OPEN item from MASTER §8.1 that closes it. When an answer
arrives, edit here, re-seed, and recompute — nothing else.

Observations from the client's test broker that bear on these values are
recorded in `docs/BROKER_OBSERVATIONS.md`. An observation constrains an
assumption; it never closes one (MASTER §5.4 — observation reveals the *shape*
of data, never its *meaning*).

⚠ **Units are no longer assumed; scaling still is.** The client supplied a signal
schedule on 10 Sep 2026 (`docs/TAG_CATALOGUE.md`) giving units for 7 of the 17
Device Types. Those units are marked SUPPLIED below. What the schedule does *not*
give is a scaling factor or a valid range for anything — its Range column is
blank throughout — so `scale` and the bounds here remain placeholders, and they
are the dangerous half: a unit says what 11.37 means, a scale says whether the
register holds 11.37 or 11370.
"""

from __future__ import annotations

from typing import Final, Literal, NamedTuple

# ════════════════════════════════════════════════════════════════════════════
# Quality codes — BACKEND_SPEC §6.4. Not assumed; the classification
# *thresholds* below are.
# ════════════════════════════════════════════════════════════════════════════

QUALITY_GOOD: Final = 0
QUALITY_OUT_OF_RANGE: Final = 1
QUALITY_STALE: Final = 2
QUALITY_UNPARSEABLE: Final = 3

RollupMethod = Literal["avg", "last", "max"]
TagCategory = Literal["performance", "electrical", "diagnostic", "environmental", "status"]


class TagSpec(NamedTuple):
    """One row of the Tag registry's assumed defaults.

    `scale` is the factor applied to a raw published value. It is an assumption
    of last resort: the authoritative scale is per-Device, in
    `device_tag_bindings` (MASTER §3.5 — field wiring never matches the
    datasheet). This value seeds a binding when nothing better is known.
    """

    unit: str
    scale: float
    valid_min: float
    valid_max: float
    rollup_method: RollupMethod
    category: TagCategory
    cumulative: bool = False  # counter, not instantaneous → rollover applies


# ════════════════════════════════════════════════════════════════════════════
# §12.1 Units and scaling — ⚠ ASSUMED. Closes on OPEN-15.
#
# The client has undertaken to supply the real table. Not inferable: `10.92` is
# equally plausible as volts or kilovolts, and a factor-of-1000 error looks
# entirely plausible in every chart and report it touches.
# ════════════════════════════════════════════════════════════════════════════

TAG_SPECS: Final[dict[str, TagSpec]] = {
    # ── AC power ────────────────────────────────────────────────────────────
    # ⚠ valid_min is negative, not 0. A meter reads negative active power when
    # the Plant imports — at night, or when auxiliaries draw from the grid — and
    # the first live ingest run flagged a perfectly normal -6.42 kW as
    # out-of-range against an assumed floor of 0. An Inverter cannot go negative,
    # but that is a per-Device binding narrowing, not a property of the metric.
    "AC_ACTIVE_POWER":     TagSpec("kW",    0.1,  -5000.0,  5000.0, "avg", "performance"),
    # Apparent power is an unsigned magnitude, so 0 is a real floor here.
    "AC_APPARENT_POWER":   TagSpec("kVA",   0.1,      0.0,  5000.0, "avg", "electrical"),
    "AC_REACTIVE_POWER":   TagSpec("kVAr",  0.1,  -5000.0,  5000.0, "avg", "electrical"),
    "POWER_FACTOR":        TagSpec("ratio", 0.001,   -1.0,     1.0, "avg", "electrical"),
    "FREQUENCY":           TagSpec("Hz",    0.01,    45.0,    55.0, "avg", "electrical"),
    # ── LV voltages ─────────────────────────────────────────────────────────
    # Retained for any Device that genuinely reports at LV. The client's MFM does
    # not: its voltages are kV (SUPPLIED), so the HV family below is the default.
    "AC_VOLTAGE_RY":       TagSpec("V",     0.1,      0.0,   500.0, "avg", "electrical"),
    "AC_VOLTAGE_YB":       TagSpec("V",     0.1,      0.0,   500.0, "avg", "electrical"),
    "AC_VOLTAGE_BR":       TagSpec("V",     0.1,      0.0,   500.0, "avg", "electrical"),
    # ── HV voltages — unit SUPPLIED (kV), scale still assumed ───────────────
    # The client's schedule gives MFM RY/YB/BR/AVG VOLTAGE in kV, and the broker
    # publishes 11.37 on an 11 kV feeder. This is the default voltage family.
    "HV_VOLTAGE_RY":       TagSpec("kV",    0.01,     0.0,   800.0, "avg", "electrical"),
    "HV_VOLTAGE_YB":       TagSpec("kV",    0.01,     0.0,   800.0, "avg", "electrical"),
    "HV_VOLTAGE_BR":       TagSpec("kV",    0.01,     0.0,   800.0, "avg", "electrical"),
    "HV_VOLTAGE_AVG":      TagSpec("kV",    0.01,     0.0,   800.0, "avg", "electrical"),
    # ── Currents ────────────────────────────────────────────────────────────
    "AC_CURRENT_R":        TagSpec("A",     0.01,     0.0,  4000.0, "avg", "electrical"),
    "AC_CURRENT_Y":        TagSpec("A",     0.01,     0.0,  4000.0, "avg", "electrical"),
    "AC_CURRENT_B":        TagSpec("A",     0.01,     0.0,  4000.0, "avg", "electrical"),
    # ── DC side ─────────────────────────────────────────────────────────────
    "DC_VOLTAGE":          TagSpec("V",     0.1,      0.0,  1500.0, "avg", "electrical"),
    "DC_CURRENT":          TagSpec("A",     0.01,     0.0,   500.0, "avg", "electrical"),
    # ── Energy counters ─────────────────────────────────────────────────────
    # `last`, never `avg`: averaging a cumulative counter is meaningless.
    "ENERGY_TODAY":        TagSpec("kWh",   0.1,      0.0, 1e5,  "last", "performance", True),
    "ENERGY_TOTAL":        TagSpec("kWh",   1.0,      0.0, 1e9,  "last", "performance", True),
    "ENERGY_EXPORT_TODAY": TagSpec("kWh",   0.1,      0.0, 1e5,  "last", "performance", True),
    "ENERGY_IMPORT_TODAY": TagSpec("kWh",   0.1,      0.0, 1e5,  "last", "performance", True),
    "ENERGY_EXPORT_TOTAL": TagSpec("kWh",   1.0,      0.0, 1e9,  "last", "performance", True),
    "ENERGY_IMPORT_TOTAL": TagSpec("kWh",   1.0,      0.0, 1e9,  "last", "performance", True),
    # ── Temperatures ────────────────────────────────────────────────────────
    "DEVICE_TEMPERATURE":  TagSpec("degC",  0.1,    -20.0,   120.0, "max", "diagnostic"),
    "MODULE_TEMPERATURE":  TagSpec("degC",  0.1,    -40.0,   100.0, "avg", "environmental"),
    "AMBIENT_TEMPERATURE": TagSpec("degC",  0.1,    -40.0,    60.0, "avg", "environmental"),
    # ── Irradiance and weather ──────────────────────────────────────────────
    "GHI":                 TagSpec("W/m2",  1.0,      0.0,  1500.0, "avg", "environmental"),
    "POA_IRRADIANCE":      TagSpec("W/m2",  1.0,      0.0,  1500.0, "avg", "environmental"),
    "WIND_SPEED":          TagSpec("m/s",   0.1,      0.0,    60.0, "avg", "environmental"),
    "WIND_DIRECTION":      TagSpec("deg",   1.0,      0.0,   360.0, "avg", "environmental"),
    "HUMIDITY":            TagSpec("%",     0.1,      0.0,   100.0, "avg", "environmental"),
    # ── Per-phase power factor — SUPPLIED by the client's MFM schedule ──────
    "POWER_FACTOR_R":      TagSpec("ratio", 0.001,   -1.0,     1.0, "avg", "electrical"),
    "POWER_FACTOR_Y":      TagSpec("ratio", 0.001,   -1.0,     1.0, "avg", "electrical"),
    "POWER_FACTOR_B":      TagSpec("ratio", 0.001,   -1.0,     1.0, "avg", "electrical"),

    # ── Inverter — units SUPPLIED (TAG_CATALOGUE §2.4) ──────────────────────
    "DC_POWER":            TagSpec("kW",    0.1,      0.0,  5000.0, "avg", "performance"),
    "INVERTER_EFFICIENCY": TagSpec("%",     0.1,      0.0,   100.0, "avg", "performance"),
    "ENERGY_MONTHLY":      TagSpec("kWh",   0.1,      0.0, 1e7,  "last", "performance", True),
    # ⚠ MWh, not kWh — the client's own schedule changes unit for this one Tag
    # while DAILY and MONTHLY stay kWh. A 1000x trap inside one Device (T-5).
    "ENERGY_CUMULATIVE_MWH": TagSpec("MWh", 1.0,      0.0, 1e7,  "last", "performance", True),
    "SPECIFIC_YIELD":      TagSpec("kWh/kWp", 0.01,   0.0,    20.0, "avg", "performance"),
    # ⚠ Client gives kWh; a peak is a power and should be kW (T-7). Unit is
    # transcribed as supplied so the discrepancy stays visible.
    "TODAY_PEAK":          TagSpec("kWh",   0.1,      0.0,  5000.0, "max", "performance"),
    "PV_VOLTAGE":          TagSpec("kV",    0.01,     0.0,     2.0, "avg", "electrical"),
    "PV_CURRENT":          TagSpec("A",     0.01,     0.0,  1000.0, "avg", "electrical"),
    "DEVICE_STATUS":       TagSpec("code",  1.0,      0.0,  1000.0, "last", "status"),

    # ── Weather, extended — units SUPPLIED (TAG_CATALOGUE §2.2) ─────────────
    # The client distinguishes instantaneous irradiance (W/m2) from cumulative
    # insolation (kWh/m2). Conflating them is a 1000x error, and it is what the
    # broker's ambiguous `AverageGHI` turns on.
    # ⚠ WMS ranges are the one place the client has stated valid_min/max: the
    # second revision of their signal sheet fills the Range column for the WMS
    # rows only (TAG_CATALOGUE §2.2). Those bounds are transcribed, not assumed —
    # every other range in this table is still ours.
    "GTI":                 TagSpec("W/m2",  1.0,      0.0,  1500.0, "avg", "environmental"),
    "GHI_CUMULATIVE":      TagSpec("kWh/m2", 0.01,    0.0,    15.0, "last", "environmental", True),
    "GTI_CUMULATIVE":      TagSpec("kWh/m2", 0.01,    0.0,    15.0, "last", "environmental", True),
    "GHI_CUMULATIVE_YESTERDAY": TagSpec("kWh/m2", 0.01, 0.0,  15.0, "last", "environmental"),
    "GTI_CUMULATIVE_YESTERDAY": TagSpec("kWh/m2", 0.01, 0.0,  15.0, "last", "environmental"),
    "DIFFUSE_RADIATION":   TagSpec("W/m2",  1.0,      0.0,  1500.0, "avg", "environmental"),
    "DIFFUSE_RADIATION_AVG": TagSpec("W/m2", 1.0,     0.0,  1500.0, "avg", "environmental"),
    "DIRECT_RADIATION":    TagSpec("W/m2",  1.0,      0.0,  1500.0, "avg", "environmental"),
    "DIRECT_RADIATION_AVG": TagSpec("W/m2", 1.0,      0.0,  1500.0, "avg", "environmental"),
    "RAIN_GAUGE":          TagSpec("mm/h",  0.1,      0.0,   200.0, "avg", "environmental"),
    "CLOUD_COVER":         TagSpec("%",     0.1,      0.0,   100.0, "avg", "environmental"),

    # ── PPC — the curtailment inputs (tender §18) ───────────────────────────
    # Inverter AVG CURRENT — the client's second sheet revision gives A, not the
    # kV the first one did (TAG_CATALOGUE §4.1 resolved).
    "AC_CURRENT_AVG":      TagSpec("A",     0.01,     0.0,  4000.0, "avg", "electrical"),

    # ── PPC setpoints (TAG_CATALOGUE §2.7). Commanded values, not measurements:
    # `last`, category status, so a setpoint change is never throttled away.
    "ACTIVE_POWER_SETPOINT":   TagSpec("kW",   0.1, 0.0, 5000.0, "last", "status"),
    "REACTIVE_POWER_SETPOINT": TagSpec("kVAr", 0.1, -5000.0, 5000.0, "last", "status"),
    "VOLTAGE_SETPOINT":        TagSpec("kV",   0.01, 0.0, 800.0, "last", "status"),
    "POWER_FACTOR_SETPOINT":   TagSpec("ratio", 0.001, -1.0, 1.0, "last", "status"),
    "FREQUENCY_SETPOINT":      TagSpec("Hz",   0.01, 45.0, 55.0, "last", "status"),

    # ── Transformer analogue temperatures (TAG_CATALOGUE §2.5, second revision).
    # OTI = oil temperature indicator, WTI = winding temperature indicator. The
    # first sheet showed the Transformer as entirely DI; these three rows on the
    # second reopen a threshold rule on the Transformer (OPEN-18).
    "OTI_TEMPERATURE":     TagSpec("degC",  0.1,    -20.0,   150.0, "max", "diagnostic"),
    "WTI_1_TEMPERATURE":   TagSpec("degC",  0.1,    -20.0,   150.0, "max", "diagnostic"),
    "WTI_2_TEMPERATURE":   TagSpec("degC",  0.1,    -20.0,   150.0, "max", "diagnostic"),

    # ── UPS (TAG_CATALOGUE §2.11). Auxiliary supply, not generation: diagnostic.
    "UPS_INPUT_VOLTAGE":   TagSpec("V",     0.1,      0.0,   500.0, "avg", "diagnostic"),
    "UPS_INPUT_FREQUENCY": TagSpec("Hz",    0.01,    45.0,    55.0, "avg", "diagnostic"),
    "UPS_OUTPUT_VOLTAGE":  TagSpec("V",     0.1,      0.0,   500.0, "avg", "diagnostic"),
    "UPS_OUTPUT_FREQUENCY": TagSpec("Hz",   0.01,    45.0,    55.0, "avg", "diagnostic"),
    "UPS_OUTPUT_CURRENT":  TagSpec("A",     0.01,     0.0,   500.0, "avg", "diagnostic"),
    "UPS_BATTERY_VOLTAGE": TagSpec("V",     0.1,      0.0,   500.0, "avg", "diagnostic"),
    "UPS_TEMPERATURE":     TagSpec("degC",  0.1,    -20.0,   100.0, "max", "diagnostic"),

    # ── Module Tracker angles (TAG_CATALOGUE §2.13). Signed: a tracker rotates
    # both ways from horizontal.
    "TRACKER_TARGET_ANGLE":    TagSpec("deg", 0.1, -90.0, 90.0, "avg", "diagnostic"),
    "TRACKER_ACTUAL_ANGLE":    TagSpec("deg", 0.1, -90.0, 90.0, "avg", "diagnostic"),
    "TRACKER_ANGLE_DEVIATION": TagSpec("deg", 0.1, -90.0, 90.0, "max", "diagnostic"),

    # ── Communication health, arriving in band (MASTER §9.7) ────────────────
    "LINK_STATUS":         TagSpec("bool",  1.0,      0.0,     1.0, "last", "status"),
    "LINK_FAIL":           TagSpec("bool",  1.0,      0.0,     1.0, "last", "status"),
    # ── Upstream-computed performance (see SOURCE_KEY_ALIASES note) ─────────
    "REPORTED_PERFORMANCE_RATIO": TagSpec("%", 1.0,   0.0,   200.0, "avg", "performance"),
}


def _di(name: str) -> tuple[str, TagSpec]:
    """A Digital Input: a two-state contact, not a measurement.

    Always `last` — averaging a contact is meaningless — and always
    min_interval_s 0 via STATUS_TAGS_ARE_NEVER_THROTTLED below. The client's VCB
    and Transformer report nothing but these.
    """
    return name, TagSpec("bool", 1.0, 0.0, 1.0, "last", "status")


# ════════════════════════════════════════════════════════════════════════════
# Digital Inputs — SUPPLIED 10 Sep 2026 (docs/TAG_CATALOGUE.md §2.1, §2.5, §2.6)
#
# Roughly 30 of the client's ~75 signals are DI contacts. The Tag model absorbs
# them with no schema change — they are rows, which is exactly what I-2 exists
# for — but they behave differently from measurements in two ways that matter:
#
#   * They must never be throttled. A trip contact that opens and re-closes
#     inside a 60 s window is the single most important event a Device will ever
#     report, and a periodic sample would miss it entirely.
#   * They are alarmed on *state*, not on a threshold. There is no analogue value
#     to compare, which is why the `is_true` / `is_false` operators exist.
# ════════════════════════════════════════════════════════════════════════════

DIGITAL_INPUT_TAGS: Final[dict[str, TagSpec]] = dict(
    (
        # VCB — the entire Device is DI (TAG_CATALOGUE §2.1)
        _di("VCB_ON_FEEDBACK"),
        _di("VCB_TRIP_FEEDBACK"),
        _di("VCB_IN_TEST_MODE"),
        _di("VCB_IN_SERVICE"),
        _di("VCB_SPRING_CHARGE"),
        _di("VCB_OC_RELAY"),
        _di("AC_FAIL"),
        _di("DC_FAIL"),
        _di("VCB_TC_HEALTHY"),
        _di("VCB_EMERGENCY_PB"),
        _di("VCB_RELAY_UNHEALTHY"),
        _di("VCB_REMOTE_SELECTION"),
        # Transformer — also entirely DI (TAG_CATALOGUE §2.5). Note there is no
        # analogue temperature anywhere here: the contact fires at the
        # transformer's own protection setting, not at one we invent.
        _di("OIL_TEMP_ALARM"),
        _di("OIL_TEMP_TRIP"),
        _di("WINDING_TEMP_1_ALARM"),
        _di("WINDING_TEMP_1_TRIP"),
        _di("WINDING_TEMP_2_ALARM"),
        _di("WINDING_TEMP_2_TRIP"),
        _di("BUCHHOLZ_RELAY_ALARM"),
        _di("BUCHHOLZ_RELAY_TRIP"),
        _di("MOG_ALARM"),
        # Battery charger (TAG_CATALOGUE §2.6). ⚠ OPEN-19: which Device Type
        # these belong to is unsettled, so they are defined but bound to nothing.
        _di("CHARGER_OVER_CURRENT"),
        _di("CHARGER_FAILURE"),
        _di("CHARGER_DC_OVER_VOLTAGE"),
        _di("CHARGER_DC_UNDER_VOLTAGE"),
        _di("CHARGER_DC_EARTH_FAULT"),
        _di("CHARGER_RECT_FUSE_FAILURE"),
        _di("BATTERY_OVER_TEMP"),
        _di("CHARGER_SOURCE1_MCB_TRIP"),
        _di("CHARGER_SOURCE2_MCB_TRIP"),
        # PPC control-enable flags — with the setpoints, these are what make
        # Curtailment separable from a fault (tender §18).
        _di("ACTIVE_POWER_CONTROL_ENABLE"),
        _di("REACTIVE_POWER_CONTROL_ENABLE"),
        _di("VOLTAGE_CONTROL_ENABLE"),
        _di("POWER_FACTOR_CONTROL_ENABLE"),
        _di("FREQUENCY_CONTROL_ENABLE"),
        # Isolator (TAG_CATALOGUE §2.9) — one contact.
        _di("ISOLATOR_FEEDBACK"),
        # Fire system (TAG_CATALOGUE §2.10). FAULT has no type on the sheet;
        # treated as DI because a fire panel's fault output is a contact.
        _di("FIRE_SYSTEM_STATUS"),
        _di("FIRE_SYSTEM_FAULT"),
        # Module tracker operating modes (TAG_CATALOGUE §2.13).
        _di("TRACKER_CLEANING_MODE"),
        _di("TRACKER_TRACKING_MODE"),
        _di("TRACKER_ZERO_ANGLE_MODE"),
        _di("TRACKER_BACK_TRACKING_MODE"),
        # SLDC telemetry (TAG_CATALOGUE §2.8 — list incomplete, OPEN-17)
        _di("SLDC_TELEMETRY_HEALTHY"),
    )
)

TAG_SPECS.update(DIGITAL_INPUT_TAGS)

# Guardrail 11: a status Tag is never throttled.
STATUS_TAGS_ARE_NEVER_THROTTLED: Final = True


# ════════════════════════════════════════════════════════════════════════════
# Source-key aliases — ⚠ ASSUMED. Constrained by observation, closes on OPEN-15.
#
# Published payload keys are not canonical Tag codes. This maps the key names
# seen in the field to the registry above, and seeds per-Device bindings during
# onboarding. It is a *default*: the authoritative mapping for any specific
# Device is its row in `device_tag_bindings`, because two Devices of the same
# Model on different firmware legitimately use different keys for the same Tag
# (MASTER §5.2).
#
# Deliberately keyed by payload key only — never by Client, Plant or Device
# name, which would violate I-1.
# ════════════════════════════════════════════════════════════════════════════

SOURCE_KEY_ALIASES: Final[dict[str, str]] = {
    # CamelCase family, observed on the client's test broker
    "VoltageRY": "HV_VOLTAGE_RY",
    "VoltageYB": "HV_VOLTAGE_YB",
    "VoltageBR": "HV_VOLTAGE_BR",
    "CurrentR": "AC_CURRENT_R",
    "CurrentY": "AC_CURRENT_Y",
    "CurrentB": "AC_CURRENT_B",
    "AvgPowerFactor": "POWER_FACTOR",
    "Frequency": "FREQUENCY",
    "ActivePower": "AC_ACTIVE_POWER",
    "ReactivePower": "AC_REACTIVE_POWER",
    "ApparentPower": "AC_APPARENT_POWER",
    "TodayExport": "ENERGY_EXPORT_TODAY",
    "TodayImport": "ENERGY_IMPORT_TODAY",
    "Export": "ENERGY_EXPORT_TOTAL",
    "Import": "ENERGY_IMPORT_TOTAL",
    # ⚠ Mapped to the CUMULATIVE tags, not the instantaneous ones. The client's
    # schedule lists `GHI IRRADIATION` (W/m2) and `CUMMULATIVE GHI` (kWh/m2) as
    # separate signals, and the observed 5.517 is implausible as the former and
    # ordinary as the latter (TAG_CATALOGUE §5.4). Provisional pending B-11 —
    # which of the four cumulative signals it is, and over what window, is
    # unstated. Storing it as W/m2 would have been a 1000x error that every range
    # check would have passed.
    "AverageGHI": "GHI_CUMULATIVE",
    "AverageGTI": "GTI_CUMULATIVE",
    "WindDirection": "WIND_DIRECTION",
    "WindSpeed": "WIND_SPEED",
    "AmbientTemp": "AMBIENT_TEMPERATURE",
    "ModuleTemp": "MODULE_TEMPERATURE",
    # The client's upstream already computes PR and publishes it. We store it
    # under its own Tag rather than treating it as our PR, so that ours and
    # theirs can be reconciled instead of silently conflated — directly useful
    # evidence for OPEN-16.
    "PerformanceRatio": "REPORTED_PERFORMANCE_RATIO",
    # SCREAMING_SNAKE family, observed in the client's REST payload (MASTER §9)
    "TOTAL_ACTIVE_POWER": "AC_ACTIVE_POWER",
    "TOTAL_REACTIVE_POWER": "AC_REACTIVE_POWER",
    "TOTAL_APPARENT_POWER": "AC_APPARENT_POWER",
    "VOLTAGE_RY": "HV_VOLTAGE_RY",
    "VOLTAGE_YB": "HV_VOLTAGE_YB",
    "VOLTAGE_BR": "HV_VOLTAGE_BR",
    "AMBIENT_TEMPERATURE": "AMBIENT_TEMPERATURE",
    "WIND_SPEED": "WIND_SPEED",
    "WIND_DIRECTION": "WIND_DIRECTION",
    "LINK_STS": "LINK_STATUS",
    "LINK_FAIL": "LINK_FAIL",
    # ── Client signal-schedule names, SUPPLIED 10 Sep 2026 ──────────────────
    # Transcribed as the client writes them, typos included: the alias table is
    # exactly where a supplier's spelling belongs, so that no misspelling has to
    # leak into a canonical Tag code. "AMBINT", "CUMMULATIVE", "PETPOINT" and
    # "REACIVE" are the client's (docs/TAG_CATALOGUE.md).
    "RY VOLTAGE": "HV_VOLTAGE_RY",
    "YB VOLTAGE": "HV_VOLTAGE_YB",
    "BR VOLTAGE": "HV_VOLTAGE_BR",
    "AVG VOLTAGE": "HV_VOLTAGE_AVG",
    "R CURRENT": "AC_CURRENT_R",
    "Y CURRENT": "AC_CURRENT_Y",
    "B CURRENT": "AC_CURRENT_B",
    "R POWER FACTOR": "POWER_FACTOR_R",
    "Y POWER FACTOR": "POWER_FACTOR_Y",
    "B POWER FACTOR": "POWER_FACTOR_B",
    "ACTIVE POWER": "AC_ACTIVE_POWER",
    "REACTIVE POWER": "AC_REACTIVE_POWER",
    "FREQUENCY": "FREQUENCY",
    "EXPORT": "ENERGY_EXPORT_TOTAL",
    "IMPORT": "ENERGY_IMPORT_TOTAL",
    # WMS
    "AMBINT TEMP.": "AMBIENT_TEMPERATURE",
    "MODULE TEMP.": "MODULE_TEMPERATURE",
    "WIND SPEED": "WIND_SPEED",
    "WIND DIRECTION": "WIND_DIRECTION",
    "GHI IRRADIATION": "GHI",
    "GTI IRRADIATION": "GTI",
    "CUMMULATIVE GHI": "GHI_CUMULATIVE",
    "CUMMULATIVE GTI": "GTI_CUMULATIVE",
    "YEST. CUMMULATIVE GHI": "GHI_CUMULATIVE_YESTERDAY",
    "YEST. CUMMULATIVE GTI": "GTI_CUMULATIVE_YESTERDAY",
    "HUMIDITY": "HUMIDITY",
    "RAIN GAUGE": "RAIN_GAUGE",
    "DIFFUSED RADIATION": "DIFFUSE_RADIATION",
    "DIFFUSED RADIATION AVERAGE": "DIFFUSE_RADIATION_AVG",
    "DIRECT RADIATION": "DIRECT_RADIATION",
    "DIRECT RADIATION AVERAGE": "DIRECT_RADIATION_AVG",
    "CLOUD COVER": "CLOUD_COVER",
    # Inverter
    "AVG CURRENT": "AC_CURRENT_R",   # ⚠ client unit says kV; expected A (T-4)
    "DC POWER": "DC_POWER",
    "POWER FACTOR": "POWER_FACTOR",
    "EFFICIENCY": "INVERTER_EFFICIENCY",
    "DAILY ENERGY": "ENERGY_TODAY",
    "MONTHLY ENERGY": "ENERGY_MONTHLY",
    "CUMULATIVE ENERGY": "ENERGY_CUMULATIVE_MWH",  # ⚠ MWh, not kWh (T-5)
    "SPECIFIC YIELD": "SPECIFIC_YIELD",
    "DEVICE STATUS": "DEVICE_STATUS",
    "PV VOLTAGE": "PV_VOLTAGE",
    "PV CURRENT": "PV_CURRENT",
    "TODAY PEAK": "TODAY_PEAK",
    # VCB (all DI)
    "ON FEEDBACK": "VCB_ON_FEEDBACK",
    "VCB TRIP FEEDBACK": "VCB_TRIP_FEEDBACK",
    "VCB IN TEST MODE": "VCB_IN_TEST_MODE",
    "VCB IN SERVICE": "VCB_IN_SERVICE",
    "VCB SPRING CHARGE": "VCB_SPRING_CHARGE",
    "VCB OC RLAY": "VCB_OC_RELAY",
    "AC FAIL": "AC_FAIL",
    "DC FAIL": "DC_FAIL",
    "VCB TC HEALTHY": "VCB_TC_HEALTHY",
    "VCB EMERGRNCY PB": "VCB_EMERGENCY_PB",
    "VCB RELAY UNHEALTHY": "VCB_RELAY_UNHEALTHY",
    "VCB REMOTE SELECTION": "VCB_REMOTE_SELECTION",
    # Transformer (all DI)
    "OIL TEMP. ALARM": "OIL_TEMP_ALARM",
    "OIL TEMP. TRIP": "OIL_TEMP_TRIP",
    "WINDING TEMP.1 ALARM": "WINDING_TEMP_1_ALARM",
    "WINDING TEMP.1 TRIP": "WINDING_TEMP_1_TRIP",
    "WINDING TEMP.2 ALARM": "WINDING_TEMP_2_ALARM",
    "WINDING TEMP.2 TRIP": "WINDING_TEMP_2_TRIP",
    "BUCHHOLZ RELAY ALARM": "BUCHHOLZ_RELAY_ALARM",
    "BUCHHOLZ RELAY TRIP": "BUCHHOLZ_RELAY_TRIP",
    "MOG ALARM": "MOG_ALARM",
    # Battery charger (all DI) — ⚠ Device Type unsettled (OPEN-19)
    "OVER CURRENT": "CHARGER_OVER_CURRENT",
    "CHARGER FAILURE": "CHARGER_FAILURE",
    "DC OVER VOLTAGE": "CHARGER_DC_OVER_VOLTAGE",
    "DC UNDER VOLTAGE": "CHARGER_DC_UNDER_VOLTAGE",
    "DC EARTH FAULT": "CHARGER_DC_EARTH_FAULT",
    "RECT. FUSE FAILURE": "CHARGER_RECT_FUSE_FAILURE",
    "BATTERY OVER TEMP.": "BATTERY_OVER_TEMP",
    "SOURCE1 MCB TRIP": "CHARGER_SOURCE1_MCB_TRIP",
    "SOURCE2 MCB TRIP": "CHARGER_SOURCE2_MCB_TRIP",
    # PPC — the curtailment inputs
    "ACTIVE POWER PETPOINT": "ACTIVE_POWER_SETPOINT",
    "REACTIVE POWER SETPOINT": "REACTIVE_POWER_SETPOINT",
    "ACTIVE POWER CONTROL ENABLE": "ACTIVE_POWER_CONTROL_ENABLE",
    "REACIVE POWER CONTROL ENABLE": "REACTIVE_POWER_CONTROL_ENABLE",
    "SLDC TELEMETRY HEALTHY": "SLDC_TELEMETRY_HEALTHY",
}


# ════════════════════════════════════════════════════════════════════════════
# §12.2 Formula coefficients — ⚠ ASSUMED. Closes on OPEN-16.
#
# The formulas themselves live in `domain/formulas.py`; only their constants
# live here. Each formula logs which variant it used, so that when the client's
# definition arrives, historical figures can be identified and recomputed.
# ════════════════════════════════════════════════════════════════════════════

G_REF_W_PER_M2: Final = 1000.0  # standard test condition irradiance
DEFAULT_GRID_EMISSION_FACTOR_KG_PER_KWH: Final = 0.82  # CEA all-India average, approximate
PR_VARIANT: Final = "poa_uncorrected"  # not temperature-corrected
CUF_VARIANT: Final = "ac_capacity_calendar_hours"  # no exclusions
AVAILABILITY_VARIANT: Final = "time_based_excluding_comms"


# ════════════════════════════════════════════════════════════════════════════
# §12.3 Alarm thresholds — ⚠ ASSUMED. Seed data only; closes on OPEN-14.
#
# The client has decades of domain knowledge here; anything invented is worse.
# These become rows in `alarm_rules`, editable by a user with config.modify —
# they are not consulted at evaluation time.
# ════════════════════════════════════════════════════════════════════════════


class AlarmRuleSeed(NamedTuple):
    code: str
    name: str
    scope: str  # 'global' or a device_type code
    tag_code: str | None
    operator: str  # gt | lt | outside | special
    threshold: float | None
    threshold_high: float | None
    duration_s: int
    severity: Literal["critical", "high", "medium", "low"]


ALARM_RULE_SEEDS: Final[tuple[AlarmRuleSeed, ...]] = (
    AlarmRuleSeed("COMM_LOST", "Communication Lost", "global",
                  None, "special", None, None, 300, "medium"),
    AlarmRuleSeed("COLLECTOR_OFFLINE", "Collector Offline", "global",
                  None, "special", None, None, 300, "high"),
    # ⚠ CORRECTED 10 Sep 2026. These were 440 V and 380 V — sensible on a 415 V
    # LV board, and wrong by a factor of 1000 here. The client's MFM reports in
    # kV (TAG_CATALOGUE §2.3) and the broker publishes 11.37. These are the ±10%
    # statutory band around 11 kV and remain ASSUMED until the client states the
    # real limits.
    AlarmRuleSeed("GRID_VOLTAGE_HIGH", "Grid Voltage High", "MFM",
                  "HV_VOLTAGE_RY", "gt", 12.1, None, 60, "high"),
    AlarmRuleSeed("GRID_VOLTAGE_LOW", "Grid Voltage Low", "MFM",
                  "HV_VOLTAGE_RY", "lt", 10.5, None, 60, "high"),
    AlarmRuleSeed("FREQUENCY_EXCURSION", "Frequency Excursion", "MFM",
                  "FREQUENCY", "outside", 49.0, 51.0, 30, "high"),
    AlarmRuleSeed("INV_DC_OVERVOLTAGE", "Inverter DC Over-Voltage", "INVERTER",
                  "DC_VOLTAGE", "gt", 1450.0, None, 30, "critical"),
    AlarmRuleSeed("INV_OVERTEMP", "Inverter Over-Temperature", "INVERTER",
                  "DEVICE_TEMPERATURE", "gt", 75.0, None, 300, "medium"),
    # ⚠ REMOVED 10 Sep 2026: "Transformer Over-Temperature" thresholded
    # DEVICE_TEMPERATURE > 85 C. The client's Transformer publishes no analogue
    # value at all — only DI alarm and trip contacts (TAG_CATALOGUE §2.5,
    # OPEN-18) — so that rule had no input and could never have fired. It is
    # replaced by the DI state rules in DIGITAL_INPUT_RULE_SEEDS below, which is
    # the better instrument anyway: the contact fires at the transformer's own
    # protection setting, chosen by its manufacturer, rather than at a number we
    # invented.
    AlarmRuleSeed("INV_UNDERPERFORMANCE", "Inverter Underperformance", "INVERTER",
                  "AC_ACTIVE_POWER", "special", None, None, 900, "medium"),
    AlarmRuleSeed("ZERO_GEN_DAYLIGHT", "Zero Generation in Daylight", "INVERTER",
                  "AC_ACTIVE_POWER", "special", None, None, 600, "high"),
    AlarmRuleSeed("FROZEN_SENSOR", "Frozen Sensor", "global",
                  None, "special", None, None, 0, "low"),
    AlarmRuleSeed("STRING_CURRENT_DEVIATION", "String Current Deviation", "SMB",
                  "DC_CURRENT", "special", None, None, 600, "medium"),
)

# ════════════════════════════════════════════════════════════════════════════
# Digital Input rule seeds — ⚠ ASSUMED severities, SUPPLIED signals.
#
# `is_true` / `is_false` carry no threshold: there is nothing to compare. The
# contact itself is the condition.
#
# Debounce is 0 s on every *trip* contact. A protection trip is not a transient
# to wait out, and delaying a Buchholz trip 120 s "to be sure" would be
# indefensible. It is non-zero on *health* contacts, where a momentary flicker is
# not a fault.
# ════════════════════════════════════════════════════════════════════════════

DIGITAL_INPUT_RULE_SEEDS: Final[tuple[AlarmRuleSeed, ...]] = (
    AlarmRuleSeed("TX_OIL_TEMP_ALARM", "Transformer Oil Temperature Alarm", "TRANSFORMER",
                  "OIL_TEMP_ALARM", "is_true", None, None, 0, "high"),
    AlarmRuleSeed("TX_OIL_TEMP_TRIP", "Transformer Oil Temperature Trip", "TRANSFORMER",
                  "OIL_TEMP_TRIP", "is_true", None, None, 0, "critical"),
    AlarmRuleSeed("TX_WINDING_1_ALARM", "Transformer Winding 1 Temperature Alarm",
                  "TRANSFORMER", "WINDING_TEMP_1_ALARM", "is_true", None, None, 0, "high"),
    AlarmRuleSeed("TX_WINDING_1_TRIP", "Transformer Winding 1 Temperature Trip",
                  "TRANSFORMER", "WINDING_TEMP_1_TRIP", "is_true", None, None, 0, "critical"),
    AlarmRuleSeed("TX_WINDING_2_ALARM", "Transformer Winding 2 Temperature Alarm",
                  "TRANSFORMER", "WINDING_TEMP_2_ALARM", "is_true", None, None, 0, "high"),
    AlarmRuleSeed("TX_WINDING_2_TRIP", "Transformer Winding 2 Temperature Trip",
                  "TRANSFORMER", "WINDING_TEMP_2_TRIP", "is_true", None, None, 0, "critical"),
    AlarmRuleSeed("TX_BUCHHOLZ_ALARM", "Buchholz Relay Alarm", "TRANSFORMER",
                  "BUCHHOLZ_RELAY_ALARM", "is_true", None, None, 0, "high"),
    AlarmRuleSeed("TX_BUCHHOLZ_TRIP", "Buchholz Relay Trip", "TRANSFORMER",
                  "BUCHHOLZ_RELAY_TRIP", "is_true", None, None, 0, "critical"),
    AlarmRuleSeed("TX_MOG_ALARM", "Magnetic Oil Gauge Alarm", "TRANSFORMER",
                  "MOG_ALARM", "is_true", None, None, 0, "medium"),
    AlarmRuleSeed("VCB_TRIP", "VCB Trip", "VCB",
                  "VCB_TRIP_FEEDBACK", "is_true", None, None, 0, "high"),
    AlarmRuleSeed("VCB_RELAY_UNHEALTHY", "VCB Relay Unhealthy", "VCB",
                  "VCB_RELAY_UNHEALTHY", "is_true", None, None, 60, "medium"),
    # is_false: the healthy state is 1, so the *absence* of health is the fault.
    AlarmRuleSeed("VCB_TC_UNHEALTHY", "VCB Trip Coil Unhealthy", "VCB",
                  "VCB_TC_HEALTHY", "is_false", None, None, 60, "high"),
    AlarmRuleSeed("VCB_AC_FAIL", "VCB AC Supply Fail", "VCB",
                  "AC_FAIL", "is_true", None, None, 30, "medium"),
    AlarmRuleSeed("VCB_DC_FAIL", "VCB DC Supply Fail", "VCB",
                  "DC_FAIL", "is_true", None, None, 30, "medium"),
    AlarmRuleSeed("VCB_EMERGENCY_PB", "VCB Emergency Pushbutton Operated", "VCB",
                  "VCB_EMERGENCY_PB", "is_true", None, None, 0, "critical"),
    AlarmRuleSeed("SLDC_TELEMETRY_UNHEALTHY", "SLDC Telemetry Unhealthy",
                  "SLDC_TELEMETRY", "SLDC_TELEMETRY_HEALTHY", "is_false",
                  None, None, 300, "medium"),
)

# All seeds, threshold and state alike, as one catalogue for the seeder.
ALL_ALARM_RULE_SEEDS: Final[tuple[AlarmRuleSeed, ...]] = (
    *ALARM_RULE_SEEDS, *DIGITAL_INPUT_RULE_SEEDS,
)

# Coefficients for the two comparative rules. These are the valuable ones — a
# fixed threshold cannot detect a Device merely doing worse than its neighbours.
UNDERPERFORMANCE_FRACTION: Final = 0.10  # >10% below same-variant sibling median
UNDERPERFORMANCE_MIN_IRRADIANCE_W_PER_M2: Final = 400.0
ZERO_GENERATION_MIN_IRRADIANCE_W_PER_M2: Final = 200.0
ZERO_GENERATION_POWER_EPSILON_KW: Final = 1.0
STRING_DEVIATION_FRACTION: Final = 0.20  # >20% below string-box median


# ════════════════════════════════════════════════════════════════════════════
# §12.4 Intervals — ⚠ ASSUMED.
#
# ⚠ Observation contradicts the publish-interval assumption: the client's test
# broker publishes every ~2.75 s, not 60 s. The assumed value is retained as
# the *registration default* for a Device whose rate nobody has stated, but
# `devices.expected_interval_s` is per-Device and set from observation at
# commissioning. Health detection uses the column, never this constant.
# ════════════════════════════════════════════════════════════════════════════

DEFAULT_PUBLISH_INTERVAL_S: Final = 60  # tender §14 caps acquisition at 1 minute
MIN_INTERVAL_S_BY_CATEGORY: Final[dict[str, int]] = {
    "performance": 60,
    "electrical": 60,
    "diagnostic": 300,
    "environmental": 60,
    # ⚠ Zero, deliberately. A status Tag is a Digital Input, and throttling one
    # discards a trip contact that opened and re-closed inside the window
    # (Guardrail 11). Every other category is a periodic measurement where
    # sampling loses only resolution.
    "status": 0,
}
MIN_INTERVAL_S_CUMULATIVE: Final = 300  # monotonic; throttling loses nothing
LIVE_ROLLUP_HEARTBEAT_S: Final = 5
HEALTH_SWEEP_INTERVAL_S: Final = 60

# Health classification multipliers of expected_interval_s (BACKEND_SPEC §10.2)
HEALTH_DEGRADED_MULTIPLIER: Final = 2
HEALTH_OFFLINE_MULTIPLIER: Final = 10
FROZEN_VALUE_READING_COUNT: Final = 60
STALE_SOURCE_TIME_MULTIPLIER: Final = 2  # quality classification, §6.4


# ════════════════════════════════════════════════════════════════════════════
# §12.5 Escalation — ⚠ ASSUMED. From tender §23's own example.
#
# ⚠ Three escalation levels cannot be expressed by role under the CONFIRMED
# four-role model (MASTER §3.6) — escalation is driven by named people
# (`notify_user_id`), with role as a coarse fallback. Raise with OPEN-2.
# ════════════════════════════════════════════════════════════════════════════

ESCALATION_DELAYS_MINUTES: Final[tuple[int, ...]] = (0, 10, 20)  # L1 immediate, L2, L3
ESCALATION_MIN_SEVERITY: Final = "high"  # low/medium never escalate


# ════════════════════════════════════════════════════════════════════════════
# Counter handling — ⚠ ASSUMED. Closes on OPEN-14.
#
# A counter that decreases is either a rollover or a meter replacement. Those
# are indistinguishable in the stream and opposite in meaning, so neither is
# assumed: the delta is flagged and alarmed, never silently accepted.
# ════════════════════════════════════════════════════════════════════════════

COUNTER_ROLLOVER_MAXIMUM: Final[float | None] = None  # unknown — client must state
NEGATIVE_DELTA_IS_SUSPECT: Final = True


# ════════════════════════════════════════════════════════════════════════════
# Incident snapshots — PROPOSED, OPEN-6.
# ════════════════════════════════════════════════════════════════════════════

INCIDENT_SNAPSHOT_WINDOW_MINUTES: Final = 15  # ± around the trigger
INCIDENT_SNAPSHOT_MIN_SEVERITY: Final = "high"
