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

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import * as readingsApi from "./endpoints/readings";
import { usePlantDevices } from "./hooks";
import { TIERS, type DeviceListItem, type ReadingPoint, type Tag, type Tier } from "./schemas";
import { curveRefusal, provenanceOf, seriesFromReadings, useSlotSource, type TrendPoint } from "./useSlotTrend";
import { bucketMs, sameFrame, tierWithin, type WindowRange } from "./trendWindow";

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

// ── Finer readings where the reader zoomed ───────────────────────────────────

/**
 * The coarse series with a finer one laid over the zoomed span.
 *
 * A coarse bucket that overlaps the span at all is dropped, or one hour's
 * mean would sit among its own minutes. The finer points keep their own
 * gaps; a hole at the seam is made a break, never a line drawn across it
 * (Guardrail 23).
 */
export function mergeDetail(
  coarse: TrendPoint[],
  coarseTier: Tier | null,
  fine: TrendPoint[],
  window: { from: number; to: number },
): TrendPoint[] {
  if (fine.length === 0) return coarse;
  const step = (coarseTier ? bucketMs(coarseTier) : undefined) ?? 0;
  const before = coarse.filter((point) => Date.parse(point.at) + step <= window.from);
  const after = coarse.filter((point) => Date.parse(point.at) >= window.to);
  const inside = fine.filter((point) => {
    const at = Date.parse(point.at);
    return at >= window.from && at < window.to;
  });
  const seam = (at: number): TrendPoint => ({ at: new Date(at).toISOString(), value: null, contributors: 0 });
  // A break at each seam: the two resolutions are separate claims, and a line
  // joining an hourly mean to a minute's reading would be neither.
  return [
    ...before,
    ...(before.length > 0 ? [seam(window.from)] : []),
    ...inside,
    ...(after.length > 0 ? [seam(Math.max(window.from, window.to - 1))] : []),
    ...after,
  ];
}

const tierIndex = (tier: Tier | null) => (tier ? TIERS.indexOf(tier) : -1);

/** How fine the zoomed span is, in words, for the chart's badge. */
const DETAIL_WORDS: Record<Tier, string> = {
  readings: "Raw readings",
  agg_1m: "1-minute averages",
  agg_15m: "15-minute averages",
  agg_1h: "Hourly averages",
  agg_1d: "Daily averages",
};

export interface ZoomableSeries extends Series {
  /** For `TrendChart`'s `zoom` prop. */
  zoom: {
    from: number;
    to: number;
    onWindow: (window: { from: number; to: number } | null) => void;
    detail: { label: string; loading: boolean } | null;
  } | null;
}

/**
 * `useSeries`, and — once the reader has zoomed in far enough that a finer
 * tier fits — the zoomed span again at that tier, merged in.
 */
export function useZoomableSeries(
  source: SeriesSource,
  range: WindowRange | null,
  options: { live: boolean; enabled?: boolean },
): ZoomableSeries {
  const main = useSeries(source, range, options);
  const [window, setWindow] = useState<{ from: number; to: number } | null>(null);
  // A new period is a new chart; a zoom into the old one means nothing here.
  // ⚠ The same period still running is not new: its end moves every minute,
  // and the zoom must survive that (`sameFrame`).
  const frame = range ? { from: Date.parse(range.from), to: Date.parse(range.to) } : null;
  const [zoomedFrame, setZoomedFrame] = useState<{ from: number; to: number } | null>(null);
  const activeWindow = frame && zoomedFrame && sameFrame(zoomedFrame, frame) ? window : null;

  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  const fineRange = activeWindow
    ? { from: new Date(activeWindow.from).toISOString(), to: new Date(activeWindow.to).toISOString(), day: null }
    : null;
  const finest: Tier = source.aggregate === "sum" && source.devices.length > 1 ? "agg_15m" : "agg_1m";
  const fineTier = fineRange ? tierWithin(fineRange, source.devices.length, nowMs, finest) : null;
  const finer = fineTier !== null && main.tier !== null && tierIndex(fineTier) < tierIndex(main.tier);
  const detail = useSeries(source, finer ? fineRange : null, {
    live: options.live,
    enabled: (options.enabled ?? true) && finer,
  });

  const points = useMemo(
    () =>
      finer && activeWindow && detail.tier !== null
        ? mergeDetail(main.points, main.tier, detail.points, activeWindow)
        : main.points,
    [finer, activeWindow, detail.points, detail.tier, main.points, main.tier],
  );

  const from = range ? Date.parse(range.from) : 0;
  const to = range ? Date.parse(range.to) : 0;
  return {
    ...main,
    points,
    flaggedCount: main.flaggedCount + (finer ? detail.flaggedCount : 0),
    zoom: range
      ? {
          from,
          to,
          onWindow: (next) => {
            setZoomedFrame(frame);
            setWindow(next);
          },
          detail: finer
            ? {
                label: `${DETAIL_WORDS[detail.tier ?? fineTier]} in the zoomed span`,
                loading: detail.isLoading,
              }
            : null,
        }
      : null,
  };
}

export interface SlotSeries extends ZoomableSeries {
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
  const refusal = curveRefusal(slotSource.source);
  const devicesQuery = usePlantDevices(plantId);
  const devices = useMemo(() => {
    const ids = new Set(slotSource.deviceIds);
    return (devicesQuery.data ?? []).filter((device) => ids.has(device.id));
  }, [devicesQuery.data, slotSource.deviceIds]);

  // Zoomable: a reader who zooms into the curve is shown finer buckets there
  // (`useZoomableSeries`) — nothing changes until a chart asks for it.
  const series = useZoomableSeries(
    { devices, tag: slotSource.tag, aggregate: slotSource.source?.aggregate ?? "first" },
    range,
    { live: options.live, enabled: slotSource.source !== null && refusal === null },
  );

  return {
    ...series,
    unit: slotSource.slot?.unit ?? slotSource.tag?.unit ?? null,
    label: slotSource.slot?.label ?? slotCode,
    provenance: provenanceOf(slotSource.slot),
    unavailableReason: slotSource.unavailableReason ?? refusal,
    isLoading: slotSource.isLoading || series.isLoading,
  };
}
