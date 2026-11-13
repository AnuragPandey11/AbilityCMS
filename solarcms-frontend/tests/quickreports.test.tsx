/**
 * Quick reports: saved custom reports a reader pins to the top of Reports.
 *
 * Driven against a stubbed `fetch`, so what is asserted is what the screen
 * sends: a download posts the saved definition as it is (the server resolves
 * its period now), and every change to the row is one PUT of the whole row.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "@/api/schemas";
import type { CustomReportDefinition, SavedReport } from "@/api/endpoints/reports";

const me: Me = {
  user_id: 1,
  client_id: 10,
  client_code: "SUNFIELD",
  client_name: "Sunfield Energy",
  role: "admin",
  platform_admin: false,
  permissions: ["dashboard.view", "report.generate"],
  plants: [
    { id: 1, code: "SF_NORTH", name: "Sunfield North", status: "active" },
    { id: 2, code: "SF_SOUTH", name: "Sunfield South", status: "active" },
  ],
  dashboards: [],
};

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated" }),
}));

const triggerDownload = vi.fn();
vi.mock("@/api/client", async (original) => ({
  ...(await original<typeof import("@/api/client")>()),
  triggerDownload: (blob: Blob, name: string) => triggerDownload(blob, name),
}));

const { ReportsDashboard } = await import("@/dashboards/ReportsDashboard");
const { useSelection } = await import("@/state/selection");
const rules = await import("@/dashboards/reports/quickReportRules");

const WEEKLY: CustomReportDefinition = {
  name: "Inverter power",
  plant_ids: [1],
  series: [
    { device_id: 11, tag_code: "AC_ACTIVE_POWER" },
    { device_id: 12, tag_code: "AC_ACTIVE_POWER" },
  ],
  interval_minutes: 60,
  aggregation: "auto",
  period: "last_7_days",
};

function savedReport(id: number, name: string, pin: number | null, definition = WEEKLY): SavedReport {
  return {
    id,
    name,
    definition: { ...definition, name },
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    created_by: 1,
    created_by_email: "sunfield@example.com",
    can_change: true,
    pin_position: pin,
  };
}

let saved: SavedReport[] = [];
const sent: { method: string; path: string; body: unknown; format: string | null }[] = [];

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  saved = [];
  sent.length = 0;
  triggerDownload.mockClear();
  useSelection.getState().reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const path = url.pathname.replace(/^\/api/, "");
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
      sent.push({ method, path, body, format: url.searchParams.get("format") });
      if (path === "/plants/1") {
        return respond({ id: 1, code: "SF_NORTH", name: "Sunfield North", status: "active",
          ac_capacity_kw: "4800", dc_capacity_kwp: "5760", latitude: null, longitude: null,
          timezone: "Asia/Kolkata", region_code: null, grid_factor: null, commissioned_on: null });
      }
      if (path === "/reports/custom/saved") return respond(saved);
      if (path === "/reports/custom/pins" && method === "PUT") {
        const ids = (body as { report_ids: number[] }).report_ids;
        saved = saved.map((report) => {
          const at = ids.indexOf(report.id);
          return { ...report, pin_position: at === -1 ? null : at + 1 };
        });
        return respond({ limit: 5, report_ids: ids });
      }
      if (path === "/reports/custom/export") return new Response("file", { status: 200 });
      if (path === "/reports/custom/catalog") return respond({ plants: [], devices: [] });
      if (path === "/reports/definitions") return respond([]);
      return respond({ detail: `unexpected ${path}` }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ReportsDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pinWrites = () => sent.filter((call) => call.path === "/reports/custom/pins");

describe("Quick reports on the Reports screen", () => {
  it("shows the pinned reports in the reader's order, and only those", async () => {
    saved = [
      savedReport(1, "Daily meters", 2),
      savedReport(2, "Not pinned", null),
      savedReport(3, "Inverter power", 1),
    ];
    renderScreen();
    const cards = await screen.findAllByRole("article");
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Inverter power",
      "Daily meters",
    ]);
    expect(within(cards[0]!).getByText("Sunfield North")).toBeInTheDocument();
    expect(within(cards[0]!).getByText("2 columns · every 1 hour · Last 7 days")).toBeInTheDocument();
    expect(screen.queryByText("Not pinned")).not.toBeInTheDocument();
  });

  it("downloads a pinned report by posting its saved definition as it is", async () => {
    saved = [savedReport(3, "Inverter power", 1)];
    renderScreen();
    const card = await screen.findByRole("article", { name: "Inverter power" });
    fireEvent.click(within(card).getByRole("button", { name: /Excel/ }));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledTimes(1));
    const exported = sent.find((call) => call.path === "/reports/custom/export");
    expect(exported?.format).toBe("xlsx");
    // The period goes by name, so the server runs it against today.
    expect(exported?.body).toMatchObject({ period: "last_7_days", series: WEEKLY.series });
    expect(triggerDownload.mock.calls[0]![1]).toMatch(/^Inverter_power_\d{8}\.xlsx$/);
  });

  it("unpins with one write of the rest of the row", async () => {
    saved = [savedReport(1, "Daily meters", 2), savedReport(3, "Inverter power", 1)];
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Unpin Inverter power" }));
    await waitFor(() => expect(pinWrites()).toHaveLength(1));
    expect(pinWrites()[0]!.body).toEqual({ report_ids: [1] });
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Inverter power" })).not.toBeInTheDocument(),
    );
  });

  it("says how to pin when nothing is pinned", async () => {
    saved = [savedReport(2, "Not pinned", null)];
    renderScreen();
    expect(await screen.findByText(/press Pin to download it from here/)).toBeInTheDocument();
  });

  it("opens a pinned report in the builder", async () => {
    saved = [savedReport(3, "Inverter power", 1)];
    renderScreen();
    const card = await screen.findByRole("article", { name: "Inverter power" });
    fireEvent.click(within(card).getByRole("button", { name: "Open" }));
    expect(await screen.findByDisplayValue("Inverter power")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin" })).toBeInTheDocument();
  });

  it("asks which report to replace when the row is full, then writes the row once", async () => {
    saved = [
      ...[1, 2, 3, 4, 5].map((n) => savedReport(n, `Pinned ${n}`, n)),
      savedReport(6, "Sixth", null),
    ];
    renderScreen();
    await screen.findAllByRole("article");
    fireEvent.click(screen.getByText("Build your own"));
    fireEvent.change(await screen.findByLabelText("Open a saved report"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin to quick reports" }));
    const chooser = await screen.findByRole("group", { name: "Choose a quick report to replace" });
    expect(pinWrites()).toHaveLength(0);
    fireEvent.click(within(chooser).getByRole("button", { name: "Replace Pinned 2" }));
    await waitFor(() => expect(pinWrites()).toHaveLength(1));
    expect(pinWrites()[0]!.body).toEqual({ report_ids: [1, 6, 3, 4, 5] });
  });
});

describe("quick report rules", () => {
  it("adds at the end, replaces in place, and never twice", () => {
    expect(rules.withPin([1, 2], 3)).toEqual([1, 2, 3]);
    expect(rules.withPin([1, 2, 3], 9, 2)).toEqual([1, 9, 3]);
    expect(rules.withPin([1, 2], 2)).toEqual([1, 2]);
    expect(rules.withoutPin([1, 2, 3], 2)).toEqual([1, 3]);
  });

  it("names a fixed custom range as fixed, and a named period by name", () => {
    expect(rules.periodWords({ ...WEEKLY, period: "yesterday" })).toBe("Yesterday");
    expect(
      rules.periodWords({
        ...WEEKLY,
        period: "custom",
        from_date: "2026-03-01",
        to_date: "2026-03-31",
        from_time: "00:00",
        to_time: "23:59",
      }),
    ).toBe("01-03-2026 to 31-03-2026 (fixed dates)");
  });

  it("names a last N days period as a count that moves with the calendar", () => {
    expect(rules.periodWords({ ...WEEKLY, period: "last_14_days" })).toBe("Last 14 days");
    expect(rules.periodWords({ ...WEEKLY, period: "last_1_days" })).toBe("Last 1 day");
  });

  it("words an interval as people say it", () => {
    expect(rules.intervalWords(15)).toBe("15 min");
    expect(rules.intervalWords(60)).toBe("1 hour");
    expect(rules.intervalWords(360)).toBe("6 hours");
    expect(rules.intervalWords(1440)).toBe("1 day");
    expect(rules.intervalWords(90)).toBe("90 min");
  });

  it("lists only the Plants the reader can see", () => {
    const plants = [{ id: 1, name: "Sunfield North" }];
    expect(rules.plantWords({ ...WEEKLY, plant_ids: [1, 7] }, plants)).toBe("Sunfield North");
    expect(rules.plantWords({ ...WEEKLY, plant_ids: [7] }, plants)).toBe(
      "No Plant of this report is visible to you",
    );
  });

  it("names the file after the report and the day it was run", () => {
    expect(rules.quickReportFilename(" Inverter power / hourly ", "csv", new Date(2026, 10, 3))).toBe(
      "Inverter_power_hourly_20261103.csv",
    );
    expect(rules.quickReportFilename("***", "pdf", new Date(2026, 0, 9))).toBe("report_20260109.pdf");
  });
});
