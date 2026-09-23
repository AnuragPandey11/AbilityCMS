/**
 * The trend chart used across the dashboards.
 *
 * One measure, one axis, over time. **Never two y-scales**: the alignment
 * between two scales is arbitrary, so a dual-axis plot invents a correlation
 * that is not in the data — put irradiance beside power on one plot and the
 * chart asserts a relationship nobody measured. Where two measures genuinely
 * need comparing, `<SmallMultiples>` below stacks them on a shared x-axis,
 * which lets the eye line up the times without the chart claiming anything
 * about the values.
 *
 * ── What makes it read as instrument-grade rather than decorative ───────────
 * - Thin marks on a recessive grid: a 2px line, solid hairline gridlines one
 *   shade off the surface, no axis boxes. Dashed gridlines are avoided
 *   deliberately — dashing means "projection" or "threshold" elsewhere in this
 *   platform, and a grid that looks like a threshold is a grid nobody trusts.
 * - A gradient area under a single series, fading to nothing, so the curve has
 *   weight without the fill competing with it.
 * - The peak is direct-labelled and nothing else is. A value beside every point
 *   is chaos and goes unread; the one that matters is the maximum, which on a
 *   generation curve is the number somebody is actually looking for.
 * - Zoom lives on the chart: scroll or pinch to zoom, drag to pan, and a slider
 *   for coarse framing. Range selection is a control *above* the chart, not
 *   inside it, so every chart on the screen re-renders against the same slice.
 * - A table view twin, because a value reachable only by hovering is a value
 *   somebody on a keyboard cannot read at all.
 *
 * ── Two things it will not do ───────────────────────────────────────────────
 * It never interpolates across a gap. A missing bucket is a break in the line,
 * because the Plant was not producing zero — nobody knows what it was doing,
 * and a line drawn through the hole asserts that somebody does. And it never
 * converts a unit: the unit arrives from the Tag catalogue and is rendered
 * verbatim (§4.1).
 */

import { useMemo, useState } from "react";
import type { EChartsOption } from "echarts";
import type { Tier } from "@/api/schemas";
import type { TrendPoint } from "@/api/useSlotTrend";
import { formatAxisLabel, formatBucket, DEFAULT_TIMEZONE } from "@/format/datetime";
import { formatCompact, formatNumber, formatValue } from "@/format/value";
import { chartTheme, useEcharts } from "./useEcharts";
import { seriesPalette, token, tokenAlpha, withAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { Badge, InfoHint } from "@/components/ui";
import { IconList, IconGauge } from "@/components/icons";
import { TIER_LABELS } from "./TimeSeriesChart";

export interface TrendChartProps {
  points: TrendPoint[];
  unit: string | null;
  label: string;
  tier: Tier | null;
  /** Which Device answered. Rendered under the title, never inferred here. */
  provenance?: string | null;
  timezone?: string;
  height?: number;
  /** `area` for a rate (power, irradiance); `bar` for a per-bucket total. */
  shape?: "area" | "bar";
  /** Series colour. Defaults to the brand accent — this chart is one series. */
  colorToken?: "series" | "accent";
  /** Mark and label the maximum. Off for a chart where the peak means nothing. */
  markPeak?: boolean;
  /**
   * Readings that arrived but were not plotted because they were flagged.
   * Rendered as a note — an empty chart because every value was out of range
   * and an empty chart because nothing arrived look identical and mean
   * opposite things.
   */
  flaggedCount?: number;
  /**
   * The series is still being fetched.
   *
   * Kept separate from "no points", because the two look identical and mean
   * opposite things: one is a Plant that reported nothing, the other is a
   * question nobody has answered yet.
   */
  isLoading?: boolean;
  /**
   * Frame the x-axis on one Plant-local calendar day, midnight to midnight,
   * with a tick every two hours. The data stops at now; the axis does not, so
   * the rest of the day reads as not yet happened rather than as the morning
   * stretched across the frame.
   */
  day?: DayFrame | null;
  /**
   * A legend above the plot. Omitted, the chart names its one series in the
   * tooltip only, which is enough when the panel title already says what it is.
   */
  legend?: TrendLegendEntry[];
  /**
   * Replaces the tier badge when the points are not one tier's own buckets —
   * a series built from finer ones says what it was built from, rather than
   * naming a tier it was never read from (§9).
   */
  resolution?: { label: string; title: string };
}

/** One Plant-local calendar day, `[start, end)` in epoch ms. */
export interface DayFrame {
  start: number;
  end: number;
}

export interface TrendLegendEntry {
  label: string;
  /** Solid for a measured series; dashed for a reference line such as an expectation. */
  line: "solid" | "dashed";
  /**
   * Set when the series has nothing to draw, and why. The entry stays in the
   * legend, visibly off, so the reason is on the screen — a line that is
   * simply missing reads as a line somebody forgot, and a line drawn from a
   * guess reads as a measurement.
   */
  unavailable?: { note: string; reason: string };
}

const TWO_HOURS = 2 * 3_600_000;

/** A label every two hours across the day, midnight to midnight inclusive. */
function dayTicks(day: DayFrame): number[] {
  const ticks: number[] = [];
  for (let at = day.start; at <= day.end; at += TWO_HOURS) ticks.push(at);
  return ticks;
}

/**
 * The time-axis label, with the day's closing midnight written `24:00`.
 *
 * Formatted as a clock it would read `00:00` at both ends of the axis, and the
 * right-hand one would claim the start of a day the chart is not showing.
 */
function timeAxisLabel(
  value: number,
  tier: Tier | null | undefined,
  timezone: string,
  day: DayFrame | null | undefined,
): string {
  if (day && value >= day.end) return "24:00";
  return formatAxisLabel(new Date(value), tier ?? "agg_1h", timezone);
}

/** The x-axis bounds and labels for a day frame; nothing when there is none. */
function dayAxis(
  day: DayFrame | null | undefined,
): { min?: number; max?: number; customValues?: number[] } {
  return day ? { min: day.start, max: day.end, customValues: dayTicks(day) } : {};
}

function LegendSwatch({ line, color }: { line: "solid" | "dashed"; color: string | null }): JSX.Element {
  return line === "solid" ? (
    <span
      aria-hidden
      className="h-0.5 w-4 shrink-0 rounded-full bg-ink-faint"
      style={color ? { backgroundColor: color } : undefined}
    />
  ) : (
    <span
      aria-hidden
      className={`w-4 shrink-0 border-t-2 border-dashed ${color ? "border-ink-muted" : "border-ink-faint"}`}
    />
  );
}

/**
 * A y-axis tick label that fits its gutter, and the gutter it needs.
 *
 * ⚠ ECharts does not measure axis labels against the grid — it draws them and
 * lets them overflow. A lifetime energy counter ticks at 1,500,000, which is
 * nine characters, and against the fixed 52px gutter the leading digit was
 * simply **cut off**: the axis read `,500,000`. Silently losing the most
 * significant digit of a scale is about the worst thing an axis can do.
 *
 * Two halves to the fix. Compact the label once it is long enough to be a
 * problem — `1.5M` rather than `1,500,000`, which is also easier to read at
 * tick size — and then size the gutter from the longest label that will
 * actually be drawn rather than from a guess.
 *
 * Compaction starts at 10,000 rather than at `COMPACT_ABOVE`: a tile has room
 * for `999,999` and an axis tick does not, so the two thresholds are
 * deliberately different.
 */
const AXIS_COMPACT_ABOVE = 10_000;

function axisTickLabel(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Math.abs(value) >= AXIS_COMPACT_ABOVE) return formatCompact(value);
  if (Number.isInteger(value)) return formatNumber(value, { digits: 0 });
  // A tick is not a reading: trailing zeros that pad it to the app's usual
  // precision are noise on an axis. `0.200 0.400 0.600` becomes `0.2 0.4 0.6`,
  // which is the same scale with a third of the ink.
  return String(Number(value.toFixed(3)));
}

/** Left gutter wide enough for the widest tick this series will produce. */
function axisGutter(points: TrendPoint[]): number {
  let widest = 0;
  for (const point of points) {
    if (point.value === null) continue;
    widest = Math.max(widest, axisTickLabel(point.value).length);
  }
  // ~6.2px per character at the 10px tick size, plus the tick and a margin.
  return Math.min(78, Math.max(44, Math.round(widest * 6.2) + 16));
}

/**
 * The series colour, resolved at render so it follows the theme.
 *
 * The brand accent by default. This chart always draws exactly one series, so
 * its hue has nothing to be told apart from, and the categorical palette —
 * whose slot order is the colourblind-safety mechanism (see `index.css`) — is
 * for charts that do. `"series"` still selects slot 1 for a caller that sits a
 * trend beside a multi-series chart and wants them to agree.
 */
function seriesColor(which: "series" | "accent"): string {
  return which === "accent" ? token("accent") : (seriesPalette()[0] ?? token("accent"));
}

export function TrendChart({
  points,
  unit,
  label,
  tier,
  provenance,
  timezone = DEFAULT_TIMEZONE,
  height = 200,
  shape = "area",
  colorToken = "accent",
  markPeak = true,
  flaggedCount = 0,
  isLoading = false,
  day = null,
  legend,
  resolution,
}: TrendChartProps): JSX.Element {
  const [tableView, setTableView] = useState(false);
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();

  const { peak, peakPosition } = useMemo(() => {
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
    return {
      peak: found,
      // Where along the axis the peak fell, 0..1 — used only to keep its label
      // inside the plot. Against the day when the axis is a day: the data
      // stops at now, so the last point is not the right-hand edge.
      peakPosition:
        day && found
          ? (Date.parse(found.at) - day.start) / (day.end - day.start)
          : points.length > 1
            ? bestIndex / (points.length - 1)
            : 0.5,
    };
  }, [points, day]);

  const color = seriesColor(colorToken);
  const data = points.map((point) => [point.at, point.value] as [string, number | null]);

  /**
   * How many points can actually be drawn.
   *
   * ⚠ **A single point on a line with `showSymbol: false` renders nothing at
   * all** — a line needs two vertices, so one reading produces a blank plot
   * with axes, which reads as "no data" when the truth is "one reading". It is
   * the worst of the edge cases because it is silent and plausible. Below three
   * points the symbols come back on, so one reading is a visible dot.
   */
  const plottable = points.filter((point) => point.value !== null).length;
  const sparse = plottable > 0 && plottable < 3;

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 320,
    grid: { left: axisGutter(points), right: 26, top: markPeak ? 28 : 20, bottom: 34 },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      // A crosshair rather than a bare pointer: on a curve this dense the
      // reader needs the time as much as the value.
      axisPointer: {
        type: "line",
        lineStyle: { color: token("ink-faint"), width: 1, type: "solid" },
        label: { show: false },
      },
      formatter: (params: unknown) => {
        const rows = Array.isArray(params) ? params : [params];
        const first = rows[0] as { axisValue?: string; dataIndex?: number } | undefined;
        const point = points[first?.dataIndex ?? -1];
        if (!point || point.value === null) {
          return `${formatBucket(first?.axisValue, tier, timezone)}<br/><span style="opacity:.7">no data in this interval</span>`;
        }
        // The contributor count is on the tooltip rather than the axis: on a
        // summed series a bucket where four of seventeen Inverters reported is
        // a low number that looks like a dip, and this is the only thing on
        // the screen that can say otherwise.
        const partial =
          point.contributors > 1
            ? `<br/><span style="opacity:.65">${point.contributors} Device(s) in this bucket</span>`
            : "";
        return (
          `${formatBucket(point.at, tier, timezone)}<br/>` +
          `<span style="color:${color}">●</span> ${label}: ` +
          `<strong>${formatValue(point.value, unit ?? undefined)}</strong>${partial}`
        );
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: token("chart-grid") } },
      axisTick: { show: false },
      splitLine: { show: false },
      /*
        On the daily tier the ticks must land on whole days. Without this
        ECharts chose a sub-day interval and, since the label renders as
        `DD-MM`, the same date appeared two or three times in a row — an axis
        that looks like duplicated data rather than a tick spacing choice.
      */
      minInterval: tier === "agg_1d" ? 24 * 3600 * 1000 : undefined,
      min: dayAxis(day).min,
      max: dayAxis(day).max,
      axisLabel: {
        fontSize: 10,
        hideOverlap: true,
        color: token("ink-faint"),
        customValues: dayAxis(day).customValues,
        formatter: (value: number) => timeAxisLabel(value, tier, timezone, day),
      },
    },
    yAxis: {
      type: "value",
      name: unit ?? "",
      nameTextStyle: { color: token("ink-faint"), fontSize: 10, align: "left" },
      nameGap: 10,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: theme.splitLine,
      axisLabel: {
        fontSize: 10,
        color: token("ink-faint"),
        formatter: (value: number) => axisTickLabel(value),
      },
      scale: false,
    },
    dataZoom: [
      { type: "inside", throttle: 60, zoomOnMouseWheel: true, moveOnMouseMove: true },
      {
        type: "slider",
        height: 14,
        bottom: 2,
        borderColor: "transparent",
        backgroundColor: tokenAlpha("chart-grid", 0.45),
        fillerColor: tokenAlpha("accent", 0.12),
        handleStyle: { color: token("accent"), borderColor: token("accent") },
        moveHandleStyle: { color: token("chart-grid") },
        dataBackground: {
          lineStyle: { color: tokenAlpha("ink-faint", 0.5), width: 1 },
          areaStyle: { color: tokenAlpha("ink-faint", 0.12) },
        },
        selectedDataBackground: {
          lineStyle: { color, width: 1 },
          areaStyle: { color: tokenAlpha("accent", 0.15) },
        },
        labelFormatter: "",
      },
    ],
    series: [
      shape === "area"
        ? {
            name: label,
            type: "line",
            data,
            // See `sparse`: one point with no symbol draws nothing.
            showSymbol: sparse,
            symbolSize: 7,
            // ⚠ Never `connectNulls`. A gap means the Plant did not report,
            // which is not the same as reporting zero, and a line drawn across
            // the hole claims a value nobody measured.
            connectNulls: false,
            smooth: 0.18,
            sampling: "lttb",
            lineStyle: { width: 2, color },
            itemStyle: { color },
            areaStyle: {
              /**
               * Filled to **zero**, not to the bottom of the plot.
               *
               * ECharts fills to the axis minimum by default, so a series that
               * never reaches zero — a meter idling at −5.4 kW overnight on an
               * axis running 0 to −6 — paints almost the entire panel solid and
               * the area stops meaning anything. Anchored at zero the fill is
               * the quantity itself, and import below the line reads as the
               * opposite of export above it, which is what those signs mean.
               */
              origin: 0,
              color: {
                type: "linear",
                x: 0, y: 0, x2: 0, y2: 1,
                colorStops: [
                  { offset: 0, color: tokenAlpha("accent", 0) },
                  { offset: 1, color: tokenAlpha("accent", 0) },
                ],
              },
              opacity: 1,
            },
            markPoint: markPeak && peak
              ? {
                  symbol: "circle",
                  symbolSize: 7,
                  itemStyle: { color, borderColor: token("surface-raised"), borderWidth: 2 },
                  label: {
                    show: true,
                    /*
                      Flipped when the peak sits near an edge.
                      
                      ECharts anchors a markPoint label to the point and does
                      not reflow it, so a peak in the last minutes of the
                      window — which on a generation curve is where a *rising*
                      day peaks — pushed "peak 235 kW" off the right of the
                      plot and rendered it as "peak 235 k". Nudging the label
                      inboard costs nothing and the one case it fixes is the
                      common one.
                    */
                    position:
                      peakPosition > 0.86 ? "left" : peakPosition < 0.1 ? "right" : "top",
                    distance: 8,
                    fontSize: 10,
                    color: token("ink"),
                    backgroundColor: theme.tooltipBackground,
                    borderColor: theme.tooltipBorder,
                    borderWidth: 1,
                    borderRadius: 4,
                    padding: [2, 5],
                    formatter: () =>
                      `peak ${formatValue(peak.value, unit ?? undefined)}`,
                  },
                  data: [{ name: "peak", coord: [peak.at, peak.value as number] }],
                }
              : undefined,
          }
        : {
            name: label,
            type: "bar",
            data,
            // 4px rounded data-ends anchored to the baseline: the bar's far end
            // is rounded, the end that meets the axis is square, so the
            // baseline stays a straight line.
            itemStyle: { color, borderRadius: [4, 4, 0, 0] },
            barMaxWidth: 26,
            // A 2px gap of surface between adjacent bars rather than a border
            // drawn around each: a keyline thickens every mark and makes a
            // dense series read as a solid block.
            barCategoryGap: "32%",
          },
    ],
  };

  // The gradient has to be built from the series colour, which is only known
  // here. ECharts takes the object above by reference, so patch it in place.
  if (shape === "area") {
    const area = (option.series as { areaStyle?: { color: { colorStops: { offset: number; color: string }[] } } }[])[0]?.areaStyle;
    if (area) {
      area.color.colorStops = [
        { offset: 0, color: withAlpha(color, 0.26) },
        { offset: 1, color: withAlpha(color, 0.02) },
      ];
    }
  }

  const ref = useEcharts(option, [
    points,
    unit,
    label,
    tier,
    timezone,
    shape,
    themeVersion,
    tableView,
    day?.start,
    day?.end,
  ]);

  const rows = points.filter((point) => point.value !== null);

  return (
    <div>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="min-w-0">
          {legend && legend.length > 0 ? (
            <div className="mb-0.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              {legend.map((entry) => (
                <span
                  key={entry.label}
                  className={`flex items-center gap-1.5 ${
                    entry.unavailable ? "text-ink-faint" : "font-medium text-ink"
                  }`}
                >
                  <LegendSwatch
                    line={entry.line}
                    color={entry.unavailable ? null : entry.line === "solid" ? color : token("ink-muted")}
                  />
                  {entry.label}
                  {entry.unavailable ? (
                    <span className="flex items-center font-normal">
                      · {entry.unavailable.note}
                      <InfoHint text={entry.unavailable.reason} />
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          ) : null}
          {provenance ? (
            <div
              className="text-[11px] text-ink-faint"
              title="Which Device answered this figure. Resolved by the server against what this Plant is bound to."
            >
              {provenance}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setTableView((on) => !on)}
          aria-pressed={tableView}
          title={
            tableView
              ? "Back to the chart"
              : "Read the same numbers as a table — every value on the chart, without hovering"
          }
          className="flex shrink-0 items-center gap-1 rounded-control border border-line px-1.5 py-1 text-[10px] font-medium text-ink-muted transition hover:text-ink"
        >
          {tableView ? <IconGauge size={12} /> : <IconList size={12} />}
          {tableView ? "Chart" : "Table"}
        </button>
      </div>

      {/*
        ⚠ Each branch carries its own `key`, and that is load-bearing.

        All three render a `div` at the same position, so without distinct keys
        React reuses one DOM node and only swaps its props and children. ECharts
        then appends a canvas into the very node React is still reconciling, and
        the next swap throws `NotFoundError: Failed to execute 'removeChild'` —
        which unmounts the whole dashboard, not just the chart. Switching to the
        table view and back did exactly that. Distinct keys make React mount and
        unmount separate nodes, so the callback ref disposes the old instance and
        initialises a new one, and React never fights the library for a child.
      */}
      {isLoading ? (
        /*
          Loading is not emptiness. "No readings in this window" is a statement
          about the Plant, and printing it while the request is still in flight
          asserts something nobody has checked — on a slow link it was the first
          thing the operator read, every time.
        */
        <div
          key="loading"
          style={{ height }}
          className="flex items-center justify-center rounded-control border border-line"
        >
          <span className="text-[11px] text-ink-faint">Loading readings…</span>
        </div>
      ) : plottable === 0 && !tableView ? (
        /*
          An empty plot with axes and no marks reads as a broken chart. The
          three reasons a series is empty are different problems — nothing was
          ever recorded, everything in the window was flagged, or the Plant went
          quiet — and the first two are named here rather than left to be
          guessed from a blank rectangle.
        */
        <div
          key="empty"
          style={{ height }}
          className="flex items-center justify-center rounded-control border border-dashed border-line px-4 text-center"
        >
          <p className="text-[11px] leading-snug text-ink-faint">
            {flaggedCount > 0
              ? `No value could be plotted: all ${flaggedCount} reading${flaggedCount === 1 ? "" : "s"} in this window were flagged out of range, stale or unparseable.`
              : "No readings in this window. That is not a reading of zero — nothing arrived to draw."}
          </p>
        </div>
      ) : tableView ? (
        <div
          key="table"
          style={{ height }}
          className="overflow-auto rounded-control border border-line"
        >
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-surface-sunken text-ink-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Time</th>
                <th className="px-2 py-1 text-right font-medium">
                  {label}
                  {unit ? ` (${unit})` : ""}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-2 py-3 text-center text-ink-faint">
                    No readings in this period.
                  </td>
                </tr>
              ) : (
                rows.map((point) => (
                  <tr key={point.at} className="border-t border-line-soft">
                    <td className="px-2 py-1 text-ink-muted">
                      {formatBucket(point.at, tier, timezone)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono tabular-nums text-ink">
                      {formatNumber(point.value)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div key="chart" ref={ref} style={{ height }} />
      )}

      {flaggedCount > 0 ? (
        <p className="mt-1 text-[10px] leading-snug text-warn">
          {flaggedCount} reading{flaggedCount === 1 ? " was" : "s were"} flagged and{" "}
          {points.length === 0 ? "none could be plotted" : "are not plotted"} — out of range,
          stale or unparseable. They are stored and flagged, never discarded; the time-series
          explorer re-draws them in the quality&rsquo;s own colour.
        </p>
      ) : null}

      {tier || resolution ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* §9: say which tier served this, or a smoothed line reads as a
              measurement taken at that resolution. */}
          <Badge
            tone="neutral"
            title={
              resolution?.title ??
              "The coarsest tier that covers this range and still retains it. Every tier runs with real-time aggregation, so a coarser tier costs resolution, not freshness."
            }
          >
            {resolution?.label ?? (tier ? TIER_LABELS[tier] : null)}
          </Badge>
          <span className="text-[10px] text-ink-faint">scroll to zoom · drag to pan</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Two measures stacked on a shared x-axis — the honest alternative to a
 * dual-axis chart.
 *
 * Each plot keeps its own scale and its own unit, and they share only the time
 * axis, which is the thing they genuinely have in common. The reader can line
 * up "irradiance peaked here, power peaked there" without the chart asserting
 * any ratio between the two, which is precisely what a second y-axis does
 * assert and cannot support.
 */
export function SmallMultiples({
  series,
  timezone = DEFAULT_TIMEZONE,
  height = 190,
  day = null,
}: {
  series: {
    key: string;
    label: string;
    unit: string | null;
    points: TrendPoint[];
    tier: Tier | null;
    flaggedCount?: number;
  }[];
  timezone?: string;
  height?: number;
  /** As `TrendChart`'s: the same day frame, so stacked charts line up with it. */
  day?: DayFrame | null;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();
  const palette = theme.palette;
  const count = Math.max(series.length, 1);

  // Each plot gets an equal band, with the axis labels living under the last.
  const bandHeight = (100 - 14) / count;
  const grids = series.map((_, index) => ({
    left: 52,
    right: 16,
    top: `${index * bandHeight + 6}%`,
    height: `${bandHeight - 9}%`,
  }));

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 320,
    grid: grids,
    // One pointer, linked across every plot: moving the cursor over the top
    // chart shows the same instant on the one below it, which is the entire
    // reason these are stacked rather than side by side.
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
        const rows = Array.isArray(params) ? params : [params];
        const first = rows[0] as { axisValue?: string } | undefined;
        const body = rows
          .map((row) => {
            const typed = row as { seriesName: string; value: unknown[]; color: string };
            const entry = series.find((candidate) => candidate.label === typed.seriesName);
            const value = Array.isArray(typed.value) ? typed.value[1] : null;
            if (value === null || value === undefined) return null;
            return (
              `<span style="color:${typed.color}">●</span> ${typed.seriesName}: ` +
              `<strong>${formatValue(Number(value), entry?.unit ?? undefined)}</strong>`
            );
          })
          .filter(Boolean)
          .join("<br/>");
        return `${formatBucket(first?.axisValue, series[0]?.tier, timezone)}<br/>${body || '<span style="opacity:.7">no data</span>'}`;
      },
    },
    xAxis: series.map((entry, index) => ({
      type: "time" as const,
      gridIndex: index,
      axisLine: { lineStyle: { color: token("chart-grid") } },
      axisTick: { show: false },
      splitLine: { show: false },
      min: dayAxis(day).min,
      max: dayAxis(day).max,
      // Only the bottom plot carries time labels. Repeating them under every
      // band triples the chrome and says the same thing three times.
      axisLabel: {
        show: index === series.length - 1,
        fontSize: 10,
        hideOverlap: true,
        color: token("ink-faint"),
        customValues: dayAxis(day).customValues,
        formatter: (value: number) => timeAxisLabel(value, entry.tier, timezone, day),
      },
    })),
    yAxis: series.map((entry, index) => ({
      type: "value" as const,
      gridIndex: index,
      name: entry.unit ?? "",
      nameTextStyle: { color: token("ink-faint"), fontSize: 9, align: "left" },
      nameGap: 8,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: theme.splitLine,
      splitNumber: 3,
      axisLabel: { fontSize: 9, color: token("ink-faint") },
    })),
    dataZoom: [
      {
        type: "inside",
        // Every plot zooms together — they are one chart shown in bands.
        xAxisIndex: series.map((_, index) => index),
        throttle: 60,
      },
    ],
    series: series.map((entry, index) => ({
      name: entry.label,
      type: "line" as const,
      xAxisIndex: index,
      yAxisIndex: index,
      showSymbol: false,
      connectNulls: false,
      smooth: 0.18,
      sampling: "lttb" as const,
      lineStyle: { width: 1.8, color: palette[index % palette.length] },
      itemStyle: { color: palette[index % palette.length] },
      areaStyle: { origin: 0, color: withAlpha(palette[index % palette.length] ?? "", 0.14) },
      data: entry.points.map((point) => [point.at, point.value]),
    })),
  };

  const ref = useEcharts(option, [series, timezone, themeVersion, day?.start, day?.end]);

  return (
    <div>
      {/* The legend is always present for two or more series, and each band is
          also directly labelled by its own y-axis name — identity is never
          carried by colour alone. */}
      <div className="mb-1 flex flex-wrap items-center gap-3">
        {series.map((entry, index) => (
          <span key={entry.key} className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            <span
              aria-hidden
              className="h-0.5 w-3.5 rounded-full"
              style={{ backgroundColor: palette[index % palette.length] }}
            />
            {entry.label}
          </span>
        ))}
      </div>
      <div ref={ref} style={{ height }} />

      {series
        .filter((entry) => (entry.flaggedCount ?? 0) > 0)
        .map((entry) => (
          <p key={entry.key} className="mt-1 text-[10px] leading-snug text-warn">
            {entry.label}: {entry.flaggedCount} reading
            {entry.flaggedCount === 1 ? " was" : "s were"} flagged and{" "}
            {entry.points.length === 0 ? "none could be plotted" : "are not plotted"}.
          </p>
        ))}
    </div>
  );
}
