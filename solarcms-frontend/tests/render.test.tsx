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
        children: [
          {
            device_id: 4,
            code: "INV-01",
            name: "Inverter",
            type: "INVERTER",
            variant: "central",
            children: [],
          },
        ],
      },
    ],
    excluded_not_in_power_path: [{ device_id: 3, code: "WMS-01", type: "WMS" }],
    orphaned: [],
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
