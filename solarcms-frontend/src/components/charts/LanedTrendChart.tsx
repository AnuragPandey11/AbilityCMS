/**
 * One big trend, with a menu of readings to put on it — the Power trend's
 * form (a "Select options" checkbox menu over one full-width chart) for every
 * screen that used to carry a grid of small separate trends.
 *
 * ── What "one graph" means here ─────────────────────────────────────────────
 * One chart, one time axis, one zoom, one crosshair, one menu. Not one y-axis:
 * readings of **one unit** overlay on a shared plot, and each **other unit**
 * (and each TRUE/FALSE contact) gets its own plot stacked beneath, on the same
 * time axis. Guardrail 22 forbids two independently fitted y-axes — the
 * alignment between two fitted scales is arbitrary, so a chart asserts a
 * relationship nobody measured — and nothing locks W/m² to °C the way the DC
 * nameplate locks radiation to power. See `trendLanes` for the grouping rules.
 *
 * What it keeps from every other trend, deliberately identical: a gap is a gap
 * (Guardrail 23, `connectNulls` stays off); one or two readings show their
 * points rather than nothing; fills are anchored at zero; flagged readings are
 * counted per reading and never drawn; contacts are TRUE/FALSE as sent, in the
 * chart colour and never red (`StateTrendChart`'s rules); a table twin so no
 * value is reachable only by hovering; every colour through `theme/tokens`
 * (Guardrail 28); a `key` on each render branch (Guardrail 32); and no unmount
 * effect (`useEcharts`).
 *
 * ⚠ The zoom the reader chose lives in a ref and is re-applied on every
 * paint. These trends refetch every minute, `useEcharts` repaints with
 * `notMerge`, and without it each refresh threw the reader back out to the
 * whole day mid-inspection.
 *
 * ⚠ The tooltip is built from the data, not from what ECharts hands the
 * formatter: with several grids, which rows an axis-triggered tooltip carries
 * depends on the pointer's link, and a hover that listed one plot's readings
 * and not the others' would defeat the comparison this chart is for.
 */

import { useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import type { Tier } from "@/api/schemas";
import type { TrendPoint } from "@/api/useSlotTrend";
import { bucketMs } from "@/api/trendWindow";
import { DEFAULT_TIMEZONE, formatBucket } from "@/format/datetime";
import { digitsForUnit, formatNumber } from "@/format/value";
import { seriesPalette, token, tokenAlpha, withAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { Badge, InfoHint } from "@/components/ui";
import { CheckboxMenu, type CheckboxOption } from "@/components/ui/CheckboxMenu";
import { IconExpand, IconGauge, IconList } from "@/components/icons";
import type { StateSeries } from "@/dashboards/equipment/stateSeries";
import { axisTickLabel, dayAxis, timeAxisLabel, type DayFrame } from "./TrendChart";
import { TIER_LABELS } from "./TimeSeriesChart";
import { chartTheme, useEcharts } from "./useEcharts";
import {
  analogValueAt,
  asPercentOfPeak,
  buildLanes,
  laneLayout,
  laneTitle,
  peakMagnitude,
  slotFor,
  stateAt,
  toMs,
  type LaneInput,
  type TrendLayout,
} from "./trendLanes";

/** One reading the menu offers. */
export interface TrendLaneOption extends LaneInput {
  /** A measurement's buckets. Absent for a contact. */
  points?: TrendPoint[];
  /** A contact's steps. Present exactly when `kind` is `state`. */
  state?: StateSeries;
  /** Readings that arrived and were not drawn because they were flagged. */
  flaggedCount: number;
  /** The tier this reading was actually read from. */
  tier: Tier | null;
  /**
   * Its history has been asked for and has not arrived. Distinct from "no
   * readings": one is a question nobody has answered yet, the other a Device
   * that sent nothing (the distinction `TrendChart`'s `isLoading` keeps).
   */
  pending?: boolean;
  /** Mark and label the maximum — only drawn while it is alone in its plot. */
  markPeak?: boolean;
  /** Where it came from, printed under the chart ("Meter MFM_1"). */
  provenance?: string | null;
  /** One line under its name in the menu. */
  description?: string;
}

const WORD = ["FALSE", "TRUE"] as const;
const NOT_A_UNIT_WORDS = new Set(["ratio", "code", "bool"]);

/** Ids for arrays, so a chart repaints when its data changes and not when a parent re-renders. */
const ids = new WeakMap<object, number>();
let nextId = 1;
function idOf(value: object | undefined): number {
  if (!value) return 0;
  let id = ids.get(value);
  if (id === undefined) {
    id = nextId++;
    ids.set(value, id);
  }
  return id;
}

function colourOf(options: readonly TrendLaneOption[], key: string): string {
  const option = options.find((candidate) => candidate.key === key);
  if (!option) return token("chart-primary");
  if (option.kind === "state") return token("chart-primary");
  if (option.colorToken === "accent") return token("accent");
  if (option.colorToken === "neutral") return token("ink-muted");
  return seriesPalette()[slotFor(options, key)] ?? token("chart-primary");
}

/** Left gutter wide enough for the widest tick any plot will draw. */
function gutterFor(options: readonly TrendLaneOption[]): number {
  let widest = 0;
  for (const option of options) {
    const values = (option.points ?? []).map((point) => point.value).filter((v): v is number => v !== null);
    if (values.length === 0) continue;
    for (const value of [Math.min(0, ...values), Math.max(0, ...values)]) {
      widest = Math.max(widest, axisTickLabel(value).length);
    }
  }
  return Math.min(80, Math.max(48, Math.round(widest * 6.2) + 18));
}

function displayUnit(unit: string | null): string | null {
  return unit && !NOT_A_UNIT_WORDS.has(unit) ? unit : null;
}

/**
 * A reading with its unit, digits from the catalogue's unit but never a type
 * name printed as one: `0.98 ratio` is a power factor that says what it is
 * stored as rather than what it means.
 */
function formatReading(value: number, unit: string | null): string {
  const text = formatNumber(value, { digits: digitsForUnit(unit) });
  const shown = displayUnit(unit);
  return shown ? `${text} ${shown}` : text;
}

function peakOf(points: TrendPoint[], day: DayFrame | null): { at: string; value: number; position: number } | null {
  let best: TrendPoint | null = null;
  let bestIndex = -1;
  points.forEach((point, index) => {
    if (point.value === null) return;
    if (best === null || point.value > (best.value ?? -Infinity)) {
      best = point;
      bestIndex = index;
    }
  });
  const found = best as TrendPoint | null;
  if (!found || found.value === null) return null;
  const position =
    day !== null
      ? (Date.parse(found.at) - day.start) / (day.end - day.start)
      : points.length > 1
        ? bestIndex / (points.length - 1)
        : 0.5;
  return { at: found.at, value: found.value, position };
}

const plottableCount = (option: TrendLaneOption): number =>
  option.kind === "state"
    ? (option.state?.points ?? []).filter((point) => point.state !== null).length
    : (option.points ?? []).filter((point) => point.value !== null).length;

/** A legend and menu key: the line in the reading's colour, or a step for a contact. */
function Swatch({ kind, color }: { kind: "analog" | "state"; color: string }): JSX.Element {
  return kind === "state" ? (
    <svg aria-hidden width="18" height="10" viewBox="0 0 18 10" className="shrink-0">
      <path d="M1 8 H6 V2 H12 V8 H17" fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg aria-hidden width="18" height="6" viewBox="0 0 18 6" className="shrink-0">
      <line x1="1" y1="3" x2="17" y2="3" stroke={color} strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function LanedTrendChart({
  options,
  selected,
  onSelectedChange,
  from,
  to,
  day,
  timezone = DEFAULT_TIMEZONE,
  isLoading = false,
  menuLabel = "Select readings",
  emptyHint = "Pick at least one reading from the list to draw it.",
  initialLayout,
}: {
  options: TrendLaneOption[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  /** The window's bounds, epoch ms — every plot shares them. */
  from: number;
  to: number;
  day: DayFrame | null;
  timezone?: string;
  isLoading?: boolean;
  menuLabel?: string;
  emptyHint?: string;
  /**
   * A layout the reader is taken to have already chosen. Omitted, the chart
   * chooses for them until they press a button: "Compare shapes" where the
   * ticked readings are in different units (the one honest single scale),
   * "Overlaid" where they share one (real numbers, fully comparable).
   */
  initialLayout?: TrendLayout;
}): JSX.Element {
  const [tableView, setTableView] = useState(false);
  // `null` is "not chosen yet": the chart picks from what is ticked.
  const [mode, setMode] = useState<TrendLayout | null>(initialLayout ?? null);
  // Bumped by "Show all": a fresh chart, at the whole window.
  const [zoomEpoch, setZoomEpoch] = useState(0);
  const zoom = useRef({ start: 0, end: 100 });
  const onZoom = (params: unknown) => {
    const event = params as { start?: number; end?: number; batch?: { start?: number; end?: number }[] };
    const range = event.batch?.[0] ?? event;
    if (typeof range.start === "number" && typeof range.end === "number") {
      zoom.current = { start: range.start, end: range.end };
    }
  };
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();

  // What is ticked decides which layouts mean anything: one plain plot for a
  // lone reading; "Overlaid" and "Stacked" differ only across more than one
  // unit; "Compare shapes" needs two readings to compare.
  const analogTicked = options.filter(
    (entry) => selected.has(entry.key) && !entry.unavailableReason && entry.kind === "analog",
  );
  const analogCount = analogTicked.length;
  const unitCount = new Set(analogTicked.map((entry) => entry.unit)).size;
  // Different units have no real scale in common, so the honest single plot is
  // "Compare shapes"; one unit has, so "Overlaid" keeps the real numbers. A
  // button pressed by the reader overrides this, and stays pressed.
  const automatic: TrendLayout = unitCount > 1 ? "shapes" : "overlay";
  const chosenLayout = mode ?? automatic;
  const layoutInUse: TrendLayout =
    analogCount < 2 ? "stacked" : chosenLayout === "stacked" && unitCount <= 1 ? "overlay" : chosenLayout;
  const lanes = buildLanes(options, selected, layoutInUse);
  const layout = laneLayout(lanes);
  const drawn = options.filter((option) => selected.has(option.key) && !option.unavailableReason);
  const unavailable = options.filter((option) => option.unavailableReason);
  const byKey = new Map(options.map((option) => [option.key, option]));
  const gutter = gutterFor(drawn);
  const axis = day ? dayAxis(day) : { min: from, max: to };
  const spanMs = to - from;
  const lastLane = lanes.length - 1;

  // What each drawn reading says at a time, for the tooltip — prepared once.
  const prepared = new Map(
    drawn.map((option) => {
      const bucket = option.tier ? (bucketMs(option.tier) ?? 0) : 0;
      return [
        option.key,
        {
          ms: option.kind === "analog" ? toMs(option.points ?? []) : [],
          // 100% in "Compare shapes": the reading's own largest magnitude, null
          // where it is flat at zero (or float noise) and has no shape.
          peak: option.kind === "analog" ? peakMagnitude((option.points ?? []).map((point) => point.value)) : null,
          tolerance: option.kind === "analog" ? Math.max(bucket, 120_000) : Math.max(bucket * 1.5, 120_000),
        },
      ] as const;
    }),
  );

  // ── The y-axes. Stacked: one per plot. Overlaid: one per unit on the shared
  // plot, alternating left and right and stepping outward, each coloured as the
  // line it scales (a unit shared by several lines takes the neutral ink), so
  // which axis reads which line is never a guess.
  const yAxes: unknown[] = [];
  const yIndexOf = new Map<string, number>();
  const axesPerLane = lanes.map((lane) => lane.axes?.length ?? 1);
  const mostAxes = Math.max(1, ...axesPerLane);
  const leftAxes = Math.ceil(mostAxes / 2);
  const rightAxes = Math.floor(mostAxes / 2);
  const plotLeft = gutter * leftAxes;
  const plotRight = rightAxes > 0 ? gutter * rightAxes + 12 : 22;
  lanes.forEach((lane, laneIndex) => {
    if (lane.kind === "state") {
      yIndexOf.set(lane.members[0] ?? "", yAxes.length);
      yAxes.push({
        type: "category" as const,
        gridIndex: laneIndex,
        data: [...WORD],
        boundaryGap: true,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: true, lineStyle: { color: token("chart-grid"), width: 1 } },
        axisLabel: { fontSize: 10, fontWeight: 600, color: token("ink-muted") },
      });
      return;
    }
    if (lane.normalised) {
      // One scale for every reading: a percentage of its own peak. The floor is
      // only ever below zero where a reading goes negative (an import).
      let lowest = 0;
      for (const key of lane.members) {
        const data = prepared.get(key);
        if (!data?.peak) continue;
        for (const point of data.ms) {
          const percent = asPercentOfPeak(point.value, data.peak);
          if (percent !== null && percent < lowest) lowest = percent;
        }
      }
      for (const key of lane.members) yIndexOf.set(key, yAxes.length);
      yAxes.push({
        type: "value" as const,
        gridIndex: laneIndex,
        min: Math.floor(lowest / 20) * 20,
        max: 100,
        interval: 20,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: theme.splitLine,
        axisLabel: { fontSize: 10, color: token("ink-faint"), formatter: (value: number) => `${value}%` },
        scale: false,
      });
      return;
    }
    const groups = lane.axes ?? [{ unit: lane.unit, members: lane.members }];
    const several = groups.length > 1;
    groups.forEach((group, groupIndex) => {
      const side = groupIndex % 2 === 0 ? "left" : "right";
      const single = group.members.length === 1;
      const colour = several ? (single ? colourOf(options, group.members[0] ?? "") : token("ink-muted")) : token("ink-faint");
      const named = displayUnit(group.unit) ?? (single ? (byKey.get(group.members[0] ?? "")?.label ?? "") : "");
      for (const key of group.members) yIndexOf.set(key, yAxes.length);
      yAxes.push({
        type: "value" as const,
        gridIndex: laneIndex,
        position: side,
        offset: Math.floor(groupIndex / 2) * gutter,
        // Ticks of every further scale fall on the first's gridlines, so one
        // set of lines serves them all and no scale has gridlines of its own.
        alignTicks: groupIndex > 0,
        axisLine: several ? { show: true, lineStyle: { color: colour, width: 2 } } : { show: false },
        axisTick: { show: false },
        splitLine: groupIndex === 0 ? theme.splitLine : { show: false },
        splitNumber: lanes.length === 1 || several ? 5 : 3,
        axisLabel: { fontSize: 10, color: colour, formatter: (value: number) => axisTickLabel(value) },
        ...(several
          ? {
              name: named,
              nameLocation: "end" as const,
              nameGap: 10,
              nameTextStyle: { color: colour, fontSize: 10, fontWeight: 600, align: side === "left" ? "right" : "left" },
            }
          : {}),
        scale: false,
      });
    });
  });

  const seriesList: unknown[] = [];
  lanes.forEach((lane, laneIndex) => {
    if (lane.kind === "analog") {
      for (const key of lane.members) {
        const option = byKey.get(key);
        if (!option) continue;
        const color = colourOf(options, key);
        const points = option.points ?? [];
        const count = plottableCount(option);
        const alone = lane.members.length === 1;
        // "Compare shapes": this reading as a share of its own peak. One with no
        // peak (flat at zero) has no shape and is left out, and said so below.
        const own = lane.normalised ? (prepared.get(key)?.peak ?? null) : null;
        if (lane.normalised && own === null) continue;
        const percent = (value: number | null) => (own === null ? value : asPercentOfPeak(value, own));
        // A peak label is for a reading that has the plot to itself, or shares
        // it with one other; more than that and the labels would pile up.
        const peak = lane.members.length <= 2 && option.markPeak ? peakOf(points, day) : null;
        seriesList.push({
          name: option.label,
          type: "line",
          xAxisIndex: laneIndex,
          yAxisIndex: yIndexOf.get(key) ?? laneIndex,
          data: points.map((point) => [point.at, percent(point.value)] as [string, number | null]),
          // One or two readings with no symbol draw nothing at all.
          showSymbol: count > 0 && count < 3,
          symbolSize: 6,
          // ⚠ Never `connectNulls`: a hole is a Plant that did not report.
          connectNulls: false,
          smooth: 0.18,
          sampling: "lttb",
          lineStyle: { width: 2, color },
          itemStyle: { color },
          // Fills only where a reading is alone in its plot: overlaid fills
          // hide whichever line is behind them.
          areaStyle: alone
            ? {
                // Filled to zero, not to the bottom of the plot — see TrendChart.
                origin: 0,
                color: {
                  type: "linear",
                  x: 0,
                  y: 0,
                  x2: 0,
                  y2: 1,
                  colorStops: [
                    { offset: 0, color: withAlpha(color, 0.26) },
                    { offset: 1, color: withAlpha(color, 0.02) },
                  ],
                },
              }
            : undefined,
          markPoint: peak
            ? {
                symbol: "circle",
                symbolSize: 7,
                itemStyle: { color, borderColor: token("surface-raised"), borderWidth: 2 },
                label: {
                  show: true,
                  // Flipped near an edge: ECharts never reflows a markPoint label.
                  position: peak.position > 0.86 ? "left" : peak.position < 0.1 ? "right" : "top",
                  distance: 8,
                  fontSize: 10,
                  color: token("ink"),
                  backgroundColor: theme.tooltipBackground,
                  borderColor: theme.tooltipBorder,
                  borderWidth: 1,
                  borderRadius: 4,
                  padding: [2, 5],
                  formatter: () => `peak ${formatReading(peak.value, option.unit)}`,
                },
                data: [{ name: "peak", coord: [peak.at, percent(peak.value)] }],
              }
            : undefined,
        });
      }
    } else {
      const option = byKey.get(lane.members[0] ?? "");
      if (!option?.state) return;
      const color = token("chart-primary");
      const lonely = option.state.points.filter((point) => point.state !== null).length === 1;
      seriesList.push(
        {
          name: option.label,
          type: "line",
          xAxisIndex: laneIndex,
          yAxisIndex: yIndexOf.get(option.key) ?? laneIndex,
          step: "end",
          data: option.state.points.map((point) => [point.at, point.state ?? "-"]),
          connectNulls: false,
          // A single reading has no second vertex; it is a dot, not nothing.
          showSymbol: lonely,
          symbolSize: 6,
          lineStyle: { color, width: 2 },
          itemStyle: { color },
          z: 2,
        },
        {
          // A dot at each change, as in the client's reference.
          type: "scatter",
          xAxisIndex: laneIndex,
          yAxisIndex: yIndexOf.get(option.key) ?? laneIndex,
          data: option.state.changes.map((point) => [point.at, point.state ?? 0]),
          symbolSize: 7,
          itemStyle: { color, borderColor: token("surface-raised"), borderWidth: 1.5 },
          z: 3,
          silent: true,
          tooltip: { show: false },
        },
        {
          // Where the bucket also saw the other state: a ring at that state.
          type: "scatter",
          xAxisIndex: laneIndex,
          yAxisIndex: yIndexOf.get(option.key) ?? laneIndex,
          data: option.state.mixed.map((bucket) => [bucket.at, 1 - bucket.last]),
          symbolSize: 8,
          itemStyle: { color: token("surface-raised"), borderColor: color, borderWidth: 1.8 },
          z: 3,
          silent: true,
          tooltip: { show: false },
        },
      );
    }
  });

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animation: false,
    grid: lanes.map((_, index) => ({
      left: plotLeft,
      right: plotRight,
      top: layout.rects[index]?.top ?? 0,
      height: layout.rects[index]?.height ?? 0,
    })),
    // One heading per plot, in the gap above it: the unit, or a contact's name.
    title: lanes.map((lane, index) => ({
      text: laneTitle(lane, options),
      left: plotLeft,
      top: (layout.rects[index]?.top ?? 0) - 19,
      textStyle: {
        color: lane.kind === "state" ? token("ink") : token("ink-muted"),
        fontSize: 11,
        fontWeight: lane.kind === "state" ? 600 : 500,
      },
    })),
    // One pointer, linked across every plot: the same instant on all of them.
    axisPointer: { link: [{ xAxisIndex: "all" }], lineStyle: { color: token("ink-faint") } },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      axisPointer: { type: "line", label: { show: false } },
      formatter: (params: unknown) => {
        const rows = (Array.isArray(params) ? params : [params]) as { axisValue?: number | string }[];
        const raw = rows[0]?.axisValue;
        const at = typeof raw === "number" ? raw : Date.parse(String(raw));
        if (!Number.isFinite(at)) return "";
        const lines: string[] = [];
        for (const lane of lanes) {
          for (const key of lane.members) {
            const entry = byKey.get(key);
            const data = prepared.get(key);
            if (!entry || !data) continue;
            const swatch = `<span style="color:${colourOf(options, key)}">●</span> ${entry.label}: `;
            if (entry.kind === "state") {
              const state = stateAt(entry.state?.points ?? [], at, data.tolerance);
              if (state === undefined) continue;
              lines.push(
                swatch +
                  (state === null
                    ? `<span style="opacity:.7">nothing received</span>`
                    : `<strong>${WORD[state]}</strong>`),
              );
            } else {
              const value = analogValueAt(data.ms, at, data.tolerance);
              if (value === undefined) continue;
              // In "Compare shapes" the line is a percentage; the real value stays
              // the headline and the percentage is said beside it.
              const share =
                lane.normalised && data.peak !== null && value !== null
                  ? ` <span style="opacity:.7">· ${Math.round(asPercentOfPeak(value, data.peak) ?? 0)}% of its peak</span>`
                  : "";
              lines.push(
                swatch +
                  (value === null
                    ? `<span style="opacity:.7">no data</span>`
                    : `<strong>${formatReading(value, entry.unit)}</strong>${share}`),
              );
            }
          }
        }
        const tier = drawn[0]?.tier ?? null;
        return `${formatBucket(at, tier, timezone)}<br/>${
          lines.length > 0 ? lines.join("<br/>") : '<span style="opacity:.7">no data in this interval</span>'
        }`;
      },
    },
    xAxis: lanes.map((_, index) => ({
      type: "time" as const,
      gridIndex: index,
      min: axis.min,
      max: axis.max,
      axisLine: { lineStyle: { color: token("chart-grid") } },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: token("chart-grid"), width: 1 } },
      // Only the bottom plot carries time labels: repeating them under every
      // plot says the same thing again and again.
      axisLabel: {
        show: index === lastLane,
        fontSize: 10,
        hideOverlap: true,
        color: token("ink-faint"),
        customValues: day ? dayAxis(day).customValues : undefined,
        formatter: (value: number) => timeAxisLabel(value, drawn[0]?.tier ?? null, timezone, day, spanMs),
      },
    })),
    yAxis: yAxes as EChartsOption["yAxis"],
    dataZoom: [
      {
        type: "inside",
        // Every plot zooms together — they are one chart shown in bands.
        xAxisIndex: lanes.map((_, index) => index),
        throttle: 60,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        start: zoom.current.start,
        end: zoom.current.end,
      },
      {
        type: "slider",
        xAxisIndex: lanes.map((_, index) => index),
        start: zoom.current.start,
        end: zoom.current.end,
        height: 14,
        bottom: 4,
        borderColor: "transparent",
        backgroundColor: tokenAlpha("chart-grid", 0.45),
        fillerColor: tokenAlpha("chart-primary", 0.12),
        handleStyle: { color: token("chart-primary"), borderColor: token("chart-primary") },
        moveHandleStyle: { color: token("chart-grid") },
        dataBackground: {
          lineStyle: { color: tokenAlpha("ink-faint", 0.5), width: 1 },
          areaStyle: { color: tokenAlpha("ink-faint", 0.12) },
        },
        labelFormatter: "",
      },
    ],
    series: seriesList as EChartsOption["series"],
  };

  const dataSignature = drawn
    .map((entry) => `${entry.key}:${idOf(entry.points)}:${idOf(entry.state)}:${entry.tier ?? ""}`)
    .join("|");
  const ref = useEcharts(
    option,
    [dataSignature, themeVersion, tableView, zoomEpoch, from, to, day?.start, day?.end, timezone, gutter, mode],
    { datazoom: onZoom },
  );

  // ── The menu
  const menu: CheckboxOption<string>[] = options.map((entry) => ({
    value: entry.key,
    label: entry.label,
    description: entry.description ?? (displayUnit(entry.unit) ? `Drawn in ${displayUnit(entry.unit)}` : undefined),
    disabledReason: entry.unavailableReason ?? null,
    swatch: <Swatch kind={entry.kind} color={colourOf(options, entry.key)} />,
  }));

  // ── The table twin — built only while it is open, and indexed once rather
  // than searched per cell (a day at one minute is ~1,440 rows × every reading).
  const table = tableView
    ? (() => {
        const analogAt = new Map(
          drawn
            .filter((entry) => entry.kind === "analog")
            .map((entry) => [entry.key, new Map(toMs(entry.points ?? []).map((point) => [point.at, point.value]))]),
        );
        const stateExact = new Map(
          drawn
            .filter((entry) => entry.kind === "state")
            .map((entry) => [entry.key, new Map((entry.state?.points ?? []).map((point) => [point.at, point.state]))]),
        );
        const stamps = [
          ...new Set([
            ...[...analogAt.values()].flatMap((byTime) => [...byTime.keys()]),
            ...[...stateExact.values()].flatMap((byTime) => [...byTime.keys()]),
          ]),
        ].sort((a, b) => a - b);
        const cell = (entry: TrendLaneOption, at: number): string => {
          if (entry.kind === "state") {
            const exact = stateExact.get(entry.key)?.get(at);
            const state =
              exact !== undefined
                ? exact
                : stateAt(entry.state?.points ?? [], at, prepared.get(entry.key)?.tolerance ?? 0);
            return state === null || state === undefined ? "—" : WORD[state];
          }
          const value = analogAt.get(entry.key)?.get(at);
          // Digits from the catalogue's unit, as everywhere: a power factor is
          // two decimals, a count none (Guardrail 24).
          return value === null || value === undefined
            ? "—"
            : formatNumber(value, { digits: digitsForUnit(entry.unit) });
        };
        return { stamps, cell };
      })()
    : null;

  const tiers = [...new Set(drawn.map((entry) => entry.tier).filter((tier): tier is Tier => tier !== null))];
  const flagged = drawn.filter((entry) => entry.flaggedCount > 0);
  const withProvenance = drawn.filter((entry) => entry.provenance);

  // "Stacked" only differs from "Overlaid" across more than one unit, so it is
  // only offered then; "Compare shapes" is offered whenever there are two lines.
  const layoutChoices: (readonly [TrendLayout, string, string])[] = [
    ["overlay", "Overlaid", "Every reading on one plot, each unit on its own scale, real numbers."],
    ...(unitCount > 1
      ? ([["stacked", "Stacked", "One plot per unit, on one shared time axis, real numbers."]] as const)
      : []),
    [
      "shapes",
      "Compare shapes",
      "Every reading rescaled to a percentage of its own peak, on one scale: shows when things rise and fall together, not how big they are.",
    ],
  ];
  // Readings that are flat at zero in "Compare shapes" have no shape to draw.
  const flatInShapes =
    layoutInUse === "shapes"
      ? analogTicked.filter((entry) => plottableCount(entry) > 0 && prepared.get(entry.key)?.peak === null)
      : [];

  return (
    <div>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {drawn.map((entry) => (
            <span key={entry.key} className="flex items-center gap-1.5 font-medium text-ink">
              <Swatch kind={entry.kind} color={colourOf(options, entry.key)} />
              {entry.label}
              {displayUnit(entry.unit) ? (
                <span className="font-normal text-ink-muted">({displayUnit(entry.unit)})</span>
              ) : null}
              {layoutInUse === "shapes" && prepared.get(entry.key)?.peak ? (
                // 100% is this reading's own peak: say what that is in real terms.
                <span className="font-normal text-ink-faint">
                  · peak {formatReading(prepared.get(entry.key)?.peak ?? 0, entry.unit)}
                </span>
              ) : null}
              {entry.pending ? <span className="font-normal text-ink-faint">· loading…</span> : null}
            </span>
          ))}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {analogCount >= 2 && !tableView ? (
            <div
              role="group"
              aria-label="Chart layout"
              className="flex overflow-hidden rounded-control border border-line text-[10px] font-medium"
            >
              {layoutChoices.map(([value, text, hint]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={layoutInUse === value}
                  title={hint}
                  onClick={() => setMode(value)}
                  className={`px-2 py-1.5 transition ${
                    layoutInUse === value ? "bg-accent text-on-accent" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {text}
                </button>
              ))}
            </div>
          ) : null}
          <CheckboxMenu
            label={menuLabel}
            options={menu}
            selected={selected}
            onChange={onSelectedChange}
            bulk
          />
          {!tableView && drawn.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                zoom.current = { start: 0, end: 100 };
                setZoomEpoch((epoch) => epoch + 1);
              }}
              title="Undo any zoom or pan and show the whole window."
              className="flex items-center gap-1 rounded-control border border-line px-1.5 py-1.5 text-[10px] font-medium text-ink-muted transition hover:text-ink"
            >
              <IconExpand size={12} />
              Show all
            </button>
          ) : null}
          {drawn.length > 0 ? (
            <button
              type="button"
              onClick={() => setTableView((on) => !on)}
              aria-pressed={tableView}
              title={tableView ? "Back to the chart" : "Read the same numbers as a table"}
              className="flex items-center gap-1 rounded-control border border-line px-1.5 py-1.5 text-[10px] font-medium text-ink-muted transition hover:text-ink"
            >
              {tableView ? <IconGauge size={12} /> : <IconList size={12} />}
              {tableView ? "Chart" : "Table"}
            </button>
          ) : null}
        </div>
      </div>

      {/* Each branch keyed: React must never reuse the node ECharts filled. */}
      {drawn.length === 0 ? (
        <div
          key="none"
          className="flex min-h-[200px] flex-col items-center justify-center gap-1.5 rounded-control border border-dashed border-line px-4 py-6 text-center"
        >
          {unavailable.length === options.length && options.length > 0 ? (
            // Nothing on the menu can be drawn: say why, here, because the
            // reasons would otherwise be inside a menu with nothing to tick
            // (Guardrail 26).
            <>
              <p className="text-xs font-medium text-ink-muted">Nothing here can be drawn yet.</p>
              {unavailable.slice(0, 6).map((entry) => (
                <p key={entry.key} className="max-w-xl text-[11px] leading-snug text-ink-faint">
                  <span className="font-medium text-ink-muted">{entry.label}</span> — {entry.unavailableReason}
                </p>
              ))}
              {unavailable.length > 6 ? (
                <p className="text-[11px] text-ink-faint">and {unavailable.length - 6} more.</p>
              ) : null}
            </>
          ) : (
            <p className="text-xs text-ink-faint">{emptyHint}</p>
          )}
        </div>
      ) : isLoading ? (
        <div
          key="loading"
          style={{ height: layout.total }}
          className="flex items-center justify-center rounded-control border border-line"
        >
          <span className="text-[11px] text-ink-faint">Loading readings…</span>
        </div>
      ) : table ? (
        <div key="table" style={{ height: Math.min(layout.total, 520) }} className="overflow-auto rounded-control border border-line">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-surface-sunken text-ink-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Time</th>
                {drawn.map((entry) => (
                  <th key={entry.key} className="px-2 py-1 text-right font-medium">
                    {entry.label}
                    {displayUnit(entry.unit) ? ` (${displayUnit(entry.unit)})` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.stamps.map((at) => (
                <tr key={at} className="border-t border-line-soft">
                  <td className="px-2 py-1 text-ink-muted">{formatBucket(at, drawn[0]?.tier ?? null, timezone)}</td>
                  {drawn.map((entry) => (
                    <td key={entry.key} className="px-2 py-1 text-right font-mono tabular-nums text-ink">
                      {table.cell(entry, at)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div key={`chart-${zoomEpoch}`} className="relative" style={{ height: layout.total }}>
          <div ref={ref} style={{ height: layout.total }} role="img" aria-label="Trend of the chosen readings over time" />
          {/* A plot with nothing in it would be a bare frame — a chart that
              failed, or slid out of its space. Say why it is empty in the plot
              itself (Guardrail 26). */}
          {lanes.map((lane, index) => {
            const members = lane.members.map((key) => byKey.get(key)).filter((m): m is TrendLaneOption => !!m);
            // In "Compare shapes" a reading flat at zero has data and no shape.
            const hasShape = (member: TrendLaneOption) =>
              plottableCount(member) > 0 && (!lane.normalised || prepared.get(member.key)?.peak != null);
            if (members.some(hasShape)) return null;
            const anyData = members.some((member) => plottableCount(member) > 0);
            const rect = layout.rects[index];
            if (!rect) return null;
            const flaggedHere = members.reduce((sum, member) => sum + member.flaggedCount, 0);
            // Asked for and not here yet is not the same as nothing arriving.
            const waiting = members.some((member) => member.pending);
            return (
              <div
                key={lane.id}
                className="pointer-events-none absolute flex items-center justify-center rounded border border-dashed border-line bg-surface-raised/70 px-3 text-center text-[11px] text-ink-faint"
                style={{ top: rect.top, height: rect.height, left: plotLeft, right: plotRight }}
              >
                {waiting
                  ? "Loading readings…"
                  : anyData
                  ? "Every ticked reading is flat at zero in this window, so there is no shape to compare."
                  : flaggedHere > 0
                  ? `Every reading in this window was flagged (${flaggedHere}) — nothing to plot.`
                  : "No readings in this window. That is not a reading of zero — nothing arrived to draw."}
              </div>
            );
          })}
        </div>
      )}

      {layoutInUse === "overlay" && unitCount > 1 && !tableView && drawn.length > 0 ? (
        <p className="mt-1.5 flex items-center text-[11px] text-ink-muted">
          Each unit is drawn on its own scale, its axis coloured as its line. Where two lines cross says
          nothing about the readings — read values from the crosshair.
          <InfoHint
            text={
              "Readings in different units have no physical link, so their scales are fitted separately " +
              "and can be made to line up any way at all — a crossing is an accident of the two scales. " +
              "The Power trend is the one chart whose scales are locked (1,000 W/m² = the DC nameplate); " +
              "Stacked draws one plot per unit on a shared time axis instead, which asserts no such relationship."
            }
          />
        </p>
      ) : null}

      {layoutInUse === "shapes" && !tableView && drawn.length > 0 ? (
        <p className="mt-1.5 flex items-center text-[11px] text-ink-muted">
          Each reading is rescaled so its own highest point in this window is 100%. This shows when things
          rise and fall together, not how big they are — hover for the real values.
          <InfoHint
            text={
              "Different kinds of reading cannot share a real scale, so each is drawn as a share of its own " +
              "peak over the window shown. A line that reaches the top has simply reached its own highest " +
              "value; it says nothing about being larger than another. Use it to see which reading moves " +
              "first, which follows, and which move together."
            }
          />
        </p>
      ) : null}
      {flatInShapes.length > 0 ? (
        <p className="mt-1 text-[11px] text-ink-faint">
          {flatInShapes.map((entry) => entry.label).join(", ")} {flatInShapes.length === 1 ? "is" : "are"} flat at zero
          in this window, so {flatInShapes.length === 1 ? "it has" : "they have"} no shape to compare and{" "}
          {flatInShapes.length === 1 ? "is" : "are"} left off.
        </p>
      ) : null}

      {withProvenance.length > 0 ? (
        <div className="mt-1.5 flex flex-col gap-0.5 text-[11px] text-ink-faint">
          {withProvenance.map((entry) => (
            <span key={entry.key}>
              {entry.label}: {entry.provenance}
            </span>
          ))}
        </div>
      ) : null}

      {flagged.map((entry) => (
        <p key={entry.key} className="mt-1 text-[10px] leading-snug text-warn">
          {entry.label}: {entry.flaggedCount} reading{entry.flaggedCount === 1 ? " was" : "s were"} flagged and not
          plotted — out of range, stale or unparseable. They are stored and flagged, never discarded.
        </p>
      ))}

      {tiers.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {tiers.map((tier) => (
            <Badge
              key={tier}
              tone="neutral"
              title="The coarsest tier that covers this range and still retains it. Every tier runs with real-time aggregation, so a coarser tier costs resolution, not freshness."
            >
              {TIER_LABELS[tier]}
            </Badge>
          ))}
          <span className="text-[10px] text-ink-faint">scroll to zoom · drag to pan</span>
        </div>
      ) : null}
    </div>
  );
}
