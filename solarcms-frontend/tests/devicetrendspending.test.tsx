/**
 * Ticking a reading must read as "loading", never as "nothing arrived".
 *
 * Ticking changes the readings query's key, and `placeholderData` keeps the
 * previous answer on screen while the new one is fetched. That answer has
 * nothing for the newly ticked Tag, so a chart reading it as empty would say
 * a Device sent nothing about a fetch still in flight — the confusion
 * `TrendChart`'s own `isLoading` exists to prevent.
 */

import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { DeviceListItem, Tag } from "@/api/schemas";

const getReadings = vi.fn();
vi.mock("@/api/endpoints/readings", () => ({ getReadings: (...args: unknown[]) => getReadings(...args) }));

const { useDeviceTrends } = await import("@/components/devices/useDeviceTrends");

const tag = (id: number, code: string): Tag =>
  ({ id, code, name: code, unit: "kW", min_interval_s: 0 }) as unknown as Tag;
const A = tag(1, "A");
const B = tag(2, "B");
const device = { id: 7, expected_interval_s: 30 } as unknown as DeviceListItem;
const tagsById = new Map([A, B].map((entry) => [entry.id, entry]));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

const answer = (...ids: number[]) => ({
  tier: "agg_1m",
  items: ids.map((id) => ({
    bucket: "2026-11-01T06:00:00Z",
    tag_id: id,
    device_id: 7,
    value: 5,
    quality: 0,
  })),
});

describe("useDeviceTrends — a reading ticked while its history is in flight", () => {
  it("is pending until it arrives, while the readings already shown are not", async () => {
    getReadings.mockResolvedValueOnce(answer(1));
    const { result, rerender } = renderHook(
      ({ tags }: { tags: Tag[] }) => useDeviceTrends(device, tags, "today", "Asia/Kolkata", tagsById),
      { wrapper, initialProps: { tags: [A] } },
    );
    await waitFor(() => expect(result.current.seriesOf(A).points.length).toBeGreaterThan(0));
    expect(result.current.pendingOf(A)).toBe(false);

    // Tick B; the request never comes back.
    getReadings.mockReturnValueOnce(new Promise(() => {}));
    rerender({ tags: [A, B] });
    await waitFor(() => expect(result.current.pendingOf(B)).toBe(true));
    expect(result.current.pendingOf(A)).toBe(false);
    // The old answer is still what is drawn for A — nothing flickers.
    expect(result.current.seriesOf(A).points.length).toBeGreaterThan(0);
  });

  it("stops being pending once the right answer is in, even if it is empty", async () => {
    getReadings.mockResolvedValueOnce(answer(1));
    const { result, rerender } = renderHook(
      ({ tags }: { tags: Tag[] }) => useDeviceTrends(device, tags, "today", "Asia/Kolkata", tagsById),
      { wrapper, initialProps: { tags: [A] } },
    );
    await waitFor(() => expect(result.current.seriesOf(A).points.length).toBeGreaterThan(0));

    // B has no readings in the window: the answer is in, and it is empty.
    getReadings.mockResolvedValueOnce(answer(1));
    rerender({ tags: [A, B] });
    await waitFor(() => expect(result.current.pendingOf(B)).toBe(false));
    expect(result.current.seriesOf(B).points).toHaveLength(0);
  });
});
