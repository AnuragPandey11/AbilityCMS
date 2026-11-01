/**
 * A contact's steps (`dashboards/equipment/stateSeries.ts`): the last state of
 * each bucket, a mark where a bucket saw both, and a break where nothing came.
 */

import { describe, expect, it } from "vitest";
import type { ReadingPoint } from "@/api/schemas";
import { stateSeries } from "@/dashboards/equipment/stateSeries";

const T0 = Date.parse("2026-11-01T00:00:00Z");
const MIN = 60_000;

function bucket(
  minute: number,
  last: number,
  extra: Partial<ReadingPoint> = {},
): ReadingPoint {
  return {
    bucket: new Date(T0 + minute * MIN).toISOString(),
    device_id: 1,
    tag_id: 7,
    tag_code: "VCB_TRIP_FEEDBACK",
    value: last,
    quality: 0,
    min_value: last,
    max_value: last,
    last_value: last,
    ...extra,
  } as ReadingPoint;
}

describe("stateSeries", () => {
  it("holds each bucket's last state and marks every change", () => {
    const series = stateSeries([bucket(0, 0), bucket(1, 0), bucket(2, 1), bucket(3, 1), bucket(4, 0)], "agg_1m", 30_000);
    expect(series.points.map((p) => p.state)).toEqual([0, 0, 1, 1, 0]);
    expect(series.changes.map((p) => [(p.at - T0) / MIN, p.state])).toEqual([
      [2, 1],
      [4, 0],
    ]);
    expect(series.latest).toBe(0);
  });

  it("marks a bucket that saw both states, though its last is unchanged", () => {
    // A trip that opened and closed inside minute 1: same last, different max.
    const series = stateSeries([bucket(0, 0), bucket(1, 0, { max_value: 1 }), bucket(2, 0)], "agg_1m", 30_000);
    expect(series.changes).toEqual([]);
    expect(series.mixed).toEqual([{ at: T0 + MIN, spanMs: MIN, last: 0 }]);
  });

  it("breaks the step where nothing arrived, never holding through the silence", () => {
    const series = stateSeries([bucket(0, 1), bucket(1, 1), bucket(30, 1)], "agg_1m", 30_000);
    expect(series.points.map((p) => p.state)).toEqual([1, 1, null, 1]);
    // The break sits where the next reading was due.
    expect(series.points[2]?.at).toBe(T0 + 2 * MIN);
  });

  it("does not draw a flagged reading, and counts it", () => {
    const series = stateSeries([bucket(0, 0), bucket(1, 1, { quality: 2 })], "agg_1m", 30_000);
    expect(series.points.map((p) => p.state)).toEqual([0]);
    expect(series.flaggedCount).toBe(1);
  });

  it("reads a raw reading's value where there is no last", () => {
    const raw = bucket(0, 1, { last_value: undefined, min_value: undefined, max_value: undefined });
    expect(stateSeries([raw], "readings", 30_000).points).toEqual([{ at: T0, state: 1 }]);
  });

  it("is empty when nothing arrived", () => {
    const series = stateSeries([], "agg_1m", 30_000);
    expect(series.points).toEqual([]);
    expect(series.latest).toBeNull();
  });
});
