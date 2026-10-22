/**
 * Today's Energy read from a meter's lifetime register (`counter_today`).
 *
 * Since 22 Oct 2026 the tile reads the meter first, and a meter that sends only
 * a lifetime total answers it as that register's advance since midnight. Its
 * hourly steps are the same claim as the figure, so the sun clock draws them;
 * the register's own curve is a different claim, so no trend is drawn. The
 * refusal sat in `useSlotSource`, which both share, and the sun clock was
 * replaced by its sentence on every Plant with such a meter.
 */

import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ResolvedSlot } from "@/api/schemas";

const H = 3_600_000;
// 08:00 IST: the day's first hourly bucket starts 00:30 IST (19:00 UTC).
const NOW = Date.parse("2026-10-22T02:30:00Z");

const slot: ResolvedSlot = {
  slot_code: "kpi.energy_today",
  label: "Today's Energy",
  position: 3,
  value: 300,
  unit: "kWh",
  undefined_reason: null,
  source: {
    kind: "counter_today",
    device_type_code: "MFM",
    tag_code: "ENERGY_EXPORT_TOTAL",
    aggregate: "sum",
    device_count: 1,
    is_aggregated: false,
    degraded: false,
  },
};

vi.mock("@/api/hooks", () => ({
  usePlant: () => ({ data: { id: 1, timezone: "Asia/Kolkata" } }),
  usePlantDashboard: () => ({
    data: { panels: { kpi_row: [slot] }, sld: { stages: [] } },
    isLoading: false,
  }),
  usePlantDevices: () => ({ data: [{ id: 7, type_code: "MFM", measures_generation: true }] }),
  useTags: () => ({ data: [{ id: 42, code: "ENERGY_EXPORT_TOTAL", unit: "kWh" }] }),
}));

const getReadings = vi.fn(async () => ({
  tier: "agg_1h",
  items: [
    // A lifetime register: 14 MWh, then 100 kWh and 200 kWh in two hours.
    { device_id: 7, tag_id: 42, bucket: "2026-10-22T00:00:00Z", value: 14_000_000, quality: 0 },
    { device_id: 7, tag_id: 42, bucket: "2026-10-22T01:00:00Z", value: 14_000_100, quality: 0 },
    { device_id: 7, tag_id: 42, bucket: "2026-10-22T02:00:00Z", value: 14_000_300, quality: 0 },
  ],
}));
vi.mock("@/api/endpoints/readings", () => ({ getReadings: (...args: unknown[]) => getReadings(...(args as [])) }));

const { useSlotSteps } = await import("@/api/useSlotSteps");
const { useSlotTrend } = await import("@/api/useSlotTrend");

function wrapper({ children }: { children: ReactNode }): JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("Today's Energy from a meter's lifetime register", () => {
  it("draws the sun clock from the register's hourly steps", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      const { result } = renderHook(
        () => useSlotSteps(1, "kpi.energy_today", "day", { resetsExpected: true }),
        { wrapper },
      );
      expect(result.current.unavailableReason).toBeNull();
      await waitFor(() => expect(result.current.placed).toBe(300));
      // Never the whole lifetime total in one hour.
      expect(Math.max(...result.current.periods.map((period) => period.energy ?? 0))).toBe(200);
      expect(result.current.frame && result.current.frame.end - result.current.frame.start).toBe(24 * H);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still draws no curve of the register under the tile", () => {
    getReadings.mockClear();
    const { result } = renderHook(() => useSlotTrend(1, "kpi.energy_today", "today"), { wrapper });
    expect(result.current.unavailableReason).toMatch(/advance since midnight/);
    expect(getReadings).not.toHaveBeenCalled();
  });
});
