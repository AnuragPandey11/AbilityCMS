/**
 * One Device's history for a handful of its Tags, over a window the reader
 * chose — the trends under a screen about one Device.
 *
 * One request for every trend on the page: the tier is the finest that fits
 * all of them under the server's point cap (`tierWithin`), so the charts side
 * by side are always the same resolution. Each series keeps its gaps: a Tag is
 * expected every `max(throttle, cycle) + cycle`, and a hole wider than that is
 * a break in the line, never a slope drawn across it (Guardrail 23).
 *
 * The Weather Station, Transformer and PPC screens read their trends through
 * here, so the rule for turning a window into a request lives once.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import * as readingsApi from "@/api/endpoints/readings";
import type { DeviceListItem, ReadingPoint, Tag, Tier } from "@/api/schemas";
import { seriesFromReadings, type TrendPoint } from "@/api/useSlotTrend";
import { tierWithin, windowRange, type TrendWindow, type WindowRange } from "@/api/trendWindow";
import { stateSeries, type StateSeries } from "@/dashboards/equipment/stateSeries";

/** The windows a screen about one Device offers, in the client's reference order. */
export const TREND_WINDOWS: { value: TrendWindow; label: string; hint: string }[] = [
  { value: "today", label: "Today", hint: "The Plant's day so far, midnight to midnight." },
  { value: "yesterday", label: "Yesterday", hint: "The Plant's previous day." },
  { value: "7d", label: "Last 7 days", hint: "The last seven days, ending now." },
  { value: "30d", label: "Last 30 days", hint: "The last thirty days, ending now." },
];

export interface TrendSeries {
  points: TrendPoint[];
  flaggedCount: number;
}

const NO_SERIES: TrendSeries = { points: [], flaggedCount: 0 };
const NO_ITEMS: ReadingPoint[] = [];
const NO_STATE: StateSeries = { points: [], changes: [], mixed: [], flaggedCount: 0, latest: null };

export interface DeviceTrends {
  /** Null until the Plant's zone is known. */
  range: WindowRange | null;
  /** The tier the server actually answered from. */
  tier: Tier | null;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  seriesOf: (tag: Tag | undefined) => TrendSeries;
  /** The buckets as the server sent them — min, max and last too — for a contact's steps. */
  itemsOf: (tag: Tag | undefined) => ReadingPoint[];
  /**
   * A contact's steps (`stateSeries`), worked out once per fetch rather than
   * per render so a chart holding them does not repaint on every render.
   * Empty for a Tag that is not a contact.
   */
  stateOf: (tag: Tag | undefined) => StateSeries;
  /**
   * True for a requested Tag whose history has not arrived yet. Ticking a
   * reading changes the query, and `placeholderData` keeps the previous
   * answer on screen meanwhile — which has nothing for the newly ticked Tag,
   * and a chart that reads that as "no readings" says "nothing arrived" about
   * a fetch still in flight. Always false once the answer is the right one.
   */
  pendingOf: (tag: Tag | undefined) => boolean;
}

export function useDeviceTrends(
  device: DeviceListItem | null,
  tags: (Tag | undefined)[],
  trendWindow: TrendWindow,
  timezone: string | undefined,
  tagsById: Map<number, Tag>,
): DeviceTrends {
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  // Waits for the Plant's zone: "today" framed on the browser's day first
  // would be a request answering a question nobody asked.
  const range = timezone ? windowRange(trendWindow, nowMs, timezone) : null;

  const tagIds = [
    ...new Set(tags.map((tag) => tag?.id).filter((id): id is number => id !== undefined)),
  ].sort((a, b) => a - b);
  const tier = range ? tierWithin(range, tagIds.length, nowMs) : "agg_1m";
  const args: readingsApi.ReadingsQuery = {
    deviceIds: device ? [device.id] : [],
    tagIds,
    from: range?.from ?? "",
    to: range?.to ?? "",
    resolution: tier,
  };
  const enabled = device !== null && range !== null && tagIds.length > 0;
  const query = useQuery({
    queryKey: qk.readings(args),
    queryFn: () => readingsApi.getReadings(args),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchInterval: trendWindow === "yesterday" ? false : 60_000,
    placeholderData: (previous) => previous,
  });

  const itemsByTag = useMemo(() => {
    const byTag = new Map<number, ReadingPoint[]>();
    for (const point of (query.data?.items ?? []) as ReadingPoint[]) {
      const list = byTag.get(point.tag_id);
      if (list) list.push(point);
      else byTag.set(point.tag_id, [point]);
    }
    return byTag;
  }, [query.data]);

  const seriesByTag = useMemo(() => {
    const byTag = itemsByTag;
    const out = new Map<number, TrendSeries>();
    const servedTier = query.data?.tier ?? null;
    for (const [tagId, items] of byTag) {
      // How often this Tag is stored when all is well — its throttle or the
      // Device's cycle, whichever is longer, plus one more cycle.
      const cycle = device?.expected_interval_s ?? 0;
      const throttle = tagsById.get(tagId)?.min_interval_s ?? 0;
      out.set(tagId, seriesFromReadings(items, "first", servedTier, (Math.max(throttle, cycle) + cycle) * 1000));
    }
    return out;
  }, [itemsByTag, query.data?.tier, tagsById, device?.expected_interval_s]);

  const stateByTag = useMemo(() => {
    const out = new Map<number, StateSeries>();
    const servedTier = query.data?.tier ?? null;
    // A contact is never throttled, so it is due every Device cycle.
    const cycleMs = (device?.expected_interval_s ?? 0) * 1000;
    for (const [tagId, items] of itemsByTag) {
      if (tagsById.get(tagId)?.unit === "bool") out.set(tagId, stateSeries(items, servedTier, cycleMs));
    }
    return out;
  }, [itemsByTag, query.data?.tier, tagsById, device?.expected_interval_s]);

  return {
    range,
    tier: query.data?.tier ?? null,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    seriesOf: (tag) => (tag ? seriesByTag.get(tag.id) : undefined) ?? NO_SERIES,
    itemsOf: (tag) => (tag ? itemsByTag.get(tag.id) : undefined) ?? NO_ITEMS,
    stateOf: (tag) => (tag ? stateByTag.get(tag.id) : undefined) ?? NO_STATE,
    pendingOf: (tag) => enabled && query.isPlaceholderData && tag !== undefined && !itemsByTag.has(tag.id),
  };
}
