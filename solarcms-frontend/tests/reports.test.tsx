/**
 * The Reports screen: pick a type and a period, and the preview answers.
 *
 * Driven against a stubbed `fetch`, so what is asserted is what the screen
 * *asks the server for* — the period goes by name and is resolved in the
 * Plant's zone there, never computed from the browser's clock here.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me, ReportColumn, ReportTable } from "@/api/schemas";

const me: Me = {
  user_id: 1,
  client_id: 10,
  client_code: "SUNFIELD",
  client_name: "Sunfield Energy",
  role: "admin",
  platform_admin: false,
  permissions: ["dashboard.view", "report.generate"],
  plants: [{ id: 1, code: "SF_NORTH", name: "Sunfield North", status: "active" }],
  dashboards: [],
};

vi.mock("@/auth/AuthProvider", () => ({
  useAuth: () => ({ me, status: "authenticated" }),
}));

const printHtml = vi.fn();
vi.mock("@/dashboards/reports/printHtml", () => ({ printHtml: (html: string) => printHtml(html) }));

const triggerDownload = vi.fn();
vi.mock("@/api/client", async (original) => ({
  ...(await original<typeof import("@/api/client")>()),
  triggerDownload: (blob: Blob, name: string) => triggerDownload(blob, name),
}));

const { ReportsDashboard } = await import("@/dashboards/ReportsDashboard");
const { useSelection } = await import("@/state/selection");
const {
  customRangeProblem,
  formatReportCell,
  shiftDate,
} = await import("@/dashboards/reports/format");

const DAILY_COLUMNS: ReportColumn[] = [
  { key: "date", label: "Date", kind: "date", unit: "", digits: 1 },
  { key: "peak_power_kw", label: "Peak power", kind: "number", unit: "kW", digits: 1 },
  { key: "energy_kwh", label: "Export energy", kind: "number", unit: "kWh", digits: 1 },
  { key: "coverage", label: "Coverage", kind: "percent", unit: "%", digits: 0 },
];

function table(period: string, days: string[]): ReportTable {
  return {
    kind: "daily_plant",
    title: "Daily Plant Report",
    plant: { id: 1, code: "SF_NORTH", name: "Sunfield North", timezone: "Asia/Kolkata" },
    period,
    first_day: days[0]!,
    last_day: days[days.length - 1]!,
    start: "2026-09-27T18:30:00Z",
    end: "2026-09-28T10:48:00Z",
    source_tier: "agg_1m",
    columns: DAILY_COLUMNS,
    rows: days.map((date, index) => ({
      date,
      peak_power_kw: 3176.15,
      // The first day of a longer range has nothing to read.
      energy_kwh: index === 0 && days.length > 1 ? null : 1265.9,
      coverage: 4.4,
    })),
    flags: [],
    notes: ["Energy is read from the ABT Meter (ENERGY_EXPORT_TOTAL)."],
    truncated: false,
    generated_at: "2026-09-28T10:48:00Z",
  };
}

const requested: URL[] = [];
let pdfInstalled = false;

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  requested.length = 0;
  pdfInstalled = false;
  printHtml.mockClear();
  triggerDownload.mockClear();
  useSelection.getState().reset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      requested.push(url);
      const path = url.pathname.replace(/^\/api/, "");
      if (path === "/plants/1") {
        return respond({ id: 1, code: "SF_NORTH", name: "Sunfield North", status: "active",
          ac_capacity_kw: "4800", dc_capacity_kwp: "5760", latitude: null, longitude: null,
          timezone: "Asia/Kolkata", region_code: null, grid_factor: null, commissioned_on: null });
      }
      if (path === "/reports/definitions") return respond([]);
      if (path === "/reports/tables/daily_plant/export") {
        const format = url.searchParams.get("format");
        if (format === "pdf" && !pdfInstalled) {
          return respond({ title: "Error", status: 503,
            detail: "PDF rendering is not installed on this server." }, 503);
        }
        return new Response(format === "html" ? "<html>report</html>" : "file", { status: 200 });
      }
      if (path === "/reports/tables/daily_plant") {
        const period = url.searchParams.get("period") ?? "today";
        const days = period === "last_7_days"
          ? ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26",
             "2026-09-27", "2026-09-28"]
          : period === "custom"
            ? [url.searchParams.get("from_date")!, url.searchParams.get("to_date")!]
            : ["2026-09-28"];
        return respond(table(period, days));
      }
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

const tableRequests = () =>
  requested.filter((url) => url.pathname.endsWith("/reports/tables/daily_plant"));

describe("Reports screen", () => {
  it("previews today's Daily Plant Report for the chosen Plant", async () => {
    renderScreen();
    expect(
      await screen.findByText("Daily Plant Report — preview (1 row)"),
    ).toBeInTheDocument();
    const first = tableRequests()[0]!;
    expect(first.searchParams.get("plant_id")).toBe("1");
    expect(first.searchParams.get("period")).toBe("today");
    expect(screen.getByText("Peak power (kW)")).toBeInTheDocument();
    expect(screen.getByText("1,265.9")).toBeInTheDocument();
  });

  it("asks for the period by name and swaps the rows when it changes", async () => {
    renderScreen();
    await screen.findByText("Daily Plant Report — preview (1 row)");
    fireEvent.click(screen.getByRole("radio", { name: "Last 7 Days" }));
    expect(
      await screen.findByText("Daily Plant Report — preview (7 rows)"),
    ).toBeInTheDocument();
    expect(tableRequests().at(-1)!.searchParams.get("period")).toBe("last_7_days");
    // Nothing to read is a dash, never a zero.
    const firstRow = screen.getByText("22-09-2026").closest("tr")!;
    expect(within(firstRow).getByText("—")).toBeInTheDocument();
  });

  it("opens a custom range on the Plant's last seven days and sends its dates", async () => {
    renderScreen();
    await screen.findByText("Daily Plant Report — preview (1 row)");
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const first = screen.getByLabelText("First day") as HTMLInputElement;
    const last = screen.getByLabelText("Last day") as HTMLInputElement;
    expect(shiftDate(last.value, -6)).toBe(first.value);

    fireEvent.change(first, { target: { value: "2026-09-01" } });
    fireEvent.change(last, { target: { value: "2026-09-03" } });
    await waitFor(() => {
      const url = tableRequests().at(-1)!;
      expect(url.searchParams.get("period")).toBe("custom");
      expect(url.searchParams.get("from_date")).toBe("2026-09-01");
      expect(url.searchParams.get("to_date")).toBe("2026-09-03");
    });
  });

  it("does not ask for a backwards range, and says why", async () => {
    renderScreen();
    await screen.findByText("Daily Plant Report — preview (1 row)");
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const first = (screen.getByLabelText("First day") as HTMLInputElement).value;
    // A last day before the first the range opened with.
    fireEvent.change(screen.getByLabelText("Last day"), {
      target: { value: shiftDate(first, -1) },
    });
    expect(await screen.findByText("The last day is before the first.")).toBeInTheDocument();
    expect(
      tableRequests().filter((url) => url.searchParams.get("to_date") === shiftDate(first, -1)),
    ).toHaveLength(0);
  });

  it("downloads Excel under the server's filename", async () => {
    renderScreen();
    await screen.findByText("Daily Plant Report — preview (1 row)");
    fireEvent.click(screen.getByRole("button", { name: /Excel/ }));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledTimes(1));
    expect(triggerDownload.mock.calls[0]![1]).toBe("SF_NORTH_daily_plant_20260928_20260928.xlsx");
  });

  it("prints the page when the server cannot render a PDF, and says so", async () => {
    renderScreen();
    await screen.findByText("Daily Plant Report — preview (1 row)");
    fireEvent.click(screen.getByRole("button", { name: /PDF/ }));
    await waitFor(() => expect(printHtml).toHaveBeenCalledWith("<html>report</html>"));
    expect(screen.getByText(/print dialog/)).toBeInTheDocument();
    expect(triggerDownload).not.toHaveBeenCalled();
  });
});

describe("report cell formatting", () => {
  const column = (kind: ReportColumn["kind"], digits = 1): ReportColumn =>
    ({ key: "k", label: "K", kind, unit: "", digits });

  it("reads a Plant date as text, never through a UTC Date", () => {
    expect(formatReportCell(column("date"), "2026-09-28", "America/Los_Angeles"))
      .toBe("28-09-2026");
  });

  it("names a month as the files do", () => {
    expect(formatReportCell(column("month"), "2026-09", "Asia/Kolkata")).toBe("Sep 2026");
  });

  it("shows a datetime in the Plant's zone", () => {
    expect(formatReportCell(column("datetime"), "2026-09-28T09:00:00+05:30", "Asia/Kolkata"))
      .toBe("28-09-2026 09:00:00");
  });

  it("never puts a decimal on a count, and never a zero for nothing", () => {
    expect(formatReportCell(column("count", 0), 3, "UTC")).toBe("3");
    expect(formatReportCell(column("number"), null, "UTC")).toBe("—");
    expect(formatReportCell(column("number", 2), 50.0006, "UTC")).toBe("50.00");
  });

  it("checks a custom range the way the server will", () => {
    expect(customRangeProblem("2026-09-01", "2026-09-29", "2026-09-28", 366))
      .toMatch(/after today/);
    expect(customRangeProblem("2025-01-01", "2026-09-01", "2026-09-28", 366))
      .toMatch(/at most 366/);
    expect(customRangeProblem("2026-09-01", "2026-09-28", "2026-09-28", 366)).toBeNull();
  });
});
