/**
 * The one-big-graph trend. ECharts is mocked, as in `powercomparisonchart`:
 * jsdom has no canvas, so what is asserted is the option the chart would
 * paint — the plots it stacks, what each says on hover, and that the menu
 * decides what is drawn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EChartsOption } from "echarts";

const painted: { option: EChartsOption | null; handlers: Record<string, (params: unknown) => void> }[] = [];

vi.mock("echarts", () => ({
  init: () => {
    const chart = { option: null as EChartsOption | null, handlers: {} as Record<string, (params: unknown) => void> };
    painted.push(chart);
    return {
      setOption: (option: EChartsOption) => {
        chart.option = option;
      },
      resize: () => {},
      dispose: () => {},
      on: (name: string, handler: (params: unknown) => void) => {
        chart.handlers[name] = handler;
      },
    };
  },
}));

const { LanedTrendChart } = await import("@/components/charts/LanedTrendChart");
type Option = Parameters<typeof LanedTrendChart>[0]["options"][number];

const DAY_START = Date.parse("2026-11-01T00:00:00Z");
const iso = (minutes: number) => new Date(DAY_START + minutes * 60_000).toISOString();
const points = (values: (number | null)[]) =>
  values.map((value, index) => ({ at: iso(index), value, contributors: 1 }));

const ghi: Option = {
  key: "ghi",
  label: "GHI",
  unit: "W/m2",
  kind: "analog",
  points: points([0, 400, 600]),
  flaggedCount: 0,
  tier: "agg_1m",
  markPeak: true,
};
const gti: Option = { ...ghi, key: "gti", label: "GTI", points: points([0, 450, 700]), markPeak: false };
const ambient: Option = {
  key: "ambient",
  label: "Ambient",
  unit: "degC",
  kind: "analog",
  points: points([20, 21, null]),
  flaggedCount: 3,
  tier: "agg_1m",
};
const trip: Option = {
  key: "trip",
  label: "Oil temp. trip",
  unit: "bool",
  kind: "state",
  state: {
    points: [
      { at: DAY_START, state: 0 },
      { at: DAY_START + 60_000, state: 1 },
    ],
    changes: [{ at: DAY_START + 60_000, state: 1 }],
    mixed: [],
    flaggedCount: 0,
    latest: 1,
  },
  flaggedCount: 0,
  tier: "agg_1m",
};
const noWind: Option = {
  key: "wind",
  label: "Wind speed",
  unit: null,
  kind: "analog",
  unavailableReason: "No anemometer is registered at this Plant.",
  flaggedCount: 0,
  tier: null,
};

const last = () => painted[painted.length - 1]?.option;
const lanes = () => last()?.grid as unknown[];

function draw(
  selected: string[],
  options: Option[] = [ghi, gti, ambient, trip, noWind],
  onChange = vi.fn(),
  initialLayout: "overlay" | "stacked" | "shapes" = "stacked",
) {
  return render(
    <LanedTrendChart
      initialLayout={initialLayout}
      options={options}
      selected={new Set(selected)}
      onSelectedChange={onChange}
      from={DAY_START}
      to={DAY_START + 3_600_000}
      day={{ start: DAY_START, end: DAY_START + 86_400_000 }}
    />,
  );
}

beforeEach(() => {
  painted.length = 0;
});

describe("the laned trend chart", () => {
  it("overlays one unit on one plot and stacks each other unit and contact beneath", () => {
    draw(["ghi", "gti", "ambient", "trip"]);
    // W/m² (two lines), °C, and one contact: three plots, four lines + two scatters.
    expect(lanes()).toHaveLength(3);
    const series = last()?.series as { type: string; xAxisIndex: number; name?: string }[];
    expect(series.filter((entry) => entry.type === "line").map((entry) => [entry.name, entry.xAxisIndex])).toEqual([
      ["GHI", 0],
      ["GTI", 0],
      ["Ambient", 1],
      ["Oil temp. trip", 2],
    ]);
  });

  it("shares one time axis: same bounds everywhere, labels only under the last plot", () => {
    draw(["ghi", "ambient", "trip"]);
    const x = last()?.xAxis as { min: number; max: number; axisLabel: { show: boolean } }[];
    expect(new Set(x.map((axis) => axis.min)).size).toBe(1);
    expect(new Set(x.map((axis) => axis.max)).size).toBe(1);
    expect(x.map((axis) => axis.axisLabel.show)).toEqual([false, false, true]);
    // One zoom drives every plot.
    const zoom = last()?.dataZoom as { xAxisIndex: number[] }[];
    expect(zoom.every((entry) => entry.xAxisIndex.length === 3)).toBe(true);
  });

  it("never joins a gap, and never fills an overlay", () => {
    draw(["ghi", "gti", "ambient"]);
    const lines = last()?.series as { connectNulls: boolean; name: string; areaStyle?: unknown }[];
    expect(lines.every((entry) => entry.connectNulls === false)).toBe(true);
    // Two lines share the W/m² plot, so neither is filled; the lone one is.
    expect(lines.find((entry) => entry.name === "GHI")?.areaStyle).toBeUndefined();
    expect(lines.find((entry) => entry.name === "Ambient")?.areaStyle).toBeDefined();
  });

  it("says every selected reading on hover, from every plot at once", () => {
    draw(["ghi", "ambient", "trip"]);
    const tooltip = last()?.tooltip as { formatter: (params: unknown) => string };
    const text = tooltip.formatter([{ axisValue: DAY_START + 60_000 }]);
    expect(text).toContain("GHI");
    expect(text).toContain("400");
    expect(text).toContain("Ambient");
    expect(text).toContain("21");
    expect(text).toContain("Oil temp. trip");
    expect(text).toContain("TRUE");
  });

  it("says a hole is no data, and does not invent a value past the data", () => {
    draw(["ambient", "trip"]);
    const tooltip = last()?.tooltip as { formatter: (params: unknown) => string };
    expect(tooltip.formatter([{ axisValue: DAY_START + 2 * 60_000 }])).toContain("no data");
    // Hours past the last bucket: nothing near enough to speak for the instant.
    expect(tooltip.formatter([{ axisValue: DAY_START + 5 * 3_600_000 }])).toContain("no data in this interval");
  });

  it("draws only what is ticked", () => {
    draw(["gti"]);
    expect(lanes()).toHaveLength(1);
    const lines = last()?.series as { name: string }[];
    expect(lines.map((entry) => entry.name)).toEqual(["GTI"]);
  });

  it("asks for a reading to be picked, rather than showing an empty frame", () => {
    draw([]);
    expect(screen.getByText(/pick at least one reading/i)).toBeTruthy();
    expect(painted).toHaveLength(0);
  });

  it("lists a reading that cannot be drawn in the menu, off, with the reason", () => {
    draw(["ghi"]);
    fireEvent.click(screen.getByRole("button", { name: /select readings/i }));
    const box = screen.getByLabelText(/wind speed/i) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText("No anemometer is registered at this Plant.")).toBeTruthy();
  });

  it("reports a tick through the menu, and 'All' ticks only what can be drawn", () => {
    const onChange = vi.fn();
    draw(["ghi"], [ghi, gti, ambient, trip, noWind], onChange);
    fireEvent.click(screen.getByRole("button", { name: /select readings/i }));
    fireEvent.click(screen.getByLabelText(/^GTI/));
    expect(onChange).toHaveBeenLastCalledWith(new Set(["ghi", "gti"]));
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenLastCalledWith(new Set(["ghi", "gti", "ambient", "trip"]));
  });

  it("counts flagged readings per reading and never draws them", () => {
    draw(["ambient"]);
    expect(screen.getByText(/Ambient: 3 readings were flagged and not plotted/)).toBeTruthy();
  });

  it("keeps the reader's zoom across a data refresh", () => {
    const { rerender } = draw(["ghi"]);
    // The reader zooms to the middle of the window…
    act(() => painted[painted.length - 1]?.handlers.datazoom?.({ start: 20, end: 60 }));
    // …and a minute later the data refreshes.
    rerender(
      <LanedTrendChart
        options={[{ ...ghi, points: points([0, 500, 650]) }]}
        selected={new Set(["ghi"])}
        onSelectedChange={() => {}}
        from={DAY_START}
        to={DAY_START + 3_600_000}
        day={{ start: DAY_START, end: DAY_START + 86_400_000 }}
      />,
    );
    const zoom = last()?.dataZoom as { start: number; end: number }[];
    expect(zoom.map((entry) => [entry.start, entry.end])).toEqual([
      [20, 60],
      [20, 60],
    ]);
  });

  it("says a reading is loading, not that nothing arrived, while its history is in flight", () => {
    // Ticked a moment ago: the previous answer is still on screen and has
    // nothing for it. An empty plot here would read "nothing arrived".
    draw(["ghi", "ambient"], [ghi, { ...ambient, points: [], flaggedCount: 0, pending: true }]);
    expect(screen.getByText("Loading readings…")).toBeTruthy();
    expect(screen.queryByText(/no readings in this window/i)).toBeNull();
    // …and the legend says which reading it is waiting for.
    expect(screen.getByText("· loading…")).toBeTruthy();
  });

  it("still says nothing arrived once the answer is in and a reading really is empty", () => {
    draw(["ambient"], [{ ...ambient, points: [], flaggedCount: 0 }]);
    expect(screen.getByText(/no readings in this window/i)).toBeTruthy();
  });

  it("explains every reading when none of them can be drawn, instead of an empty prompt", () => {
    draw(
      [],
      [
        noWind,
        { ...noWind, key: "cloud", label: "Cloud cover", unavailableReason: "The station does not report this." },
      ],
    );
    expect(screen.getByText(/nothing here can be drawn yet/i)).toBeTruthy();
    expect(screen.getByText("No anemometer is registered at this Plant.", { exact: false })).toBeTruthy();
    expect(screen.getByText("The station does not report this.", { exact: false })).toBeTruthy();
    expect(screen.queryByText(/pick at least one reading/i)).toBeNull();
  });

  it("reads the same numbers as a table, contacts as TRUE/FALSE", () => {
    draw(["ghi", "trip"]);
    fireEvent.click(screen.getByRole("button", { name: /table/i }));
    expect(screen.getByRole("columnheader", { name: /GHI/ })).toBeTruthy();
    expect(screen.getAllByText("TRUE").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^400(\.0+)?$/).length).toBeGreaterThan(0);
  });

  describe("overlaid — every reading on one plot so they can be compared", () => {
    const wind: Option = { ...ghi, key: "wind", label: "Wind speed", unit: "m/s", points: points([1, 3, 2]), markPeak: false };
    const all = [ghi, gti, ambient, wind, trip];

    it("draws every measurement in one plot, with a scale per unit", () => {
      draw(["ghi", "gti", "ambient", "wind", "trip"], all, vi.fn(), "overlay");
      // One shared plot and one thin contact plot — not four.
      expect(lanes()).toHaveLength(2);
      const y = last()?.yAxis as { gridIndex: number; type: string; position?: string; alignTicks?: boolean }[];
      const measured = y.filter((axis) => axis.type === "value");
      // W/m² (GHI + GTI share it), °C and m/s: three scales on the one plot.
      expect(measured).toHaveLength(3);
      expect(new Set(measured.map((axis) => axis.gridIndex))).toEqual(new Set([0]));
      // Alternating sides, and the further scales sit on the first one's gridlines.
      expect(measured.map((axis) => axis.position)).toEqual(["left", "right", "left"]);
      expect(measured.map((axis) => axis.alignTicks)).toEqual([false, true, true]);
    });

    it("puts each line on its own unit's scale, and two lines of one unit on the same one", () => {
      draw(["ghi", "gti", "ambient", "wind"], all, vi.fn(), "overlay");
      const lines = last()?.series as { name: string; yAxisIndex: number }[];
      const on = (name: string) => lines.find((entry) => entry.name === name)?.yAxisIndex;
      expect(on("GHI")).toBe(on("GTI"));
      expect(new Set([on("GHI"), on("Ambient"), on("Wind speed")]).size).toBe(3);
    });

    it("colours an axis as the one line it scales, and a shared one neutral", () => {
      draw(["ghi", "gti", "ambient"], all, vi.fn(), "overlay");
      const y = last()?.yAxis as { axisLabel: { color: string } }[];
      // GHI and GTI share the W/m² axis: neither line's colour is its own.
      // Ambient is alone on °C: its axis wears its line's colour.
      const lineColours = (last()?.series as { name: string; lineStyle: { color: string } }[]).map(
        (entry) => entry.lineStyle.color,
      );
      expect(y[0]?.axisLabel.color).not.toBe(lineColours[0]);
      expect(y[1]?.axisLabel.color).toBe(lineColours[2]);
    });

    it("lines every reading's values up at one instant in one tooltip", () => {
      draw(["ghi", "ambient", "wind"], all, vi.fn(), "overlay");
      const tooltip = last()?.tooltip as { formatter: (params: unknown) => string };
      const text = tooltip.formatter([{ axisValue: DAY_START + 60_000 }]);
      expect(text).toContain("GHI");
      expect(text).toContain("Ambient");
      expect(text).toContain("Wind speed");
    });

    it("says the scales are separate, and offers the stacked layout", () => {
      draw(["ghi", "ambient"], all, vi.fn(), "overlay");
      expect(screen.getByText(/each unit is drawn on its own scale/i)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Stacked" }));
      expect(lanes()).toHaveLength(2);
      expect(screen.queryByText(/each unit is drawn on its own scale/i)).toBeNull();
    });

    it("offers no choice of layout where there is only one unit — they would be the same chart", () => {
      draw(["ghi", "gti"], all, vi.fn(), "overlay");
      expect(screen.queryByRole("button", { name: "Stacked" })).toBeNull();
      expect(lanes()).toHaveLength(1);
    });
  });

  describe("compare shapes — every reading on one 0–100% scale", () => {
    const wind: Option = { ...ghi, key: "wind", label: "Wind speed", unit: "m/s", points: points([1, 4, 2]), markPeak: false };
    const calm: Option = { ...ghi, key: "calm", label: "Rain", unit: "mm", points: points([0, 0, 0]), markPeak: false };
    const all = [ghi, gti, ambient, wind, calm, trip];

    const yAxes = () => last()?.yAxis as { type: string; min?: number; max?: number }[];
    const lines = () => last()?.series as { name: string; data: [string, number | null][]; yAxisIndex: number }[];

    it("draws every measurement against one scale that ends at 100%", () => {
      draw(["ghi", "ambient", "wind"], all, vi.fn(), "shapes");
      const measured = yAxes().filter((axis) => axis.type === "value");
      expect(measured).toHaveLength(1);
      expect(measured[0]).toMatchObject({ min: 0, max: 100 });
      // All three lines sit on that one axis.
      expect(new Set(lines().filter((entry) => entry.name !== "Oil temp. trip").map((entry) => entry.yAxisIndex)).size).toBe(1);
    });

    it("rescales each reading so its own highest point is 100%, whatever its units", () => {
      draw(["ghi", "ambient", "wind"], all, vi.fn(), "shapes");
      const topOf = (name: string) =>
        Math.max(...lines().find((entry) => entry.name === name)!.data.map(([, value]) => value ?? 0));
      expect(topOf("GHI")).toBeCloseTo(100);
      expect(topOf("Wind speed")).toBeCloseTo(100);
      // Ambient is 20, 21, then a gap: its peak is 21, so 21 -> 100 and 20 -> ~95.
      const ambientValues = lines().find((entry) => entry.name === "Ambient")!.data.map(([, value]) => value);
      expect(ambientValues[0]).toBeCloseTo((20 / 21) * 100);
      // A gap stays a gap.
      expect(ambientValues[2]).toBeNull();
    });

    it("still says the real value on hover, and what share of its peak it is", () => {
      draw(["ghi", "wind"], all, vi.fn(), "shapes");
      const tooltip = last()?.tooltip as { formatter: (params: unknown) => string };
      const text = tooltip.formatter([{ axisValue: DAY_START + 60_000 }]);
      expect(text).toContain("400");
      expect(text).toContain("W/m2");
      expect(text).toContain("67% of its peak");
      expect(text).toContain("4.0");
      expect(text).toContain("100% of its peak");
    });

    it("says what 100% is for each reading, in real terms, in the legend", () => {
      draw(["ghi", "wind"], all, vi.fn(), "shapes");
      expect(screen.getByText(/· peak 600/)).toBeTruthy();
      expect(screen.getByText(/· peak 4/)).toBeTruthy();
    });

    it("says it shows shape and not size", () => {
      draw(["ghi", "wind"], all, vi.fn(), "shapes");
      expect(screen.getByText(/rescaled so its own highest point in this window is 100%/i)).toBeTruthy();
      expect(screen.getByText(/not how big they are/i)).toBeTruthy();
    });

    it("leaves off a reading that is flat at zero, and says so, rather than inventing a shape", () => {
      draw(["ghi", "calm"], all, vi.fn(), "shapes");
      expect(lines().map((entry) => entry.name)).toEqual(["GHI"]);
      expect(screen.getByText(/Rain is flat at zero in this window/i)).toBeTruthy();
    });

    it("says so in the plot when every ticked reading is flat", () => {
      draw(["calm", "ambient"], [calm, { ...ambient, points: points([0, 0, 0]), flaggedCount: 0 }], vi.fn(), "shapes");
      expect(screen.getByText(/every ticked reading is flat at zero/i)).toBeTruthy();
    });

    it("keeps contacts as thin strips below, and the table in real numbers", () => {
      draw(["ghi", "wind", "trip"], all, vi.fn(), "shapes");
      expect(lanes()).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: /table/i }));
      expect(screen.getAllByText(/^400(\.0+)?$/).length).toBeGreaterThan(0);
    });

    it("is offered whenever two readings are ticked — even in one unit — and Stacked only across units", () => {
      draw(["ghi", "gti"], all, vi.fn(), "overlay");
      expect(screen.getByRole("button", { name: "Compare shapes" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Stacked" })).toBeNull();
    });

    it("is not offered for a lone reading, where there is nothing to compare", () => {
      draw(["ghi"], all, vi.fn(), "overlay");
      expect(screen.queryByRole("button", { name: "Compare shapes" })).toBeNull();
    });

    it("switches to it from the card", () => {
      draw(["ghi", "ambient"], all, vi.fn(), "overlay");
      fireEvent.click(screen.getByRole("button", { name: "Compare shapes" }));
      const measured = yAxes().filter((axis) => axis.type === "value");
      expect(measured).toHaveLength(1);
      expect(screen.getByText(/not how big they are/i)).toBeTruthy();
    });
  });

  describe("the default, before the reader has chosen", () => {
    const wind: Option = { ...ghi, key: "wind", label: "Wind speed", unit: "m/s", points: points([1, 4, 2]), markPeak: false };
    const all = [ghi, gti, ambient, wind];
    const bare = (selected: string[]) =>
      render(
        <LanedTrendChart
          options={all}
          selected={new Set(selected)}
          onSelectedChange={() => {}}
          from={DAY_START}
          to={DAY_START + 3_600_000}
          day={{ start: DAY_START, end: DAY_START + 86_400_000 }}
        />,
      );
    const pressed = () =>
      screen
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-pressed") === "true")
        .map((button) => button.textContent);

    it("opens on Compare shapes when the ticked readings are in different units", () => {
      bare(["ghi", "ambient"]);
      expect(pressed()).toEqual(["Compare shapes"]);
      const measured = (last()?.yAxis as { type: string; max?: number }[]).filter((axis) => axis.type === "value");
      expect(measured).toHaveLength(1);
      expect(measured[0]?.max).toBe(100);
    });

    it("opens on Overlaid, in real numbers, when they share one unit", () => {
      bare(["ghi", "gti"]);
      expect(pressed()).toEqual(["Overlaid"]);
      const measured = (last()?.yAxis as { type: string; max?: number }[]).filter((axis) => axis.type === "value");
      expect(measured).toHaveLength(1);
      expect(measured[0]?.max).toBeUndefined();
    });

    it("keeps the reader's choice when they tick something else afterwards", () => {
      const { rerender } = bare(["ghi", "gti"]);
      fireEvent.click(screen.getByRole("button", { name: "Compare shapes" }));
      expect(pressed()).toEqual(["Compare shapes"]);
      // They tick a reading in another unit: the choice they made stands.
      rerender(
        <LanedTrendChart
          options={all}
          selected={new Set(["ghi", "gti", "ambient"])}
          onSelectedChange={() => {}}
          from={DAY_START}
          to={DAY_START + 3_600_000}
          day={{ start: DAY_START, end: DAY_START + 86_400_000 }}
        />,
      );
      expect(pressed()).toEqual(["Compare shapes"]);
    });

    it("follows what is ticked until the reader chooses", () => {
      const { rerender } = bare(["ghi", "gti"]);
      expect(pressed()).toEqual(["Overlaid"]);
      rerender(
        <LanedTrendChart
          options={all}
          selected={new Set(["ghi", "gti", "wind"])}
          onSelectedChange={() => {}}
          from={DAY_START}
          to={DAY_START + 3_600_000}
          day={{ start: DAY_START, end: DAY_START + 86_400_000 }}
        />,
      );
      expect(pressed()).toEqual(["Compare shapes"]);
    });
  });
});
