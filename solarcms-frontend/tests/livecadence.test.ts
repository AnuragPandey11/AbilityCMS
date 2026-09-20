/**
 * Figures that claim to be current must actually be re-asked for.
 *
 * This exists because of a bug that was invisible in every way a bug can be:
 * the Portfolio's KPI queries carried `staleTime: 30_000` and no
 * `refetchInterval`. That reads like "refresh every 30 seconds" and means
 * nothing of the kind — `staleTime` says only when a cached value *may* be
 * re-fetched, never that anything will re-fetch it. With the global
 * `refetchOnWindowFocus: false`, nothing ever did. Energy today, PR and CO2
 * were fixed at page load for as long as the tab stayed open.
 *
 * There was no error, no warning, and the numbers were correct — for the
 * instant the page was opened. On a wall display that is indistinguishable
 * from a plant that has stopped generating.
 *
 * So the rule is asserted rather than trusted: a live cadence carries both
 * settings, and they agree.
 */

import { describe, expect, it } from "vitest";
import { LIVE_KPI, LIVE_SOCKET_FALLBACK, ON_RETURN } from "@/api/hooks";

describe("live refresh cadences", () => {
  it("re-asks, rather than merely permitting a re-ask", () => {
    // The whole bug in one assertion.
    expect(LIVE_KPI.refetchInterval).toBeGreaterThan(0);
  });

  it("keeps staleTime and refetchInterval in agreement", () => {
    // A staleTime longer than the interval makes the timer fire and serve the
    // cache anyway — a poll that looks alive in the network tab and changes
    // nothing on screen. Shorter is fine; equal is the intent.
    expect(LIVE_KPI.staleTime).toBeLessThanOrEqual(LIVE_KPI.refetchInterval);
  });

  it("refreshes fast enough to be called live", () => {
    // Not a round number for its own sake: the client's Devices publish about
    // every 3 s and ingest commits on a 2 s batch window, so anything past
    // ~15 s is showing a figure older than the pipeline that produced it.
    expect(LIVE_KPI.refetchInterval).toBeLessThanOrEqual(15_000);
  });

  it("refetches when a backgrounded tab is returned to", () => {
    // Browsers throttle timers in hidden tabs to roughly once a minute and may
    // suspend them outright, so the interval alone cannot be trusted across a
    // tab switch. Without this, the first thing an operator sees on coming
    // back is a number from an unknowable time ago.
    expect(ON_RETURN.refetchOnWindowFocus).toBe(true);
  });
});

describe("the socket-backed fallback", () => {
  it("still refreshes on its own if the socket goes silent", () => {
    // The socket triggering a refetch is the fast path, not the only path. If
    // it is open but silent for a reason nobody predicted, a figure claiming to
    // be current must not sit there forever.
    expect(LIVE_SOCKET_FALLBACK.refetchInterval).toBeGreaterThan(0);
  });

  it("polls more slowly than the timer it replaces", () => {
    // The whole point. Refetching on arrival *and* polling at the old rate
    // would be strictly more requests than before — the opposite of the aim.
    expect(LIVE_SOCKET_FALLBACK.refetchInterval).toBeGreaterThan(
      LIVE_KPI.refetchInterval,
    );
  });

  it("keeps staleTime and refetchInterval in agreement", () => {
    expect(LIVE_SOCKET_FALLBACK.staleTime).toBeLessThanOrEqual(
      LIVE_SOCKET_FALLBACK.refetchInterval,
    );
  });
});
