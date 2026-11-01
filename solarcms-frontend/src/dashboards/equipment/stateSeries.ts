/**
 * A contact's history as steps: TRUE or FALSE, held until it changes.
 *
 * Pure — the chart (`StateTrendChart`) only draws what this returns, so the
 * rules are tested here (`tests/stateseries.test.ts`).
 *
 * ── Three rules ─────────────────────────────────────────────────────────────
 * - **A bucket's state is its last reading.** On an aggregate tier a bucket
 *   holds a minute, a quarter-hour or an hour of readings; the last is the
 *   state the contact was left in, which is what the step holds until the
 *   next bucket.
 * - **A bucket that saw both states says so.** A trip that opened and closed
 *   inside one bucket leaves the same `last` as no trip at all; only its
 *   `min`/`max` differ. That bucket is marked (`mixed`), so a fault the tier
 *   is too coarse to place is still on the chart — never smoothed away.
 * - **A gap is a gap** (Guardrail 23). A contact is never throttled, so it is
 *   expected every Device cycle; where nothing arrived for longer than that,
 *   the step stops rather than claiming the state held through a silence.
 *
 * Flagged readings are not drawn and are counted, as on every trend.
 */

import type { ReadingPoint, Tier } from "@/api/schemas";
import { BUCKET_MS } from "@/api/useSlotTrend";

export type State = 0 | 1;

export interface StatePoint {
  /** Epoch ms of the bucket (or reading). */
  at: number;
  /** null where the line breaks: nothing was received. */
  state: State | null;
}

export interface MixedBucket {
  at: number;
  /** How long the bucket is, for the tooltip — "within this minute". */
  spanMs: number;
  /** The state it ended in; the other one was seen inside it too. */
  last: State;
}

export interface StateSeries {
  points: StatePoint[];
  /** Points where the state differs from the one before — a dot each, as in the reference. */
  changes: StatePoint[];
  mixed: MixedBucket[];
  flaggedCount: number;
  /** The last state received, or null when nothing was. */
  latest: State | null;
}

const toState = (value: number): State => (value >= 0.5 ? 1 : 0);

export function stateSeries(
  items: ReadingPoint[],
  tier: Tier | null,
  /** How often the contact arrives when all is well — the Device's cycle. */
  sampleEveryMs: number,
): StateSeries {
  let flaggedCount = 0;
  const raw: { at: number; state: State; mixed: boolean }[] = [];
  for (const item of items) {
    if (item.quality !== null && item.quality !== 0) {
      flaggedCount += 1;
      continue;
    }
    const value = item.last_value ?? item.value;
    if (value === null || value === undefined) continue;
    const low = item.min_value ?? value;
    const high = item.max_value ?? value;
    raw.push({ at: Date.parse(item.bucket), state: toState(value), mixed: toState(low) !== toState(high) });
  }
  raw.sort((a, b) => a.at - b.at);

  const bucketMs = tier ? (BUCKET_MS[tier] ?? 0) : 0;
  // Half a bucket of slack, or one cycle past the bucket for a sparse source —
  // the same allowance `withGaps` gives every other trend.
  const allowed = Math.max(bucketMs * 1.5, bucketMs + sampleEveryMs, sampleEveryMs * 2);
  const points: StatePoint[] = [];
  const changes: StatePoint[] = [];
  const mixed: MixedBucket[] = [];
  let previous: { at: number; state: State } | null = null;
  for (const entry of raw) {
    if (previous && allowed > 0 && entry.at - previous.at > allowed) {
      // The step holds to where the next reading was due, then stops.
      points.push({ at: previous.at + Math.max(bucketMs, sampleEveryMs), state: null });
    }
    if (previous && previous.state !== entry.state) changes.push({ at: entry.at, state: entry.state });
    points.push({ at: entry.at, state: entry.state });
    if (entry.mixed) mixed.push({ at: entry.at, spanMs: bucketMs, last: entry.state });
    previous = entry;
  }
  return { points, changes, mixed, flaggedCount, latest: previous?.state ?? null };
}
