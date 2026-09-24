/**
 * The Performance tiles in the single-Plant headline strip.
 *
 * The gauges sit in the first row of the page, beside a live figure, so they
 * are seen by everybody and read at the size of a measurement. The ways a
 * gauge can state something false are pinned here: three "not defined" gauges
 * standing in for a request that failed, a CUF arc coloured by thresholds it
 * can never reach, and a derived figure that does not say its period.
 *
 * ECharts is mocked as in `chartmount.test.tsx` — jsdom has no canvas, so what
 * is asserted is the option each gauge would paint, not a drawing.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { EChartsOption } from "echarts";
import type { KpiFigure, PlantKpis } from "@/api/schemas";

/** One entry per chart instance: the last option painted into it. */
const charts: { option: EChartsOption | null }[] = [];

vi.mock("echarts", () => ({
  init: () => {
    const chart = { option: null as EChartsOption | null };
    charts.push(chart);
    return {
      setOption: (option: EChartsOption) => {
        chart.option = option;
      },
      resize: () => {},
      dispose: () => {},
    };
  },
}));

const { PerformanceDetailsButton, PerformanceTiles, PerformancePanel } = await import(
  "@/dashboards/single-plant/PerformancePanel"
);

const figure = (value: number | null, variant = "provisional"): KpiFigure => ({
  value,
  variant,
  undefined_reason: value === null ? "no irradiation in period" : null,
});

const kpis: PlantKpis = {
  plant_id: 1,
  period: "today",
  energy_kwh: 3268,
  performance_ratio: figure(0.788, "poa_uncorrected"),
  cuf: figure(0.028, "ac_capacity_calendar_hours"),
  availability: figure(1, "time_based_excluding_comms"),
  co2_avoided_kg: figure(2679),
  coverage: {
    ratio: 0.139,
    complete: false,
    expected_samples: 415008,
    received_samples: 57720,
    missing_seconds: 74520,
    excluded_seconds: 0,
  },
  source_tier: "agg_1m",
  assumptions_note: "All KPI formulas are provisional pending OPEN-16.",
};

const band = (props: Partial<Parameters<typeof PerformanceTiles>[0]> = {}) =>
  render(
    <PerformanceTiles
      kpis={kpis}
      period="today"
      isLoading={false}
      error={null}
      retry={() => {}}
      {...props}
    />,
  );

/** The progress-arc colour of each gauge, in the order they were created. */
const arcColours = () =>
  charts.map(({ option }) => {
    const series = (option?.series as { progress: { itemStyle: { color: string } } }[])[0];
    return series.progress.itemStyle.color;
  });

beforeEach(() => {
  charts.length = 0;
});

describe("Performance tiles", () => {
  it("shows the three gauges without a click", () => {
    band();
    expect(screen.getByText("Performance Ratio")).toBeInTheDocument();
    expect(screen.getByText("CUF")).toBeInTheDocument();
    expect(screen.getByText("Availability")).toBeInTheDocument();
    expect(screen.getByText("Today · poa uncorrected")).toBeInTheDocument();
    expect(charts).toHaveLength(3);
  });

  it("keeps the gauges' coverage on the button into their detail", () => {
    let opened = 0;
    render(
      <PerformanceDetailsButton kpis={kpis} period="today" onOpen={() => (opened += 1)} />,
    );
    // 13.9% of the day's samples: shown in the same row as the gauges, never
    // only behind the click (Guardrail 18).
    expect(screen.getByText("14% coverage")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Performance details/ }));
    expect(opened).toBe(1);
  });

  it("names the period on every gauge, beside a figure that is live", () => {
    band({ period: "month" });
    expect(screen.getAllByText(/^This month ·/)).toHaveLength(3);
  });

  it("reports a failed request as an error, never as undefined figures", () => {
    band({ kpis: undefined, error: new Error("network down") });
    expect(screen.getByText("network down")).toBeInTheDocument();
    expect(screen.queryByText(/not defined for this period/i)).not.toBeInTheDocument();
    expect(charts).toHaveLength(0);
  });

  it("draws nothing while loading", () => {
    band({ kpis: undefined, isLoading: true });
    expect(screen.queryByText("CUF")).not.toBeInTheDocument();
    expect(charts).toHaveLength(0);
  });

  it("colours CUF with the accent, never by the 80/60 bands PR uses", () => {
    band();
    const [pr, cuf, availability] = arcColours();
    // Fallback palette (jsdom): warn, accent, ok.
    expect(pr).toBe("rgb(224,152,42)");
    expect(cuf).toBe("rgb(44,106,126)");
    expect(availability).toBe("rgb(18,164,90)");
  });

  it("leaves the gauges out of the drawer, which carries what they cannot say", () => {
    render(<PerformancePanel kpis={kpis} period="today" />);
    expect(charts).toHaveLength(0);
    expect(screen.getByText(/Energy \(today\)/)).toBeInTheDocument();
    expect(screen.getByText("agg_1m")).toBeInTheDocument();
  });
});
