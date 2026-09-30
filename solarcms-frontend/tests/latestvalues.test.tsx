/**
 * "Latest" includes the minute in progress.
 *
 * The window is anchored to the minute for a stable query key, and the server
 * returns only buckets before `to`. Ending at the start of the minute hid
 * everything received in it: a VCB trip contact that opened at 13:54:46 read
 * FALSE on a page opened at 13:54:50 (measured 30 Sep 2026).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { ReadingsQuery } from "@/api/endpoints/readings";

const calls: ReadingsQuery[] = [];
vi.mock("@/api/endpoints/readings", () => ({
  getReadings: async (query: ReadingsQuery) => {
    calls.push(query);
    return { items: [], tier: "agg_1m" };
  },
}));

import { useDeviceLatest, useLatestValues } from "@/api/useLatestValues";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

afterEach(() => {
  calls.length = 0;
  vi.useRealTimers();
});

describe("the latest-value window", () => {
  it("ends after the reading that arrived this minute, for one Device", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-30T08:24:50Z"), shouldAdvanceTime: true });
    renderHook(() => useDeviceLatest(29), { wrapper });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(new Date(calls[0]!.to).getTime()).toBeGreaterThan(Date.parse("2026-09-30T08:24:46Z"));
    expect(calls[0]!.to).toBe("2026-09-30T08:25:00.000Z");
  });

  it("and for a set of Devices", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-09-30T08:24:50Z"), shouldAdvanceTime: true });
    renderHook(() => useLatestValues([29], [7]), { wrapper });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.to).toBe("2026-09-30T08:25:00.000Z");
  });
});
