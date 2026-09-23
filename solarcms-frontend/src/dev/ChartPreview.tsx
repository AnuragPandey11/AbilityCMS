/**
 * Every chart against the data shapes that break charts.
 *
 * Development only, mounted at `/dev/charts` and not reachable from any
 * navigation. It exists because chart bugs are almost never visible on the
 * happy path: a real Plant on a sunny afternoon draws beautifully, and the
 * failures live in the shapes nobody has on screen while developing — one
 * reading, no readings, a flat line, every value negative, everything flagged,
 * a single category, a fleet that produced nothing.
 *
 * Each case below has been a real defect or is one line away from being one.
 * If a chart renders an empty frame, a blank plot or a misleading axis here,
 * it does the same thing to an operator at four in the morning.
 */

import type { TrendPoint } from "@/api/useSlotTrend";
import { TrendChart, SmallMultiples } from "@/components/charts/TrendChart";
import { ComparisonBars } from "@/components/charts/ComparisonBars";
import { SharePie } from "@/components/charts/SharePie";
import { Panel } from "@/components/ui";
import { PlantDonut, plantMarks } from "@/dashboards/fleet/HeadlineCharts";

const START = Date.parse("2026-09-22T00:00:00Z");

function series(values: (number | null)[], stepMinutes = 15): TrendPoint[] {
  return values.map((value, index) => ({
    at: new Date(START + index * stepMinutes * 60_000).toISOString(),
    value,
    contributors: value === null ? 0 : 17,
  }));
}

/** A believable generation curve, for the cases that need a normal series. */
const CURVE = series(
  Array.from({ length: 96 }, (_, i) => {
    const hour = i / 4;
    const x = (hour - 12) / 5.5;
    const v = Math.exp(-x * x) * 5400;
    return hour < 6 || hour > 18.5 ? 0 : Math.round(v);
  }),
);

/** A Portfolio headline graphic at the width of one tile in a row of four. */
function Tile({ children }: { children: JSX.Element }): JSX.Element {
  return <div className="max-w-[17rem] pt-6">{children}</div>;
}

const PLANTS = ["Sunfield North", "Sunfield South", "Warehouse 1", "Warehouse 2", "Hilltop", "Canal Bank", "Depot"].map(
  (name, index) => ({ id: index + 1, name, code: `P${index + 1}` }),
);
const donut = (
  values: (number | null)[],
  { capacity = null, unit = "kWh", empty = "Nothing generated yet" }: {
    capacity?: number | null;
    unit?: string;
    empty?: string;
  } = {},
) => (
  <Tile>
    <PlantDonut
      label="Energy"
      marks={plantMarks(PLANTS.slice(0, values.length), (id) => values[id - 1])}
      unit={unit}
      capacity={capacity}
      empty={empty}
      highlight={null}
      onHighlight={() => undefined}
    />
  </Tile>
);

const CASES: { title: string; note: string; node: JSX.Element }[] = [
  {
    title: "Live ring — half the capacity in use",
    note: "The whole ring is the AC capacity of the Plants reporting; the fill is their output, by Plant.",
    node: donut([2_410, 1_020, 250, 137], { capacity: 7_450, unit: "kW" }),
  },
  {
    title: "Live ring — night",
    note: "Zero output against a capacity is a reading — 0% in use — not an absence of one.",
    node: donut([0, 0, 0, 0], { capacity: 7_450, unit: "kW" }),
  },
  {
    title: "Live ring — output past the capacity",
    note: "Never drawn clamped at a full ring. The ratio is shown, flagged, with no fill (Guardrail 33).",
    node: donut([5_200, 3_100], { capacity: 7_450, unit: "kW" }),
  },
  {
    title: "Plant donut — four Plants",
    note: "The total split by Plant; each Plant one colour on the whole row, named in the legend.",
    node: donut([5_600, 1_850, 1_050, 440]),
  },
  {
    title: "Plant donut — nothing produced",
    note: "Before sunrise every Plant reports zero. A ring of equal slices would split nothing.",
    node: donut([0, 0, 0]),
  },
  {
    title: "Plant donut — seven Plants",
    note: "Past five the tail folds into one grey Other, which is not a Plant and is not coloured as one.",
    node: donut([900, 800, 700, 650, 500, 420, 300]),
  },
  {
    title: "Plant donut — one Plant has no figure",
    note: "A dash in the legend, never a zero-width segment that looks measured.",
    node: donut([1200, null, 400]),
  },
  {
    title: "Normal curve",
    note: "The happy path — 96 buckets, a clear peak. Everything else is judged against this.",
    node: <TrendChart points={CURVE} unit="kW" label="AC Power" tier="agg_15m" height={150} />,
  },
  {
    title: "One reading",
    note:
      "A line needs two vertices. With symbols off this drew an empty plot with axes — " +
      "silent, plausible, and the worst case in the set. The symbol must come back.",
    node: <TrendChart points={series([4210])} unit="kW" label="AC Power" tier="agg_15m" height={150} />,
  },
  {
    title: "Two readings",
    note: "Draws a line, but two vertices is still sparse enough to want its points marked.",
    node: <TrendChart points={series([3900, 4210])} unit="kW" label="AC Power" tier="agg_15m" height={150} />,
  },
  {
    title: "No readings at all",
    note: "Must say so. An empty frame with axes reads as a broken chart, not as an absence.",
    node: <TrendChart points={[]} unit="kW" label="AC Power" tier="agg_15m" height={150} />,
  },
  {
    title: "Every reading flagged",
    note:
      "Nothing plottable, but for a different reason — the sensor is reporting rubbish, not " +
      "silence. A dead datalogger and a sensor reading −3 W/m² all night must not look alike.",
    node: (
      <TrendChart
        points={series([null, null, null, null])}
        unit="W/m2"
        label="Irradiance"
        tier="agg_15m"
        height={150}
        flaggedCount={4}
      />
    ),
  },
  {
    title: "Gaps in the middle",
    note: "The line must break, never interpolate. A Plant that reported nothing was not producing zero.",
    node: (
      <TrendChart
        points={series([1200, 2400, null, null, null, 4100, 4600, 3900])}
        unit="kW"
        label="AC Power"
        tier="agg_15m"
        height={150}
      />
    ),
  },
  {
    title: "Flat line",
    note: "Every value identical. The axis must not collapse to a zero-height band.",
    node: <TrendChart points={series(Array(40).fill(24.9))} unit="degC" label="Oil Temp." tier="agg_15m" height={150} />,
  },
  {
    title: "All zeros",
    note: "Every solar plant at night. A legitimate flat line at the baseline.",
    node: <TrendChart points={series(Array(40).fill(0))} unit="kW" label="AC Power" tier="agg_15m" height={150} />,
  },
  {
    title: "All negative",
    note:
      "Import rather than export — the real state of this Plant's meter overnight. The area " +
      "fills to zero, so the sign reads as direction rather than as magnitude.",
    node: <TrendChart points={series(Array(40).fill(0).map((_, i) => -5 - (i % 5) * 0.2))} unit="kW" label="Export Power" tier="agg_15m" height={150} />,
  },
  {
    title: "Crosses zero",
    note: "Import overnight, export by day. Both sides of the baseline in one series.",
    node: <TrendChart points={series([-5, -4, -2, 1, 900, 3200, 4800, 2100, 40, -3, -5])} unit="kW" label="Export Power" tier="agg_15m" height={150} />,
  },
  {
    title: "Huge magnitudes",
    note: "A lifetime counter. Axis labels must compact rather than overrun the plot.",
    node: <TrendChart points={series([1_365_888, 1_366_402, 1_367_110, 1_368_004])} unit="kWh" label="Lifetime Energy" tier="agg_1d" height={150} />,
  },
  {
    title: "Daily bars",
    note: "One bar per day. Buckets must render as dates — a time on a day bucket is a claim nobody measured.",
    node: (
      <TrendChart
        points={series([16_405, 0, 25_609, 24_110, 26_002], 24 * 60)}
        unit="kWh"
        label="Energy"
        tier="agg_1d"
        height={150}
        shape="bar"
        markPeak={false}
      />
    ),
  },
  {
    title: "Peak at the right edge",
    note: "A rising day. The peak label must flip inboard rather than being clipped to 'peak 235 k'.",
    node: <TrendChart points={series([100, 800, 1900, 3000, 4100, 5200, 6300])} unit="kW" label="AC Power" tier="agg_15m" height={150} />,
  },
  {
    title: "Small multiples, one band empty",
    note: "Two measures, one shared time axis — never one plot with two y-axes.",
    node: (
      <SmallMultiples
        height={170}
        series={[
          { key: "irr", label: "Irradiance", unit: "W/m2", tier: "agg_15m", points: series([]), flaggedCount: 12 },
          { key: "temp", label: "Module Temp.", unit: "degC", tier: "agg_15m", points: series([22, 23, 25, 28, 31, 29, 24]) },
        ]}
      />
    ),
  },
  {
    title: "Comparison — mixed silence",
    note: "Ranked peers where some reported nothing. A silent one keeps its row and loses its rank.",
    node: (
      <ComparisonBars
        noun="Plant"
        metricLabel="Energy"
        unit="kWh"
        height={150}
        rows={[
          { id: 1, label: "KULAR_GREEN", value: 124_228 },
          { id: 2, label: "KULAR_NORTH", value: null, attention: true, attentionReason: "Nothing bound" },
          { id: 3, label: "KULAR_WEST", value: 41_900 },
        ]}
      />
    ),
  },
  {
    title: "Comparison — one row",
    note: "A single-Plant Client. A one-bar chart is honest and must not look broken.",
    node: (
      <ComparisonBars noun="Plant" metricLabel="Energy" unit="kWh" height={110}
        rows={[{ id: 1, label: "KULAR_GREEN", value: 124_228 }]} />
    ),
  },
  {
    title: "Comparison — all zero",
    note: "Night across the fleet. Bars of length zero, axis intact, no division by zero.",
    node: (
      <ComparisonBars noun="Plant" metricLabel="Energy" unit="kWh" height={130}
        rows={[
          { id: 1, label: "KULAR_GREEN", value: 0 },
          { id: 2, label: "KULAR_WEST", value: 0 },
        ]} />
    ),
  },
  {
    title: "Share — nine Plants",
    note: "Past six segments adjacent hues stop separating, so the tail folds into one grey slice.",
    node: (
      <SharePie
        unit="kWh"
        height={180}
        slices={[
          { id: 1, label: "Vardhman", value: 21.6 }, { id: 2, label: "Spinning 3", value: 15.4 },
          { id: 3, label: "Weaving 2", value: 12.8 }, { id: 4, label: "Spinning 4", value: 10.7 },
          { id: 5, label: "Open End 2", value: 8.9 }, { id: 6, label: "Open End 1", value: 7.6 },
          { id: 7, label: "Unit 26", value: 6.2 }, { id: 8, label: "Unit 29", value: 5.1 },
          { id: 9, label: "Unit 30", value: 4.0 },
        ]}
      />
    ),
  },
  {
    title: "Share — nothing produced",
    note: "A ring of equal slices splitting nothing is worse than no chart. It must refuse.",
    node: <SharePie unit="kWh" height={180} slices={[{ id: 1, label: "A", value: 0 }, { id: 2, label: "B", value: 0 }]} />,
  },
  {
    title: "Share — one Plant",
    note: "A full ring at 100%. Legitimate, and must not divide by zero.",
    node: <SharePie unit="kWh" height={180} slices={[{ id: 1, label: "KULAR_GREEN", value: 124_228 }]} />,
  },
];

export function ChartPreview(): JSX.Element {
  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-lg font-semibold text-ink">Chart edge cases</h1>
        <p className="text-xs text-ink-muted">
          Every shape that breaks a chart. If anything here renders an empty frame, a blank
          plot or a misleading axis, it does the same to an operator at four in the morning.
        </p>
      </div>
      <div className="grid gap-2.5 xl:grid-cols-2">
        {CASES.map((entry) => (
          <Panel key={entry.title} title={entry.title} subtitle={entry.note}>
            {entry.node}
          </Panel>
        ))}
      </div>
    </div>
  );
}
