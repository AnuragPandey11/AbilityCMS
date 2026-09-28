/**
 * One measure over a window the reader chose — the history screens' series.
 *
 * `useSlotTrend` serves the Single Plant screen, whose windows are four fixed
 * presets with a tier named for each. The Meteorological and Energy Analytics
 * screens also take a window typed by hand, which can be any length, so here
 * the tier is chosen from the window (`trendWindow.tierWithin`) and the rest —
 * how Devices combine in a bucket, what is flagged, where a hole becomes a
 * break — is `seriesFromReadings`, the same function `useSlotTrend` uses, so
 * the two cannot drift apart on any of it.
 *
 * `useSlotSeries` reads a dashboard slot exactly as `useSlotTrend` does: it
 * takes the Device Type, Tag and aggregate the server resolved, so a curve here
 * is the same claim as the figure on the Plant's dashboard, and a Plant that
 * cannot answer the slot gets no series rather than a fallback.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import * as readingsApi from "./endpoints/readings";
import { usePlantDevices } from "./hooks";
import type { DeviceListItem, ReadingPoint, Tag, Tier } from "./schemas";
import { provenanceOf, seriesFromReadings, useSlotSource, type TrendPoint } from "./useSlotTrend";
import { tierWithin, type WindowRange } from "./trendWindow";

export interface Series {
  points: TrendPoint[];
  /** Readings in the window not plotted because their quality was flagged. */
  flaggedCount: number;
  /** The tier that actually served it, for the chart to state (§9). */
  tier: Tier | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Which Devices, which Tag, and how one bucket's Devices combine.
 *
 * `aggregate` is `sum` for a quantity that adds across Devices (power) and
 * `avg` or `first` for one that does not (irradiance, one Device's figure).
 */
export interface SeriesSource {
  devices: DeviceListItem[];
  tag: Tag | undefined;
  aggregate: string;
}

export function useSeries(
  { devices, tag, aggregate }: SeriesSource,
  /** Null until the Plant's zone is known — a UTC day first would be a wasted request. */
  range: WindowRange | null,
  { live, enabled = true }: { live: boolean; enabled?: boolean },
): Series {
  const deviceIds = useMemo(() => devices.map((device) => device.id).sort((a, b) => a - b), [devices]);
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  // A sum across Devices is never finer than fifteen minutes — see `tierWithin`.
  const finest: Tier = aggregate === "sum" && deviceIds.length > 1 ? "agg_15m" : "agg_1m";
  const tier = range ? tierWithin(range, deviceIds.length, now, finest) : finest;

  const query: readingsApi.ReadingsQuery = {
    deviceIds,
    tagIds: tag ? [tag.id] : [],
    from: range?.from ?? "",
    to: range?.to ?? "",
    resolution: tier,
  };
  const active = enabled && range !== null && deviceIds.length > 0 && tag !== undefined;

  const readingsQuery = useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    enabled: active,
    // A 422 here is the point cap, and retrying repeats it exactly.
    retry: false,
    staleTime: 60_000,
    // Only a window that ends now has anything new to learn.
    refetchInterval: live ? 60_000 : false,
    placeholderData: (previous) => previous,
  });

  /**
   * How often a bucket can be expected at all: the slowest Device's cycle or
   * the Tag's throttle, whichever is longer, plus one more cycle — the health
   * sweep's own tolerance before it calls a Device late. Without it a Tag
   * stored every five minutes, read at the minute tier, is a hole after every
   * point and draws nothing.
   */
  const sampleEveryMs = useMemo(() => {
    const cycle = Math.max(0, ...devices.map((device) => device.expected_interval_s));
    return (Math.max(tag?.min_interval_s ?? 0, cycle) + cycle) * 1000;
  }, [devices, tag]);

  const { points, flaggedCount } = useMemo(
    () =>
      seriesFromReadings(
        (readingsQuery.data?.items ?? []) as ReadingPoint[],
        aggregate,
        readingsQuery.data?.tier ?? null,
        sampleEveryMs,
      ),
    [readingsQuery.data, aggregate, sampleEveryMs],
  );

  return {
    points,
    flaggedCount,
    tier: readingsQuery.data?.tier ?? null,
    isLoading: active && readingsQuery.isLoading,
    isError: readingsQuery.isError,
  };
}

export interface SlotSeries extends Series {
  /** Verbatim from the slot — never derived from the Tag's name (§4.1). */
  unit: string | null;
  label: string;
  /** `sum of 17 INVERTER`, `MFM` — the same claim the dashboard figure makes. */
  provenance: string | null;
  /** The slot resolved, but this Plant has nothing that can answer it. */
  unavailableReason: string | null;
}

/** A dashboard slot's history over a chosen window. */
export function useSlotSeries(
  plantId: number | null,
  slotCode: string,
  range: WindowRange | null,
  options: { live: boolean },
): SlotSeries {
  const slotSource = useSlotSource(plantId, slotCode);
  const devicesQuery = usePlantDevices(plantId);
  const devices = useMemo(() => {
    const ids = new Set(slotSource.deviceIds);
    return (devicesQuery.data ?? []).filter((device) => ids.has(device.id));
  }, [devicesQuery.data, slotSource.deviceIds]);

  const series = useSeries(
    { devices, tag: slotSource.tag, aggregate: slotSource.source?.aggregate ?? "first" },
    range,
    { live: options.live, enabled: slotSource.source !== null },
  );

  return {
    ...series,
    unit: slotSource.slot?.unit ?? slotSource.tag?.unit ?? null,
    label: slotSource.slot?.label ?? slotCode,
    provenance: provenanceOf(slotSource.slot),
    unavailableReason: slotSource.unavailableReason,
    isLoading: slotSource.isLoading || series.isLoading,
  };
}
