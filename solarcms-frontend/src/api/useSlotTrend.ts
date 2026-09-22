/**
 * The history behind a dashboard slot.
 *
 * ── Why this reads the slot rather than naming a Tag ────────────────────────
 * A tile on the dashboard says 6.32 MW, and *which* Device answered that is a
 * decision the server made: it planned the slot against what this Plant is
 * actually bound to and picked the first candidate that answered (`domain/
 * slots.py`). On one Plant that is a settlement meter; on another it is the sum
 * of twelve Inverters. Those are different claims, which is why provenance
 * travels with the value.
 *
 * A trend chart under that tile has to be the *same* claim, or the screen shows
 * a figure measured at the meter above a curve summed from the Inverters and
 * invites somebody to read the difference as a loss. So this hook does not name
 * a Device Type or a Tag. It reads the slot the server already resolved, takes
 * the `source` off it, and asks `/readings` for exactly that — same Device
 * Type, same Tag, same aggregate, same provenance string.
 *
 * The consequence worth knowing: when a Plant cannot answer a slot, this
 * returns no series rather than falling back to something else. That is
 * deliberate. A fallback would be this file inventing a resolution rule, which
 * is the thing the slot catalogue exists to prevent.
 *
 * ⚠ It aggregates **across Devices**, never across time. Each bucket already
 * carries the tier's own roll-up (`domain/tiering`), chosen from the Tag's
 * `rollup_method`; combining seventeen Inverters at one instant is a different
 * operation from combining one Inverter over an hour, and only the first
 * belongs here.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import * as readingsApi from "./endpoints/readings";
import { usePlantDashboard, usePlantDevices, useTags } from "./hooks";
import type { ReadingPoint, ResolvedSlot, Tier } from "./schemas";

/** How far back a trend looks, and which tier can serve it. */
export type TrendRange = "24h" | "7d" | "30d";

export const TREND_RANGES: { value: TrendRange; label: string; hint: string }[] = [
  { value: "24h", label: "24h", hint: "The last day, in 15-minute buckets." },
  { value: "7d", label: "7d", hint: "The last week, hourly." },
  { value: "30d", label: "30d", hint: "The last month, daily." },
];

/**
 * The tier each range asks for.
 *
 * Named rather than left on `auto` because the point cap is per *request* and
 * counts Devices × Tags × buckets: seventeen Inverters over a day at the raw
 * tier is 24,480 points and the server refuses it with a 422. Asking for the
 * tier the range actually needs turns a failed request into a correct one.
 *
 * Every tier runs with real-time aggregation on (migration 0023), so a coarser
 * tier costs resolution but not freshness.
 */
const TIER_FOR: Record<TrendRange, Tier> = {
  "24h": "agg_15m",
  "7d": "agg_1h",
  "30d": "agg_1d",
};

const HOURS_FOR: Record<TrendRange, number> = { "24h": 24, "7d": 24 * 7, "30d": 24 * 30 };

export interface TrendPoint {
  /** ISO bucket start, as the server sent it. */
  at: string;
  /** null where no Device of the source type reported in this bucket. */
  value: number | null;
  /** How many Devices contributed. Below `deviceCount`, the bucket is partial. */
  contributors: number;
}

export interface SlotTrend {
  points: TrendPoint[];
  /**
   * Readings that arrived in this window but were **not plotted**, because
   * their quality code was non-zero (§4.2, Guardrail 4).
   *
   * Surfacing the count is the whole point. A flagged reading is stored and
   * flagged, never discarded — but it is also not drawn as data, so a window
   * where every value was out of range produces an *empty chart*, which reads
   * as "the sensor sent nothing". Those are opposite diagnoses: one is a dead
   * datalogger, the other is a sensor reporting −3 W/m² all night. Without this
   * the screen cannot tell them apart, and neither can the operator.
   */
  flaggedCount: number;
  /** Verbatim from the catalogue — never derived from the Tag's name (§4.1). */
  unit: string | null;
  label: string;
  /** The tier that actually served it, for the caller to state (§9). */
  tier: Tier | null;
  /** `sum of 17 Inverters`, `MFM` — the same claim the tile above makes. */
  provenance: string | null;
  /** The slot resolved, but this Plant has nothing bound that can answer it. */
  unavailableReason: string | null;
  isLoading: boolean;
  isError: boolean;
}

/** Combine one bucket's Devices the way the slot says to. */
function combine(values: number[], aggregate: string): number | null {
  if (values.length === 0) return null;
  switch (aggregate) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "avg":
      return values.reduce((total, value) => total + value, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    // `first` is the single-Device case — a meter, a plant attribute. With one
    // contributor every aggregate agrees, so this only matters if a Plant has
    // two of something the catalogue expected one of.
    case "first":
    case "last":
    default:
      return values[0] ?? null;
  }
}

function provenanceOf(slot: ResolvedSlot | undefined): string | null {
  const source = slot?.source;
  if (!source) return null;
  if (source.kind === "plant_attribute") return "Plant record";
  if (!source.is_aggregated) return source.device_type_code ?? null;
  return `${source.aggregate} of ${source.device_count} ${source.device_type_code ?? "Device"}`;
}

export function useSlotTrend(
  plantId: number | null,
  slotCode: string,
  range: TrendRange,
): SlotTrend {
  const dashboardQuery = usePlantDashboard(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const tagsQuery = useTags();

  // The slot, wherever the server put it. Panels are keyed by panel code and a
  // caller should not have to know which panel holds `kpi.current_power`.
  const slot = useMemo(() => {
    const panels = dashboardQuery.data?.panels;
    if (!panels) return undefined;
    for (const slots of Object.values(panels)) {
      const found = slots.find((candidate) => candidate.slot_code === slotCode);
      if (found) return found;
    }
    return undefined;
  }, [dashboardQuery.data, slotCode]);

  const source = slot?.source ?? null;
  const tag = tagsQuery.data?.find((candidate) => candidate.code === source?.tag_code);

  // Every Device of the type the slot resolved to. Not "every Device that has
  // the Tag": the slot named a *type*, and widening it here would make the
  // curve include equipment the tile excluded.
  const deviceIds = useMemo(() => {
    if (!source?.device_type_code) return [];
    return (devicesQuery.data ?? [])
      .filter((device) => device.type_code === source.device_type_code)
      .map((device) => device.id)
      .sort((a, b) => a - b);
  }, [devicesQuery.data, source?.device_type_code]);

  // Anchored to the top of the current minute rather than to `Date.now()`, so
  // the query key is stable for 60 seconds. Unanchored, every render produces a
  // new `to` and therefore a new cache entry — the chart would refetch on each
  // paint and never hit cache once.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const to = new Date(now).toISOString();
  const from = new Date(now - HOURS_FOR[range] * 3_600_000).toISOString();
  const tier = TIER_FOR[range];

  const query: readingsApi.ReadingsQuery = {
    deviceIds,
    tagIds: tag ? [tag.id] : [],
    from,
    to,
    resolution: tier,
  };
  const enabled = deviceIds.length > 0 && tag !== undefined;

  const readingsQuery = useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    enabled,
    // A 422 here is the point cap, and retrying repeats it exactly.
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    // The previous curve stays on screen while the next one loads, rather than
    // the panel dropping back to a skeleton every minute.
    placeholderData: (previous) => previous,
  });

  const { points, flaggedCount } = useMemo<{ points: TrendPoint[]; flaggedCount: number }>(() => {
    const items = readingsQuery.data?.items;
    if (!items || !source) return { points: [], flaggedCount: 0 };
    let flagged = 0;
    // Bucket → the Devices that reported in it. A Map preserves insertion
    // order, and the server returns buckets ascending, so no sort is needed.
    const byBucket = new Map<string, number[]>();
    for (const point of items as ReadingPoint[]) {
      // A flagged value is not plotted as data (§4.2, Guardrail 4). Dropping it
      // from the bucket is right here rather than re-drawing it in the quality
      // colour, which is what the detailed chart does: this is an aggregate
      // across Devices, and one denormalised float inside a `sum` would move
      // the whole curve with nothing on screen to say so.
      if (point.quality !== null && point.quality !== 0) {
        flagged += 1;
        continue;
      }
      if (point.value === null) continue;
      const bucket = byBucket.get(point.bucket);
      if (bucket) bucket.push(point.value);
      else byBucket.set(point.bucket, [point.value]);
    }
    return {
      points: [...byBucket].map(([at, values]) => ({
        at,
        value: combine(values, source.aggregate),
        contributors: values.length,
      })),
      // Counted across every Device, so seventeen Inverters each flagged once
      // reads as seventeen flagged readings, which is what happened.
      flaggedCount: flagged,
    };
  }, [readingsQuery.data, source]);

  const unavailableReason = (() => {
    if (!dashboardQuery.data) return null;
    if (!slot) return `No slot "${slotCode}" is configured.`;
    if (!source) {
      return slot.undefined_reason === "no_source"
        ? "No Device at this Plant can answer this figure."
        : "This slot declares no source.";
    }
    if (!tag && source.tag_code) return `Tag ${source.tag_code} is not in the catalogue.`;
    if (deviceIds.length === 0) {
      return `No ${source.device_type_code ?? "Device"} is registered at this Plant.`;
    }
    return null;
  })();

  return {
    points,
    flaggedCount,
    unit: slot?.unit ?? tag?.unit ?? null,
    label: slot?.label ?? slotCode,
    tier: readingsQuery.data?.tier ?? null,
    provenance: provenanceOf(slot),
    unavailableReason,
    isLoading: dashboardQuery.isLoading || (enabled && readingsQuery.isLoading),
    isError: readingsQuery.isError,
  };
}
