/**
 * The history screens' pieces, rendered:
 *
 * - `useHistoryPeriod`: the link wins, the remembered period fills a link that
 *   names none, a bad link is rewritten rather than obeyed, and a change is
 *   written to both — replacing the history entry, never pushing one;
 * - `HistoryPeriodBar`: steps back and forward, refuses the future, takes a
 *   custom period only once it is one;
 * - `CalendarHeatmap`: a day nothing measured is an outline and not a shade,
 *   every day is a labelled button that opens it;
 * - `TrendChart`: the band, the event marks, a zoom that is remembered and
 *   reported, and a CSV button only where the caller allows one.
 */

import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Option = Record<string, unknown> & { series?: Record<string, unknown>[]; dataZoom?: Record<string, unknown>[] };
const painted: Option[] = [];
const handlers = new Map<string, (params: unknown) => void>();

vi.mock("echarts", () => ({
  init: () => ({
    setOption: (option: Option) => {
      painted.push(option);
    },
    on: (name: string, handler: (params: unknown) => void) => {
      handlers.set(name, handler);
    },
    resize: () => {},
    dispose: () => {},
  }),
}));

const { useHistoryPeriod } = await import("@/state/useHistoryPeriod");
const { useSelection } = await import("@/state/selection");
const { HistoryPeriodBar } = await import("@/components/history/HistoryPeriodBar");
const { CalendarHeatmap } = await import("@/dashboards/history/CalendarHeatmap");
const { metricOf } = await import("@/dashboards/history/metrics");
const { TrendChart } = await import("@/components/charts/TrendChart");
const { DEFAULT_PERIOD } = await import("@/api/historyPeriod");

beforeEach(() => {
  painted.length = 0;
  handlers.clear();
  useSelection.setState({ historyPeriod: DEFAULT_PERIOD });
});

// ── The shared period ────────────────────────────────────────────────────────

function routerAt(entry: string, seen: { search: string; action: string }[]) {
  function Spy(): null {
    const location = useLocation();
    seen.push({ search: location.search, action: (location.state as string) ?? "" });
    return null;
  }
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[entry]}>
      <Spy />
      {children}
    </MemoryRouter>
  );
}

describe("useHistoryPeriod", () => {
  it("takes the period from the link, and remembers it for the next screen", () => {
    const seen: { search: string; action: string }[] = [];
    const { result } = renderHook(() => useHistoryPeriod(), {
      wrapper: routerAt("/d/energy_analytics?from=2026-03-01&to=2026-03-31", seen),
    });
    expect(result.current.period).toEqual({ kind: "custom", from: "2026-03-01T00:00", to: "2026-04-01T00:00" });
    expect(useSelection.getState().historyPeriod).toEqual(result.current.period);
  });

  it("writes the remembered period into a link that names none", () => {
    useSelection.setState({ historyPeriod: { kind: "preset", preset: "last_month" } });
    const seen: { search: string; action: string }[] = [];
    const { result } = renderHook(() => useHistoryPeriod(), { wrapper: routerAt("/d/transformer_monitoring", seen) });
    expect(result.current.period).toEqual({ kind: "preset", preset: "last_month" });
    expect(seen.at(-1)?.search).toBe("?period=last_month");
  });

  it("rewrites a link that names a period badly, rather than obeying or guessing", () => {
    useSelection.setState({ historyPeriod: { kind: "preset", preset: "7d" } });
    const seen: { search: string; action: string }[] = [];
    const { result } = renderHook(() => useHistoryPeriod(), {
      wrapper: routerAt("/d/energy_analytics?from=2026-02-30&to=2026-03-02&device=4", seen),
    });
    expect(result.current.period).toEqual({ kind: "preset", preset: "7d" });
    // Other parameters survive.
    expect(seen.at(-1)?.search).toBe("?device=4&period=7d");
  });

  it("writes a change to both the link and the store", () => {
    const seen: { search: string; action: string }[] = [];
    const { result } = renderHook(() => useHistoryPeriod(), { wrapper: routerAt("/d/energy_analytics?period=today", seen) });
    act(() => result.current.setPeriod({ kind: "preset", preset: "this_year" }));
    expect(result.current.period).toEqual({ kind: "preset", preset: "this_year" });
    expect(useSelection.getState().historyPeriod).toEqual({ kind: "preset", preset: "this_year" });
    expect(seen.at(-1)?.search).toBe("?period=this_year");
  });

  it("does not trust a stored value from another build", () => {
    useSelection.setState({ historyPeriod: { kind: "custom", from: "garbage", to: "2026-01-01" } as never });
    const { result } = renderHook(() => useHistoryPeriod(), { wrapper: routerAt("/d/energy_analytics", []) });
    expect(result.current.period).toEqual(DEFAULT_PERIOD);
  });
});

// ── The bar ──────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 5, 10, 0);

describe("HistoryPeriodBar", () => {
  it("steps back to the previous period and will not step into the future", () => {
    const onChange = vi.fn();
    render(
      <HistoryPeriodBar period={{ kind: "preset", preset: "today" }} onChange={onChange} timezone="Asia/Kolkata" nowMs={NOW} />,
    );
    expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    expect(onChange).toHaveBeenCalledWith({ kind: "preset", preset: "yesterday" });
    expect(screen.getByText(/Showing/)).toHaveTextContent("Showing Today, in the Plant's time (Kolkata).");
  });

  it("says how coarse the readings are far back", () => {
    render(
      <HistoryPeriodBar
        period={{ kind: "custom", from: "2025-03-01T00:00", to: "2025-04-01T00:00" }}
        onChange={() => {}}
        timezone="Asia/Kolkata"
        nowMs={NOW}
      />,
    );
    expect(screen.getByText(/Showing/)).toHaveTextContent("March 2025");
    expect(screen.getByText(/15-minute averages/)).toBeInTheDocument();
  });

  it("applies a custom period only once both ends make one, and says why not", () => {
    const onChange = vi.fn();
    render(
      <HistoryPeriodBar
        period={{ kind: "custom", from: "2026-03-01T00:00", to: "2026-04-01T00:00" }}
        onChange={onChange}
        timezone="Asia/Kolkata"
        nowMs={NOW}
      />,
    );
    const to = screen.getByLabelText("To");
    fireEvent.change(to, { target: { value: "2026-02-01T00:00" } });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("The end must come after the start.")).toBeInTheDocument();
    fireEvent.change(to, { target: { value: "2026-03-15T00:00" } });
    expect(onChange).toHaveBeenCalledWith({ kind: "custom", from: "2026-03-01T00:00", to: "2026-03-15T00:00" });
  });

  it("offers nothing to type until the Plant's zone is known", () => {
    render(<HistoryPeriodBar period={{ kind: "custom", from: "2026-03-01T00:00", to: "2026-04-01T00:00" }} onChange={() => {}} timezone={undefined} nowMs={NOW} />);
    expect(screen.getByLabelText("From")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous period" })).toBeDisabled();
  });
});

// ── The calendar ─────────────────────────────────────────────────────────────

describe("CalendarHeatmap", () => {
  const days = [
    { date: "2026-03-01", energy: 100, coverage: 100 },
    { date: "2026-03-02", energy: null, coverage: null },
    { date: "2026-03-03", energy: 400, coverage: 50 },
  ].map(({ date, energy, coverage }) => ({
    date,
    in_progress: false,
    energy_kwh: energy,
    irradiation_kwh_m2: null,
    specific_yield: null,
    performance_ratio: null,
    performance_ratio_flagged: false,
    peak_power_kw: null,
    coverage,
  }));

  it("labels every day, draws nothing measured as an outline, and opens a day", () => {
    const onOpen = vi.fn();
    render(<CalendarHeatmap days={days} metric={metricOf("energy_kwh")} selected={null} onOpen={onOpen} />);
    const empty = screen.getByRole("button", { name: /02-03-2026, nothing measured/ });
    expect(empty.style.backgroundColor).toBe("");
    expect(empty.className).toContain("border-dashed");
    const full = screen.getByRole("button", { name: /01-03-2026, Energy 100\.0 kWh, coverage 100%/ });
    expect(full.style.backgroundColor).not.toBe("");
    fireEvent.click(screen.getByRole("button", { name: /03-03-2026/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-03-03" }));
    // Only the period's days are buttons: March's other 28 days are faint text.
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.getByText(/partial — under 90%/)).toBeInTheDocument();
  });
});

// ── The chart ────────────────────────────────────────────────────────────────

const points = [0, 1, 2, 3].map((hour) => ({
  at: `2026-03-01T0${hour}:00:00.000Z`,
  value: 10 + hour,
  contributors: 1,
  low: 5 + hour,
  high: 15 + hour,
}));

const lastOption = (): Option => {
  const option = painted.at(-1);
  if (!option) throw new Error("nothing painted");
  return option;
};

describe("TrendChart for long periods", () => {
  it("draws the band only when asked, as two stacked series behind the line", () => {
    const { rerender } = render(<TrendChart points={points} unit="°C" label="Temperature" tier="agg_1h" />);
    expect(lastOption().series).toHaveLength(1);
    rerender(<TrendChart points={points} unit="°C" label="Temperature" tier="agg_1h" band />);
    const series = lastOption().series!;
    expect(series).toHaveLength(3);
    expect(series[0]?.stack).toBe("band");
    expect(series[1]?.stack).toBe("band");
    expect(screen.getByText(/lowest to the highest reading inside each/)).toBeInTheDocument();
  });

  it("marks Alarms as lines and planned work as areas, and says so", () => {
    render(
      <TrendChart
        points={points}
        unit="kW"
        label="Power"
        tier="agg_1h"
        events={[
          { key: "a", at: Date.parse(points[1]!.at), label: "high · trip", tone: "bad" },
          { key: "m", at: Date.parse(points[2]!.at), end: Date.parse(points[3]!.at), label: "Planned work", tone: "neutral" },
        ]}
      />,
    );
    const main = lastOption().series![0] as { markLine?: { data: unknown[] }; markArea?: { data: unknown[] } };
    expect(main.markLine?.data).toHaveLength(1);
    expect(main.markArea?.data).toHaveLength(1);
    expect(screen.getByText(/1 Alarm opened .* and 1 maintenance window/)).toBeInTheDocument();
  });

  it("reports the zoomed span once the reader stops, remembers it across new data, and can show all again", () => {
    vi.useFakeTimers();
    try {
      const onWindow = vi.fn();
      const from = Date.parse("2026-03-01T00:00:00Z");
      const to = from + 4 * 3_600_000;
      const zoom = { from, to, onWindow };
      const { rerender } = render(<TrendChart points={points} unit="kW" label="Power" tier="agg_1h" zoom={zoom} />);
      expect((lastOption().xAxis as { min?: number }).min).toBe(from);
      act(() => handlers.get("datazoom")?.({ batch: [{ start: 25, end: 75 }] }));
      expect(onWindow).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(onWindow).toHaveBeenCalledWith({ from: from + 3_600_000, to: from + 3 * 3_600_000 });
      // Finer points arrive: the zoom stays where the reader put it.
      rerender(<TrendChart points={points.slice(1)} unit="kW" label="Power" tier="agg_1h" zoom={zoom} />);
      expect(lastOption().dataZoom?.[0]).toMatchObject({ start: 25, end: 75 });
      fireEvent.click(screen.getByRole("button", { name: /Show all/ }));
      expect(onWindow).toHaveBeenLastCalledWith(null);
      expect(lastOption().dataZoom?.[0]).toMatchObject({ start: 0, end: 100 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the zoom while a live period's end moves on, and drops it for a new period", () => {
    vi.useFakeTimers();
    try {
      const onWindow = vi.fn();
      const from = Date.parse("2026-03-01T00:00:00Z");
      const week = 7 * 86_400_000;
      const { rerender } = render(
        <TrendChart points={points} unit="kW" label="Power" tier="agg_1h" zoom={{ from, to: from + week, onWindow }} />,
      );
      act(() => handlers.get("datazoom")?.({ start: 40, end: 60 }));
      // A minute later the live window ends a minute later, with a new
      // reading in it — the refresh that repaints: the same chart.
      const later = [...points, { at: "2026-03-01T04:00:00.000Z", value: 14, contributors: 1 }];
      rerender(
        <TrendChart points={later} unit="kW" label="Power" tier="agg_1h" zoom={{ from: from + 60_000, to: from + week + 60_000, onWindow }} />,
      );
      expect(lastOption().dataZoom?.[0]).toMatchObject({ start: 40, end: 60 });
      expect(screen.getByRole("button", { name: /Show all/ })).toBeInTheDocument();
      // Another period altogether: a fresh chart.
      rerender(
        <TrendChart points={later} unit="kW" label="Power" tier="agg_1h" zoom={{ from: from - week, to: from, onWindow }} />,
      );
      expect(lastOption().dataZoom?.[0]).toMatchObject({ start: 0, end: 100 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers CSV only where its caller passes a file name", () => {
    const { rerender } = render(<TrendChart points={points} unit="kW" label="Power" tier="agg_1h" />);
    expect(screen.queryByRole("button", { name: /CSV/ })).not.toBeInTheDocument();
    rerender(<TrendChart points={points} unit="kW" label="Power" tier="agg_1h" exportName="SF_NORTH_power" />);
    expect(screen.getByRole("button", { name: /CSV/ })).toBeInTheDocument();
  });
});
