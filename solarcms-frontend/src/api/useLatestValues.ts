/**
 * The most recent stored value per (Device, Tag), for a whole Device Type.
 *
 * ── Why the live socket is not enough on its own ────────────────────────────
 * The socket carries *new* frames. It says nothing about what was true a
 * moment before you opened the page, and on this Plant a Device publishes
 * every 86 seconds — so a freshly loaded dashboard showed a row of Inverter
 * cards reading "—" for up to a minute and a half, on equipment that was
 * running perfectly. Dashes mean "we have no value", and having no value
 * because nobody has spoken *since you arrived* is not a fact about the plant.
 *
 * So the cards are seeded from what is stored, and the socket overwrites each
 * Device as its next frame lands. That is the same "heard" versus "stored"
 * distinction the ingest path already makes — `seen:device:{id}` in Redis is
 * what proves a Device is alive, and `readings` is what holds its numbers.
 *
 * ⚠ These are **stored readings, not a liveness signal.** A Device whose Tags
 * are all throttled can be perfectly alive and have written nothing recently;
 * whether it is reporting is `comm_status`, computed by the health sweep
 * against the Device's own interval, and nothing here may be used to second-
 * guess it (Guardrail 15: silence is judged against a Device's own measured
 * interval, never a fixed clock).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import * as readingsApi from "./endpoints/readings";
import type { ReadingPoint } from "./schemas";

/**
 * How far back to look for a last value.
 *
 * Thirty minutes at the 1-minute tier, which is at most 30 buckets per
 * Device-Tag: seventeen Inverters against seven curated Tags is ~3,500 points,
 * comfortably inside the server's 20,000-point cap. The raw tier would be
 * fresher by seconds and unbounded in size — a Plant publishing every two
 * seconds would blow the cap and get a 422 instead of a chart.
 *
 * `agg_1m` is safe to read for "now" because every tier runs with real-time
 * aggregation on (migration 0023), so the current minute is included rather
 * than waiting for a materialisation pass.
 */
const LOOKBACK_MINUTES = 30;

export interface LatestValues {
  /** device id → (tag id as string → value), shaped like a live frame (§5.1). */
  byDevice: Record<number, Record<string, number>>;
  isLoading: boolean;
}

export function useLatestValues(
  deviceIds: number[],
  tagIds: number[],
  enabled = true,
): LatestValues {
  // Anchored to the top of the minute so the query key is stable for 60
  // seconds. Unanchored, `Date.now()` makes a new key on every render and the
  // request repeats on every paint without ever hitting cache.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const to = new Date(now).toISOString();
  const from = new Date(now - LOOKBACK_MINUTES * 60_000).toISOString();

  const sortedDevices = useMemo(() => [...deviceIds].sort((a, b) => a - b), [deviceIds]);
  const sortedTags = useMemo(() => [...tagIds].sort((a, b) => a - b), [tagIds]);

  const query: readingsApi.ReadingsQuery = {
    deviceIds: sortedDevices,
    tagIds: sortedTags,
    from,
    to,
    resolution: "agg_1m",
  };

  const readingsQuery = useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    enabled: enabled && sortedDevices.length > 0 && sortedTags.length > 0,
    // A 422 here is the point cap, and retrying repeats it exactly.
    retry: false,
    staleTime: 60_000,
    // A backstop only. The socket is the primary path once the page is open;
    // this keeps a card from going stale on a tab left open with a dead socket.
    refetchInterval: 120_000,
    placeholderData: (previous) => previous,
  });

  const byDevice = useMemo(() => {
    const out: Record<number, Record<string, number>> = {};
    const items = (readingsQuery.data?.items ?? []) as ReadingPoint[];
    for (const point of items) {
      // A flagged value is not presented as a reading (§4.2, Guardrail 4). It
      // is not discarded from the system — `readings` still holds it, flagged,
      // and the time-series chart re-draws it in the quality's own colour. It
      // simply must not appear on a card as though it were a measurement.
      if (point.quality !== null && point.quality !== 0) continue;
      if (point.value === null) continue;
      // The server returns buckets ascending, so the last write per key wins
      // and is therefore the most recent good value.
      const device = (out[point.device_id] ??= {});
      device[String(point.tag_id)] = point.value;
    }
    return out;
  }, [readingsQuery.data]);

  return { byDevice, isLoading: readingsQuery.isLoading };
}

/** How far back a single Device's "current" values may come from. */
export const DEVICE_LOOKBACK_MINUTES = LOOKBACK_MINUTES;

/**
 * The last good value of every Tag one Device sent recently, keyed by Tag id.
 *
 * **No Tag filter**, unlike `useLatestValues`: a screen about one Device must
 * be able to list what it did not expect, and a filter built from its layout
 * would make anything outside the layout invisible. It also works for a
 * session that may not read bindings (`config.modify`), because it asks what
 * the Device *reported* rather than what it is bound to.
 */
export function useDeviceLatest(
  deviceId: number | null,
): { values: Map<number, number>; isLoading: boolean } {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const query: readingsApi.ReadingsQuery = {
    deviceIds: deviceId === null ? [] : [deviceId],
    from: new Date(now - LOOKBACK_MINUTES * 60_000).toISOString(),
    to: new Date(now).toISOString(),
    resolution: "agg_1m",
  };
  const readings = useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    enabled: deviceId !== null,
    retry: false,
    staleTime: 60_000,
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
  const values = useMemo(() => {
    const out = new Map<number, number>();
    for (const point of (readings.data?.items ?? []) as ReadingPoint[]) {
      // A flagged value is not presented as a reading (Guardrail 4). Buckets
      // arrive ascending, so the last write per Tag is the latest good value.
      if (point.quality !== null && point.quality !== 0) continue;
      if (point.value === null) continue;
      out.set(point.tag_id, point.value);
    }
    return out;
  }, [readings.data]);
  return { values, isLoading: deviceId !== null && readings.isLoading };
}
