"""The default dashboard: which figures matter, and where each one can come from.

This is the catalogue seeded into `dashboard_slots` and `dashboard_slot_candidates`.
The database is what runs; this file is where the defaults are written, reviewed
and unit-tested, the same relationship `seed.py` has with every other catalogue.

**What this file is not.** It contains no units, no thresholds, no scaling and no
formulas — those live in `assumptions.py` and `DERIVED_TAG_FORMULAS`, and
Guardrail 6 keeps them there. A slot says *where a number comes from*, never what
it means. That distinction is why this can be written now while OPEN-14, OPEN-15
and OPEN-16 are still open: re-pointing a tile at a different Device Type does
not commit the platform to a unit or a definition.

**The layout is fixed and the sources are not.** Panels and positions are the
same on every Plant — that is the whole argument against a drag-and-drop canvas.
A canvas makes every Plant a bespoke artefact that someone has to build and
nobody can compare; this makes every Plant the same screen, answered by whatever
equipment it happens to have.

Slot codes are `panel.name`, never anything derived from a Client, Plant or
Device name (Guardrail 2).
"""

from __future__ import annotations

from typing import Final

from solarcms.domain.assumptions import (
    PLANT_ENERGY_SOURCE_PRECEDENCE,
    PLANT_POWER_SOURCE_PRECEDENCE,
)
from solarcms.domain.slots import (
    KIND_DEVICE_COUNT,
    KIND_DEVICE_TAG,
    KIND_PLANT_ATTRIBUTE,
    SlotCandidate,
    SlotSpec,
)

# ── Panels. The fixed structure of the screen. ──────────────────────────────
PANEL_KPI_ROW: Final = "kpi_row"
PANEL_PLANT_STATUS: Final = "plant_status"
PANEL_POWER_SUMMARY: Final = "power_summary"
PANEL_ENERGY_SUMMARY: Final = "energy_summary"
PANEL_ENVIRONMENT: Final = "environment"
PANEL_SLD_PREFIX: Final = "sld."

PANELS: Final[tuple[str, ...]] = (
    PANEL_KPI_ROW, PANEL_PLANT_STATUS, PANEL_POWER_SUMMARY,
    PANEL_ENERGY_SUMMARY, PANEL_ENVIRONMENT,
    "sld.PV_ARRAY", "sld.INVERTERS", "sld.TRANSFORMER", "sld.GRID",
)


# ════════════════════════════════════════════════════════════════════════════
# How a metered quantity is combined across several Devices.
#
# ⚠ **OPEN.** A Plant with one ABT Meter is unambiguous; a Plant with four MFMs
# is not, because the platform does not know from the Device Type alone whether
# they sit on parallel feeders (in which case the Plant's export is their sum) or
# one behind each Inverter bank plus one at the evacuation point (in which case
# summing them counts the same electrons twice).
#
# Defaulted to `first` for every meter Type, deliberately choosing the *visible*
# error over the plausible one. Reading one of two parallel feeders shows roughly
# half what the Inverters report, which somebody notices within a day.
# Double-counting an inverter-side and a feeder-side meter shows a number that is
# simply wrong and looks entirely reasonable — the error class that produced the
# factor-of-1000 voltage warning in BACKEND_SPEC §12.
#
# A Plant with genuinely parallel metering corrects this with one row in
# `plant_dashboard_slot_overrides`. That is the mechanism working, not a workaround.
# ════════════════════════════════════════════════════════════════════════════
_METERED_AGGREGATE: Final[dict[str, str]] = {
    "ABT_METER": "first",   # I-8: there is exactly one sealed settlement instrument
    "MFM": "first",         # ⚠ see above
    "INVERTER": "sum",      # unambiguous: each machine's output is its own
    "PLANT_KPI": "first",   # one per Plant, by construction
}


def _from_precedence(
    precedence: tuple[tuple[str, str], ...], start: int = 1
) -> tuple[SlotCandidate, ...]:
    """Turn one of the hand-written precedence tuples into slot candidates.

    Imported rather than restated so `PLANT_ENERGY_SOURCE_PRECEDENCE` and its
    sibling stay the single source of truth for the two figures they cover. If
    the client's answer to OPEN-14 reorders them, both the KPI service and this
    catalogue follow in one edit.
    """
    return tuple(
        SlotCandidate(
            kind=KIND_DEVICE_TAG, priority=start + offset,
            device_type_code=device_type, tag_code=tag_code,
            aggregate=_METERED_AGGREGATE.get(device_type, "first"),
        )
        for offset, (device_type, tag_code) in enumerate(precedence)
    )


def _tag(
    priority: int, device_type: str, tag_code: str, aggregate: str
) -> SlotCandidate:
    return SlotCandidate(
        kind=KIND_DEVICE_TAG, priority=priority, device_type_code=device_type,
        tag_code=tag_code, aggregate=aggregate,
    )


def _attribute(priority: int, column: str) -> SlotCandidate:
    return SlotCandidate(
        kind=KIND_PLANT_ATTRIBUTE, priority=priority, plant_attribute=column
    )


def _count(priority: int, device_type: str, *, online_only: bool = False) -> SlotCandidate:
    return SlotCandidate(
        kind=KIND_DEVICE_COUNT, priority=priority, device_type_code=device_type,
        aggregate="count", online_only=online_only,
    )


# ════════════════════════════════════════════════════════════════════════════
# THE HEADLINE ROW — the seven figures anyone opening a Plant looks at first.
#
# Every one of them is answerable by a bare rooftop Plant that publishes nothing
# but four Inverters, and by an 8 MW Plant with a settlement meter and a weather
# station. That is the test each slot has to pass to be in this row.
# ════════════════════════════════════════════════════════════════════════════

_KPI_ROW: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="kpi.plant_capacity", label="Plant Capacity", panel=PANEL_KPI_ROW, position=1,
        unit_hint="kWp", hide_when_unresolved=False,
        candidates=(
            # A registered fact about the Plant, not a measurement — which is why
            # it is the one tile that is right at 3 a.m. with every link down.
            _attribute(1, "dc_capacity_kwp"),
            _attribute(2, "ac_capacity_kw"),
        ),
    ),
    SlotSpec(
        code="kpi.current_power", label="Current Power", panel=PANEL_KPI_ROW, position=2,
        unit_hint="kW", hide_when_unresolved=False,
        # The Plant KPI Device first: the scheduler has already applied the
        # precedence and recorded which source won, so the tile and the reports
        # cannot disagree. The raw precedence follows for a Plant whose scheduler
        # has not yet produced a figure.
        candidates=(
            _tag(1, "PLANT_KPI", "PLANT_ACTIVE_POWER", "first"),
            *_from_precedence(PLANT_POWER_SOURCE_PRECEDENCE, start=2),
        ),
    ),
    SlotSpec(
        code="kpi.energy_today", label="Today's Energy", panel=PANEL_KPI_ROW, position=3,
        unit_hint="kWh", hide_when_unresolved=False,
        candidates=(
            _tag(1, "PLANT_KPI", "PLANT_ENERGY_TODAY", "first"),
            *_from_precedence(PLANT_ENERGY_SOURCE_PRECEDENCE, start=2),
        ),
    ),
    SlotSpec(
        code="kpi.energy_month", label="Month Energy", panel=PANEL_KPI_ROW, position=4,
        unit_hint="kWh",
        candidates=(
            _tag(1, "MFM", "ENERGY_MONTHLY", "first"),
            _tag(2, "INVERTER", "ENERGY_MONTHLY", "sum"),
        ),
    ),
    SlotSpec(
        code="kpi.energy_lifetime", label="Lifetime Energy", panel=PANEL_KPI_ROW, position=5,
        unit_hint="kWh",
        candidates=(
            _tag(1, "ABT_METER", "ENERGY_EXPORT_TOTAL", "first"),
            _tag(2, "MFM", "ENERGY_EXPORT_TOTAL", "first"),
            # ⚠ MWh, not kWh — the client's schedule changes unit for this one
            # Tag (T-5). The unit travels with the resolution, so the tile
            # relabels itself rather than showing a 1000x error.
            _tag(3, "INVERTER", "ENERGY_CUMULATIVE_MWH", "sum"),
            _tag(4, "INVERTER", "ENERGY_TOTAL", "sum"),
        ),
    ),
    SlotSpec(
        code="kpi.specific_yield", label="Specific Yield", panel=PANEL_KPI_ROW, position=6,
        unit_hint="kWh/kWp",
        # Averaged, never summed: it is already normalised by capacity, so adding
        # eight Inverters' specific yields produces eight times the real figure.
        candidates=(_tag(1, "INVERTER", "SPECIFIC_YIELD", "avg"),),
    ),
    SlotSpec(
        code="kpi.performance_ratio", label="Performance Ratio", panel=PANEL_KPI_ROW,
        position=7, unit_hint="%",
        candidates=(
            _tag(1, "PLANT_KPI", "PERFORMANCE_RATIO", "first"),
            # A PR the Device itself reports. Kept distinct from the computed one
            # for the reason REPORTED_PERFORMANCE_RATIO exists at all: the two
            # may disagree, and conflating them hides that.
            _tag(2, "INVERTER", "REPORTED_PERFORMANCE_RATIO", "avg"),
        ),
    ),
)


# ════════════════════════════════════════════════════════════════════════════
# PLANT STATUS — the left-hand column of both reference screens.
# ════════════════════════════════════════════════════════════════════════════

_PLANT_STATUS: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="status.inverters_total", label="Inverters", panel=PANEL_PLANT_STATUS,
        position=1, unit_hint="count", candidates=(_count(1, "INVERTER"),),
    ),
    SlotSpec(
        code="status.inverters_online", label="Inverters Online", panel=PANEL_PLANT_STATUS,
        position=2, unit_hint="count",
        candidates=(
            # The Plant KPI figure is the client's own INVERTERS_FUNCTIONAL, which
            # counts *generating* machines. The comm-status count is a different
            # question — how many are reachable — and answers when it is absent.
            _tag(1, "PLANT_KPI", "INVERTERS_FUNCTIONAL", "first"),
            _count(2, "INVERTER", online_only=True),
        ),
    ),
    SlotSpec(
        code="status.active_power", label="Active Power", panel=PANEL_PLANT_STATUS,
        position=3, unit_hint="kW",
        candidates=(
            _tag(1, "ABT_METER", "AC_ACTIVE_POWER", "first"),
            _tag(2, "MFM", "AC_ACTIVE_POWER", "first"),
            _tag(3, "INVERTER", "AC_ACTIVE_POWER", "sum"),
        ),
    ),
    SlotSpec(
        code="status.reactive_power", label="Reactive Power", panel=PANEL_PLANT_STATUS,
        position=4, unit_hint="kVAr",
        candidates=(
            _tag(1, "ABT_METER", "AC_REACTIVE_POWER", "first"),
            _tag(2, "MFM", "AC_REACTIVE_POWER", "first"),
            _tag(3, "INVERTER", "AC_REACTIVE_POWER", "sum"),
        ),
    ),
    SlotSpec(
        code="status.power_factor", label="Power Factor", panel=PANEL_PLANT_STATUS,
        position=5, unit_hint="ratio",
        # Averaged, never summed — and only over meters, because an Inverter's
        # PF at its own terminals is not the Plant's PF at the grid interface.
        candidates=(
            _tag(1, "ABT_METER", "POWER_FACTOR", "first"),
            _tag(2, "MFM", "POWER_FACTOR", "first"),
            _tag(3, "INVERTER", "POWER_FACTOR", "avg"),
        ),
    ),
    SlotSpec(
        code="status.frequency", label="Grid Frequency", panel=PANEL_PLANT_STATUS,
        position=6, unit_hint="Hz",
        candidates=(
            _tag(1, "ABT_METER", "FREQUENCY", "first"),
            _tag(2, "MFM", "FREQUENCY", "first"),
            _tag(3, "INVERTER", "FREQUENCY", "avg"),
        ),
    ),
    SlotSpec(
        code="status.peak_power_today", label="Peak Power Today", panel=PANEL_PLANT_STATUS,
        position=7, unit_hint="kW",
        candidates=(
            _tag(1, "PLANT_KPI", "TODAY_PEAK_POWER", "first"),
            _tag(2, "INVERTER", "TODAY_PEAK", "sum"),
        ),
    ),
    SlotSpec(
        code="status.cuf", label="CUF", panel=PANEL_PLANT_STATUS, position=8,
        unit_hint="%", candidates=(_tag(1, "PLANT_KPI", "CUF", "first"),),
    ),
)


# ════════════════════════════════════════════════════════════════════════════
# POWER SUMMARY — DC in, AC out, and what actually crossed the boundary.
#
# The four together are a sanity check an operator runs by eye: DC power above
# AC power above export power, each gap a real loss. Tiles that only make sense
# as a set, which is why they are one panel rather than four loose numbers.
# ════════════════════════════════════════════════════════════════════════════

_POWER_SUMMARY: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="power.dc_power", label="DC Power", panel=PANEL_POWER_SUMMARY, position=1,
        unit_hint="kW",
        # DC_POWER is itself derived (AC_ACTIVE_POWER / efficiency) and is
        # undefined while efficiency is 0 — every Inverter at night. Correct: DC
        # power then is unknown, not zero.
        candidates=(_tag(1, "INVERTER", "DC_POWER", "sum"),),
    ),
    SlotSpec(
        code="power.ac_power", label="AC Power", panel=PANEL_POWER_SUMMARY, position=2,
        unit_hint="kW", candidates=(_tag(1, "INVERTER", "AC_ACTIVE_POWER", "sum"),),
    ),
    SlotSpec(
        code="power.export_power", label="Export Power", panel=PANEL_POWER_SUMMARY,
        position=3, unit_hint="kW",
        # No Inverter fallback, deliberately. Export is what crossed the meter;
        # an Inverter cannot know it, and substituting generation for export
        # would make the import tile below meaningless.
        candidates=(
            _tag(1, "ABT_METER", "AC_ACTIVE_POWER", "first"),
            _tag(2, "MFM", "AC_ACTIVE_POWER", "first"),
        ),
    ),
    SlotSpec(
        code="power.dc_voltage", label="DC Voltage", panel=PANEL_POWER_SUMMARY,
        position=4, unit_hint="V", candidates=(_tag(1, "INVERTER", "DC_VOLTAGE", "avg"),),
    ),
    SlotSpec(
        code="power.dc_current", label="DC Current", panel=PANEL_POWER_SUMMARY,
        position=5, unit_hint="A", candidates=(_tag(1, "INVERTER", "DC_CURRENT", "sum"),),
    ),
    SlotSpec(
        code="power.ac_voltage", label="AC Voltage", panel=PANEL_POWER_SUMMARY,
        position=6, unit_hint="kV",
        candidates=(
            _tag(1, "ABT_METER", "HV_VOLTAGE_AVG", "first"),
            _tag(2, "MFM", "HV_VOLTAGE_AVG", "first"),
            _tag(3, "TRANSFORMER", "HV_VOLTAGE_AVG", "avg"),
        ),
    ),
    SlotSpec(
        code="power.ac_current", label="AC Current", panel=PANEL_POWER_SUMMARY,
        position=7, unit_hint="A",
        candidates=(
            _tag(1, "MFM", "AC_CURRENT_AVG", "first"),
            _tag(2, "MFM", "AC_CURRENT_TOTAL", "first"),
            _tag(3, "INVERTER", "AC_CURRENT_AVG", "sum"),
        ),
    ),
)


# ════════════════════════════════════════════════════════════════════════════
# ENERGY SUMMARY — generated, exported, imported. Three different quantities.
# ════════════════════════════════════════════════════════════════════════════

_ENERGY_SUMMARY: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="energy.generated_today", label="Energy Generated", panel=PANEL_ENERGY_SUMMARY,
        position=1, unit_hint="kWh", candidates=(_tag(1, "INVERTER", "ENERGY_TODAY", "sum"),),
    ),
    SlotSpec(
        code="energy.exported_today", label="Energy Exported", panel=PANEL_ENERGY_SUMMARY,
        position=2, unit_hint="kWh",
        candidates=(
            _tag(1, "ABT_METER", "ENERGY_EXPORT_TODAY", "first"),
            _tag(2, "MFM", "ENERGY_EXPORT_TODAY", "first"),
        ),
    ),
    SlotSpec(
        code="energy.imported_today", label="Energy Imported", panel=PANEL_ENERGY_SUMMARY,
        position=3, unit_hint="kWh",
        candidates=(
            _tag(1, "ABT_METER", "ENERGY_IMPORT_TODAY", "first"),
            _tag(2, "MFM", "ENERGY_IMPORT_TODAY", "first"),
        ),
    ),
    SlotSpec(
        code="energy.plant_start", label="Plant Start", panel=PANEL_ENERGY_SUMMARY,
        position=4, unit_hint="hour",
        candidates=(_tag(1, "PLANT_KPI", "PLANT_START_TIME", "first"),),
    ),
    SlotSpec(
        code="energy.plant_stop", label="Plant Stop", panel=PANEL_ENERGY_SUMMARY,
        position=5, unit_hint="hour",
        candidates=(_tag(1, "PLANT_KPI", "PLANT_STOP_TIME", "first"),),
    ),
)


# ════════════════════════════════════════════════════════════════════════════
# ENVIRONMENT — the Weather Station, and the denominator of PR.
#
# Every one hides when absent. A Plant with no WMS is common and entirely valid;
# a permanently blank irradiance tile teaches operators to ignore blank tiles.
#
# ⚠ Instantaneous irradiance (W/m²) and cumulative insolation (kWh/m²) are
# separate slots because conflating them is a 1000x error, and it is exactly what
# the broker's ambiguous `AverageGHI` key turns on (assumptions.py, WMS block).
# ════════════════════════════════════════════════════════════════════════════

_ENVIRONMENT: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="env.irradiance", label="Irradiance", panel=PANEL_ENVIRONMENT, position=1,
        unit_hint="W/m2",
        # Plane-of-array first: it is what the modules actually see, and it is the
        # honest denominator for a tilted array. GHI answers when GTI is absent.
        candidates=(
            _tag(1, "WMS", "GTI", "avg"),
            _tag(2, "WMS", "POA_IRRADIANCE", "avg"),
            _tag(3, "WMS", "GHI", "avg"),
        ),
    ),
    SlotSpec(
        code="env.insolation_today", label="Insolation Today", panel=PANEL_ENVIRONMENT,
        position=2, unit_hint="kWh/m2",
        candidates=(
            _tag(1, "WMS", "GTI_CUMULATIVE", "avg"),
            _tag(2, "WMS", "GHI_CUMULATIVE", "avg"),
        ),
    ),
    SlotSpec(
        code="env.module_temperature", label="Module Temp.", panel=PANEL_ENVIRONMENT,
        position=3, unit_hint="degC", candidates=(_tag(1, "WMS", "MODULE_TEMPERATURE", "avg"),),
    ),
    SlotSpec(
        code="env.ambient_temperature", label="Ambient Temp.", panel=PANEL_ENVIRONMENT,
        position=4, unit_hint="degC", candidates=(_tag(1, "WMS", "AMBIENT_TEMPERATURE", "avg"),),
    ),
    SlotSpec(
        code="env.wind_speed", label="Wind Speed", panel=PANEL_ENVIRONMENT, position=5,
        unit_hint="m/s", candidates=(_tag(1, "WMS", "WIND_SPEED", "avg"),),
    ),
    SlotSpec(
        code="env.humidity", label="Humidity", panel=PANEL_ENVIRONMENT, position=6,
        unit_hint="%", candidates=(_tag(1, "WMS", "HUMIDITY", "avg"),),
    ),
    SlotSpec(
        code="env.rainfall", label="Rainfall", panel=PANEL_ENVIRONMENT, position=7,
        unit_hint="mm/h", candidates=(_tag(1, "WMS", "RAIN_GAUGE", "avg"),),
    ),
    SlotSpec(
        code="env.cloud_cover", label="Cloud Cover", panel=PANEL_ENVIRONMENT, position=8,
        unit_hint="%", candidates=(_tag(1, "WMS", "CLOUD_COVER", "avg"),),
    ),
    # The radiation the power trend is compared against by default. Direct
    # (beam) radiation, not plane-of-array: it is what the client asked to see
    # beside power, and it is *not* the PR denominator — `env.irradiance` is.
    SlotSpec(
        code="env.direct_radiation", label="Direct Radiation", panel=PANEL_ENVIRONMENT,
        position=9, unit_hint="W/m2",
        candidates=(_tag(1, "WMS", "DIRECT_RADIATION", "avg"),),
    ),
)


# ════════════════════════════════════════════════════════════════════════════
# THE FOUR SLD STAGES.
#
# Each stage resolves against **only its own Devices** (`sld_stages.build_stages`),
# so "SUM of INVERTER.AC_ACTIVE_POWER" inside the Inverters stage cannot reach a
# meter sitting in the Grid stage. Three or four figures per box: a stage with
# ten numbers in it is a table, and the diagram stops being readable at a glance.
# ════════════════════════════════════════════════════════════════════════════

_SLD_PV_ARRAY: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="sld.pv.capacity", label="DC Capacity", panel="sld.PV_ARRAY", position=1,
        unit_hint="kWp", candidates=(_attribute(1, "dc_capacity_kwp"),),
    ),
    SlotSpec(
        code="sld.pv.dc_power", label="DC Power", panel="sld.PV_ARRAY", position=2,
        unit_hint="kW",
        # An SMB measures the array's own output; without one the figure comes
        # from the far side of the DC bus, at the Inverters stage, which is why
        # this slot can legitimately resolve to nothing on a plain Plant.
        candidates=(
            _tag(1, "SMB", "DC_POWER", "sum"),
            _tag(2, "DCDB", "DC_POWER", "sum"),
        ),
    ),
    SlotSpec(
        code="sld.pv.dc_voltage", label="DC Voltage", panel="sld.PV_ARRAY", position=3,
        unit_hint="V",
        candidates=(
            _tag(1, "SMB", "DC_VOLTAGE", "avg"),
            _tag(2, "DCDB", "DC_VOLTAGE", "avg"),
        ),
    ),
    SlotSpec(
        code="sld.pv.dc_current", label="DC Current", panel="sld.PV_ARRAY", position=4,
        unit_hint="A",
        candidates=(
            _tag(1, "SMB", "DC_CURRENT", "sum"),
            _tag(2, "DCDB", "DC_CURRENT", "sum"),
        ),
    ),
)

_SLD_INVERTERS: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="sld.inv.ac_power", label="AC Power", panel="sld.INVERTERS", position=1,
        unit_hint="kW", hide_when_unresolved=False,
        candidates=(_tag(1, "INVERTER", "AC_ACTIVE_POWER", "sum"),),
    ),
    SlotSpec(
        code="sld.inv.dc_power", label="DC Power", panel="sld.INVERTERS", position=2,
        unit_hint="kW", candidates=(_tag(1, "INVERTER", "DC_POWER", "sum"),),
    ),
    SlotSpec(
        code="sld.inv.efficiency", label="Efficiency", panel="sld.INVERTERS", position=3,
        unit_hint="%", candidates=(_tag(1, "INVERTER", "INVERTER_EFFICIENCY", "avg"),),
    ),
    SlotSpec(
        code="sld.inv.energy_today", label="Energy Today", panel="sld.INVERTERS", position=4,
        unit_hint="kWh", candidates=(_tag(1, "INVERTER", "ENERGY_TODAY", "sum"),),
    ),
)

_SLD_TRANSFORMER: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="sld.tx.hv_voltage", label="HV Voltage", panel="sld.TRANSFORMER", position=1,
        unit_hint="kV", candidates=(_tag(1, "TRANSFORMER", "HV_VOLTAGE_AVG", "avg"),),
    ),
    SlotSpec(
        code="sld.tx.oil_temperature", label="Oil Temp. (OTI)", panel="sld.TRANSFORMER",
        position=2, unit_hint="degC",
        # `max`, not `avg`: two transformers and one of them running hot is the
        # entire point of showing the figure. An average hides it.
        candidates=(_tag(1, "TRANSFORMER", "OTI_TEMPERATURE", "max"),),
    ),
    SlotSpec(
        code="sld.tx.winding_temperature", label="Winding Temp. (WTI)",
        panel="sld.TRANSFORMER", position=3, unit_hint="degC",
        candidates=(
            _tag(1, "TRANSFORMER", "WTI_1_TEMPERATURE", "max"),
            _tag(2, "TRANSFORMER", "WTI_2_TEMPERATURE", "max"),
        ),
    ),
    SlotSpec(
        code="sld.tx.count", label="Transformers", panel="sld.TRANSFORMER", position=4,
        unit_hint="count", candidates=(_count(1, "TRANSFORMER"),),
    ),
)

_SLD_GRID: Final[tuple[SlotSpec, ...]] = (
    SlotSpec(
        code="sld.grid.export_power", label="Export Power", panel="sld.GRID", position=1,
        unit_hint="kW", hide_when_unresolved=False,
        candidates=(
            _tag(1, "ABT_METER", "AC_ACTIVE_POWER", "first"),
            _tag(2, "MFM", "AC_ACTIVE_POWER", "first"),
        ),
    ),
    SlotSpec(
        code="sld.grid.voltage", label="Grid Voltage", panel="sld.GRID", position=2,
        unit_hint="kV",
        candidates=(
            _tag(1, "ABT_METER", "HV_VOLTAGE_AVG", "first"),
            _tag(2, "MFM", "HV_VOLTAGE_AVG", "first"),
        ),
    ),
    SlotSpec(
        code="sld.grid.frequency", label="Frequency", panel="sld.GRID", position=3,
        unit_hint="Hz",
        candidates=(
            _tag(1, "ABT_METER", "FREQUENCY", "first"),
            _tag(2, "MFM", "FREQUENCY", "first"),
        ),
    ),
    SlotSpec(
        code="sld.grid.power_factor", label="Power Factor", panel="sld.GRID", position=4,
        unit_hint="ratio",
        candidates=(
            _tag(1, "ABT_METER", "POWER_FACTOR", "first"),
            _tag(2, "MFM", "POWER_FACTOR", "first"),
        ),
    ),
    SlotSpec(
        code="sld.grid.energy_export_today", label="Exported Today", panel="sld.GRID",
        position=5, unit_hint="kWh",
        candidates=(
            _tag(1, "ABT_METER", "ENERGY_EXPORT_TODAY", "first"),
            _tag(2, "MFM", "ENERGY_EXPORT_TODAY", "first"),
        ),
    ),
)


DEFAULT_SLOTS: Final[tuple[SlotSpec, ...]] = (
    *_KPI_ROW, *_PLANT_STATUS, *_POWER_SUMMARY, *_ENERGY_SUMMARY, *_ENVIRONMENT,
    *_SLD_PV_ARRAY, *_SLD_INVERTERS, *_SLD_TRANSFORMER, *_SLD_GRID,
)

# Stage code → its slots, the shape `sld_stages.build_stages` expects.
SLD_STAGE_SLOTS: Final[dict[str, tuple[SlotSpec, ...]]] = {
    "PV_ARRAY": _SLD_PV_ARRAY,
    "INVERTERS": _SLD_INVERTERS,
    "TRANSFORMER": _SLD_TRANSFORMER,
    "GRID": _SLD_GRID,
}


# ════════════════════════════════════════════════════════════════════════════
# PER-DEVICE TABLE COLUMNS — the "Inverter Summary" table of the reference
# screens, generalised.
#
# Not slots: a slot produces one number for a Plant, and these produce one column
# across many Devices, so forcing them through the same structure would make both
# harder to read. Still data, still seeded, still keyed by Type and never by
# Device. A Device missing one of these Tags renders "—" in that cell; the column
# itself disappears only when no Device of the Type is bound to it.
# ════════════════════════════════════════════════════════════════════════════

DEVICE_TABLE_COLUMNS: Final[dict[str, tuple[str, ...]]] = {
    "INVERTER": (
        "AC_ACTIVE_POWER", "DC_POWER", "INVERTER_EFFICIENCY",
        "ENERGY_TODAY", "DC_VOLTAGE", "DC_CURRENT", "DEVICE_TEMPERATURE",
    ),
    "MFM": (
        "AC_ACTIVE_POWER", "AC_REACTIVE_POWER", "POWER_FACTOR",
        "HV_VOLTAGE_AVG", "AC_CURRENT_AVG", "FREQUENCY", "ENERGY_EXPORT_TODAY",
    ),
    "ABT_METER": (
        "AC_ACTIVE_POWER", "POWER_FACTOR", "FREQUENCY",
        "ENERGY_EXPORT_TODAY", "ENERGY_IMPORT_TODAY", "ENERGY_EXPORT_TOTAL",
    ),
    "TRANSFORMER": ("OTI_TEMPERATURE", "WTI_1_TEMPERATURE", "WTI_2_TEMPERATURE"),
    "WMS": (
        "GTI", "GHI", "GTI_CUMULATIVE", "MODULE_TEMPERATURE",
        "AMBIENT_TEMPERATURE", "WIND_SPEED", "HUMIDITY",
    ),
    "SMB": ("DC_CURRENT", "DC_VOLTAGE"),
}


def validate() -> None:
    """Every slot code unique, every panel known, every candidate ranked distinctly.

    Called at import and by the seed. A duplicate slot code is silently
    last-write-wins in a dict and produces a tile that quietly disappears; a
    duplicate priority makes the winning candidate depend on tuple order, which
    is exactly the non-determinism this whole mechanism exists to remove.
    """
    seen: set[str] = set()
    for spec in DEFAULT_SLOTS:
        if spec.code in seen:
            raise ValueError(f"duplicate slot code {spec.code!r}")
        seen.add(spec.code)
        if spec.panel not in PANELS:
            raise ValueError(f"slot {spec.code!r} names unknown panel {spec.panel!r}")
        priorities = [c.priority for c in spec.candidates]
        if len(priorities) != len(set(priorities)):
            raise ValueError(f"slot {spec.code!r} has two candidates at the same priority")
        if not spec.candidates:
            raise ValueError(f"slot {spec.code!r} declares no candidates")


validate()
