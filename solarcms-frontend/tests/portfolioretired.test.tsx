/**
 * A decommissioned Plant is in no Portfolio total.
 *
 * It was counted, because the rule was "anything not onboarding": retired and
 * sending nothing, it read as a Plant with no Devices, so the fleet sat at
 * PARTIAL with "Plants online 3 / 4" and its capacity in the total (OASIS_2MW,
 * 22 Oct 2026). It is still named under the title, so a header saying more
 * Plants are visible than are counted says why.
 */

import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { DeviceHealth, PlantListItem } from "@/api/schemas";

function plant(id: number, code: string, status: string, dc: number): PlantListItem {
  return {
    id,
    code,
    name: code,
    status,
    ac_capacity_kw: null,
    dc_capacity_kwp: dc,
    region_code: null,
    device_count: 0,
    client_id: 1,
    client_code: "C",
    client_name: "Client",
  };
}

const PLANTS: PlantListItem[] = [
  plant(1, "KULAR_GREEN", "active", 5_500),
  plant(2, "OASIS_2MW", "decommissioned", 3_150),
  plant(3, "ORANGE_CIRCLE", "commissioning", 50_000),
];

const HEALTH: DeviceHealth[] = [
  {
    device_id: 11,
    device_code: "INVERTER_1",
    plant_id: 1,
    comm_status: "online",
    last_seen_at: null,
    frozen_tag_count: null,
    completeness_24h: null,
    updated_at: null,
    expected_interval_s: 30,
    reports_via_device_id: null,
  },
];

vi.mock("@/api/hooks", () => ({
  useAllPlants: () => ({ data: PLANTS, isLoading: false, isError: false }),
  useAlarms: () => ({ data: [] }),
  useDeviceHealth: () => ({ data: HEALTH }),
  usePlantKpiFanout: (plants: unknown[]) => ({ kpis: plants.map(() => undefined), isLoading: false }),
  usePlantDashboardFanout: (plants: unknown[]) => ({ dashboards: plants.map(() => undefined), isLoading: false }),
}));

vi.mock("@/auth/usePermission", () => ({ usePermission: () => true }));

// jsdom has no canvas; the headline donuts are not what is under test.
vi.mock("echarts", () => ({
  init: () => ({ setOption: () => {}, on: () => {}, resize: () => {}, dispose: () => {} }),
  connect: () => {},
}));

const { PortfolioDashboard } = await import("@/dashboards/PortfolioDashboard");

function wrap(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PortfolioDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Portfolio with a decommissioned Plant", () => {
  it("counts only the active Plant", () => {
    wrap();
    expect(screen.getByText(/computed across 1 active Plant\./)).toBeInTheDocument();
    // With the decommissioned Plant counted this read PARTIAL, 1 / 2.
    expect(screen.getByText("NORMAL")).toBeInTheDocument();
    expect(screen.queryByText("1 / 2")).not.toBeInTheDocument();
    expect(screen.getAllByText("1 / 1").length).toBeGreaterThan(0);
  });

  it("names it, apart from the Plants still onboarding", () => {
    wrap();
    const retired = screen.getByTestId("retired-notice");
    expect(retired).toHaveTextContent("1 more Plant is decommissioned and not counted: OASIS_2MW.");
    expect(screen.getByTestId("onboarding-notice")).toHaveTextContent(
      "1 more Plant is still onboarding",
    );
  });
});
