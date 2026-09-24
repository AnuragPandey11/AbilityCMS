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
    #
    # ⚠ valid_max raised 500 → 1500 on 17 Sep 2026. The 500 V ceiling was ours,
    # not the client's, and it assumed a 415 V LT system. Their Inverters publish
    # ~800 V line-to-line (observed `VRY` 799.9, `VYB` 795.5, `VBR` 794.8), which
    # is ordinary for a utility-scale machine and was being flagged out-of-range
    # on every reading. 1500 V covers the 690 / 800 / 1000 V LT families without
    # reaching the 11 kV a feeder would show, so a genuine kV/V confusion still
    # trips the check rather than passing silently.
    "AC_VOLTAGE_RY":       TagSpec("V",     0.1,      0.0,  1500.0, "avg", "electrical"),
    "AC_VOLTAGE_YB":       TagSpec("V",     0.1,      0.0,  1500.0, "avg", "electrical"),
    "AC_VOLTAGE_BR":       TagSpec("V",     0.1,      0.0,  1500.0, "avg", "electrical"),
    "AC_VOLTAGE_AVG":      TagSpec("V",     0.1,      0.0,  1500.0, "avg", "electrical"),
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
    # ⚠ valid_min 0.0, not 45.0 — unlike the FREQUENCY measurement above. A
    # setpoint of 0 is the client's "not commanded" sentinel, published on every
    # message while FCE (frequency control enable) is off, and observed as such
    # 17 Sep 2026 alongside VS, PFS and RPS all reading 0. A 45 Hz floor would
    # flag a normal, correct reading as out-of-range on every single message,
    # which trains everyone to ignore the flag.
    "FREQUENCY_SETPOINT":      TagSpec("Hz",   0.01,  0.0, 55.0, "last", "status"),

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
# Per-string PV inputs — SUPPLIED (docs/TAG_CATALOGUE.md §2.4a, third revision).
#
# The client's Inverter schedule lists PV1..PV28 VOLTAGE / CURRENT / ACTIVE
# POWER. How many of them a given Inverter actually has is a property of the
# *unit*, not of the Model — a 12-string and a 24-string machine are the same
# datasheet — so `devices.string_count` decides how many are bound, and the Tag
# registry simply holds all 28. Rows, not columns: this is I-2 doing its job.
#
# ⚠ The sheet's per-string voltage is V while the aggregate PV VOLTAGE is kV
# (§4.3 already questions the latter). Transcribed as given; T-6 stands.
# ⚠ The sheet lists `PV221` between PV20 and PV22, which is a typo for PV21.
# Read as PV21 — the sequence is otherwise unbroken 1..28 — and recorded as T-15.
# ════════════════════════════════════════════════════════════════════════════

MAX_PV_STRINGS: Final = 28

PV_STRING_TAGS: Final[dict[str, TagSpec]] = {}
for _n in range(1, MAX_PV_STRINGS + 1):
    PV_STRING_TAGS[f"PV{_n}_VOLTAGE"] = TagSpec("V", 0.1, 0.0, 1500.0, "avg", "electrical")
    PV_STRING_TAGS[f"PV{_n}_CURRENT"] = TagSpec("A", 0.01, 0.0, 100.0, "avg", "electrical")
    PV_STRING_TAGS[f"PV{_n}_ACTIVE_POWER"] = TagSpec(
        "kW", 0.1, 0.0, 500.0, "avg", "performance"
    )

TAG_SPECS.update(PV_STRING_TAGS)


# ════════════════════════════════════════════════════════════════════════════
# Plant-level KPI Tags — SUPPLIED (the sheet's `DASHBOARD` block).
#
# The client's Device List contains a row named DASHBOARD carrying PR, CUF, peak
# power, plant start/stop time and the functional-Inverter count. It is a Device
# in their sense: a panel that publishes Plant-level figures. Our Device Type
# code for it is `PLANT_KPI`, because `dashboard` already names a UI concept in
# this system (MASTER §1) and one word must not mean two things.
#
# These are the Tags a Plant reports about *itself*. Most are derived (below);
# the YESTERDAY family is not computed at all but copied at the day boundary,
# which is the client's own instruction: "AT 11:55 PM ... DATA WILL BE MOVE TO
# THIS PARAMETER".
# ════════════════════════════════════════════════════════════════════════════

PLANT_KPI_TAGS: Final[dict[str, TagSpec]] = {
    # PR and CUF as percentages, not fractions — the client's formula ends
    # `* 100.0` and their own broker publishes 87.1, not 0.871.
    "PERFORMANCE_RATIO":           TagSpec("%", 1.0, 0.0, 200.0, "avg", "performance"),
    "PERFORMANCE_RATIO_YESTERDAY": TagSpec("%", 1.0, 0.0, 200.0, "last", "performance"),
    "CUF":                         TagSpec("%", 1.0, 0.0, 100.0, "avg", "performance"),
    "CUF_YESTERDAY":               TagSpec("%", 1.0, 0.0, 100.0, "last", "performance"),
    "TODAY_PEAK_POWER":            TagSpec("kW", 1.0, 0.0, 1e6, "max", "performance"),
    "PEAK_POWER_YESTERDAY":        TagSpec("kW", 1.0, 0.0, 1e6, "last", "performance"),
    # ⚠ A time-of-day stored as hours since local midnight (0 to 24), not a
    # timestamp: `readings.value` is a float column and every other Tag in the
    # system is a measurement. 13.75 is 13:45. The Plant's timezone converts it
    # back for display — which is why `plants.timezone` is NOT NULL.
    "TODAY_PEAK_POWER_TIME":       TagSpec("hour", 1.0, 0.0, 24.0, "last", "performance"),
    "PEAK_POWER_TIME_YESTERDAY":   TagSpec("hour", 1.0, 0.0, 24.0, "last", "performance"),
    "PLANT_START_TIME":            TagSpec("hour", 1.0, 0.0, 24.0, "last", "performance"),
    "PLANT_STOP_TIME":             TagSpec("hour", 1.0, 0.0, 24.0, "last", "performance"),
    "INVERTERS_FUNCTIONAL":        TagSpec("count", 1.0, 0.0, 10000.0, "last", "diagnostic"),
    # The aggregate the Plant exports, summed across its meters — the input to
    # PR and CUF, and the figure a Portfolio tile shows.
    "PLANT_ACTIVE_POWER":          TagSpec("kW", 1.0, -1e6, 1e6, "avg", "performance"),
    "PLANT_ENERGY_TODAY":          TagSpec("kWh", 1.0, 0.0, 1e7, "last", "performance", True),
}

TAG_SPECS.update(PLANT_KPI_TAGS)


# ── Annunciator — SUPPLIED as SIGNAL1..SIGNAL20, all Bit, all unnamed.
#
# The client's sheet gives twenty numbered contacts with no meanings. That is
# genuinely what an annunciator is: a panel of lamps whose legends are written at
# the plant, not at the factory. They are seeded as generic DI Tags and the
# *binding* is where a Plant says what its SIGNAL7 actually means — which is
# per-Device, exactly where Plant-specific naming belongs (never a code path).
ANNUNCIATOR_SIGNAL_COUNT: Final = 20
ANNUNCIATOR_TAGS: Final[dict[str, TagSpec]] = {
    f"ANNUNCIATOR_SIGNAL_{_n}": TagSpec("bool", 1.0, 0.0, 1.0, "last", "status")
    for _n in range(1, ANNUNCIATOR_SIGNAL_COUNT + 1)
}

TAG_SPECS.update(ANNUNCIATOR_TAGS)

# The sheet's "TOTAL CURRENT" row — derived, see DERIVED_TAGS below.
TAG_SPECS["AC_CURRENT_TOTAL"] = TagSpec("A", 0.01, 0.0, 12000.0, "avg", "electrical")


# ════════════════════════════════════════════════════════════════════════════
# Derived Tags — the sheet's "Need to Calculate" rows. **SUPPLIED formulas.**
#
# These are the client's own arithmetic, transcribed verbatim from the FORMULA
# column, and they are the first thing in this module that is not an assumption:
# where a formula below is the client's, it is marked SUPPLIED and closing
# OPEN-16 for that metric. Where one is ours, it says ⚠ ASSUMED and why.
#
# The expression is stored on the Tag row and evaluated by `domain/derived.py`,
# so adding a calculated metric is an INSERT like any other Tag. Nothing here is
# a code path: names are Tag codes and Plant/Device constants, never Plant names.
#
# A published value always wins over a computed one (`evaluate_all`), so a meter
# that genuinely transmits AVG VOLTAGE keeps its own figure.
# ════════════════════════════════════════════════════════════════════════════

# Constants a formula may reference, supplied per Device or Plant by the caller:
#   INV_CAPACITY  device rated_capacity_kw   (the client writes it this way)
#   DC_CAPACITY   plant  dc_capacity_kwp
#   AC_CAPACITY   plant  ac_capacity_kw
FORMULA_CONSTANTS: Final[tuple[str, ...]] = ("INV_CAPACITY", "DC_CAPACITY", "AC_CAPACITY")

DERIVED_TAG_FORMULAS: Final[dict[str, tuple[str, str]]] = {
    # ── SUPPLIED: (VOLTAGE RY + VOLTAGE YB + VOLTAGE BR)/3
    "HV_VOLTAGE_AVG": (
        "(HV_VOLTAGE_RY + HV_VOLTAGE_YB + HV_VOLTAGE_BR) / 3", "device",
    ),
    # ── SUPPLIED: ( R PHASE CURRENT + Y PHASE CURRENT + B PHASE CURRENT )
    "AC_CURRENT_TOTAL": (
        "AC_CURRENT_R + AC_CURRENT_Y + AC_CURRENT_B", "device",
    ),
    # ── SUPPLIED: ACTIVE_POWER / (EFFICIENCY/100)
    # Undefined while EFFICIENCY is 0, which is every Inverter at night. That is
    # correct: DC power is not zero then, it is unknown.
    "DC_POWER": (
        "AC_ACTIVE_POWER / (INVERTER_EFFICIENCY / 100)", "device",
    ),
    # ── SUPPLIED: (DAILY_ENERGY / INV_CAPACITY)
    "SPECIFIC_YIELD": (
        "ENERGY_TODAY / INV_CAPACITY", "device",
    ),
    # ── SUPPLIED: (TODAY_ENERGY/(CUMMULATIVE GHI*DC CAPACITY)) * 100.0
    #
    # ⚠ This is **not** the IEC 61724 PR in `formulas.py`, and the difference is
    # deliberate. Theirs divides by GHI (horizontal) where ours used GTI/POA
    # (plane-of-array), and theirs is a percentage where ours was a fraction.
    # Both are kept: this one is what the client's reports must agree with, and
    # `formulas.performance_ratio` stays as the reference definition so the two
    # can be compared rather than conflated (the same reason
    # REPORTED_PERFORMANCE_RATIO exists). PR_VARIANT records which produced a row.
    "PERFORMANCE_RATIO": (
        "(PLANT_ENERGY_TODAY / (AVG.GHI_CUMULATIVE * DC_CAPACITY)) * 100.0", "plant",
    ),
    # ── ⚠ ASSUMED. The sheet marks CUF "Need to Calculate" but leaves the
    # FORMULA column blank for it, so this is the conventional definition —
    # energy over nameplate AC capacity times the hours in the period — and it is
    # the one figure in this block the client has not actually specified (T-16).
    "CUF": (
        "(PLANT_ENERGY_TODAY / (AC_CAPACITY * 24)) * 100.0", "plant",
    ),
    "INVERTERS_FUNCTIONAL": ("COUNT.INVERTERS_ONLINE", "plant"),
}

# ── Inputs the Plant KPI service assembles rather than reads from one Tag.
#
# `PLANT_ENERGY_TODAY` and `PLANT_ACTIVE_POWER` are not formulas because a
# formula cannot express a *precedence*, and these need one: a Plant's energy for
# the day is what its settlement meter recorded, and only if it has no meter is
# summing the Inverters the right answer. Encoding "prefer the ABT Meter, then an
# MFM, then the Inverters" as arithmetic would be a lie about what the number is,
# so the service does it explicitly and names which source it used.
#
# ⚠ I-11 still governs the *Financial* Report: it reads the ABT Meter directly
# and refuses to fall back at all. This precedence is for the operational KPI
# panel, which must show something when the settlement meter is silent.
PLANT_ENERGY_SOURCE_PRECEDENCE: Final[tuple[tuple[str, str], ...]] = (
    ("ABT_METER", "ENERGY_EXPORT_TODAY"),
    ("MFM", "ENERGY_EXPORT_TODAY"),
    ("INVERTER", "ENERGY_TODAY"),
)
PLANT_POWER_SOURCE_PRECEDENCE: Final[tuple[tuple[str, str], ...]] = (
    ("ABT_METER", "AC_ACTIVE_POWER"),
    ("MFM", "AC_ACTIVE_POWER"),
    ("INVERTER", "AC_ACTIVE_POWER"),
)

# ── Energy over a period, from lifetime counters — ⚠ PROPOSED (OPEN-14).
#
# The same Device-Type order as `PLANT_ENERGY_SOURCE_PRECEDENCE` above, read from
# each Type's *lifetime* register instead of its daily one, because a period
# longer than a day (a month, a Report) cannot be answered from a register that
# resets at midnight. The order must match — a KPI screen and a Report must not
# prefer different meters — and `test_assumptions_integrity` asserts it.
#
# ⚠ Which meter is commercially binding is the client's to say (OPEN-14). The
# ABT Meter first is the engineering default, not their answer. Financial
# Reports are not governed by this list at all: I-11 restricts them to the ABT
# Meter with no fallback.
PLANT_ENERGY_COUNTER_PRECEDENCE: Final[tuple[tuple[str, str], ...]] = (
    ("ABT_METER", "ENERGY_EXPORT_TOTAL"),
    ("MFM", "ENERGY_EXPORT_TOTAL"),
    ("INVERTER", "ENERGY_TOTAL"),
)

# ── Counter plausibility — ⚠ ASSUMED.
#
# A step in a lifetime energy counter is refused, and reported, when it goes
# backwards (a rollover, a replaced meter or a reset — indistinguishable without
# the rollover maximum OPEN-14 asks for, MASTER §5.4) or when it is larger than
# the equipment could have produced in the time between the two readings:
# nameplate AC capacity x elapsed hours x this margin. The margin allows for
# modest overloading and for the rounding of a coarse aggregate bucket; it is
# deliberately loose, because refusing real generation is its own kind of lie,
# while the failures it exists to catch are orders of magnitude larger (a
# 240 kWp rooftop "producing" 808,000 kWh in two minutes).
COUNTER_JUMP_CAPACITY_MARGIN: Final = 1.5
# Steps closer together than this are judged as though this far apart, so two
# readings a second apart cannot make a normal increment look impossible.
COUNTER_STEP_MIN_ELAPSED_S: Final = 60.0

# ── Irradiation — ⚠ ASSUMED physical ceiling.
#
# Global horizontal irradiance at the ground does not exceed ~1.2 kW/m² for
# long; cloud-edge enhancement briefly reaches ~1.4 to 1.5. A cumulative
# irradiation register climbing faster than this per hour is a fault, not sun.
MAX_IRRADIATION_KWH_PER_M2_PER_HOUR: Final = 1.5
# The daily cumulative irradiation Tags, which reset at local midnight by
# design — so a backwards step in them is expected, not suspect.
PLANT_IRRADIATION_SOURCE: Final[tuple[str, str]] = ("WMS", "GHI_CUMULATIVE")


# ════════════════════════════════════════════════════════════════════════════
# Day-boundary rollover — SUPPLIED.
#
# "AT 11:55 PM PR DATA WILL BE MOVE TO THIS PARAMETER" — the client's own note
# against every YESTERDAY row. It is a copy, not a calculation: the value that
# stood at the boundary is preserved, whatever produced it.
#
# ⚠ 23:55 **Plant-local**, not UTC. A Plant in Asia/Kolkata rolls over at 18:25
# UTC, and running this on the server's day boundary would attribute five and a
# half hours of generation to the wrong day.
# ════════════════════════════════════════════════════════════════════════════

DAY_ROLLOVER_LOCAL_TIME: Final = (23, 55)  # hour, minute — the client's 11:55 PM
DAY_ROLLOVER_PAIRS: Final[tuple[tuple[str, str], ...]] = (
    ("PERFORMANCE_RATIO", "PERFORMANCE_RATIO_YESTERDAY"),
    ("CUF", "CUF_YESTERDAY"),
    ("TODAY_PEAK_POWER", "PEAK_POWER_YESTERDAY"),
    ("TODAY_PEAK_POWER_TIME", "PEAK_POWER_TIME_YESTERDAY"),
    ("GHI_CUMULATIVE", "GHI_CUMULATIVE_YESTERDAY"),
    ("GTI_CUMULATIVE", "GTI_CUMULATIVE_YESTERDAY"),
)

# ── Plant start and stop — DECIDED 24 Sep 2026 by the project.
#
# The Plant starts when its Inverters' summed AC output rises above 0.5 kW and
# stops the moment it falls back to 0; the gap between the two is hysteresis,
# so dawn hovering at 0.3 kW neither starts nor stops it. `domain/operating`
# holds the rule; the card and the Plant KPI Device both use it.
#
# ⚠ This **supersedes the client's sheet**, which says one threshold of 0.1 MW
# for both ("When the active power is greater than 0.1 MW, that time shall be
# considered the Plant Start Time", and less than, the Stop Time — TAG_CATALOGUE
# §2.15.4; the constant was `PLANT_RUNNING_THRESHOLD_KW = 100.0`), and it reads
# the Inverters where the sheet read "the active power". Worth knowing if this
# is ever re-pointed at a meter: a stop at exactly 0 would then rarely fire,
# because a meter at night reads the Plant's own auxiliary import. Both figures
# are in the Tag's own unit, kW — a 1000x trap otherwise, of exactly the kind
# OPEN-15 exists to prevent.
PLANT_OPERATING_SOURCE: Final = ("INVERTER", "AC_ACTIVE_POWER")
PLANT_START_ABOVE_KW: Final = 0.5
PLANT_STOP_AT_OR_BELOW_KW: Final = 0.0

# ── Grid status — ⚠ ASSUMED.
#
# "Connected" is read from the breaker's ON FEEDBACK contact: closed means the
# Plant's boundary is closed onto the grid. An interpretation, not a supplied
# definition — the client's sheet names the contact and says nothing about what
# it is evidence of — and it cannot see a grid that is closed onto but dead
# (voltage absent upstream). A Plant with no VCB has no grid status at all,
# never an assumed "connected".
GRID_STATUS_SOURCE: Final = ("VCB", "VCB_ON_FEEDBACK")



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
    # ── Short-code family, observed on the client's test broker 16 Sep 2026 ───
    #
    # ⚠ `KULAR_GREEN/DATA` changed its payload keys between 10 and 16 September:
    # the long names below (`VoltageRY`, `CurrentR`, `AvgPowerFactor`) were
    # replaced by these short ones, and the feeder meter decoded nothing at all
    # in the interval (BROKER_OBSERVATIONS.md §7). Both families are kept — a
    # publisher that reverts, or another Plant that never changed, still decodes.
    #
    # These are aliases, which is to say defaults for seeding a binding. Which
    # key a specific Device really uses is its binding, and that remains the
    # authority (MASTER §5.2).
    "VRY": "HV_VOLTAGE_RY",
    "VYB": "HV_VOLTAGE_YB",
    "VBR": "HV_VOLTAGE_BR",
    "IR": "AC_CURRENT_R",
    "IY": "AC_CURRENT_Y",
    "IB": "AC_CURRENT_B",
    "PF": "POWER_FACTOR",
    "Hz": "FREQUENCY",
    # The weather topic shortened its keys the same week the meter did. Six are
    # renames of what WMS-01 already understood; the other seven (GHI, GTI, the
    # four radiation figures, CLOUD_COVER) are signals it never sent before —
    # this broker is now the first to publish the full WMS schedule rather than
    # a seven-signal subset.
    "GHI": "GHI",
    "GTI": "GTI",
    "AGHI": "GHI_CUMULATIVE",
    "AGTI": "GTI_CUMULATIVE",
    "WD": "WIND_DIRECTION",
    "WS": "WIND_SPEED",
    "AT": "AMBIENT_TEMPERATURE",
    "MT": "MODULE_TEMPERATURE",
    "DIF": "DIFFUSE_RADIATION",
    "DIFA": "DIFFUSE_RADIATION_AVG",
    "DIR": "DIRECT_RADIATION",
    # ⚠ Inferred, not confirmed: the pattern reads DIFfuse / DIFfuse-Average /
    # DIRect / Direct-Average, which would make this "DIRA". The broker sends
    # "DA" instead — plausible as a shorthand break, not yet verified against a
    # second reading. Flagged so a stray mis-map is easy to spot later.
    "DA": "DIRECT_RADIATION_AVG",
    "CC": "CLOUD_COVER",
    # ── Short-code family, second wave — observed 17 Sep 2026 on the canonical
    # six-level topics (`SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/...`). 17 Inverters,
    # an MFM, a PPC and a WMS, all publishing keys the table below did not cover.
    #
    # ⚠ Meanings are ASSUMED (MASTER §5.4: observation reveals shape, never
    # meaning). They are not guesses, though — the arithmetic closes across three
    # independent readings, which is the strongest evidence available short of
    # the client saying so:
    #
    #     sqrt(3) * VRY 800 V * IR 40 A * PF 1.0  = 55.4 kW   vs  PAC  55.097
    #     PVV 1089 V * PVI 52.1 A            = 56.7 kW   →  55.1 / 56.7 = 97.1%
    #                                                       vs  EFF  98.45
    #     17 Inverters * ~50 kW              ≈ 850 kW    vs  MFM P 879.78
    #
    # Each still needs client confirmation (OPEN-15) before a number computed
    # from it is shown as authoritative.
    "PAC": "AC_ACTIVE_POWER",     # Inverter AC output, kW
    "P": "AC_ACTIVE_POWER",       # meter active power, kW
    "Q": "AC_REACTIVE_POWER",     # kVAr; observed negative, as a meter importing reactive
    "EFF": "INVERTER_EFFICIENCY", # %
    "F": "FREQUENCY",             # Hz — short form of the existing "Hz" alias
    "CE": "ENERGY_TOTAL",         # cumulative, kWh. ⚠ NOT ENERGY_CUMULATIVE_MWH:
                                  # 80476 as MWh would be 80 GWh from one machine.
    "DE": "ENERGY_TODAY",         # daily, kWh
    "ME": "ENERGY_MONTHLY",       # monthly, kWh
    "PVV": "DC_VOLTAGE",          # PV-side voltage, V (observed ~1089)
    "PVI": "DC_CURRENT",          # PV-side current, A
    "STS": "DEVICE_STATUS",       # a status code, not a measurement (observed 512)
    "EXP": "ENERGY_EXPORT_TOTAL",
    "IMP": "ENERGY_IMPORT_TOTAL",
    "PFR": "POWER_FACTOR_R",
    "PFY": "POWER_FACTOR_Y",
    "PFB": "POWER_FACTOR_B",
    # PPC setpoints and their control-enable contacts. The `*S` / `*CE` pairing is
    # the client's own (TAG_CATALOGUE §2.7); every target Tag already existed.
    "APS": "ACTIVE_POWER_SETPOINT",
    "RPS": "REACTIVE_POWER_SETPOINT",
    "VS": "VOLTAGE_SETPOINT",
    "PFS": "POWER_FACTOR_SETPOINT",
    "FS": "FREQUENCY_SETPOINT",
    "APCE": "ACTIVE_POWER_CONTROL_ENABLE",
    "RPCE": "REACTIVE_POWER_CONTROL_ENABLE",
    "VCE": "VOLTAGE_CONTROL_ENABLE",
    "PFCE": "POWER_FACTOR_CONTROL_ENABLE",
    "FCE": "FREQUENCY_CONTROL_ENABLE",
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
    # T-4 closed by the second revision: A, not kV. It has its own Tag, so it is
    # no longer folded onto the R phase.
    "AVG CURRENT": "AC_CURRENT_AVG",
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
    "VOLTAGE CONTROL ENABLE": "VOLTAGE_CONTROL_ENABLE",
    "POWER FECTOR SETPOINT": "POWER_FACTOR_SETPOINT",
    "POWER FECTOR CONTROL ENABLE": "POWER_FACTOR_CONTROL_ENABLE",
    "FREQUENCY SETPOINT": "FREQUENCY_SETPOINT",
    "FREQUENCY CONTROL ENABLE": "FREQUENCY_CONTROL_ENABLE",
    "VOLTAGE SETPOINT": "VOLTAGE_SETPOINT",
    # Inverter three-phase rows, which the Inverter sheet writes differently
    # from the MFM sheet for the same quantities.
    "VOLTAGE RY": "HV_VOLTAGE_RY",
    "VOLTAGE YB": "HV_VOLTAGE_YB",
    "VOLTAGE BR": "HV_VOLTAGE_BR",
    "R PHASE CURRENT": "AC_CURRENT_R",
    "Y PHASE CURRENT": "AC_CURRENT_Y",
    "B PHASE CURRENT": "AC_CURRENT_B",
    "TOTAL CURRENT": "AC_CURRENT_TOTAL",
    # Transformer analogue temperatures (second revision)
    "OTI TEMP": "OTI_TEMPERATURE",
    "WTI-1 TEMP": "WTI_1_TEMPERATURE",
    "WTI-2 TEMP": "WTI_2_TEMPERATURE",
    # Isolator, fire system, module tracker
    "ISOLATER FEEDBACK": "ISOLATOR_FEEDBACK",  # the client's spelling
    "STATUS": "FIRE_SYSTEM_STATUS",
    "FAULT": "FIRE_SYSTEM_FAULT",
    "TARGETED ANGLE": "TRACKER_TARGET_ANGLE",
    "ACTUAL ANGLE": "TRACKER_ACTUAL_ANGLE",
    "DEVIATION": "TRACKER_ANGLE_DEVIATION",
    "CLEANING MODE": "TRACKER_CLEANING_MODE",
    "TRACKING MODE": "TRACKER_TRACKING_MODE",
    "ZERO ANGLE MODE": "TRACKER_ZERO_ANGLE_MODE",
    "BACK TRACKING MODE": "TRACKER_BACK_TRACKING_MODE",
    # UPS
    "INPUT VOLTAGE": "UPS_INPUT_VOLTAGE",
    "INPUT FREQUENCY": "UPS_INPUT_FREQUENCY",
    "OUTPUT VOLTAGE": "UPS_OUTPUT_VOLTAGE",
    "OUTPUT FREQUENCY": "UPS_OUTPUT_FREQUENCY",
    "OUTPUT AMP.": "UPS_OUTPUT_CURRENT",
    "BATTERY VOLTAGE": "UPS_BATTERY_VOLTAGE",
    "TEMP.": "UPS_TEMPERATURE",
    # Plant KPI panel — the sheet's DASHBOARD block
    "PR": "PERFORMANCE_RATIO",
    "YESTERDAY PR": "PERFORMANCE_RATIO_YESTERDAY",
    "CUF": "CUF",
    "YESTERDAY CUF": "CUF_YESTERDAY",
    "TODAY PEAK POWER": "TODAY_PEAK_POWER",
    "TODAY PEAK POWER TIME": "TODAY_PEAK_POWER_TIME",
    "YEST. PEAK POWER": "PEAK_POWER_YESTERDAY",
    "YEST. PEAK POWER TIME": "PEAK_POWER_TIME_YESTERDAY",
    "NO. OF INVERTER FUNCTIONAL": "INVERTERS_FUNCTIONAL",
    "PLANT START TIME": "PLANT_START_TIME",
    "PLANT STOP TIME": "PLANT_STOP_TIME",
}

# The repeating groups, generated rather than typed: 84 PV-string rows and 20
# annunciator contacts are the same three patterns repeated, and a hand-written
# list of 104 aliases is a transcription error waiting to happen.
for _n in range(1, MAX_PV_STRINGS + 1):
    SOURCE_KEY_ALIASES[f"PV{_n} VOLTAGE"] = f"PV{_n}_VOLTAGE"
    SOURCE_KEY_ALIASES[f"PV{_n} CURRENT"] = f"PV{_n}_CURRENT"
    SOURCE_KEY_ALIASES[f"PV{_n} ACTIVE POWER"] = f"PV{_n}_ACTIVE_POWER"
# ⚠ The sheet's PV221 typo (T-15): aliased to PV21 so a publisher that copies
# the sheet literally still decodes, rather than landing in unmapped_keys.
SOURCE_KEY_ALIASES["PV221 VOLTAGE"] = "PV21_VOLTAGE"
SOURCE_KEY_ALIASES["PV221 CURRENT"] = "PV21_CURRENT"
SOURCE_KEY_ALIASES["PV221 ACTIVE POWER"] = "PV21_ACTIVE_POWER"

for _n in range(1, ANNUNCIATOR_SIGNAL_COUNT + 1):
    SOURCE_KEY_ALIASES[f"SIGNAL{_n}"] = f"ANNUNCIATOR_SIGNAL_{_n}"


# ════════════════════════════════════════════════════════════════════════════
# §12.2 Formula coefficients — ⚠ ASSUMED. Closes on OPEN-16.
#
# The formulas themselves live in `domain/formulas.py`; only their constants
# live here. Each formula logs which variant it used, so that when the client's
# definition arrives, historical figures can be identified and recomputed.
# ════════════════════════════════════════════════════════════════════════════

G_REF_W_PER_M2: Final = 1000.0  # standard test condition irradiance
# ════════════════════════════════════════════════════════════════════════════
# Source keys whose meaning depends on the Device Type — ⚠ ASSUMED.
#
# `SOURCE_KEY_ALIASES` is keyed by the payload key alone, which is right for
# almost every key and **wrong for these**. The client's broker sends `VRY` from
# both an Inverter and an MFM, and it means different things:
#
#     MFM      VRY = 11.037   → an 11 kV feeder.   HV_VOLTAGE_RY, in kV.  ✓
#     INVERTER VRY = 799.9    → an 800 V LT bus.   HV_VOLTAGE_RY would
#                               store "799.9 kV" - wrong by 1000x.
#
# Only one of the three inverter phases happened to exceed `HV_VOLTAGE_RY`'s
# ceiling; `VYB` 795.5 and `VBR` 794.8 would have been stored, flagged good, and
# quietly wrong. That is the exact failure BACKEND_SPEC §12 exists to prevent,
# and it is why a global key→Tag table cannot be the last word.
#
# A binding remains the authority (MASTER §5.2). This table is what a binding is
# *seeded from* when the Device's Type is known, and it is consulted before
# `SOURCE_KEY_ALIASES`.
# ════════════════════════════════════════════════════════════════════════════

SOURCE_KEY_ALIASES_BY_DEVICE_TYPE: Final[dict[str, dict[str, str]]] = {
    "INVERTER": {
        # LT machine terminals, in volts. See the 1000x note above.
        "VRY": "AC_VOLTAGE_RY",
        "VYB": "AC_VOLTAGE_YB",
        "VBR": "AC_VOLTAGE_BR",
        # ⚠ ASSUMED, and the weaker of the two calls in this table. `MT` is
        # module temperature on the Weather Station, where the name is
        # unambiguous. On an Inverter it is far more likely the machine's own
        # heatsink: the WMS reported 34.5 °C for the modules at the same moment
        # these Inverters reported 48.7-49.5 degC, and a 15 °C spread between two
        # readings of the same quantity is not a measurement difference.
        "MT": "DEVICE_TEMPERATURE",
    },
    # The client's broker abbreviates every signal on these two Types, and the
    # abbreviations are generic words — `ON`, `TRIP`, `TEST`, `SPR` mean
    # something else on almost any other equipment — so they are Type-scoped
    # rather than global, for the same reason `VRY` is. Transcribed from the
    # signal schedule's own ordering; observed on KULAR_GREEN 20 Sep 2026.
    "VCB": {
        "ON": "VCB_ON_FEEDBACK",
        "TRIP": "VCB_TRIP_FEEDBACK",
        "TEST": "VCB_IN_TEST_MODE",
        "SERV": "VCB_IN_SERVICE",
        "SPR": "VCB_SPRING_CHARGE",
        "OCR": "VCB_OC_RELAY",
        "ACF": "AC_FAIL",
        "DCF": "DC_FAIL",
        "TCH": "VCB_TC_HEALTHY",
        "EPB": "VCB_EMERGENCY_PB",
        "RLYF": "VCB_RELAY_UNHEALTHY",
        "REM": "VCB_REMOTE_SELECTION",
    },
    "TRANSFORMER": {
        "OTA": "OIL_TEMP_ALARM",
        "OTT": "OIL_TEMP_TRIP",
        "WT1A": "WINDING_TEMP_1_ALARM",
        "WT1T": "WINDING_TEMP_1_TRIP",
        "WT2A": "WINDING_TEMP_2_ALARM",
        "WT2T": "WINDING_TEMP_2_TRIP",
        "BRA": "BUCHHOLZ_RELAY_ALARM",
        "BRT": "BUCHHOLZ_RELAY_TRIP",
        "MOGA": "MOG_ALARM",
        # `OT` is Oil Temperature throughout the DI names, so `OTI` is its
        # Indicator, and `WTI` the Winding one. The schedule names two winding
        # indicators; this machine publishes a single one, so WTI_2_TEMPERATURE
        # is simply never bound — a Tag the Model offers and this Device does
        # not report, which is the normal case and not a gap.
        "OTI": "OTI_TEMPERATURE",
        "WTI": "WTI_1_TEMPERATURE",
    },
}


def alias_for(source_key: str, device_type_code: str | None = None) -> str | None:
    """The Tag a payload key maps to, Device Type taken into account.

    The Type-specific table wins where it has an entry, because the same key
    genuinely means different things on different equipment. Everything else
    falls through to the global table.
    """
    if device_type_code is not None:
        specific = SOURCE_KEY_ALIASES_BY_DEVICE_TYPE.get(device_type_code, {})
        if source_key in specific:
            return specific[source_key]
    return SOURCE_KEY_ALIASES.get(source_key)


DEFAULT_GRID_EMISSION_FACTOR_KG_PER_KWH: Final = 0.82  # CEA all-India average, approximate
PR_VARIANT: Final = "poa_uncorrected"  # not temperature-corrected
CUF_VARIANT: Final = "ac_capacity_calendar_hours"  # no exclusions
AVAILABILITY_VARIANT: Final = "time_based_excluding_comms"

# The month a KPI "year" begins in, in the Plant's own calendar. Decided
# 23 Sep 2026 by the development team: the calendar year, January to December —
# not the Indian financial year (April to March), which the client may yet ask
# for. One constant, so that answer is a one-line change (`domain/periods`).
KPI_YEAR_START_MONTH: Final = 1


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
    # Equipment that is publishing and registered to nothing. Every message is
    # quarantined rather than decoded, so the Device runs and produces no
    # history at all — a loss that is permanent past raw retention and that
    # nothing else in the system reports. High rather than critical: the
    # equipment is healthy, it is the record that is being lost.
    AlarmRuleSeed("UNREGISTERED_DEVICE_PUBLISHING", "Unregistered Device Publishing",
                  "global", None, "special", None, None, 300, "high"),
    # A whole Plant delivering nothing. Unbuildable per Device, because every
    # per-Device check is driven by data that is no longer arriving: a
    # subscription filter matching nothing delivers no message, quarantines no
    # message, and fires no rule. Critical — the Plant is dark to us.
    AlarmRuleSeed("PLANT_SILENT", "Plant Silent", "global",
                  None, "special", None, None, 0, "critical"),
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

# ⚠ ASSUMED. How long a topic with no computable interval may be quiet before
# discovery stops offering it as something to register. A topic seen once has no
# gap to measure, so it gets this rather than a multiple of nothing; it is also
# the floor under every measured interval, so a Device on a 5 s cycle is not
# called dead thirty seconds after a momentary drop.
UNREGISTERED_LIVENESS_FLOOR_S: Final = 900  # 15 minutes

# ⚠ ASSUMED. The window the Plant-level heartbeat looks back over. A Plant with
# registered, topic-carrying Devices that delivers *nothing* for longer than
# this — and longer than its slowest Device's own interval — is silent as a
# whole, which no per-Device check can see: per-Device alarming is driven by
# data arriving, and here none is.
PLANT_SILENCE_WINDOW_S: Final = 600  # 10 minutes


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
