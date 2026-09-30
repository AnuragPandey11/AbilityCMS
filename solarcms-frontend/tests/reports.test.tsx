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
  customRangeEnd,
  customRangeProblem,
  formatReportCell,
  formatReportPeriod,
  shiftDate,
} = await import("@/dashboards/reports/format");
const { reportFilename } = await import("@/api/endpoints/reports");

const DAILY_COLUMNS: ReportColumn[] = [
  { key: "date", label: "Date", kind: "date", unit: "", digits: 1 },
  { key: "peak_power_kw", label: "Peak power", kind: "number", unit: "kW", digits: 1 },
  { key: "energy_kwh", label: "Export energy", kind: "number", unit: "kWh", digits: 1 },
  { key: "coverage", label: "Coverage", kind: "percent", unit: "%", digits: 0 },
];

function table(
  period: string,
  days: string[],
  times: { from_time?: string | null; to_time?: string | null } = {},
): ReportTable {
  return {
    kind: "daily_plant",
    title: "Daily Plant Report",
    plant: { id: 1, code: "SF_NORTH", name: "Sunfield North", timezone: "Asia/Kolkata" },
    period,
    first_day: days[0]!,
    last_day: days[days.length - 1]!,
    from_time: times.from_time ?? null,
    to_time: times.to_time ?? null,
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
        // The server keeps a time only where it cuts inside a day.
        const edge = (name: string, whole: string) => {
          const value = url.searchParams.get(name);
          return value === whole ? null : value;
        };
        return respond(table(period, days, {
          from_time: edge("from_time", "00:00"),
          to_time: edge("to_time", "23:59"),
        }));
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

  it("opens on whole days and sends the times it is narrowed to", async () => {
    renderScreen();
    await screen.findByText("Daily Plant Report — preview (1 row)");
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const start = screen.getByLabelText("Start time") as HTMLInputElement;
    const end = screen.getByLabelText("End time") as HTMLInputElement;
    expect([start.value, end.value]).toEqual(["00:00", "23:59"]);
    // Whole days: the preview names the days alone.
    expect(await screen.findByText(/Sunfield North \(SF_NORTH\) · \d{2}-\d{2}-\d{4} to/))
      .not.toHaveTextContent(/00:00/);

    fireEvent.change(screen.getByLabelText("First day"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2026-09-03" } });
    fireEvent.change(start, { target: { value: "06:00" } });
    fireEvent.change(end, { target: { value: "18:00" } });
    await waitFor(() => {
      const url = tableRequests().at(-1)!;
      expect(url.searchParams.get("from_time")).toBe("06:00");
      expect(url.searchParams.get("to_time")).toBe("18:00");
    });
    expect(
      await screen.findByText(
        "Sunfield North (SF_NORTH) · 01-09-2026 06:00 to 03-09-2026 18:00 · Kolkata time",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Excel/ }));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalledTimes(1));
    expect(triggerDownload.mock.calls[0]![1])
      .toBe("SF_NORTH_daily_plant_20260901T0600_20260903T1800.xlsx");
    const exported = requested.filter((url) => url.pathname.endsWith("/export")).at(-1)!;
    expect(exported.searchParams.get("from_time")).toBe("06:00");
    expect(exported.searchParams.get("to_time")).toBe("18:00");
  });

  it("does not ask for a day whose end is before its start, and says why", async () => {
    renderScreen();
    await screen.findByText("Daily Plant Report — preview (1 row)");
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("First day"), { target: { value: "2026-09-02" } });
    fireEvent.change(screen.getByLabelText("Last day"), { target: { value: "2026-09-02" } });
    fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "18:00" } });
    fireEvent.change(screen.getByLabelText("End time"), { target: { value: "06:00" } });
    expect(await screen.findByText("The end is not after the start.")).toBeInTheDocument();
    expect(
      tableRequests().filter((url) => url.searchParams.get("to_time") === "06:00"),
    ).toHaveLength(0);
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
    const now = "2026-09-28T16:18";
    const days = (fromDate: string, toDate: string, fromTime = "00:00", toTime = "23:59") =>
      customRangeProblem({ fromDate, fromTime, toDate, toTime }, now, 366);
    expect(days("2026-09-01", "2026-09-29")).toMatch(/after today/);
    expect(days("2025-01-01", "2026-09-01")).toMatch(/at most 366/);
    expect(days("2026-09-01", "2026-09-28")).toBeNull();
    // Times: the period stops at the end time, so an equal pair is empty.
    expect(days("2026-09-02", "2026-09-02", "06:00", "06:00")).toMatch(/not after the start/);
    expect(days("2026-09-02", "2026-09-02", "06:00", "00:00")).toMatch(/not after the start/);
    expect(days("2026-09-02", "2026-09-02", "06:00", "06:01")).toBeNull();
    expect(days("2026-09-28", "2026-09-28", "16:18", "23:59")).toBeNull();
    expect(days("2026-09-28", "2026-09-28", "16:19", "23:59")).toMatch(/after now \(16:18\)/);
    expect(days("2026-09-02", "2026-09-02", "", "18:00")).toMatch(/start and an end time/);
  });

  it("reads 23:59 as the end of its day, as the server does", () => {
    const range = { fromDate: "2026-09-01", fromTime: "00:00", toDate: "2026-09-03" };
    expect(customRangeEnd({ ...range, toTime: "23:59" })).toBe("2026-09-04T00:00");
    expect(customRangeEnd({ ...range, toTime: "18:00" })).toBe("2026-09-03T18:00");
  });

  it("names a period cut inside a day with both its times", () => {
    const period = { first_day: "2026-09-22", last_day: "2026-09-28" };
    expect(formatReportPeriod(period)).toBe("22-09-2026 to 28-09-2026");
    expect(formatReportPeriod({ ...period, from_time: "06:00", to_time: null }))
      .toBe("22-09-2026 06:00 to 28-09-2026 23:59");
    expect(formatReportPeriod({ first_day: "2026-09-28", last_day: "2026-09-28",
      from_time: "06:00", to_time: "18:00" })).toBe("28-09-2026 06:00 to 18:00");
    expect(reportFilename({ ...table("custom", ["2026-09-22", "2026-09-28"]),
      to_time: "18:00" }, "csv")).toBe("SF_NORTH_daily_plant_20260922T0000_20260928T1800.csv");
  });
});
