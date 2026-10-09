/**
 * Ranking the Inverter ranking: which Inverter is first, which is last, and
 * what the column totals are. Pure, so the rules are tested rather than eyed.
 *
 * Four rules:
 *
 * - **Rank only within a variant** (OPEN-13, Guardrail 9). A central and a
 *   string Inverter have different Tag sets and different expected outputs, so
 *   ranking across them is meaningless — the same rule the rest of Inverter
 *   Monitoring keeps. An Inverter with no variant is ordered, never ranked.
 * - **An Inverter without the figure is not ranked last.** An undefined PR is
 *   not a low PR (Guardrail 30): it is listed after the ranked ones, unranked,
 *   with the reason the server gave.
 * - **A tie on the measure breaks on a second one, stated** — availability,
 *   downtime and loss then generation; generation and PR then availability. On
 *   a healthy day every Inverter is 100% available, and seventeen joint firsts
 *   identify nothing; the subtitle names the second measure so the order is
 *   never a mystery. Only a tie on both shares a rank (1, 2, 2, 4), and then
 *   breaks by code for the display order alone — INVERTER_2 before
 *   INVERTER_10, because people count.
 * - **Totals say when they are partial.** A sum that skipped an Inverter with
 *   no figure is still a sum, and reads as a smaller one; the count skipped
 *   travels with it.
 */

import type { RankedInverterRow } from "@/api/schemas";

export type RankMeasure = "pr" | "availability" | "downtime" | "loss" | "generation";

export interface MeasureSpec {
  label: string;
  /** Which way is better: the first-ranked Inverter has the most, or the least. */
  better: "higher" | "lower";
  value: (row: RankedInverterRow) => number | null;
  hint: string;
  /** What breaks a tie on this measure. */
  then: RankMeasure;
}

export const MEASURES: Record<RankMeasure, MeasureSpec> = {
  pr: {
    label: "PR",
    better: "higher",
    value: (row) => row.performance_ratio.value,
    hint:
      "Energy over the sunlight the panels received, per kWp — comparable between Inverters of different sizes. Needs each Inverter's DC size.",
    then: "availability",
  },
  availability: {
    label: "Availability",
    better: "higher",
    value: (row) => row.availability.value,
    hint: "The share of generating time it was producing, while the others were generating.",
    then: "generation",
  },
  downtime: {
    label: "Downtime",
    better: "lower",
    value: (row) => row.downtime_hours,
    hint: "Hours it stood still while the others were generating.",
    then: "generation",
  },
  loss: {
    label: "Energy lost",
    better: "lower",
    value: (row) => row.lost_kwh.value,
    hint: "The energy its stops cost. Needs each Inverter's DC size.",
    then: "generation",
  },
  generation: {
    label: "Generation",
    better: "higher",
    value: (row) => row.generation_kwh,
    hint: "Like-for-like only between Inverters of the same size; PR compares across sizes.",
    then: "availability",
  },
};

export const MEASURE_ORDER: RankMeasure[] = ["pr", "availability", "downtime", "loss", "generation"];

export interface RankedRow {
  row: RankedInverterRow;
  /** 1 is best. Null: not ranked — no figure, or no variant recorded. */
  rank: number | null;
}

export interface RankedGroup {
  /** `string`, `central`, or `unspecified` where no variant is recorded. */
  variant: string;
  /** False for `unspecified`: an order, not a like-for-like rank. */
  ranked: boolean;
  rows: RankedRow[];
  /** How many have the measure — what the ranks run up to. */
  measured: number;
}

const VARIANT_ORDER = ["string", "central"];

/** INVERTER_2 before INVERTER_10. */
export const byCode = (a: RankedInverterRow, b: RankedInverterRow): number =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

/** PR where any Inverter has one, else availability — which needs no sizes. */
export function defaultMeasure(rows: RankedInverterRow[]): RankMeasure {
  return rows.some((row) => row.performance_ratio.value !== null) ? "pr" : "availability";
}

export function rankWithinVariants(
  rows: RankedInverterRow[],
  measure: RankMeasure,
): RankedGroup[] {
  const spec = MEASURES[measure];
  const groups = new Map<string, RankedInverterRow[]>();
  for (const row of rows) {
    const variant = row.variant ?? "unspecified";
    const members = groups.get(variant);
    if (members) members.push(row);
    else groups.set(variant, [row]);
  }

  const tie = MEASURES[spec.then];
  const sign = (which: MeasureSpec) => (which.better === "higher" ? -1 : 1);
  /** Better first on the measure, then on the tie-break; a missing tie-break goes after. */
  const compare = (a: RankedInverterRow, b: RankedInverterRow): number => {
    const first = sign(spec) * ((spec.value(a) as number) - (spec.value(b) as number));
    if (first !== 0) return first;
    const left = tie.value(a);
    const right = tie.value(b);
    if (left !== null && right !== null && left !== right) return sign(tie) * (left - right);
    if (left === null && right !== null) return 1;
    if (right === null && left !== null) return -1;
    return 0;
  };

  const out: RankedGroup[] = [];
  for (const [variant, members] of groups) {
    const ranked = variant !== "unspecified";
    const valued = members.filter((row) => spec.value(row) !== null);
    valued.sort((a, b) => compare(a, b) || byCode(a, b));
    const rankedRows: RankedRow[] = [];
    let previous: RankedInverterRow | null = null;
    let previousRank = 0;
    valued.forEach((row, index) => {
      const rank = previous !== null && compare(previous, row) === 0 ? previousRank : index + 1;
      previous = row;
      previousRank = rank;
      rankedRows.push({ row, rank: ranked ? rank : null });
    });
    const unvalued = members
      .filter((row) => spec.value(row) === null)
      .sort(byCode)
      .map((row) => ({ row, rank: null }));
    out.push({ variant, ranked, rows: [...rankedRows, ...unvalued], measured: valued.length });
  }

  const order = (variant: string) => {
    const at = VARIANT_ORDER.indexOf(variant);
    if (variant === "unspecified") return VARIANT_ORDER.length + 1;
    return at === -1 ? VARIANT_ORDER.length : at;
  };
  return out.sort((a, b) => order(a.variant) - order(b.variant) || a.variant.localeCompare(b.variant));
}

/** A column total, and how many Inverters it had to leave out. */
export interface Total {
  value: number | null;
  missing: number;
}

function total(rows: RankedInverterRow[], pick: (row: RankedInverterRow) => number | null): Total {
  let sum = 0;
  let counted = 0;
  for (const row of rows) {
    const value = pick(row);
    if (value === null) continue;
    sum += value;
    counted += 1;
  }
  return { value: counted > 0 ? sum : null, missing: rows.length - counted };
}

export interface RankingTotals {
  generationKwh: Total;
  downtimeHours: Total;
  stops: number;
  lostKwh: Total;
  lossInr: Total;
  /** Inverters whose PR and loss wait on a DC size. */
  unsized: number;
}

export function totals(rows: RankedInverterRow[]): RankingTotals {
  return {
    generationKwh: total(rows, (row) => row.generation_kwh),
    downtimeHours: total(rows, (row) => row.downtime_hours),
    stops: rows.reduce((sum, row) => sum + row.stop_count, 0),
    lostKwh: total(rows, (row) => row.lost_kwh.value),
    lossInr: total(rows, (row) => row.loss_inr.value),
    unsized: rows.filter((row) => row.dc_capacity_kwp === null).length,
  };
}
