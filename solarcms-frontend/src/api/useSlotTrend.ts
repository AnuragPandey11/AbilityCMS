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
import { usePlant, usePlantDashboard, usePlantDevices, useTags } from "./hooks";
import type { ReadingPoint, ResolvedSlot, Tag, Tier } from "./schemas";
import { dayInZone } from "@/format/datetime";

/**
 * How far back a trend looks, and which tier can serve it.
 *
 * `today` is the one calendar span among rolling ones, and it is here because
 * a solar Plant's output has the shape of a *day*: a rolling 24 hours opened at
 * 11:00 shows the back half of yesterday's curve beside the front half of
 * today's, and the one shape anybody reads a generation curve for — the ramp,
 * the plateau, the fall — is split across the frame.
 */
export type TrendRange = "today" | "24h" | "7d" | "30d";

export const TREND_RANGES: { value: TrendRange; label: string; hint: string }[] = [
  {
    value: "today",
    label: "Today",
    hint: "Since midnight at the Plant, on a 00:00–24:00 axis, in 15-minute buckets.",
  },
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
  today: "agg_15m",
  "24h": "agg_15m",
  "7d": "agg_1h",
  "30d": "agg_1d",
};

const HOURS_FOR: Record<Exclude<TrendRange, "today">, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

/**
 * What a range asks the server for, and how the chart should frame it.
 *
 * `now` is anchored to the top of the current minute by the caller, so the
 * query key is stable for 60 seconds. `day` is set for `today` only: the data
 * stops at now, but the axis runs to midnight, so the afternoon still to come
 * is visibly empty rather than the morning stretched across the whole frame.
 */
export function trendWindow(
  range: TrendRange,
  now: number,
  timeZone: string,
): { from: string; to: string; day: { start: number; end: number } | null } {
  const to = new Date(now).toISOString();
  if (range === "today") {
    const day = dayInZone(now, timeZone);
    return { from: new Date(day.start).toISOString(), to, day };
  }
  return { from: new Date(now - HOURS_FOR[range] * 3_600_000).toISOString(), to, day: null };
}

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
  /** The Plant-local day to frame the axis on — `today` only, otherwise null. */
  day: { start: number; end: number } | null;
  isLoading: boolean;
  isError: boolean;
}

/** Bucket width per aggregate tier. The raw tier is irregular and has none. */
const BUCKET_MS: Partial<Record<Tier, number>> = {
  agg_1m: 60_000,
  agg_15m: 15 * 60_000,
  agg_1h: 3_600_000,
  agg_1d: 86_400_000,
};

/**
 * Put a `null` where a bucket is missing, so the line breaks there.
 *
 * ⚠ The server returns only buckets that hold readings, so a Plant silent from
 * 03:15 to 14:15 arrives as two buckets eleven hours apart — and a line chart
 * joins them with a straight diagonal, drawing eleven hours of steady decline
 * that nobody measured. `connectNulls: false` cannot help, because there is no
 * null to not connect. One null just past the last bucket before a hole is
 * enough: the axis is time, so the break lands where the silence began
 * (Guardrail 23).
 */
export function withGaps(points: TrendPoint[], tier: Tier | null): TrendPoint[] {
  const step = tier ? BUCKET_MS[tier] : undefined;
  if (!step || points.length < 2) return points;
  const out: TrendPoint[] = [];
  let previous: number | null = null;
  for (const point of points) {
    const at = Date.parse(point.at);
    // Half a bucket of slack, so a bucket that lands a few seconds late is not
    // mistaken for a missing one.
    if (previous !== null && at - previous > step * 1.5) {
      out.push({ at: new Date(previous + step).toISOString(), value: null, contributors: 0 });
    }
    out.push(point);
    previous = at;
  }
  return out;
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

export function provenanceOf(slot: ResolvedSlot | undefined): string | null {
  const source = slot?.source;
  if (!source) return null;
  if (source.kind === "plant_attribute") return "Plant record";
  if (!source.is_aggregated) return source.device_type_code ?? null;
  return `${source.aggregate} of ${source.device_count} ${source.device_type_code ?? "Device"}`;
}

/**
 * What a slot resolved to on this Plant, and every Device and Tag that answers
 * it — the half of a trend that is not about time.
 *
 * Shared by every view that draws history under a headline figure, so there is
 * exactly one rule for turning a resolved slot into a readings request. A
 * second copy would be free to drift, and the drift is the bug this file
 * exists to prevent: a chart that is no longer the tile's claim.
 */
export interface SlotSource {
  slot: ResolvedSlot | undefined;
  source: ResolvedSlot["source"];
  tag: Tag | undefined;
  /** Every Device of the resolved type, ascending. */
  deviceIds: number[];
  /** The Plant's zone, once the Plant has loaded. */
  timeZone: string | undefined;
  /** Set when the slot resolved but nothing here can be asked for it. */
  unavailableReason: string | null;
  isLoading: boolean;
}

export function useSlotSource(plantId: number | null, slotCode: string): SlotSource {
  const plantQuery = usePlant(plantId);
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
    slot,
    source,
    tag,
    deviceIds,
    timeZone: plantQuery.data?.timezone,
    unavailableReason,
    isLoading: dashboardQuery.isLoading,
  };
}

export function useSlotTrend(
  plantId: number | null,
  slotCode: string,
  range: TrendRange,
  /**
   * Force a tier instead of the one the range implies.
   *
   * The one caller that needs this is the daily-energy view. `ENERGY_TODAY` is
   * a **cumulative counter that resets at midnight**, so at a sub-daily tier it
   * draws a rising staircase — correct, and not what "energy per day" means. At
   * `agg_1d` the tier's `last` roll-up returns each day's final value, which is
   * that day's total, and summing across the Inverters gives the Plant's.
   *
   * ⚠ This is a *resolution* override and nothing more. It never changes which
   * Device or Tag answers — that stays the slot's own resolution, so the bars
   * remain the same claim as the tile above them.
   */
  tierOverride?: Tier,
): SlotTrend {
  const { slot, source, tag, deviceIds, timeZone, unavailableReason, isLoading } =
    useSlotSource(plantId, slotCode);

  // Anchored to the top of the current minute rather than to `Date.now()`, so
  // the query key is stable for 60 seconds. Unanchored, every render produces a
  // new `to` and therefore a new cache entry — the chart would refetch on each
  // paint and never hit cache once.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  // The Plant's zone, never the browser's: "today" at a Plant in Kolkata began
  // at 18:30 UTC yesterday, whatever the clock says on the operator's laptop.
  const { from, to, day } = trendWindow(range, now, timeZone ?? "UTC");
  const tier = tierOverride ?? TIER_FOR[range];

  const query: readingsApi.ReadingsQuery = {
    deviceIds,
    tagIds: tag ? [tag.id] : [],
    from,
    to,
    resolution: tier,
  };
  // `today` waits for the Plant's zone rather than asking for a UTC day first
  // and then the right one — two requests, the first answering nothing asked.
  const enabled =
    deviceIds.length > 0 && tag !== undefined && (range !== "today" || timeZone !== undefined);

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
      points: withGaps(
        [...byBucket].map(([at, values]) => ({
          at,
          value: combine(values, source.aggregate),
          contributors: values.length,
        })),
        readingsQuery.data?.tier ?? null,
      ),
      // Counted across every Device, so seventeen Inverters each flagged once
      // reads as seventeen flagged readings, which is what happened.
      flaggedCount: flagged,
    };
  }, [readingsQuery.data, source]);

  return {
    points,
    flaggedCount,
    unit: slot?.unit ?? tag?.unit ?? null,
    label: slot?.label ?? slotCode,
    tier: readingsQuery.data?.tier ?? null,
    provenance: provenanceOf(slot),
    unavailableReason,
    day,
    isLoading: isLoading || (enabled && readingsQuery.isLoading),
    isError: readingsQuery.isError,
  };
}
