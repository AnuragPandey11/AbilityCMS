/**
 * The power trend's comparison chart — the one chart on the platform allowed
 * two y-axes, and only on condition that they are locked.
 *
 * ECharts is mocked as in `performancetiles.test.tsx`: jsdom has no canvas, so
 * what is asserted is the option the chart would paint.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { EChartsOption } from "echarts";

const painted: { option: EChartsOption | null }[] = [];

vi.mock("echarts", () => ({
  init: () => {
    const chart = { option: null as EChartsOption | null };
    painted.push(chart);
    return {
      setOption: (option: EChartsOption) => {
        chart.option = option;
      },
      resize: () => {},
      dispose: () => {},
      on: () => {},
    };
  },
}));

const { PowerComparisonChart } = await import("@/dashboards/single-plant/PowerComparisonChart");
type Series = Parameters<typeof PowerComparisonChart>[0]["series"][number];

const at = (hour: number) => `2026-09-24T${String(hour).padStart(2, "0")}:00:00Z`;
const points = (values: (number | null)[]) =>
  values.map((value, index) => ({ at: at(index + 4), value, contributors: 1 }));

const power: Series = {
  key: "power",
  label: "Actual power",
  unit: "kW",
  points: points([0, 1200, null, 3100, 2800]),
  axis: "power",
  line: "solid",
  slot: 0,
  fill: true,
};
const radiation: Series = {
  key: "radiation",
  label: "Direct radiation",
  unit: "W/m2",
  points: points([0, 300, 450, 700, 610]),
  axis: "radiation",
  line: "solid",
  slot: 1,
  fill: true,
};

const last = () => painted[painted.length - 1]?.option;
const axes = () => last()?.yAxis as { min?: number; max?: number; name?: string }[];
const drawn = () => last()?.series as { name: string; yAxisIndex: number; connectNulls: boolean }[];

beforeEach(() => {
  painted.length = 0;
});

describe("the power comparison chart", () => {
  it("locks the radiation axis to the power axis through the DC nameplate", () => {
    render(
      <PowerComparisonChart series={[power, radiation]} perWm2={5.76} dcCapacityKwp={5760} tier="agg_15m" />,
    );
    const [left, right] = axes();
    expect(axes()).toHaveLength(2);
    expect(left?.max).toBeDefined();
    expect(right?.max).toBeDefined();
    // The same ratio at both ends: 1,000 W/m² sits level with 5,760 kW.
    expect((left!.max ?? 0) / (right!.max ?? 1)).toBeCloseTo(5.76);
    expect(drawn().find((entry) => entry.name === "Direct radiation")?.yAxisIndex).toBe(1);
  });

  it("draws no radiation, and no second axis, without a DC capacity to lock to", () => {
    render(
      <PowerComparisonChart series={[power, radiation]} perWm2={null} dcCapacityKwp={null} tier="agg_15m" />,
    );
    expect(axes()).toHaveLength(1);
    expect(drawn().map((entry) => entry.name)).toEqual(["Actual power"]);
  });

  it("never joins a line across a gap (Guardrail 23)", () => {
    render(
      <PowerComparisonChart series={[power, radiation]} perWm2={5.76} dcCapacityKwp={5760} tier="agg_15m" />,
    );
    expect(drawn().every((entry) => entry.connectNulls === false)).toBe(true);
  });

  it("draws a night of float noise as it draws zeros, instead of freezing", () => {
    // OASIS_2MW before sunrise: its meters send 1.5E-17 kW for zero and its
    // pyranometer 2.5E-41 W/m². Counting the radiation ticks out in steps that
    // small once ran for ever.
    const noise = (values: number[]): Series["points"] => points(values);
    render(
      <PowerComparisonChart
        series={[
          { ...power, points: noise([1.500121e-17, 1.000077e-17, 0, 1.99996e-17, 0]) },
          { ...radiation, points: noise([2.530885e-41, 0, 0, 2.530885e-41, 0]) },
        ]}
        perWm2={2}
        dcCapacityKwp={2000}
        tier="agg_15m"
      />,
    );
    const [left, right] = axes();
    // A quarter of the nameplate, as a night of exact zeros is framed.
    expect(left?.max).toBe(500);
    expect(right?.max).toBe(250);
  });

  it("names each axis with the unit the catalogue gives", () => {
    render(
      <PowerComparisonChart series={[power, radiation]} perWm2={5.76} dcCapacityKwp={5760} tier="agg_15m" />,
    );
    expect(axes().map((axis) => axis.name)).toEqual(["Power (kW)", "Radiation (W/m2)"]);
  });
});
