/**
 * Ambient beside module temperature: two lines, one unit, one axis.
 *
 * ECharts is mocked as in `chartmount.test.tsx`, so what is asserted is the
 * option the chart would paint — one y-axis only (Guardrail 22), gaps never
 * joined (Guardrail 23), and a line that cannot be drawn named in the legend
 * rather than silently missing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EChartsOption } from "echarts";

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

const { OverlayTrendChart } = await import("@/components/charts/OverlayTrendChart");

const point = (at: string, value: number | null) => ({ at, value, contributors: 1 });

beforeEach(() => {
  charts.length = 0;
});

describe("overlay trend chart", () => {
  it("draws every line on one axis and never across a gap", () => {
    render(
      <OverlayTrendChart
        unit="degC"
        tier="agg_1m"
        series={[
          {
            key: "ambient",
            label: "Ambient",
            points: [point("2026-09-28T04:00:00Z", 28.1), point("2026-09-28T04:01:00Z", null), point("2026-09-28T04:30:00Z", 29)],
          },
          { key: "module", label: "Module", points: [point("2026-09-28T04:00:00Z", 41.5)] },
        ]}
      />,
    );
    const option = charts.at(-1)?.option;
    expect(option).toBeTruthy();
    expect(Array.isArray(option?.yAxis)).toBe(false);
    const series = option?.series as { connectNulls: boolean; showSymbol: boolean }[];
    expect(series).toHaveLength(2);
    expect(series.every((entry) => entry.connectNulls === false)).toBe(true);
    // One reading on a line with no symbol draws nothing, so it gets one.
    expect(series[1]?.showSymbol).toBe(true);
    expect(screen.getByText("Ambient")).toBeInTheDocument();
    expect(screen.getByText("Module")).toBeInTheDocument();
  });

  it("says nothing arrived rather than drawing an empty frame", () => {
    render(
      <OverlayTrendChart
        unit="degC"
        tier="agg_1m"
        series={[
          { key: "ambient", label: "Ambient", points: [] },
          { key: "module", label: "Module", points: [], unavailableReason: "Not reported by this station." },
        ]}
      />,
    );
    expect(screen.getByText(/nothing arrived to draw/)).toBeInTheDocument();
    expect(screen.getByText(/not reported/)).toBeInTheDocument();
    expect(charts).toHaveLength(0);
  });
});
