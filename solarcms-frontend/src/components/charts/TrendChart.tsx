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

import { useEffect, useMemo, useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import type { Tier } from "@/api/schemas";
import type { TrendPoint } from "@/api/useSlotTrend";
import { formatAxisLabel, formatBucket, DEFAULT_TIMEZONE } from "@/format/datetime";
import { formatCompact, formatNumber, formatValue } from "@/format/value";
import { chartTheme, useEcharts } from "./useEcharts";
import { seriesPalette, token, tokenAlpha, withAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { Badge, InfoHint } from "@/components/ui";
import { IconExpand, IconExport, IconList, IconGauge } from "@/components/icons";
import { downloadCsv, trendCsv } from "./csv";
import { sameFrame } from "@/api/trendWindow";
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
  /**
   * Series colour. Defaults to `primary`, the one-series chart colour (blue in
   * light, the accent in dark). `accent` is the brand teal, for a page of
   * trends that needs one more hue beside the palette's; `neutral` is the
   * muted ink, for a page that has run out of hues clear of the ones status
   * owns.
   */
  colorToken?: "primary" | "series" | "accent" | "neutral";
  /**
   * A slot of the validated categorical palette instead, for a page of
   * several single-series charts that should be told apart at a glance — the
   * Inverter view's six trends. Wins over `colorToken`.
   */
  paletteSlot?: number;
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
  /**
   * Shade each bucket's lowest-to-highest reading behind the line, where the
   * points carry one (`TrendPoint.low`/`high`: one Device, an averaged Tag).
   * An hourly mean over a year flattens a ten-minute 95 °C excursion into a
   * gentle bump; the band keeps it on screen at any zoom.
   */
  band?: boolean;
  /**
   * What happened in the window that explains a dip: Alarms as thin vertical
   * marks at the moment they opened, planned work as a shaded stretch. Drawn on
   * the time axis itself, so a fall in output and the trip that caused it are
   * read together rather than cross-checked on another screen.
   */
  events?: ChartEvent[];
  /**
   * Make the zoom **fetch**: the chart frames `[from, to)` and, when the reader
   * zooms in, calls `onWindow` with the visible span (null once back at the
   * whole) so the caller can ask for finer buckets there. The zoom is
   * remembered across data refreshes — without that, the finer data arriving
   * would itself throw the reader back out to the whole window.
   */
  zoom?: ZoomControl;
  /**
   * A file name stem for "CSV" — the points drawn, as a table. Omitted, there
   * is no button: the caller passes one only where the session may export
   * (`data.export`, MASTER §4.3), which this chart cannot know.
   */
  exportName?: string | null;
  /**
   * Run the time axis over the whole period, `[from, to)` in epoch ms, rather
   * than fitting it to wherever the points happen to be. Several charts on one
   * screen then agree about time: a Device heard only on the last day of a
   * five-day period draws that day at the right-hand end, not across the frame.
   */
  frame?: { from: number; to: number } | null;
}

export interface ChartEvent {
  key: string;
  /** Epoch ms. */
  at: number;
  /** Epoch ms; set for a stretch (planned work), absent for a moment (an Alarm opening). */
  end?: number | null;
  /** What it was, for the label on hover. */
  label: string;
  /** `bad`/`warn` from the Alarm's own severity — a verdict the Alarm Rules made, not this chart. */
  tone: "bad" | "warn" | "info" | "neutral";
}

export interface ZoomControl {
  from: number;
  to: number;
  onWindow: (window: { from: number; to: number } | null) => void;
  /** Set while finer readings for the zoomed span are being fetched or shown. */
  detail?: { label: string; loading: boolean } | null;
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

const DAY_MS = 86_400_000;

/**
 * The time-axis label, with the day's closing midnight written `24:00`.
 *
 * Formatted as a clock it would read `00:00` at both ends of the axis, and the
 * right-hand one would claim the start of a day the chart is not showing.
 */
export function timeAxisLabel(
  value: number,
  tier: Tier | null | undefined,
  timezone: string,
  day: DayFrame | null | undefined,
  /**
   * How much time the series covers. Over a day, a sub-hourly label carries
   * its date, or a week at fifteen minutes reads `16:00 20:00 00:00` seven
   * times over and the reader cannot tell which Tuesday a dip was on.
   */
  spanMs = 0,
): string {
  if (day && value >= day.end) return "24:00";
  return formatAxisLabel(new Date(value), tier ?? "agg_1h", timezone, !day && spanMs > DAY_MS);
}

/** First to last point, in ms — what `timeAxisLabel` needs to know. */
export function pointsSpan(points: { at: string }[]): number {
  if (points.length < 2) return 0;
  return Date.parse(points[points.length - 1]!.at) - Date.parse(points[0]!.at);
}

/** The x-axis bounds and labels for a day frame; nothing when there is none. */
export function dayAxis(
  day: DayFrame | null | undefined,
): { min?: number; max?: number; customValues?: number[] } {
  return day ? { min: day.start, max: day.end, customValues: dayTicks(day) } : {};
}

export function LegendSwatch({ line, color }: { line: "solid" | "dashed"; color: string | null }): JSX.Element {
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

export function axisTickLabel(value: number): string {
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
 * `chart-primary` by default: this chart always draws exactly one series, and
 * that token is the one-series colour everywhere (`index.css`) — in light it
 * is palette slot 1, so this trend and the first line of a multi-series chart
 * agree. It was the brand accent until 28 Sep 2026, which in light mode read
 * as a grey-teal smear on a grey card. `"series"` still selects slot 1
 * explicitly, which differs only in dark.
 */
function seriesColor(which: "primary" | "series" | "accent" | "neutral", slot?: number): string {
  if (slot !== undefined) return seriesPalette()[slot] ?? token("chart-primary");
  if (which === "neutral") return token("ink-muted");
  if (which === "accent") return token("accent");
  return which === "series" ? (seriesPalette()[0] ?? token("chart-primary")) : token("chart-primary");
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
  colorToken = "primary",
  paletteSlot,
  markPeak = true,
  flaggedCount = 0,
  isLoading = false,
  day = null,
  legend,
  resolution,
  band = false,
  events,
  zoom,
  exportName,
  frame = null,
}: TrendChartProps): JSX.Element {
  const [tableView, setTableView] = useState(false);
  // ── A remembered zoom (see `zoom`) ──
  // Percentages of the framed axis, in a ref: it moves on every wheel tick and
  // nothing needs to re-render for it. Reset when the frame itself changes —
  // a new period is a new chart, and yesterday's zoom means nothing in it.
  const zoomPercent = useRef({ start: 0, end: 100 });
  const [zoomEpoch, setZoomEpoch] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  // ⚠ A live period's end moves every minute; that is the same chart, and
  // resetting on it would throw the reader out of a zoom once a minute. Only a
  // different period — its start or length moved more than a little — is new.
  const lastFrame = useRef<{ from: number; to: number } | null>(null);
  const frameKey = (() => {
    if (!zoom) return "";
    const previous = lastFrame.current;
    if (!previous || !sameFrame(previous, zoom)) {
      lastFrame.current = { from: zoom.from, to: zoom.to };
      // Reset here, before this render's option is built — in an effect it
      // would come after the paint, and the new period would open zoomed into
      // a span of the old one.
      zoomPercent.current = { start: 0, end: 100 };
    }
    return `${lastFrame.current!.from}|${lastFrame.current!.to}`;
  })();
  const onWindowRef = useRef(zoom?.onWindow);
  onWindowRef.current = zoom?.onWindow;
  const zoomTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    zoomPercent.current = { start: 0, end: 100 };
    setZoomed(false);
    window.clearTimeout(zoomTimer.current);
  }, [frameKey]);
  useEffect(() => () => window.clearTimeout(zoomTimer.current), []);
  const onZoomEvent = (params: unknown) => {
    if (!zoom) return;
    const event = params as { start?: number; end?: number; batch?: { start?: number; end?: number }[] };
    const range = event.batch?.[0] ?? event;
    if (typeof range.start !== "number" || typeof range.end !== "number") return;
    zoomPercent.current = { start: range.start, end: range.end };
    const whole = range.start <= 0.5 && range.end >= 99.5;
    setZoomed(!whole);
    // Asked once the reader has stopped, not on every tick of the wheel.
    window.clearTimeout(zoomTimer.current);
    const { from, to } = zoom;
    const start = range.start;
    const end = range.end;
    zoomTimer.current = window.setTimeout(() => {
      onWindowRef.current?.(
        whole ? null : { from: from + ((to - from) * start) / 100, to: from + ((to - from) * end) / 100 },
      );
    }, 350);
  };
  const showAll = () => {
    zoomPercent.current = { start: 0, end: 100 };
    setZoomed(false);
    window.clearTimeout(zoomTimer.current);
    onWindowRef.current?.(null);
    setZoomEpoch((epoch) => epoch + 1);
  };
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

  const color = seriesColor(colorToken, paletteSlot);
  const data = points.map((point) => [point.at, point.value] as [string, number | null]);
  // The band only where it has something to say: a bucket whose lowest and
  // highest differ. On the raw tier every point is one reading and there is none.
  const banded =
    band && shape === "area" && points.some((point) => point.low !== undefined && point.high !== undefined && point.high > point.low);
  const bandLow = banded
    ? points.map((point) => [point.at, point.low ?? null] as [string, number | null])
    : [];
  const bandSpread = banded
    ? points.map(
        (point) =>
          [point.at, point.low !== undefined && point.high !== undefined ? point.high - point.low : null] as [
            string,
            number | null,
          ],
      )
    : [];
  const shownEvents = useMemo(() => limitEvents(events ?? []), [events]);

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
        const spread =
          banded && point.low !== undefined && point.high !== undefined
            ? `<br/><span style="opacity:.75">range ${formatValue(point.low, unit ?? undefined)} – ${formatValue(point.high, unit ?? undefined)}</span>`
            : "";
        return (
          `${formatBucket(point.at, tier, timezone)}<br/>` +
          `<span style="color:${color}">●</span> ${label}: ` +
          `<strong>${formatValue(point.value, unit ?? undefined)}</strong>${spread}${partial}`
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
      // A zoomable chart frames its whole window, so a zoom kept as a share of
      // the axis still names the same span when finer points arrive inside it.
      min: dayAxis(day).min ?? (zoom ? zoom.from : frame?.from),
      max: dayAxis(day).max ?? (zoom ? zoom.to : frame?.to),
      axisLabel: {
        fontSize: 10,
        hideOverlap: true,
        color: token("ink-faint"),
        customValues: dayAxis(day).customValues,
        // The axis's own span decides whether a label carries its date: a
        // framed period of five days with one day of readings is still five days.
        formatter: (value: number) =>
          timeAxisLabel(
            value,
            tier,
            timezone,
            day,
            zoom ? zoom.to - zoom.from : frame ? frame.to - frame.from : pointsSpan(points),
          ),
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
      {
        type: "inside",
        throttle: 60,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        ...(zoom ? { start: zoomPercent.current.start, end: zoomPercent.current.end } : {}),
      },
      {
        type: "slider",
        ...(zoom ? { start: zoomPercent.current.start, end: zoomPercent.current.end } : {}),
        height: 14,
        bottom: 2,
        borderColor: "transparent",
        backgroundColor: tokenAlpha("chart-grid", 0.45),
        // The zoom window in the series' own colour, so the slider reads as
        // part of this chart rather than as a control of a different one.
        fillerColor: withAlpha(color, 0.12),
        handleStyle: { color, borderColor: color },
        moveHandleStyle: { color: token("chart-grid") },
        dataBackground: {
          lineStyle: { color: tokenAlpha("ink-faint", 0.5), width: 1 },
          areaStyle: { color: tokenAlpha("ink-faint", 0.12) },
        },
        selectedDataBackground: {
          lineStyle: { color, width: 1 },
          areaStyle: { color: withAlpha(color, 0.15) },
        },
        labelFormatter: "",
      },
    ],
    series: [
      ...(banded
        ? [
            {
              name: `${label} lowest`,
              type: "line" as const,
              data: bandLow,
              stack: "band",
              stackStrategy: "all" as const,
              showSymbol: false,
              connectNulls: false,
              silent: true,
              lineStyle: { opacity: 0 },
              itemStyle: { opacity: 0 },
              tooltip: { show: false },
            },
            {
              name: `${label} range`,
              type: "line" as const,
              data: bandSpread,
              stack: "band",
              stackStrategy: "all" as const,
              showSymbol: false,
              connectNulls: false,
              silent: true,
              lineStyle: { opacity: 0 },
              itemStyle: { opacity: 0 },
              areaStyle: { color: withAlpha(color, 0.16), origin: "auto" as const },
              tooltip: { show: false },
            },
          ]
        : []),
      shape === "area"
        ? {
            name: label,
            type: "line",
            data,
            ...eventMarks(shownEvents.shown),
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
                  { offset: 0, color: tokenAlpha("chart-primary", 0) },
                  { offset: 1, color: tokenAlpha("chart-primary", 0) },
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

  const ref = useEcharts(
    option,
    [
      points,
      unit,
      label,
      tier,
      timezone,
      shape,
      paletteSlot,
      themeVersion,
      tableView,
      day?.start,
      day?.end,
      banded,
      shownEvents,
      frameKey,
      zoomEpoch,
      frame?.from,
      frame?.to,
    ],
    zoom ? { datazoom: onZoomEvent } : undefined,
  );

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
        <div className="flex shrink-0 items-center gap-1.5">
        {zoom && zoomed && !tableView ? (
          <button
            type="button"
            onClick={showAll}
            title="Undo any zoom or pan and show the whole period."
            className="flex items-center gap-1 rounded-control border border-line px-1.5 py-1 text-[10px] font-medium text-ink-muted transition hover:text-ink"
          >
            <IconExpand size={12} />
            Show all
          </button>
        ) : null}
        {exportName && rows.length > 0 ? (
          <button
            type="button"
            onClick={() =>
              downloadCsv(`${exportName}.csv`, trendCsv(points, { label, unit, tier, timezone }))
            }
            title="Download the values drawn here as a CSV file, in the Plant's time"
            className="flex items-center gap-1 rounded-control border border-line px-1.5 py-1 text-[10px] font-medium text-ink-muted transition hover:text-ink"
          >
            <IconExport size={12} />
            CSV
          </button>
        ) : null}
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
        <div key={`chart-${zoomEpoch}`} ref={ref} style={{ height }} />
      )}

      {banded && !tableView ? (
        <p className="mt-1 text-[10px] leading-snug text-ink-faint">
          Shaded: the lowest to the highest reading inside each{" "}
          {tier ? (TIER_LABELS[tier] ?? "bucket").toLowerCase() : "bucket"}, so a short excursion the
          average smooths away is still on screen.
        </p>
      ) : null}
      {shownEvents.total > 0 && !tableView ? (
        <p className="mt-1 text-[10px] leading-snug text-ink-faint">
          {eventSummary(shownEvents)}
        </p>
      ) : null}

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
          {zoom?.detail ? (
            <Badge tone="info" title="Zoomed in, so the span on screen is read at a finer resolution than the whole period.">
              {zoom.detail.loading ? "Loading finer readings…" : zoom.detail.label}
            </Badge>
          ) : null}
          <span className="text-[10px] text-ink-faint">
            scroll to zoom · drag to pan{zoom ? " · zoom in for finer readings" : ""}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export { sameFrame };

// ── Events on the time axis ──────────────────────────────────────────────────

/** More marks than this and the axis is a barcode; the worst are kept, and the count said. */
export const MAX_EVENT_MARKS = 40;

const TONE_RANK: Record<ChartEvent["tone"], number> = { bad: 0, warn: 1, info: 2, neutral: 3 };

export interface ShownEvents {
  shown: ChartEvent[];
  total: number;
  alarms: number;
  stretches: number;
}

/** Keep every stretch and the most severe moments, at most `MAX_EVENT_MARKS` in all. */
export function limitEvents(events: ChartEvent[]): ShownEvents {
  const stretches = events.filter((event) => event.end !== undefined && event.end !== null);
  const moments = events
    .filter((event) => event.end === undefined || event.end === null)
    .sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || a.at - b.at);
  const room = Math.max(0, MAX_EVENT_MARKS - stretches.length);
  return {
    shown: [...stretches.slice(0, MAX_EVENT_MARKS), ...moments.slice(0, room)],
    total: events.length,
    alarms: moments.length,
    stretches: stretches.length,
  };
}

export function eventSummary(events: ShownEvents): string {
  const parts: string[] = [];
  if (events.alarms > 0) {
    parts.push(`${events.alarms} Alarm${events.alarms === 1 ? "" : "s"} opened (thin marks)`);
  }
  if (events.stretches > 0) {
    parts.push(`${events.stretches} maintenance window${events.stretches === 1 ? "" : "s"} (shaded)`);
  }
  const hidden = events.total - events.shown.length;
  return (
    `In this period: ${parts.join(" and ")}. Hover a mark to name it.` +
    (hidden > 0 ? ` ${hidden} less severe not marked, to keep the axis readable.` : "")
  );
}

const TONE_TOKEN = { bad: "bad", warn: "warn", info: "info", neutral: "ink-faint" } as const;

/** ECharts mark lines (moments) and mark areas (stretches) for a series. */
function eventMarks(events: ChartEvent[]): Record<string, unknown> {
  if (events.length === 0) return {};
  const moments = events.filter((event) => event.end === undefined || event.end === null);
  const stretches = events.filter((event) => event.end !== undefined && event.end !== null);
  return {
    markLine:
      moments.length > 0
        ? {
            silent: false,
            symbol: ["none", "none"],
            animation: false,
            label: { show: false },
            emphasis: {
              label: {
                show: true,
                formatter: (params: { name?: string }) => params.name ?? "",
                fontSize: 10,
                color: token("ink"),
                backgroundColor: token("surface-raised"),
                borderColor: token("line"),
                borderWidth: 1,
                borderRadius: 4,
                padding: [2, 5],
              },
              lineStyle: { width: 2 },
            },
            data: moments.map((event) => ({
              name: event.label,
              xAxis: event.at,
              lineStyle: { color: tokenAlpha(TONE_TOKEN[event.tone], 0.75), width: 1, type: "solid" },
            })),
          }
        : undefined,
    markArea:
      stretches.length > 0
        ? {
            silent: false,
            label: { show: false },
            emphasis: {
              label: {
                show: true,
                position: "insideTop",
                fontSize: 10,
                color: token("ink-muted"),
              },
            },
            itemStyle: { color: tokenAlpha("ink-faint", 0.12) },
            data: stretches.map((event) => [
              { name: event.label, xAxis: event.at },
              { xAxis: event.end as number },
            ]),
          }
        : undefined,
  };
}

const SMALL_MULTIPLE_LEFT = 52;
const SMALL_MULTIPLE_RIGHT = 16;
/** Room above the first band for its unit, which ECharts draws above the plot. */
const SMALL_MULTIPLE_TOP = 18;
/** Room under the last band for the time labels. */
const SMALL_MULTIPLE_BOTTOM = 24;
/** Between bands: the next band's unit sits in it. */
const SMALL_MULTIPLE_GAP = 26;

/** Each stacked band's top and height in pixels, inside a chart `height` tall. */
export function smallMultipleBands(
  count: number,
  height: number,
): { top: number; height: number }[] {
  const n = Math.max(count, 1);
  const usable = height - SMALL_MULTIPLE_TOP - SMALL_MULTIPLE_BOTTOM - SMALL_MULTIPLE_GAP * (n - 1);
  const band = Math.max(usable / n, 24);
  return Array.from({ length: n }, (_, index) => ({
    top: SMALL_MULTIPLE_TOP + index * (band + SMALL_MULTIPLE_GAP),
    height: band,
  }));
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
  // Laid out in pixels, not percentages: each band's unit sits above it, and at
  // 6% of a 210px chart the top one was drawn half above the canvas — "W/m2"
  // cut in two, which on an empty band was all there was to see.
  const bands = smallMultipleBands(count, height);
  const grids = bands.map((band) => ({
    left: SMALL_MULTIPLE_LEFT,
    right: SMALL_MULTIPLE_RIGHT,
    top: band.top,
    height: band.height,
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
      <div className="relative" style={{ height }}>
        <div ref={ref} style={{ height }} />
        {/* A series with nothing to draw leaves its band blank — no line, no
            scale, no grid — which reads as a chart that failed or slid out of
            its space. Say in the band itself why it is empty (Guardrail 26). */}
        {series.map((entry, index) =>
          entry.points.length === 0 && bands[index] ? (
            <div
              key={entry.key}
              className="pointer-events-none absolute flex items-center justify-center rounded border border-dashed border-line px-2 text-center text-[11px] text-ink-faint"
              style={{
                top: bands[index].top,
                height: bands[index].height,
                left: SMALL_MULTIPLE_LEFT,
                right: SMALL_MULTIPLE_RIGHT,
              }}
            >
              {(entry.flaggedCount ?? 0) > 0
                ? `${entry.label}: every reading in this window was flagged — nothing to plot`
                : `${entry.label}: no readings in this window`}
            </div>
          ) : null,
        )}
      </div>

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
