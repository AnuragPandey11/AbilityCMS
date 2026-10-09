/**
 * The Inverter ranking: ranks within a variant only, never ranks a missing
 * figure last, never prices a stop it cannot size, and says how much of the
 * period it actually heard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InverterRankingSchema, type InverterRanking } from "@/api/schemas";
import {
  defaultMeasure,
  rankWithinVariants,
  totals,
} from "@/dashboards/inverters/ranking";

const auth = vi.hoisted(() => ({
  me: { permissions: ["dashboard.view", "plant.manage"], plants: [], dashboards: [] } as {
    permissions: string[];
    plants: unknown[];
    dashboards: unknown[];
  },
}));
vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me: auth.me, status: "authenticated", refreshMe: vi.fn(), logout: vi.fn() }),
}));

const ranking = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/api/hooks", () => ({
  useInverterRanking: () => ({
    data: ranking.data,
    isLoading: false,
    isError: false,
    isPlaceholderData: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

const devices = vi.hoisted(() => ({ updateDevice: vi.fn(async () => ({})) }));
vi.mock("@/api/endpoints/devices", () => devices);
const plants = vi.hoisted(() => ({ updatePlant: vi.fn(async () => ({})) }));
vi.mock("@/api/endpoints/plants", () => plants);

import { InverterRankingPanel } from "@/dashboards/inverters/InverterRankingPanel";

const explained = (value: number | null, reason: string | null = null) => ({
  value,
  undefined_reason: value === null ? (reason ?? "not worked out") : null,
});

function inverter(over: Record<string, unknown>) {
  return {
    device_id: 1,
    code: "INVERTER_1",
    name: "INVERTER_1",
    variant: "string",
    comm_status: "online",
    dc_capacity_kwp: null,
    rated_capacity_kw: null,
    generation_kwh: 1000,
    generation_reason: null,
    refused_steps: 0,
    availability: explained(1),
    performance_ratio: explained(null, "no DC size is recorded for this Inverter"),
    generating_hours: 8,
    downtime_hours: 0,
    short_stop_hours: 0,
    no_data_hours: 0,
    planned_hours: 0,
    stop_count: 0,
    stops: [],
    lost_kwh: explained(0),
    loss_inr: explained(null, "no tariff is recorded for this Plant"),
    flagged_minutes: 0,
    ...over,
  };
}

function body(over: Record<string, unknown> = {}, rows?: Record<string, unknown>[]): InverterRanking {
  return InverterRankingSchema.parse({
    plant_id: 2,
    period: "today",
    first_day: "2026-10-09",
    last_day: "2026-10-09",
    period_start: "2026-10-08T18:30:00+00:00",
    period_end: "2026-10-09T10:30:00+00:00",
    timezone: "Asia/Kolkata",
    computed_at: "2026-10-09T10:30:00+00:00",
    tariff_inr_per_kwh: null,
    irradiation_kwh_m2: 4.2,
    irradiation_reason: null,
    energy_tier: "agg_1m",
    coverage: { period_hours: 16, heard_hours: 16, generating_hours: 8 },
    rule: { producing_above_kw: 0.5, min_stop_minutes: 10, status: "PROPOSED" },
    inverters: rows ?? [
      inverter({ device_id: 1, code: "INVERTER_1", generation_kwh: 1200 }),
      inverter({
        device_id: 2,
        code: "INVERTER_2",
        generation_kwh: 900,
        availability: explained(0.75),
        downtime_hours: 2,
        stop_count: 1,
        stops: [
          {
            start: "2026-10-09T05:00:00+00:00",
            end: "2026-10-09T07:00:00+00:00",
            minutes: 120,
            lost_kwh: null,
            ongoing: false,
          },
        ],
        lost_kwh: explained(null, "no DC size is recorded for this Inverter"),
        loss_inr: explained(null, "no DC size is recorded for this Inverter"),
      }),
      inverter({ device_id: 10, code: "INVERTER_10", generation_kwh: 1150 }),
    ],
    ...over,
  });
}

describe("ranking within variants", () => {
  it("ranks only within a variant, and an Inverter with no variant is ordered, not ranked", () => {
    const data = body({}, [
      inverter({ device_id: 1, code: "S1", variant: "string", availability: explained(0.9) }),
      inverter({ device_id: 2, code: "C1", variant: "central", availability: explained(0.5) }),
      inverter({ device_id: 3, code: "X1", variant: null, availability: explained(1) }),
    ]);
    const groups = rankWithinVariants(data.inverters, "availability");
    expect(groups.map((group) => group.variant)).toEqual(["string", "central", "unspecified"]);
    expect(groups[0].rows[0].rank).toBe(1);
    expect(groups[1].rows[0].rank).toBe(1);
    expect(groups[2].ranked).toBe(false);
    expect(groups[2].rows[0].rank).toBeNull();
  });

  it("never ranks a missing figure last; it is listed unranked after the ranked ones", () => {
    const data = body({}, [
      inverter({ device_id: 1, code: "INVERTER_1", performance_ratio: explained(null) }),
      inverter({ device_id: 2, code: "INVERTER_2", performance_ratio: explained(0.7) }),
      inverter({ device_id: 3, code: "INVERTER_3", performance_ratio: explained(0.8) }),
    ]);
    const [group] = rankWithinVariants(data.inverters, "pr");
    expect(group.rows.map((entry) => [entry.row.code, entry.rank])).toEqual([
      ["INVERTER_3", 1],
      ["INVERTER_2", 2],
      ["INVERTER_1", null],
    ]);
    expect(group.measured).toBe(2);
  });

  it("ties share a rank and the next skips, and less downtime ranks first", () => {
    const data = body({}, [
      inverter({ device_id: 1, code: "INVERTER_10", downtime_hours: 0 }),
      inverter({ device_id: 2, code: "INVERTER_2", downtime_hours: 0 }),
      inverter({ device_id: 3, code: "INVERTER_3", downtime_hours: 1.5 }),
    ]);
    const [group] = rankWithinVariants(data.inverters, "downtime");
    expect(group.rows.map((entry) => [entry.row.code, entry.rank])).toEqual([
      ["INVERTER_2", 1],
      ["INVERTER_10", 1],
      ["INVERTER_3", 3],
    ]);
  });

  it("breaks a tie on availability by generation, so a healthy day still has an order", () => {
    const data = body({}, [
      inverter({ device_id: 1, code: "INVERTER_1", generation_kwh: 900 }),
      inverter({ device_id: 2, code: "INVERTER_2", generation_kwh: 1100 }),
      inverter({ device_id: 3, code: "INVERTER_3", generation_kwh: null }),
    ]);
    const [group] = rankWithinVariants(data.inverters, "availability");
    expect(group.rows.map((entry) => [entry.row.code, entry.rank])).toEqual([
      ["INVERTER_2", 1],
      ["INVERTER_1", 2],
      ["INVERTER_3", 3],
    ]);
  });

  it("ranks by PR where any Inverter has one, else by availability, which needs no sizes", () => {
    expect(defaultMeasure(body().inverters)).toBe("availability");
    const sized = body({}, [inverter({ performance_ratio: explained(0.8) })]);
    expect(defaultMeasure(sized.inverters)).toBe("pr");
  });

  it("totals say how many Inverters they left out", () => {
    const sums = totals(body().inverters);
    expect(sums.generationKwh).toEqual({ value: 3250, missing: 0 });
    expect(sums.lostKwh).toEqual({ value: 0, missing: 1 });
    expect(sums.unsized).toBe(3);
    expect(sums.stops).toBe(1);
  });
});

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <InverterRankingPanel
        plantId={2}
        plantName="Kular Green"
        timezone="Asia/Kolkata"
        plantDcKwp={3600}
        onSelect={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("the panel", () => {
  beforeEach(() => {
    ranking.data = body();
    auth.me = { permissions: ["dashboard.view", "plant.manage"], plants: [], dashboards: [] };
    devices.updateDevice.mockClear();
    plants.updatePlant.mockClear();
  });

  it("shows each Inverter's figures, and says what PR and loss are waiting for", () => {
    renderPanel();
    const row = screen.getByText("INVERTER_2").closest("tr") as HTMLElement;
    expect(within(row).getByText("75.0%")).toBeTruthy();
    expect(within(row).getByText("2.0 h")).toBeTruthy();
    expect(within(row).getByText("1 stop")).toBeTruthy();
    expect(screen.getByText(/PR and loss need each Inverter's DC size \(none is recorded\) and this Plant's tariff/)).toBeTruthy();
    // A stop it cannot size is "—", with the reason on hover — never ₹0.
    const cells = row.querySelectorAll("td");
    const loss = cells[cells.length - 1] as HTMLElement;
    expect(within(loss).getByText("—")).toBeTruthy();
    expect(within(loss).getByTitle(/Not worked out: no DC size is recorded/)).toBeTruthy();
  });

  it("ranks by availability while no sizes are recorded, and orders INVERTER_2 last", () => {
    renderPanel();
    const codes = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector("td .font-medium")?.textContent);
    expect(codes).toEqual(["INVERTER_1", "INVERTER_10", "INVERTER_2"]);
  });

  it("warns when the period was only partly heard", () => {
    ranking.data = body({ coverage: { period_hours: 24, heard_hours: 6, generating_hours: 2 } });
    renderPanel();
    expect(screen.getByText(/Readings are missing for the rest/)).toBeTruthy();
  });

  it("records sizes and the tariff through the routes that own them", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Sizes & tariff" }));
    fireEvent.change(screen.getByPlaceholderText("e.g. 3.45"), { target: { value: "3.5" } });
    fireEvent.change(screen.getByLabelText("Same size for all"), { target: { value: "1200" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill all" }));
    expect(screen.getByText(/Sizes add up to 3,600 kWp/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(devices.updateDevice).toHaveBeenCalledTimes(3));
    expect(devices.updateDevice).toHaveBeenCalledWith(1, { dc_capacity_kwp: 1200 });
    expect(plants.updatePlant).toHaveBeenCalledWith(2, { energy_tariff_inr_per_kwh: 3.5 });
  });

  it("offers no setup to someone who cannot manage the Plant, and says who can", () => {
    auth.me = { permissions: ["dashboard.view"], plants: [], dashboards: [] };
    renderPanel();
    expect(screen.queryByRole("button", { name: "Sizes & tariff" })).toBeNull();
    expect(screen.getByText(/An administrator records them/)).toBeTruthy();
  });
});
