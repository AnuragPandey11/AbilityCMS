/**
 * Fleet arithmetic — the rules for combining per-Plant figures into one number.
 *
 * **Portfolio is computed, never stored** (MASTER §1.1). There is no
 * `/portfolio` endpoint and there should not be: these functions sum what
 * `/plants` returns and what each Plant answered for its own KPIs. Keeping the
 * rules here rather than inline in a component is what lets them be tested
 * against the cases that actually go wrong, which are all about Plants that
 * cannot answer at all.
 */

import type { KpiCoverage, KpiFigure, PlantKpis } from "@/api/schemas";

export interface FleetEntry {
  figure: KpiFigure | undefined;
  /** Capacity, for weighting. */
  weight: number;
  /** That Plant's coverage, which says whether it could answer at all. */
  coverage?: KpiCoverage | null;
}

/**
 * Did this Plant have anything to report in the period?
 *
 * ⚠ This is the load-bearing check, and it is not the same as "is the figure
 * null". A Plant with **no Devices** answers `availability: 0.0` — a real
 * number, not a null — and averaging that into a fleet mean is how three
 * Plants, one healthy and two not yet commissioned, reported **52.6% fleet
 * availability**. Nothing was down. Nothing was even connected.
 *
 * `expected_samples === 0` is the backend stating that nothing was due, which
 * is the one thing that distinguishes "not instrumented" from "instrumented
 * and silent". A Plant that expected nothing gets no vote; a Plant that
 * expected readings and received none keeps its vote, because that is a real
 * and terrible 0.
 */
export function couldAnswer(coverage: KpiCoverage | null | undefined): boolean {
  // Absent coverage means an older API that does not report it. Assume the
  // Plant counts, which is the previous behaviour — a silent change in what
  // the fleet number means is worse than an unimproved one.
  if (!coverage) return true;
  return coverage.expected_samples > 0;
}

/**
 * A capacity-weighted mean of a fleet-wide ratio.
 *
 * Weighted, not arithmetic: a 2 MW Plant and a 200 MW Plant do not contribute
 * equally to fleet performance, and an unweighted mean lets a small outlier
 * dominate. Plants whose figure is undefined are excluded from both sides of
 * the fraction rather than counted as zero (§4.3), and so are Plants that were
 * never due to report.
 */
export function weightedRatio(entries: FleetEntry[]): KpiFigure {
  let numerator = 0;
  let denominator = 0;
  let variant: string | null = null;
  let defined = 0;
  let excludedNotInstrumented = 0;

  for (const entry of entries) {
    if (!couldAnswer(entry.coverage)) {
      excludedNotInstrumented += 1;
      continue;
    }
    const value = entry.figure?.value;
    if (value === null || value === undefined || entry.weight <= 0) continue;
    numerator += value * entry.weight;
    denominator += entry.weight;
    variant = entry.figure?.variant ?? variant;
    defined += 1;
  }

  if (denominator === 0) {
    return {
      value: null,
      variant,
      undefined_reason:
        excludedNotInstrumented > 0 && defined === 0
          ? `No active Plant reported a defined figure for this period. ${excludedNotInstrumented} Plant(s) have no Devices bound, so nothing was expected of them.`
          : defined === 0
            ? "No active Plant reported a defined figure for this period."
            : "No Plant with a defined figure has a capacity to weight it by.",
    };
  }
  return { value: numerator / denominator, variant, undefined_reason: null };
}

/**
 * A fleet total of a quantity — energy, CO₂.
 *
 * Summed rather than averaged, and a Plant that could not answer contributes
 * nothing rather than being excluded: zero energy from an uncommissioned Plant
 * is arithmetically correct for a *total*, where it is nonsense for a *mean*.
 * That asymmetry is the whole reason these are two functions.
 */
export function fleetTotal(values: (number | null | undefined)[]): number {
  let total = 0;
  for (const value of values) {
    if (value === null || value === undefined || !Number.isFinite(value)) continue;
    total += value;
  }
  return total;
}

/**
 * Which grid factor stands behind the fleet's CO₂ figure.
 *
 * CO₂ avoided is energy × the Plant's Region factor, and a Plant with no Region
 * — or a Region with no factor recorded — falls back to the national default.
 * The API says which happened in `variant`, and the tile must repeat it: when
 * every Plant falls back, CO₂ is energy times one constant, so its per-Plant
 * split is the energy split exactly, and a footer claiming "each Region's
 * factor" makes that look like a coincidence rather than a missing setting.
 *
 * Only Plants with a defined figure count, because only they are in the total.
 * Fallbacks are named, since each is one Region assignment away from fixed.
 */
export interface Co2FactorBasis {
  regional: number;
  fallback: string[];
}

export function co2FactorBasis(
  entries: { code: string; figure: KpiFigure | undefined }[],
): Co2FactorBasis {
  const basis: Co2FactorBasis = { regional: 0, fallback: [] };
  for (const { code, figure } of entries) {
    if (figure?.value === null || figure?.value === undefined) continue;
    // Anything else — a null or unknown variant from an older API — makes no
    // claim either way, so it counts as neither.
    if (figure.variant === "co2_region_factor") basis.regional += 1;
    else if (figure.variant === "co2_default_factor") basis.fallback.push(code);
  }
  return basis;
}

/** How many Plants were in a position to report, and how many were not. */
export function instrumentedSplit(
  kpis: (PlantKpis | undefined)[],
): { instrumented: number; notInstrumented: number; pending: number } {
  let instrumented = 0;
  let notInstrumented = 0;
  let pending = 0;
  for (const kpi of kpis) {
    if (!kpi) {
      pending += 1;
      continue;
    }
    if (couldAnswer(kpi.coverage)) instrumented += 1;
    else notInstrumented += 1;
  }
  return { instrumented, notInstrumented, pending };
}
