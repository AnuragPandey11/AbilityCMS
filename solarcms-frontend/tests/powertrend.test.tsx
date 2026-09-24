/**
 * The power trend's day frame and the Power Summary's ring.
 *
 * Both are places a plausible picture can say something false: a "today" that
 * is the browser's or UTC's day cuts an Indian morning ramp in half, and a ring
 * drawn from a kW figure over an MW capacity is off by a thousand while looking
 * entirely reasonable. ECharts is mocked as in `chartmount.test.tsx`, so what is
 * asserted is the option each chart would paint.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EChartsOption } from "echarts";
import type { ResolvedSlot } from "@/api/schemas";

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

const { dayInZone, startOfDayInZone } = await import("@/format/datetime");
const { trendWindow, withGaps } = await import("@/api/useSlotTrend");
const { TrendChart } = await import("@/components/charts/TrendChart");
const { CapacityGauge } = await import("@/components/charts/CapacityGauge");
const { PowerSummary } = await import("@/dashboards/single-plant/PowerSummary");

const iso = (ms: number) => new Date(ms).toISOString();

beforeEach(() => {
  charts.length = 0;
});

describe("a day is the Plant's day", () => {
  it("starts an Asia/Kolkata day at 18:30 UTC the evening before", () => {
    const day = dayInZone(Date.parse("2026-09-23T08:00:00Z"), "Asia/Kolkata");
    expect(iso(day.start)).toBe("2026-09-22T18:30:00.000Z");
    expect(iso(day.end)).toBe("2026-09-23T18:30:00.000Z");
  });

  it("puts a minute after local midnight in the new day, not the UTC one", () => {
    // 00:15 IST on the 23rd is still the 22nd in UTC.
    const start = startOfDayInZone(Date.parse("2026-09-22T18:45:00Z"), "Asia/Kolkata");
    expect(iso(start)).toBe("2026-09-22T18:30:00.000Z");
  });

  it("ends a 23-hour daylight-saving day at its own next midnight", () => {
    // Europe/London springs forward on 29 Mar 2026: GMT midnight to BST midnight.
    const day = dayInZone(Date.parse("2026-03-29T12:00:00Z"), "Europe/London");
    expect(iso(day.start)).toBe("2026-03-29T00:00:00.000Z");
    expect(iso(day.end)).toBe("2026-03-29T23:00:00.000Z");
  });
});

describe("the trend window", () => {
  const now = Date.parse("2026-09-23T08:00:00Z");

  it("asks for today from local midnight to now, and frames the whole day", () => {
    const window = trendWindow("today", now, "Asia/Kolkata");
    expect(window.from).toBe("2026-09-22T18:30:00.000Z");
    expect(window.to).toBe(iso(now));
    expect(window.day && iso(window.day.end)).toBe("2026-09-23T18:30:00.000Z");
  });

  it("keeps the rolling ranges rolling, with no day frame", () => {
    const window = trendWindow("24h", now, "Asia/Kolkata");
    expect(window.from).toBe(iso(now - 24 * 3_600_000));
    expect(window.day).toBeNull();
  });
});

describe("a missing bucket is a gap, not a slope (Guardrail 23)", () => {
  const point = (at: string, value: number) => ({ at, value, contributors: 1 });

  it("breaks the line where the server returned no bucket", () => {
    // Measured on SF_NORTH: silent 03:15–14:15 IST, drawn as an 11-hour diagonal.
    const filled = withGaps(
      [
        point("2026-09-22T21:30:00Z", 2995),
        point("2026-09-23T08:45:00Z", -6),
        point("2026-09-23T09:00:00Z", -6),
      ],
      "agg_15m",
    );
    expect(filled.map((entry) => entry.value)).toEqual([2995, null, -6, -6]);
    expect(filled[1]?.at).toBe("2026-09-22T21:45:00.000Z");
  });

  it("leaves consecutive buckets alone, and never gap-fills the irregular raw tier", () => {
    const steady = [point("2026-09-23T08:45:00Z", 1), point("2026-09-23T09:00:00Z", 2)];
    expect(withGaps(steady, "agg_15m")).toEqual(steady);
    const raw = [point("2026-09-23T08:45:00Z", 1), point("2026-09-23T12:00:00Z", 2)];
    expect(withGaps(raw, "readings")).toEqual(raw);
  });

  it("does not call every bucket of a sparse Tag the edge of a hole", () => {
    // A Tag throttled to 300 s fills one minute bucket in five. Judged against
    // the bucket alone, a null went after every point and nothing was drawn.
    const sparse = [
      point("2026-09-23T08:00:00Z", 36.8),
      point("2026-09-23T08:05:00Z", 36.9),
      point("2026-09-23T08:11:00Z", 37.0),
    ];
    // 300 s throttle on a 30 s Device: stored every 300–330 s, plus a cycle.
    expect(withGaps(sparse, "agg_1m", (300 + 30) * 1000)).toEqual(sparse);
    // An hour of silence is still a hole.
    const silent = [...sparse, point("2026-09-23T09:15:00Z", 36.1)];
    expect(withGaps(silent, "agg_1m", (300 + 30) * 1000).map((entry) => entry.value)).toEqual([
      36.8, 36.9, 37.0, null, 36.1,
    ]);
  });
});

describe("the power trend chart", () => {
  const day = dayInZone(Date.parse("2026-09-23T08:00:00Z"), "Asia/Kolkata");
  const points = [
    { at: "2026-09-23T01:00:00Z", value: 120, contributors: 17 },
    { at: "2026-09-23T01:15:00Z", value: 180, contributors: 17 },
    { at: "2026-09-23T01:30:00Z", value: 240, contributors: 17 },
  ];

  it("runs the axis midnight to midnight, labelled every two hours and closing at 24:00", () => {
    render(
      <TrendChart
        points={points}
        unit="kW"
        label="Actual power"
        tier="agg_15m"
        timezone="Asia/Kolkata"
        day={day}
      />,
    );
    const xAxis = charts.at(-1)?.option?.xAxis as {
      min: number;
      max: number;
      axisLabel: { customValues: number[]; formatter: (value: number) => string };
    };
    expect(xAxis.min).toBe(day.start);
    expect(xAxis.max).toBe(day.end);
    expect(xAxis.axisLabel.customValues).toHaveLength(13);
    expect(xAxis.axisLabel.formatter(day.start)).toBe("00:00");
    expect(xAxis.axisLabel.formatter(day.end)).toBe("24:00");
  });

  it("keeps an undefined series in the legend, visibly off, and draws nothing for it", () => {
    render(
      <TrendChart
        points={points}
        unit="kW"
        label="Actual power"
        tier="agg_15m"
        legend={[
          { label: "Actual power", line: "solid" },
          {
            label: "Expected power",
            line: "dashed",
            unavailable: { note: "not yet defined", reason: "No basis yet." },
          },
        ]}
      />,
    );
    expect(screen.getByText("Expected power")).toBeTruthy();
    expect(screen.getByText(/not yet defined/)).toBeTruthy();
    const series = charts.at(-1)?.option?.series as unknown[];
    expect(series).toHaveLength(1);
  });
});

describe("the capacity ring", () => {
  it("draws current power as a fraction of AC capacity", () => {
    render(
      <CapacityGauge label="Current Power" value={6320} unit="kW" capacity={8000} capacityUnit="kW" />,
    );
    const series = (charts.at(-1)?.option?.series as { data: { value: number }[] }[])[0];
    expect(series?.data[0]?.value).toBeCloseTo(0.79);
    expect(screen.getByText("79% of AC capacity")).toBeTruthy();
  });

  it("never compares units that differ, and says why", () => {
    render(
      <CapacityGauge label="Current Power" value={6.32} unit="MW" capacity={8000} capacityUnit="kW" />,
    );
    expect(charts).toHaveLength(0);
    expect(screen.getByText(/They are not compared/)).toBeTruthy();
  });

  it("draws no arc for an unknown figure — a ring at zero would say stopped", () => {
    render(
      <CapacityGauge
        label="Current Power"
        value={null}
        unit="kW"
        capacity={8000}
        capacityUnit="kW"
        undefinedReason="ABT Meter is registered here but is reporting nothing."
      />,
    );
    expect(charts).toHaveLength(0);
    expect(screen.getByText(/reporting nothing/)).toBeTruthy();
  });

  it("shows a figure above capacity unaltered, with the arc full and a note", () => {
    render(
      <CapacityGauge label="Current Power" value={9000} unit="kW" capacity={8000} capacityUnit="kW" />,
    );
    const series = (charts.at(-1)?.option?.series as { data: { value: number }[] }[])[0];
    expect(series?.data[0]?.value).toBe(1);
    expect(screen.getByText("9,000")).toBeTruthy();
    expect(screen.getByText(/Above the recorded AC capacity/)).toBeTruthy();
  });
});

describe("the Power Summary drawer", () => {
  const slot = (code: string, label: string, value: number | null, position: number): ResolvedSlot =>
    ({
      slot_code: code,
      label,
      value,
      unit: "kW",
      position,
      source: null,
      undefined_reason: value === null ? "no_source" : null,
      override_note: null,
    }) as unknown as ResolvedSlot;

  it("lists DC, AC, export and import in that order, with import blank and explained", () => {
    render(
      <PowerSummary
        slots={[
          slot("power.dc_voltage", "DC Voltage", 780, 4),
          slot("power.export_power", "Export Power", 6320, 3),
          slot("power.dc_power", "DC Power", 7150, 1),
          slot("power.ac_power", "AC Power", 6400, 2),
        ]}
        currentPower={slot("kpi.current_power", "Current Power", 6320, 2)}
        acCapacityKw={8000}
      />,
    );
    const labels = ["DC Power", "AC Power", "Export Power", "Import Power", "DC Voltage"].map(
      (label) => screen.getByText(label),
    );
    for (let index = 1; index < labels.length; index += 1) {
      const previous = labels[index - 1]!;
      const current = labels[index]!;
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByText("no signal")).toBeTruthy();
    expect(screen.getByText(/No Tag in the catalogue carries import power/)).toBeTruthy();
  });
});
