/**
 * Yesterday's total energy, as the same claim as "Energy Generated Today".
 *
 * No Tag stores yesterday's energy, so it is read from yesterday's history of
 * whatever the Plant's `kpi.energy_today` slot resolved to — the same Device
 * Type, Tag and aggregate as the row above it (`useSlotSource`), never a second
 * resolution rule. Yesterday is the Plant's own calendar day.
 *
 * Two shapes of source, read differently:
 * - a **daily register** (`ENERGY_TODAY`, `PLANT_ENERGY_TODAY`): the day's total
 *   is the register's highest value after it restarted for the day;
 * - a **lifetime register's advance** (`counter_today`): how far it moved from
 *   the day's first reading to its last.
 *
 * Honesty rules: a register still rising at its last reading means readings
 * stopped while the Plant was generating, so the total is "at least" that; a
 * register that went backwards inside the day is not counted as negative
 * energy; Devices that sent nothing yesterday are counted and said, never
 * treated as zero. Flagged readings are left out (Guardrail 23).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import * as readingsApi from "./endpoints/readings";
import type { ReadingPoint } from "./schemas";
import { provenanceOf, useSlotSource } from "./useSlotTrend";
import { dayInZone } from "@/format/datetime";

/** A register falling below this share of its day's highest value restarted. */
const RESET_SHARE = 0.5;

export interface RegisterBucket {
  at: string;
  min: number;
  max: number;
  last: number;
}

export interface DeviceDay {
  /** Undefined where the readings cannot say. */
  total: number | null;
  /** Still rising at the last reading: the day's total is at least `total`. */
  rising: boolean;
}

/**
 * One Device's day from a register that restarts each day.
 *
 * A drop to under half of the day's highest value so far is a restart — the
 * register's own midnight may not be the Plant's — and only what follows it
 * counts. A smaller dip (one Inverter of a summed figure going quiet) is not.
 */
export function dailyRegisterDay(buckets: RegisterBucket[]): DeviceDay {
  if (buckets.length === 0) return { total: null, rising: false };
  const ordered = [...buckets].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let start = 0;
  let highest = ordered[0].max;
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].max < highest * RESET_SHARE) {
      start = i;
      highest = ordered[i].max;
    } else {
      highest = Math.max(highest, ordered[i].max);
    }
  }
  const segment = ordered.slice(start);
  const total = Math.max(...segment.map((bucket) => bucket.max));
  const last = segment[segment.length - 1];
  const before = segment.length > 1 ? segment[segment.length - 2] : null;
  const rising = last.max > last.min || (before !== null && last.max > before.max);
  return { total, rising };
}

/** One Device's advance over the day from a lifetime register. */
export function lifetimeAdvanceDay(buckets: RegisterBucket[]): DeviceDay {
  if (buckets.length === 0) return { total: null, rising: false };
  const ordered = [...buckets].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const advance = ordered[ordered.length - 1].last - ordered[0].min;
  const last = ordered[ordered.length - 1];
  const before = ordered.length > 1 ? ordered[ordered.length - 2] : null;
  return {
    // Backwards is a rollover, a reset or a replaced meter (OPEN-14): unknown.
    total: advance >= 0 ? advance : null,
    rising: last.max > last.min || (before !== null && last.max > before.max),
  };
}

/** Combine the Devices' days the way the slot says, counting who was missing. */
export function combineDays(
  days: DeviceDay[],
  aggregate: string,
): { value: number | null; rising: boolean } {
  const known = days.filter((day) => day.total !== null);
  if (known.length === 0) return { value: null, rising: false };
  const totals = known.map((day) => day.total as number);
  const rising = known.some((day) => day.rising);
  switch (aggregate) {
    case "sum":
      return { value: totals.reduce((a, b) => a + b, 0), rising };
    case "avg":
      return { value: totals.reduce((a, b) => a + b, 0) / totals.length, rising };
    case "max":
      return { value: Math.max(...totals), rising };
    case "min":
      return { value: Math.min(...totals), rising };
    default:
      return { value: totals[0], rising: known[0].rising };
  }
}

export interface YesterdayEnergy {
  value: number | null;
  unit: string | null;
  /** The total is at least `value`: readings stopped while it was still rising. */
  atLeast: boolean;
  /** Devices of the source that sent nothing usable yesterday. */
  missing: number;
  deviceCount: number;
  provenance: string | null;
  /** Why there is no value, when that is knowable. */
  reason: string | null;
  isLoading: boolean;
}

const SLOT = "kpi.energy_today";

export function useYesterdayEnergy(plantId: number | null): YesterdayEnergy {
  const { slot, source, tag, deviceIds, timeZone, unavailableReason, isLoading } =
    useSlotSource(plantId, SLOT);
  // Anchored to the hour: yesterday does not move, and the key stays stable.
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const today = dayInZone(now, timeZone ?? "UTC");
  const yesterday = dayInZone(today.start - 3_600_000, timeZone ?? "UTC");

  const counter = source?.kind === "counter_today";
  const usable =
    !!source &&
    (source.kind === "device_tag" || counter) &&
    !!tag &&
    deviceIds.length > 0 &&
    !!timeZone;

  const query: readingsApi.ReadingsQuery = {
    deviceIds,
    tagIds: tag ? [tag.id] : [],
    from: new Date(yesterday.start).toISOString(),
    to: new Date(yesterday.end).toISOString(),
    resolution: "agg_15m",
  };
  const readings = useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    enabled: usable,
    staleTime: 10 * 60_000,
    retry: false,
  });

  return useMemo((): YesterdayEnergy => {
    const base = {
      unit: slot?.unit ?? tag?.unit ?? null,
      deviceCount: deviceIds.length,
      provenance: provenanceOf(slot),
    };
    if (isLoading || (usable && readings.isLoading)) {
      return { ...base, value: null, atLeast: false, missing: 0, reason: null, isLoading: true };
    }
    if (!usable) {
      const reason =
        source?.kind === "plant_attribute" || source?.kind === "device_count"
          ? "Today's energy here is not read from a register, so yesterday's cannot be read back."
          : (unavailableReason ?? "Nothing at this Plant answers today's energy.");
      return { ...base, value: null, atLeast: false, missing: 0, reason, isLoading: false };
    }
    if (readings.isError) {
      return {
        ...base, value: null, atLeast: false, missing: 0, isLoading: false,
        reason: "Yesterday's readings could not be loaded.",
      };
    }
    const byDevice = new Map<number, RegisterBucket[]>();
    for (const point of (readings.data?.items ?? []) as ReadingPoint[]) {
      if (point.quality !== null && point.quality !== 0) continue;
      const min = point.min_value ?? point.value;
      const max = point.max_value ?? point.value;
      const last = point.last_value ?? point.value;
      if (min === null || min === undefined || max === null || max === undefined) continue;
      if (last === null || last === undefined) continue;
      const list = byDevice.get(point.device_id) ?? [];
      list.push({ at: point.bucket, min, max, last });
      byDevice.set(point.device_id, list);
    }
    const days = deviceIds.map((id) =>
      (counter ? lifetimeAdvanceDay : dailyRegisterDay)(byDevice.get(id) ?? []),
    );
    const missing = days.filter((day) => day.total === null).length;
    const { value, rising } = combineDays(days, source?.aggregate ?? "first");
    return {
      ...base,
      value,
      atLeast: value !== null && rising,
      missing,
      reason: value === null ? "Nothing was received from this source yesterday." : null,
      isLoading: false,
    };
  }, [
    slot, tag, deviceIds, isLoading, usable, readings.isLoading, readings.isError,
    readings.data, source, unavailableReason, counter,
  ]);
}
