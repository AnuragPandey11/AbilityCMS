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
import { useTags } from "./hooks";
import type { ReadingPoint } from "./schemas";

/** `QUALITY_OUT_OF_RANGE` in `domain/assumptions.py`. */
const OUT_OF_RANGE = 1;

/**
 * The Tags whose value is a status code (unit `code`).
 *
 * A code is a label, not a measurement, so a valid range says nothing about
 * it: the Inverters send `STS` 40960 against an assumed range of 0–1000, the
 * value is stored flagged out of range, and hiding it left every card without
 * its status. A code flagged *only* for its range is therefore still shown —
 * as sent — while a stale or unreadable one is not (8 Oct 2026, the user's
 * rule: show what the broker sends).
 */
function useCodeTagIds(): ReadonlySet<number> {
  const tags = useTags().data;
  return useMemo(
    () => new Set((tags ?? []).filter((tag) => tag.unit === "code").map((tag) => tag.id)),
    [tags],
  );
}

/** Whether a stored point may be shown as the latest value. */
export function presentable(point: ReadingPoint, codeTagIds: ReadonlySet<number>): boolean {
  if (point.value === null) return false;
  if (point.quality === null || point.quality === 0) return true;
  return point.quality === OUT_OF_RANGE && codeTagIds.has(point.tag_id);
}

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

/**
 * The window ends at the *end* of the current minute, not its start.
 *
 * The start keeps the query key stable, but the server returns only buckets
 * before `to`, so ending there left out the minute in progress: a page opened
 * at 13:54:50 read nothing newer than 13:53, and showed a breaker's trip
 * contact that had opened at 13:54:46 as FALSE until the next live frame
 * (measured 30 Sep 2026). Ending a minute later keeps the key just as stable
 * and includes it; real-time aggregation fills the bucket from raw rows.
 */
const CURRENT_MINUTE_MS = 60_000;

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
  const to = new Date(now + CURRENT_MINUTE_MS).toISOString();
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

  const codeTagIds = useCodeTagIds();
  const byDevice = useMemo(() => {
    const out: Record<number, Record<string, number>> = {};
    const items = (readingsQuery.data?.items ?? []) as ReadingPoint[];
    for (const point of items) {
      // A flagged value is not presented as a reading (§4.2, Guardrail 4). It
      // is not discarded from the system — `readings` still holds it, flagged,
      // and the time-series chart re-draws it in the quality's own colour. It
      // simply must not appear on a card as though it were a measurement.
      // A status code outside its assumed range is the exception — see above.
      if (!presentable(point, codeTagIds)) continue;
      // The server returns buckets ascending, so the last write per key wins
      // and is therefore the most recent good value.
      const device = (out[point.device_id] ??= {});
      device[String(point.tag_id)] = point.value as number;
    }
    return out;
  }, [readingsQuery.data, codeTagIds]);

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
    to: new Date(now + CURRENT_MINUTE_MS).toISOString(),
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
  const codeTagIds = useCodeTagIds();
  const values = useMemo(() => {
    const out = new Map<number, number>();
    for (const point of (readings.data?.items ?? []) as ReadingPoint[]) {
      // A flagged value is not presented as a reading (Guardrail 4), but for a
      // status code outside its assumed range. Buckets arrive ascending, so
      // the last write per Tag is the latest good value.
      if (!presentable(point, codeTagIds)) continue;
      out.set(point.tag_id, point.value as number);
    }
    return out;
  }, [readings.data, codeTagIds]);
  return { values, isLoading: deviceId !== null && readings.isLoading };
}
