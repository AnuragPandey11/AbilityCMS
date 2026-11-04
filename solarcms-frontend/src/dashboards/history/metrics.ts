/**
 * What Performance History can colour a day by, and the arithmetic behind the
 * calendar — kept pure so the rules that make it honest are tested on their own.
 *
 * ── Three rules ─────────────────────────────────────────────────────────────
 * - **A day nothing measured has no colour.** It is drawn as an empty outline,
 *   never as the palest step of the scale, which would read as "a poor day"
 *   when nobody knows what the day was (Guardrail 23).
 * - **Best and worst exclude what was not measured whole.** A day with a third
 *   of its readings sits at the bottom of any ranking and is the Plant least
 *   in trouble rather than most; today is still running. Both are left out and
 *   counted (Guardrail 30).
 * - **A ratio outside what it can physically be is shown and marked**, never
 *   clamped into the scale (Guardrail 33), and it is kept out of the scale's
 *   own bounds so one impossible day cannot wash every other day pale.
 */

import type { HistoryDay, HistoryMonth } from "@/api/endpoints/history";

export type MetricKey =
  | "energy_kwh"
  | "specific_yield"
  | "performance_ratio"
  | "irradiation_kwh_m2"
  | "peak_power_kw"
  | "coverage";

export interface Metric {
  key: MetricKey;
  label: string;
  unit: string;
  digits: number;
  /** One line on what it means, for the picker and the legend. */
  hint: string;
  /** Whether higher is better — for "best day". Coverage and irradiation are not judgements of the Plant. */
  better: "higher" | null;
}

export const METRICS: Metric[] = [
  {
    key: "energy_kwh",
    label: "Energy",
    unit: "kWh",
    digits: 1,
    hint: "What the Plant made that day, from the same register the Energy figures use.",
    better: "higher",
  },
  {
    key: "specific_yield",
    label: "Specific yield",
    unit: "kWh/kWp",
    digits: 2,
    hint: "Energy per kWp of DC capacity — comparable between Plants of different sizes.",
    better: "higher",
  },
  {
    key: "performance_ratio",
    label: "PR",
    unit: "%",
    digits: 1,
    hint: "Energy against what the sunlight measured allows. Separates a dull day from a poorly performing Plant.",
    better: "higher",
  },
  {
    key: "irradiation_kwh_m2",
    label: "Irradiation",
    unit: "kWh/m²",
    digits: 2,
    hint: "The sunlight the Weather Stations measured (GHI). How bright the day was, not how the Plant did.",
    better: null,
  },
  {
    key: "peak_power_kw",
    label: "Peak power",
    unit: "kW",
    digits: 1,
    hint: "The highest 15-minute average of the Plant's power that day.",
    better: "higher",
  },
  {
    key: "coverage",
    label: "Coverage",
    unit: "%",
    digits: 0,
    hint: "The share of the day's 15-minute slots with a good reading. Low coverage makes every other figure low.",
    better: null,
  },
];

export function metricOf(key: MetricKey): Metric {
  return METRICS.find((metric) => metric.key === key) ?? METRICS[0]!;
}

/** A day under this share of its slots measured is marked partial and never ranked. */
export const PARTIAL_COVERAGE = 90;

type Row = Pick<HistoryDay, MetricKey> & { performance_ratio_flagged: boolean };

export function valueOf(row: Row | HistoryMonth, key: MetricKey): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Whether this figure of this day is outside what it can physically be. */
export function isFlagged(row: Row | HistoryMonth, key: MetricKey): boolean {
  return key === "performance_ratio" && row.performance_ratio_flagged;
}

export function isPartial(day: HistoryDay): boolean {
  return day.coverage !== null && day.coverage < PARTIAL_COVERAGE;
}

/**
 * Energy the period counted that no single day can claim: a register read on
 * either side of an outage across midnight steps once, and which day that
 * energy belongs to is not known (`report_tables.split_steps`). The period's
 * total includes it; the days do not — said beside the total, so the two
 * never look like they disagree for no reason.
 */
export function unattributedEnergy(total: number | null, days: HistoryDay[]): number | null {
  if (total === null) return null;
  const counted = days.reduce((sum, day) => sum + (day.energy_kwh ?? 0), 0);
  const rest = total - counted;
  return rest > Math.max(1, Math.abs(total) * 0.005) ? rest : null;
}

/** The scale's bounds: the measured, plausible values. Null when nothing was. */
export function scaleBounds(days: HistoryDay[], key: MetricKey): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const day of days) {
    const value = valueOf(day, key);
    if (value === null || isFlagged(day, key)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return Number.isFinite(min) ? { min, max } : null;
}

/**
 * Where a value sits on the scale, 0 (lowest measured) to 1 (highest).
 *
 * The scale starts at zero for a quantity that does, so a 40 kWh day beside
 * 400 kWh days looks like a tenth of one, not like the same day — unless every
 * day sits close together far from zero, when anchoring at zero would paint
 * them all one shade and hide the differences the calendar is for.
 */
export function shade(value: number, bounds: { min: number; max: number }): number {
  const anchored = bounds.min >= 0 && bounds.min < bounds.max * 0.5 ? 0 : bounds.min;
  const span = bounds.max - anchored;
  if (span <= 0) return 1;
  return Math.min(1, Math.max(0, (value - anchored) / span));
}

/** The lightest and darkest fill, as an alpha over the card — one hue, light to dark. */
export const SHADE_RANGE = { lightest: 0.14, darkest: 0.95 } as const;

export function fillAlpha(t: number): number {
  return SHADE_RANGE.lightest + (SHADE_RANGE.darkest - SHADE_RANGE.lightest) * t;
}

/** Which days are rankable for a metric, and how many were left out and why. */
export function rankable(days: HistoryDay[], key: MetricKey): {
  days: HistoryDay[];
  inProgress: number;
  partial: number;
  unmeasured: number;
  flagged: number;
} {
  let inProgress = 0;
  let partial = 0;
  let unmeasured = 0;
  let flagged = 0;
  const kept: HistoryDay[] = [];
  for (const day of days) {
    if (day.in_progress) inProgress += 1;
    else if (valueOf(day, key) === null) unmeasured += 1;
    else if (isFlagged(day, key)) flagged += 1;
    else if (isPartial(day)) partial += 1;
    else kept.push(day);
  }
  return { days: kept, inProgress, partial, unmeasured, flagged };
}

/** The best and worst whole, measured days by a metric that judges the Plant; null where it does not. */
export function bestAndWorst(
  days: HistoryDay[],
  key: MetricKey,
): { best: HistoryDay; worst: HistoryDay } | null {
  if (metricOf(key).better === null) return null;
  const { days: kept } = rankable(days, key);
  if (kept.length < 2) return null;
  const sorted = [...kept].sort((a, b) => (valueOf(a, key) ?? 0) - (valueOf(b, key) ?? 0) || a.date.localeCompare(b.date));
  return { best: sorted[sorted.length - 1]!, worst: sorted[0]! };
}

// ── The calendar's shape ─────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface CalendarMonth {
  key: string; // YYYY-MM
  title: string;
  /** Weeks Monday-first; a cell is a day of the period, a day outside it, or padding. */
  weeks: (CalendarCell | null)[][];
}

export interface CalendarCell {
  date: string;
  dayOfMonth: number;
  /** The day's row, where the period includes it; null for a day of the month outside the period. */
  day: HistoryDay | null;
}

/**
 * Each month the days touch, as Monday-first weeks. Days of the month outside
 * the period are cells without a row (drawn faint), so a period from the 10th
 * still reads as a month rather than as a ragged strip.
 */
export function calendarMonths(days: HistoryDay[]): CalendarMonth[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const keys = [...new Set(days.map((day) => day.date.slice(0, 7)))].sort();
  return keys.map((key) => {
    const [year, month] = key.split("-").map(Number) as [number, number];
    const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
    // getUTCDay: 0 Sunday … 6 Saturday → Monday-first offset.
    const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
    const cells: (CalendarCell | null)[] = Array.from({ length: lead }, () => null);
    for (let dayOfMonth = 1; dayOfMonth <= length; dayOfMonth += 1) {
      const date = `${key}-${String(dayOfMonth).padStart(2, "0")}`;
      cells.push({ date, dayOfMonth, day: byDate.get(date) ?? null });
    }
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: (CalendarCell | null)[][] = [];
    for (let index = 0; index < cells.length; index += 7) weeks.push(cells.slice(index, index + 7));
    return { key, title: `${MONTH_NAMES[month - 1]} ${year}`, weeks };
  });
}

/** `DD-MM-YYYY` for a `YYYY-MM-DD`, the platform's display order (tender §28). */
export function displayDate(date: string): string {
  const [year, month, day] = date.split("-");
  return year && month && day ? `${day}-${month}-${year}` : date;
}

/** `March 2026` for `2026-03`. */
export function displayMonth(month: string): string {
  const [year, index] = month.split("-").map(Number) as [number, number];
  return MONTH_NAMES[index - 1] ? `${MONTH_NAMES[index - 1]} ${year}` : month;
}

// ── Against another period ───────────────────────────────────────────────────

/**
 * The change from `previous` to `current`, in the metric's own terms: a
 * relative change for a quantity, a difference in points for a percentage —
 * "PR +3.1 points", never "+4.0%" of a percentage. Null where either is unknown
 * or the base is zero.
 */
export function change(
  current: number | null,
  previous: number | null,
  unit: string,
): { value: number; kind: "relative" | "points" } | null {
  if (current === null || previous === null) return null;
  if (unit === "%") return { value: current - previous, kind: "points" };
  if (previous === 0) return null;
  return { value: (current - previous) / Math.abs(previous), kind: "relative" };
}

/**
 * The comparison's days laid on the current period's dates, day *n* on day *n*
 * — the only alignment two periods of different months share. Where the
 * comparison is shorter (February against March) the last days have none.
 */
export function alignByIndex<T>(current: { date: string }[], other: T[]): { date: string; other: T | null }[] {
  return current.map((day, index) => ({ date: day.date, other: other[index] ?? null }));
}
