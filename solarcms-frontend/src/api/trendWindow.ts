/**
 * A chart's time window, and the tier that can serve it.
 *
 * ── Windows ─────────────────────────────────────────────────────────────────
 * `today` and `yesterday` are the Plant's calendar days, framed midnight to
 * midnight: a generation curve is read for the shape of a day, and a rolling
 * 24 hours splits that shape in two. The 7- and 30-day windows are rolling,
 * ending now. A custom window is two Plant-local wall times somebody typed.
 *
 * ── Tiers ───────────────────────────────────────────────────────────────────
 * The server refuses a request whose `devices × tags × buckets` exceeds its
 * 20,000-point cap with a 422 (`routers/readings.py`), and a window typed by
 * hand can be any length. So the tier is chosen here, from the window and the
 * number of series asked for — the finest one that fits under the cap and
 * still retains the window's start — rather than named per preset and left to
 * fail on the first long custom range.
 */

import type { Tier } from "./schemas";
import { dayInZone } from "@/format/datetime";

export type TrendWindow = "today" | "yesterday" | "7d" | "30d";

/** One Plant-local day, `[start, end)` in epoch ms. */
export interface DayBounds {
  start: number;
  end: number;
}

export interface WindowRange {
  from: string;
  to: string;
  /** Set for a single Plant day, so the axis runs 00:00–24:00; null otherwise. */
  day: DayBounds | null;
}

/** A preset window's bounds. `now` is anchored to the minute by the caller. */
export function windowRange(span: TrendWindow, now: number, timeZone: string): WindowRange {
  const today = dayInZone(now, timeZone);
  switch (span) {
    case "today":
      return { from: new Date(today.start).toISOString(), to: new Date(now).toISOString(), day: today };
    case "yesterday": {
      const yesterday = dayInZone(today.start - 1, timeZone);
      return {
        from: new Date(yesterday.start).toISOString(),
        to: new Date(yesterday.end).toISOString(),
        day: yesterday,
      };
    }
    default: {
      const days = span === "7d" ? 7 : 30;
      return {
        from: new Date(now - days * 86_400_000).toISOString(),
        to: new Date(now).toISOString(),
        day: null,
      };
    }
  }
}

/**
 * A typed window, or why it cannot be one.
 *
 * The end is clamped to now: there are no readings from the future, and a
 * window ending next week would spend the point budget on buckets that cannot
 * hold anything.
 */
export function customRange(
  fromMs: number,
  toMs: number,
  now: number,
): WindowRange | { error: string } {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { error: "Choose both a start and an end." };
  }
  if (fromMs >= now) return { error: "The start is in the future — there are no readings yet." };
  const end = Math.min(toMs, now);
  if (end <= fromMs) return { error: "The end must come after the start." };
  return { from: new Date(fromMs).toISOString(), to: new Date(end).toISOString(), day: null };
}

// ── Tier choice ──────────────────────────────────────────────────────────────

/**
 * Under the server's 20,000-point cap, with room for its own estimate's
 * rounding — the budget `useSlotSteps` already keeps.
 */
export const POINT_BUDGET = 18_000;

const DAY_MS = 86_400_000;

/**
 * The aggregate tiers, finest first, as `domain/tiering.TIERS` has them —
 * bucket, retention, and the longest window each is meant to serve.
 *
 * The raw tier is left out on purpose: it is irregular, so there is no bucket
 * to count against the cap, and every aggregate runs with real-time
 * aggregation on (migration 0023) — a minute bucket costs resolution, not
 * freshness.
 *
 * ⚠ `maxSpanMs` is the server's own `max_range`, and it binds even when the
 * point cap would allow finer: a week of one Device at the minute tier is
 * 10,080 points — inside the cap, and still a megabyte and a half of JSON per
 * chart to draw a line a few hundred pixels wide.
 */
const TIERS: { tier: Tier; bucketMs: number; retentionMs: number; maxSpanMs: number }[] = [
  { tier: "agg_1m", bucketMs: 60_000, retentionMs: 365 * DAY_MS, maxSpanMs: 2 * DAY_MS },
  { tier: "agg_15m", bucketMs: 15 * 60_000, retentionMs: 3 * 365 * DAY_MS, maxSpanMs: 14 * DAY_MS },
  { tier: "agg_1h", bucketMs: 3_600_000, retentionMs: 10 * 365 * DAY_MS, maxSpanMs: 365 * DAY_MS },
  { tier: "agg_1d", bucketMs: DAY_MS, retentionMs: 10 * 365 * DAY_MS, maxSpanMs: Infinity },
];

/** Bucket width per tier; the raw tier has none. */
export function bucketMs(tier: Tier): number | undefined {
  return TIERS.find((spec) => spec.tier === tier)?.bucketMs;
}

/**
 * The finest tier that serves the window's length, answers `series` series
 * inside the point budget, and still holds the window's start.
 *
 * `finest` is the finest the caller may use. A sum across Devices passes
 * `agg_15m`: an Inverter reporting every 86 s is absent from a third of all
 * minute buckets, and a minute-by-minute sum of seventeen of them reads a
 * third low in a sawtooth nobody measured.
 */
export function tierWithin(
  range: { from: string; to: string },
  series: number,
  now: number,
  finest: Tier = "agg_1m",
): Tier {
  const from = Date.parse(range.from);
  const span = Date.parse(range.to) - from;
  const age = now - from;
  const start = Math.max(
    0,
    TIERS.findIndex((spec) => spec.tier === finest),
  );
  for (const spec of TIERS.slice(start)) {
    const points = Math.floor(span / spec.bucketMs) * Math.max(series, 1);
    if (span <= spec.maxSpanMs && points <= POINT_BUDGET && age <= spec.retentionMs) return spec.tier;
  }
  return "agg_1d";
}
