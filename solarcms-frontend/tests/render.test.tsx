/**
 * Render smoke tests.
 *
 * These catch what a typecheck cannot: an import cycle, a hook called
 * conditionally, a component that throws on its empty state. Every screen here
 * is rendered with no data, because the empty state is the state most of these
 * screens are actually in today (§0.4).
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

import { KpiTile, StatTile } from "@/components/charts/KpiTile";
import { StatusIndicator } from "@/components/charts/DigitalStatus";
import { SldTree } from "@/components/sld/SldTree";
import { DataTable } from "@/components/tables/DataTable";
import { AwaitingDeviceDataState, ErrorState } from "@/components/state";
import { PlantStatusBadge, CommStatusBadge } from "@/components/domain";
import { LoginPage } from "@/components/layout/LoginPage";
import { AuthProvider } from "@/auth/AuthProvider";
import { ApiError } from "@/api/problem";
import type { Sld } from "@/api/schemas";
import { PlantDonut, plantMarks } from "@/dashboards/fleet/HeadlineCharts";

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("KPI tiles", () => {
  it("renders an undefined KPI as a dash with its reason, never as 0", () => {
    wrap(
      <KpiTile
        label="Performance ratio"
        kind="ratio"
        figure={{
          value: null,
          variant: "poa_uncorrected",
          undefined_reason: "no irradiation in period",
        }}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.getByText(/no irradiation in period/)).toBeInTheDocument();
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
  });

  it("surfaces the provisional formula variant when a value is defined", () => {
    wrap(
      <KpiTile
        label="PR"
        kind="ratio"
        figure={{ value: 0.812, variant: "poa_uncorrected", undefined_reason: null }}
      />,
    );
    expect(screen.getByText("81.2%")).toBeInTheDocument();
    expect(screen.getByText(/OPEN-16/)).toBeInTheDocument();
  });

  it("renders a plain stat tile", () => {
    wrap(<StatTile label="Devices" value="3" />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});

describe("fleet headline donut", () => {
  const plants = [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `Plant ${id}`, code: `P${id}` }));
  const donut = (values: (number | null)[], highlight: number | null = null) =>
    wrap(
      <PlantDonut
        label="Energy"
        marks={plantMarks(plants.slice(0, values.length), (id) => values[id - 1])}
        unit="kWh"
        empty="Nothing generated yet"
        highlight={highlight}
        onHighlight={() => undefined}
      />,
    );

  it("names every Plant with its share, and the largest in the centre", () => {
    donut([100, 300]);
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getAllByText("75%")).toHaveLength(2);
    // Once in the legend, once in the centre.
    expect(screen.getAllByText("P2")).toHaveLength(2);
  });

  it("refuses to split a total of zero", () => {
    const { container } = donut([0, 0]);
    expect(container.querySelectorAll("circle[stroke-dasharray]")).toHaveLength(0);
    expect(screen.getByText("Nothing generated yet")).toBeTruthy();
  });

  it("says there is no figure, which is not the same as every figure being zero", () => {
    donut([null, null]);
    expect(screen.getByText("No figure")).toBeTruthy();
  });

  it("puts a Plant highlighted from another tile in the centre", () => {
    donut([100, 300], 1);
    expect(screen.getAllByText("P1")).toHaveLength(2);
    expect(screen.getAllByText("25%")).toHaveLength(2);
  });

  it("names the largest Plant in the centre, never the Other that adds several up", () => {
    wrap(
      <PlantDonut
        label="Energy"
        marks={plantMarks(plants, (id) => (id >= 5 ? 400 : 100))}
        unit="kWh"
        empty="Nothing generated yet"
        highlight={null}
        onHighlight={() => undefined}
      />,
    );
    // Other is 800 of 1,200 — the biggest segment — but it is not a Plant.
    expect(screen.getAllByText("P1")).toHaveLength(2);
    expect(screen.getAllByText("Other")).toHaveLength(1);
  });

  it("against a capacity, fills to the share in use and lists amounts", () => {
    const { container } = wrap(
      <PlantDonut
        label="Live generation"
        marks={plantMarks(plants.slice(0, 2), (id) => (id === 1 ? 300 : 100))}
        unit="kW"
        capacity={800}
        empty="No Plant is reporting power"
        highlight={null}
        onHighlight={() => undefined}
      />,
    );
    expect(screen.getByText("50%")).toBeTruthy();
    expect(screen.getByText("of capacity")).toBeTruthy();
    expect(screen.getByText("300")).toBeTruthy();
    expect(container.querySelectorAll("circle[stroke-dasharray]")).toHaveLength(2);
  });

  it("never draws output past the capacity as a full ring", () => {
    // A clamped ring says "exactly full"; the number says "impossible".
    const { container } = wrap(
      <PlantDonut
        label="Live generation"
        marks={plantMarks(plants.slice(0, 2), () => 900)}
        unit="kW"
        capacity={1000}
        empty="No Plant is reporting power"
        highlight={null}
        onHighlight={() => undefined}
      />,
    );
    expect(screen.getByText("180%")).toBeTruthy();
    expect(container.querySelectorAll("circle[stroke-dasharray]")).toHaveLength(0);
  });

  it("keeps a Plant's colour whatever its share, and folds the tail into a grey Other", () => {
    // Colour follows the Plant, not its rank in this donut.
    const marks = plantMarks(plants, (id) => (id === 1 ? 1 : 100 * id));
    expect(marks[0].colour).toBe("rgb(var(--c-series-1))");
    expect(marks).toHaveLength(5);
    expect(marks[4]).toMatchObject({ key: "other", value: 1100, plantIds: [5, 6] });
  });
});

describe("Digital Inputs", () => {
  it("renders an unknown contact as a dash, not OFF", () => {
    wrap(<StatusIndicator label="Trip" value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("OFF")).not.toBeInTheDocument();
  });

  it("renders 0 as OFF and 1 as ON", () => {
    const { unmount } = wrap(<StatusIndicator label="Trip" value={0} />);
    expect(screen.getByText("OFF")).toBeInTheDocument();
    unmount();
    wrap(<StatusIndicator label="Trip" value={1} />);
    expect(screen.getByText("ON")).toBeInTheDocument();
  });
});

describe("the Single Line Diagram", () => {
  const sld: Sld = {
    plant_id: 1,
    device_count: 2,
    roots: [
      {
        device_id: 1,
        code: "MFM-01",
        name: "Feeder Meter",
        type: "MFM",
        variant: null,
        collector_code: null,
        children: [
          {
            device_id: 4,
            code: "INV-01",
            name: "Inverter",
            type: "INVERTER",
            variant: "central",
            collector_code: "MCR",
            children: [],
          },
        ],
      },
    ],
    excluded_not_in_power_path: [
      { device_id: 3, code: "WMS-01", name: "Weather Station", type: "WMS",
        variant: null, collector_code: null },
    ],
    orphaned: [],
    collectors: [
      {
        code: "MCR",
        device_ids: [4],
        device_count: 1,
        in_power_path_count: 1,
        // The one edge the box owns: the MCR feeds the meter. Said once, on
        // the enclosure, instead of once per Device inside it.
        parent_device_id: 1,
      },
    ],
  };

  it("draws the power-path nodes", () => {
    wrap(
      <SldTree
        sld={sld}
        overlay={{ commStatus: {}, livePower: {}, staleDevices: new Set() }}
      />,
    );
    expect(screen.getByText("MFM-01")).toBeInTheDocument();
    expect(screen.getByText("INV-01")).toBeInTheDocument();
  });

  it("says so plainly when nothing is in the power path", () => {
    wrap(
      <SldTree
        sld={{ ...sld, roots: [], device_count: 0 }}
        overlay={{ commStatus: {}, livePower: {}, staleDevices: new Set() }}
      />,
    );
    expect(screen.getByText(/no electrical tree to draw/i)).toBeInTheDocument();
  });

  it("labels the collector as an enclosure, and draws no node for it", () => {
    wrap(
      <SldTree
        sld={sld}
        overlay={{ commStatus: {}, livePower: {}, staleDevices: new Set() }}
      />,
    );
    // The outline's label. Spelled out as "collector" beside the name,
    // because an unlabelled dashed box is read as a selection by some people
    // and as a fault region by others.
    expect(screen.getByText("MCR")).toBeInTheDocument();
    expect(screen.getByText(/collector · 1/)).toBeInTheDocument();
    // Two Devices in the power path, two nodes. The room is not a third.
    expect(screen.getByText("MFM-01")).toBeInTheDocument();
    expect(screen.getByText("INV-01")).toBeInTheDocument();
  });

  it("offers zoom and full screen, because the diagram outgrows a phone", () => {
    wrap(
      <SldTree
        sld={sld}
        overlay={{ commStatus: {}, livePower: {}, staleDevices: new Set() }}
      />,
    );
    for (const label of ["Zoom in", "Zoom out", "Fit to view", "Full screen"]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });
});

describe("states", () => {
  it("explains an awaiting-data screen rather than showing a blank panel", () => {
    wrap(<AwaitingDeviceDataState screen="Inverter Monitoring" />);
    expect(screen.getByText(/nothing here is broken/i)).toBeInTheDocument();
    expect(screen.getByText(/simulate\.py/)).toBeInTheDocument();
  });

  it("never shows a 500's detail", () => {
    const error = new ApiError({
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
      detail: "relation readings does not exist for role solarcms_api",
    });
    wrap(<ErrorState error={error} />);
    expect(screen.queryByText(/solarcms_api/)).not.toBeInTheDocument();
    expect(screen.getByText(/logged/i)).toBeInTheDocument();
  });
});

describe("badges", () => {
  it("marks an onboarding Plant as excluded from totals", () => {
    wrap(<PlantStatusBadge status="draft" />);
    expect(screen.getByTitle(/Excluded from portfolio totals/)).toBeInTheDocument();
  });

  it("distinguishes communication loss from equipment downtime", () => {
    wrap(<CommStatusBadge status="offline" />);
    expect(screen.getByTitle(/not equipment downtime/)).toBeInTheDocument();
  });
});

describe("DataTable", () => {
  it("renders rows and an empty message", () => {
    const columns = [
      { key: "a", header: "Name", render: (r: { a: string }) => r.a, sortValue: (r: { a: string }) => r.a },
    ];
    const { unmount } = wrap(
      <DataTable rows={[{ a: "one" }]} columns={columns} rowKey={(r) => r.a} />,
    );
    expect(screen.getByText("one")).toBeInTheDocument();
    unmount();
    wrap(<DataTable rows={[]} columns={columns} rowKey={(r) => r.a} emptyMessage="Nothing" />);
    expect(screen.getByText("Nothing")).toBeInTheDocument();
  });
});

describe("login", () => {
  it("renders without revealing anything about accounts", () => {
    wrap(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });
});
