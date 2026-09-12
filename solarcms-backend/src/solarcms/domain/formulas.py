"""PR, CUF, specific yield, availability, CO2. Pure — no I/O.

⚠ **Every formula here is provisional.** OPEN-16: the client has undertaken to
supply theirs. These are IEC 61724-style defaults, and variants differ by
percentage points — a mismatch against the client's existing reports will be
reported as a system defect, not as a definitional difference.

Each function therefore returns its result *together with the variant name that
produced it*, so that when the client's definition arrives, historical figures
can be identified and recomputed rather than silently superseded. That is the
whole reason `FormulaResult` exists instead of a bare float.

Coefficients live in `assumptions.py`; only the arithmetic lives here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from solarcms.domain.assumptions import (
    AVAILABILITY_VARIANT,
    CUF_VARIANT,
    DEFAULT_GRID_EMISSION_FACTOR_KG_PER_KWH,
    G_REF_W_PER_M2,
    PR_VARIANT,
)

SECONDS_PER_HOUR: Final = 3600.0


@dataclass(frozen=True, slots=True)
class FormulaResult:
    """A computed KPI and the provenance needed to recompute it later."""

    value: float | None
    variant: str
    # Why the value is None, when it is. A KPI that cannot be computed is not
    # zero: zero PR and unknown PR mean entirely different things to an operator.
    undefined_reason: str | None = None

    @property
    def is_defined(self) -> bool:
        return self.value is not None


def specific_yield(energy_kwh: float, dc_capacity_kwp: float) -> FormulaResult:
    """kWh/kWp over the period."""
    if dc_capacity_kwp <= 0:
        return FormulaResult(None, "specific_yield", "dc_capacity_kwp is zero or unknown")
    return FormulaResult(energy_kwh / dc_capacity_kwp, "specific_yield")


def performance_ratio(
    energy_kwh: float, poa_irradiation_wh_m2: float, dc_capacity_kwp: float
) -> FormulaResult:
    """PR = actual yield / reference yield. Dimensionless, nominally 0 to 1.

    ⚠ ASSUMED: uses POA irradiance and is **not** temperature-corrected. A
    temperature-corrected PR runs several points higher in hot weather, which is
    exactly the disagreement OPEN-16 exists to prevent.

    ⚠ Note the unit trap: `poa_irradiation_wh_m2` is *irradiation* (energy, Wh/m²)
    over the same period as `energy_kwh`, not *irradiance* (power, W/m²). The
    client's broker publishes a figure whose unit is unconfirmed — see
    docs/BROKER_OBSERVATIONS.md §4.1, where the same number is defensible as
    either, three orders of magnitude apart.
    """
    if dc_capacity_kwp <= 0:
        return FormulaResult(None, PR_VARIANT, "dc_capacity_kwp is zero or unknown")
    if poa_irradiation_wh_m2 <= 0:
        # At night this is the normal case, not an error. PR is undefined with no
        # irradiation, and reporting 0 would drag every daily average down.
        return FormulaResult(None, PR_VARIANT, "no irradiation in period")
    reference_yield = poa_irradiation_wh_m2 / G_REF_W_PER_M2
    return FormulaResult((energy_kwh / dc_capacity_kwp) / reference_yield, PR_VARIANT)


def cuf(energy_kwh: float, ac_capacity_kw: float, hours: float) -> FormulaResult:
    """Capacity Utilisation Factor.

    ⚠ ASSUMED: AC capacity, full calendar hours, no exclusions. Some operators
    compute it against DC capacity, and some exclude grid-outage hours; both give
    a materially different number.
    """
    if ac_capacity_kw <= 0:
        return FormulaResult(None, CUF_VARIANT, "ac_capacity_kw is zero or unknown")
    if hours <= 0:
        return FormulaResult(None, CUF_VARIANT, "period is zero length")
    return FormulaResult(energy_kwh / (ac_capacity_kw * hours), CUF_VARIANT)


def availability(
    uptime_seconds: float, period_seconds: float, excluded_seconds: float = 0.0
) -> FormulaResult:
    """⚠ ASSUMED: time-based, computed from `device_health_events`.

    Grid outage and communication loss are excluded via `excluded_seconds` —
    which is why `reports_via_device_id` exists: without it, a failed Collector's
    silence is indistinguishable from equipment downtime and lands in the
    numerator as real unavailability (MASTER §3.4).

    The client may define this energy-based instead, which is a material
    difference rather than a rounding one.
    """
    denominator = period_seconds - excluded_seconds
    if denominator <= 0:
        return FormulaResult(None, AVAILABILITY_VARIANT, "period fully excluded")
    return FormulaResult(uptime_seconds / denominator, AVAILABILITY_VARIANT)


def co2_avoided_kg(
    energy_kwh: float, grid_factor_kg_per_kwh: float | None = None
) -> FormulaResult:
    """⚠ ASSUMED factor. Should come from `regions.grid_emission_factor_kg_per_kwh`.

    The default is the approximate CEA all-India grid average and is only a
    fallback for a Region with no factor recorded — grid intensity varies enough
    between Indian states to matter in a report.
    """
    factor = (
        grid_factor_kg_per_kwh
        if grid_factor_kg_per_kwh is not None
        else DEFAULT_GRID_EMISSION_FACTOR_KG_PER_KWH
    )
    variant = "region_factor" if grid_factor_kg_per_kwh is not None else "default_factor"
    return FormulaResult(energy_kwh * factor, f"co2_{variant}")


def energy_from_counter(
    first_value: float, last_value: float, *, rollover_maximum: float | None = None
) -> FormulaResult:
    """Energy over a period from a cumulative counter's endpoints.

    A decrease is either a rollover or a meter replacement. Those are
    indistinguishable in the data and opposite in meaning (MASTER §5.4), so this
    refuses to guess: without a stated `rollover_maximum` (OPEN-14) the result is
    undefined rather than silently wrong. A mishandled rollover produces one
    enormous negative energy value on the day it happens, with no earlier signal.
    """
    delta = last_value - first_value
    if delta >= 0:
        return FormulaResult(delta, "counter_delta")
    if rollover_maximum is None:
        return FormulaResult(
            None, "counter_delta", "counter decreased and no rollover maximum is known"
        )
    return FormulaResult(
        (rollover_maximum - first_value) + last_value, "counter_delta_rollover"
    )
