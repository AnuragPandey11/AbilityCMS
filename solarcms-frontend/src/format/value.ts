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

import type { KpiPeriod, Tag } from "@/api/schemas";

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
 * How many decimals a unit deserves, where the unit itself settles it.
 *
 * The default rule is magnitude-based, which is right for a measurement and
 * wrong for a tally: `significantDigits(0)` is 2, so a count of zero open
 * Alarms rendered as **"0.00"** and seventeen Inverters as "17.00 count". A
 * fractional part on a count is not a rounding choice, it is a category error —
 * there is no such thing as 0.4 of an Alarm, and the two extra digits invite
 * the reader to look for a precision that does not exist.
 *
 * `ratio` is power factor — every Tag in that unit is one — and is shown to two
 * decimals everywhere (the client's choice, 8 Oct 2026): `0.99`, never
 * `0.988`. The magnitude rule would give it three, which is why it is stated.
 *
 * Returns `undefined` for every other unit, meaning "use the magnitude rule".
 */
export function digitsForUnit(unit: string | null | undefined): number | undefined {
  if (unit === "count") return 0;
  if (unit === "ratio") return 2;
  return undefined;
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
  const rendered = formatNumber(value, {
    digits: options.digits ?? digitsForUnit(unit),
  });
  if (rendered === UNDEFINED_DISPLAY) return rendered;
  return unit ? `${rendered} ${unit}` : rendered;
}

/**
 * A Digital Input is not a number (§4.5). Roughly a third of Tags are DI, and
 * the whole of VCB is. Rendered as state, never as a quantity.
 */
export function formatDigital(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return UNDEFINED_DISPLAY;
  }
  return value === 0 ? "OFF" : "ON";
}

/**
 * Whether a Tag is a two-state contact — decided by its unit, `bool`.
 *
 * ⚠ Not by category. `status` is the category of everything that must never
 * be throttled, and that is wider than contacts: the PPC's five setpoints (kW,
 * kVAr, kV, a ratio, Hz) and `DEVICE_STATUS` (a code) are `status` too. Keyed
 * on category, a 4,800 kW Active Power Setpoint rendered as "ON" and could not
 * be charted. Every Digital Input is catalogued in `bool` (`assumptions._di`).
 */
export function isDigital(tag: { unit: string | null } | null | undefined): boolean {
  return tag?.unit === "bool";
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
  // ⚠ Uppercased, for the same reason `formatHeadline` uppercases: `en-GB`
  // compact notation emits a lowercase `k`/`m`, and `1.5m kWh` reads as
  // *milli*-something to exactly the audience this is for. This function feeds
  // chart axis ticks, where the suffix sits right beside the unit name.
  return Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 })
    .format(value)
    .toUpperCase();
}

/**
 * Above this magnitude a headline figure is rendered compactly.
 *
 * A million, not a hundred thousand, and the reason is the suffix rather than
 * the width: compacting at 100,000 produces `100k`, and a lowercase `k` sitting
 * next to `kWh` is one character away from the unit it is not. Starting at a
 * million means the only suffixes ever produced are M, B and T — none of which
 * collides with an SI prefix the client's schedule uses.
 *
 * `999,999` still renders in full at seven characters, which fits every tile in
 * the app at full type size. Below the threshold nothing changes at all, so the
 * common case — a power reading, a percentage, a Device count — is untouched.
 */
export const COMPACT_ABOVE = 1_000_000;

/**
 * A headline figure for a tile.
 *
 * ⚠ **This is a change of numeral, never a change of unit.** `1,241,466 kWh`
 * becomes `1.24M kWh` — still kWh, with the unit string the API supplied passed
 * through untouched. It must never become `1,241.47 MWh`: rescaling a value
 * against a unit the backend did not state is the factor-of-1000 error §4.1 and
 * Guardrail 2 exist to prevent, and the client's own schedule already mixes kWh
 * and MWh inside a single Device (OPEN-15).
 *
 * The exact value travels alongside so the caller can put it on the tooltip. A
 * compacted figure is a *rounded* one, and an operator quoting a number in a
 * support conversation needs the digits.
 */
export function formatHeadline(
  value: number | null | undefined,
  options: { digits?: number } = {},
): { text: string; exact: string; compacted: boolean } {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return { text: UNDEFINED_DISPLAY, exact: UNDEFINED_DISPLAY, compacted: false };
  }
  const exact = formatNumber(value, options);
  if (Math.abs(value) < COMPACT_ABOVE) {
    return { text: exact, exact, compacted: false };
  }
  // Two fraction digits, so a fleet total keeps three significant figures
  // (`1.24M`) rather than collapsing to `1.2M` and losing 40,000 kWh of
  // resolution on a screen somebody reads as a daily total.
  //
  // ⚠ Uppercased, because `en-GB` compact notation emits a lowercase `m` and
  // `1.24m kWh` reads as *milli*-something to exactly the audience this is for.
  const text = Intl.NumberFormat("en-GB", {
    notation: "compact",
    maximumFractionDigits: 2,
  })
    .format(value)
    .toUpperCase();
  return { text, exact, compacted: true };
}

/**
 * A ratio that is outside anything the physical quantity can be.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `/plants/{id}/kpis?period=month` returned a Performance Ratio of **3.89** —
 * 389%. A PR is energy out over energy available, so it cannot meaningfully
 * exceed 1; 3.89 means the numerator and the denominator were measured over
 * different spans. On this Plant that is exactly what happened: a month of
 * Inverter energy divided by irradiance the weather station only reported for
 * 15% of it.
 *
 * The figure is **not corrected and not hidden**. Correcting it would invent
 * data, and hiding it would conceal the gap that produced it — the same stance
 * the platform already takes on out-of-range readings, which are stored and
 * flagged rather than discarded (Guardrail 4). It is flagged, so nobody reads
 * 389% as a result.
 *
 * ⚠ The ceiling is deliberately loose. A PR slightly above 1 is physically real
 * in cold, bright conditions — modules outperform their 25 °C nameplate — so a
 * tight bound would flag good data. 1.2 is well past anything weather explains
 * and well below the order-of-magnitude errors a coverage mismatch produces.
 */
export const RATIO_PLAUSIBLE_MAX = 1.2;

export function ratioIsImplausible(value: number | null | undefined): boolean {
  if (value === null || value === undefined || !Number.isFinite(value)) return false;
  return value < 0 || value > RATIO_PLAUSIBLE_MAX;
}

/** Why a ratio is being flagged, in words an operator can act on. */
export function implausibleRatioReason(value: number, label = "This figure"): string {
  return (
    `${label} is ${formatRatioAsPercent(value)}, which is outside the range the quantity ` +
    `can physically take. It almost always means the numerator and the denominator were ` +
    `measured over different spans — a period of generation divided by irradiance that was ` +
    `only recorded for part of it. Check the coverage beside it. The figure is shown ` +
    `unaltered: correcting it would invent data, and hiding it would conceal the gap.`
  );
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

/** Where a period's calendar hours begin, in words. */
const HOURS_SINCE: Record<KpiPeriod, string> = {
  today: "midnight",
  month: "the 1st",
  year: "the year began",
  lifetime: "the first reading",
};

/**
 * A formula variant in words, for the footnote of the tile showing it.
 *
 * The codes are identifiers, and with the underscores swapped for spaces they
 * read as jargon ("poa uncorrected"). This says what each one means. An
 * unknown code falls back to that swap rather than to nothing: a new variant
 * must still be named (OPEN-16). `measuredLater` is a Plant younger than the
 * period, whose CUF hours count from its first reading instead.
 */
export function variantWords(
  variant: string | null | undefined,
  period: KpiPeriod,
  measuredLater = false,
): string | null {
  if (!variant) return null;
  switch (variant) {
    case "poa_uncorrected":
      return "plane-of-array irradiance, not temperature-corrected";
    case "ac_capacity_calendar_hours":
      return `AC capacity, every hour since ${measuredLater ? "the first reading" : HOURS_SINCE[period]}`;
    case "time_based_excluding_comms":
      return "time-weighted; comms loss not counted as downtime";
    default:
      return variant.replace(/_/g, " ");
  }
}
