/**
 * Value formatting.
 *
 * The rule that governs this file: **the unit comes from the API and is rendered
 * verbatim** (§4.1, Guardrail 2). No conversion, no scaling, no inference from a
 * Tag's name. The client's own schedule mixes kWh and MWh inside one Device and
 * labels an Inverter current in kV; converting client-side would turn a
 * documented oddity into a silent factor-of-1000 error. Conversion is a backend
 * decision that has not been made yet (OPEN-15).
 */

import type { Tag } from "@/api/schemas";

/** Rendered wherever a figure is undefined. Never "0". */
export const UNDEFINED_DISPLAY = "—";

function significantDigits(magnitude: number): number {
  if (magnitude === 0) return 2;
  if (magnitude >= 1000) return 0;
  if (magnitude >= 100) return 1;
  if (magnitude >= 1) return 2;
  return 3;
}

/**
 * A bare number, grouped, at a sensible precision. `null` is undefined, and
 * undefined is not zero (§4.3, Guardrail 3).
 */
export function formatNumber(
  value: number | null | undefined,
  options: { digits?: number } = {},
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNDEFINED_DISPLAY;
  }
  const digits = options.digits ?? significantDigits(Math.abs(value));
  return value.toLocaleString("en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * A value with its unit. `unit` must have come from `/catalog/tags` or a
 * Device's bindings — there is no default, deliberately.
 */
export function formatValue(
  value: number | null | undefined,
  unit: string | null | undefined,
  options: { digits?: number } = {},
): string {
  const rendered = formatNumber(value, options);
  if (rendered === UNDEFINED_DISPLAY) return rendered;
  return unit ? `${rendered} ${unit}` : rendered;
}

/**
 * A Digital Input is not a number (§4.5). Roughly a third of Tags are DI, and
 * the whole of VCB and TRANSFORMER is. Rendered as state, never as a quantity.
 */
export function formatDigital(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNDEFINED_DISPLAY;
  }
  return value === 0 ? "OFF" : "ON";
}

export function isDigital(tag: Pick<Tag, "category"> | null | undefined): boolean {
  return tag?.category === "status";
}

/** Format against a Tag, which is the only object that knows the unit. */
export function formatForTag(
  value: number | null | undefined,
  tag: Tag | null | undefined,
): string {
  if (!tag) return formatNumber(value);
  if (isDigital(tag)) return formatDigital(value);
  return formatValue(value, tag.unit);
}

/**
 * A ratio the backend expresses as 0..1, shown as a percentage.
 *
 * `null` stays `—`. PR is undefined at night; 0% drags every average down and
 * tells an operator their Plant failed.
 */
export function formatRatioAsPercent(
  value: number | null | undefined,
  digits = 1,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNDEFINED_DISPLAY;
  }
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * A KPI whose `value` may be null. Ratios (PR, CUF, availability) come back as
 * 0..1; energy and CO2 come back in their own units.
 */
export function formatKpi(
  value: number | null | undefined,
  kind: "ratio" | "quantity",
  unit?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNDEFINED_DISPLAY;
  }
  return kind === "ratio" ? formatRatioAsPercent(value) : formatValue(value, unit);
}

/**
 * A capacity figure. The column names carry the unit (`ac_capacity_kw`,
 * `dc_capacity_kwp`), so it is stated rather than guessed.
 */
export function formatCapacity(
  value: number | null | undefined,
  unit: "kW" | "kWp",
): string {
  return formatValue(value, unit, { digits: value !== null && Math.abs(value ?? 0) >= 1000 ? 0 : 1 });
}

/** Compact axis/tile rendering for large counts. Never used for a unit value. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNDEFINED_DISPLAY;
  }
  return Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 })
    .format(value);
}

/**
 * A one-line note naming the provisional formula behind a figure.
 *
 * Every KPI is provisional until the client supplies theirs and figures will be
 * recomputed; a UI that presents them as settled makes that correction look like
 * a defect (§4.3, OPEN-16).
 */
export function variantNote(variant: string | null | undefined): string {
  const label = variant ? variant.replace(/_/g, " ") : "unspecified";
  return `${label} — provisional pending OPEN-16`;
}
