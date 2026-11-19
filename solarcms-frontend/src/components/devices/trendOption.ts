/**
 * A Device's Tag as one entry on a `LanedTrendChart` menu — the shared step
 * from "a position filled with a Tag" to "a reading the chart can draw".
 *
 * A contact (unit `bool`, `format/value.isDigital` — never `category ===
 * "status"`, which also covers a 4,800 kW setpoint) is drawn as steps; every
 * other Tag as a line. The unit is the catalogue's, verbatim, so the chart
 * groups plots by what the catalogue says and not by what a screen prints.
 */

import type { Tag } from "@/api/schemas";
import { isDigital } from "@/format/value";
import type { TrendLaneOption } from "@/components/charts/LanedTrendChart";
import type { Filled } from "./InverterView";
import type { DeviceTrends } from "./useDeviceTrends";

/**
 * Whether a reading beyond a screen's essentials belongs on its menu: the
 * Device reported it recently, or is bound to it (so it is merely quiet and
 * its history is worth reading). A catalogue Tag the Device has nothing to do
 * with is left off — `fillPosition` still hands back the catalogue's Tag for
 * it, and listing every one would be a menu of readings that draw nothing.
 */
export function isReported(filled: Filled, codes: readonly string[], bound: Set<string> | null): boolean {
  return filled.value !== null || (bound !== null && codes.some((code) => bound.has(code)));
}

export function deviceTrendOption({
  key,
  label,
  tag,
  reason,
  trends,
  provenance,
  markPeak,
  slot,
  colorToken,
  description,
}: {
  key: string;
  label: string;
  tag: Tag | undefined;
  /** Why there is no Tag, where there is none (Guardrail 26). */
  reason: string | null;
  trends: DeviceTrends;
  provenance?: string | null;
  markPeak?: boolean;
  slot?: number;
  colorToken?: "accent" | "neutral";
  description?: string;
}): TrendLaneOption {
  if (!tag) {
    return {
      key,
      label,
      unit: null,
      kind: "analog",
      unavailableReason: reason ?? "Nothing is recorded for this reading here.",
      flaggedCount: 0,
      tier: trends.tier,
    };
  }
  if (isDigital(tag)) {
    const state = trends.stateOf(tag);
    return {
      key,
      label,
      unit: tag.unit,
      kind: "state",
      state,
      flaggedCount: state.flaggedCount,
      tier: trends.tier,
      pending: trends.pendingOf(tag),
      description: description ?? "TRUE or FALSE, as the equipment sent it",
    };
  }
  const series = trends.seriesOf(tag);
  return {
    key,
    label,
    unit: tag.unit,
    kind: "analog",
    points: series.points,
    flaggedCount: series.flaggedCount,
    tier: trends.tier,
    pending: trends.pendingOf(tag),
    provenance,
    markPeak,
    slot,
    colorToken,
    description,
  };
}
