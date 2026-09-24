/**
 * The power trend, compared: actual output against radiation, and against the
 * two nameplate references — the client's reference chart.
 *
 * ⚠ **Two y-axes, locked.** Power on the left in kW, radiation on the right in
 * W/m², with the right-hand scale *derived* from the left through the Plant's
 * DC nameplate (`powerComparison.lockedAxes`), never fitted on its own. See
 * that module for why this is the only form in which Guardrail 22 permits a
 * second axis, and why there is no second axis at all without a DC capacity.
 * The lock is printed on the chart, because a reader can only trust a scale
 * relationship they can see.
 *
 * What it keeps from `TrendChart`, deliberately identical: a gap is drawn as a
 * gap (Guardrail 23), a series with one or two readings shows its points
 * rather than nothing, fills are anchored at zero, flagged readings are
 * counted and never drawn, every colour comes through `theme/tokens`
 * (Guardrail 28), and each render branch has its own key (Guardrail 32).
 */

import { useRef, useState } from "react";
import type { EChartsOption } from "echarts";
import type { Tier } from "@/api/schemas";
import type { TrendPoint } from "@/api/useSlotTrend";
import { DEFAULT_TIMEZONE, formatBucket } from "@/format/datetime";
import { formatNumber, formatValue } from "@/format/value";
import { chartTheme, useEcharts } from "@/components/charts/useEcharts";
import { axisTickLabel, dayAxis, timeAxisLabel, type DayFrame } from "@/components/charts/TrendChart";
import { TIER_LABELS } from "@/components/charts/TimeSeriesChart";
import { seriesPalette, token, tokenAlpha, withAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { Badge, InfoHint } from "@/components/ui";
import { IconExpand, IconGauge, IconList } from "@/components/icons";
import { STC_IRRADIANCE_W_M2, lockedAxes, niceStep } from "./powerComparison";

export interface ComparisonSeries {
  key: string;
  label: string;
  /** Verbatim from the catalogue, never converted (§4.1). */
  unit: string | null;
  points: TrendPoint[];
  axis: "power" | "radiation";
  /**
   * Solid for a measurement; dashed or dotted for a reference curve. Two
   * references can coincide exactly — the AC one is the DC one until the
   * Inverters clip — so they never share a dash pattern.
   */
  line: SeriesLine;
  /**
   * Which slot of the validated categorical palette. The slot order is the
   * colour-blind safety mechanism, so callers take slots in order.
   */
  slot: number;
  fill: boolean;
  /** Where it came from — on the legend's hover. */
  note?: string;
}

export type SeriesLine = "solid" | "dashed" | "dotted";

/** ECharts dash pattern per line style. */
const DASH: Record<SeriesLine, "solid" | number[]> = {
  solid: "solid",
  dashed: [7, 4],
  dotted: [2, 3],
};

/**
 * A legend key: the line as the chart draws it, in its colour. The shared
 * `LegendSwatch` draws a dashed key in grey, which was fine when a dashed line
 * meant "not drawn"; here a dashed line is drawn, and its key must match it.
 */
export function SeriesSwatch({ line, color }: { line: SeriesLine; color: string }): JSX.Element {
  return (
    <svg aria-hidden width="18" height="6" viewBox="0 0 18 6" className="shrink-0">
      <line
        x1="1"
        y1="3"
        x2="17"
        y2="3"
        stroke={color}
        strokeWidth={line === "dotted" ? 2.2 : 2}
        strokeLinecap="round"
        strokeDasharray={line === "dashed" ? "5 3" : line === "dotted" ? "0.5 3.5" : undefined}
      />
    </svg>
  );
}

/** Colour of a palette slot, resolved at render so it follows the theme. */
export function slotColor(slot: number): string {
  return seriesPalette()[slot] ?? token("accent");
}

/** Width of an axis gutter for its widest tick label. */
function gutter(labels: string[]): number {
  const widest = labels.reduce((most, label) => Math.max(most, label.length), 0);
  return Math.min(78, Math.max(40, Math.round(widest * 6.2) + 14));
}

export function PowerComparisonChart({
  series,
  perWm2,
  dcCapacityKwp,
  tier,
  timezone = DEFAULT_TIMEZONE,
  day = null,
  height = 260,
  isLoading = false,
  flaggedCount = 0,
  provenance,
}: {
  /** Actual power first; references and radiation after it. */
  series: ComparisonSeries[];
  /** kW per W/m² — the lock. Required for any radiation series to be drawn. */
  perWm2: number | null;
  dcCapacityKwp: number | null;
  tier: Tier | null;
  timezone?: string;
  day?: DayFrame | null;
  height?: number;
  isLoading?: boolean;
  flaggedCount?: number;
  provenance?: string | null;
}): JSX.Element {
  const [tableView, setTableView] = useState(false);
  // Bumped by "Show all": a fresh chart, at the whole window.
  const [zoomEpoch, setZoomEpoch] = useState(0);
  /**
   * The window the reader zoomed to, as percentages of the axis.
   *
   * A ref, not state: it changes on every wheel tick and nothing needs to
   * re-render for it. It exists because the option is re-applied whenever the
   * data refreshes — every minute, and on every live frame — and without it
   * each refresh threw the reader back out to the whole day mid-inspection.
   */
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

  // A radiation series with nothing to lock it to is not drawn at all — see
  // the module note. The caller should not pass one; this is the backstop.
  const drawn = series.filter((entry) => entry.axis === "power" || perWm2 !== null);
  const hasRadiation = drawn.some((entry) => entry.axis === "radiation");
  const powerUnit = drawn.find((entry) => entry.axis === "power")?.unit ?? null;
  const radiationUnit = drawn.find((entry) => entry.axis === "radiation")?.unit ?? null;

  const valuesOn = (axis: "power" | "radiation") =>
    drawn
      .filter((entry) => entry.axis === axis)
      .flatMap((entry) => entry.points.map((point) => point.value))
      .filter((value): value is number => value !== null);
  const scales =
    hasRadiation && perWm2 !== null ? lockedAxes(valuesOn("power"), valuesOn("radiation"), perWm2) : null;

  const powerTicks = scales
    ? Array.from(
        { length: Math.round((scales.power.max - scales.power.min) / scales.power.interval) + 1 },
        (_, index) => axisTickLabel(scales.power.min + index * scales.power.interval),
      )
    : valuesOn("power").map((value) => axisTickLabel(value));
  const radiationTick = (value: number) => formatNumber(Math.round(value), { digits: 0 });
  /*
    Round W/m² ticks, placed where they truly fall on the locked scale. The
    lock makes this side's divisions the power side's divided by kW-per-W/m²,
    which on a 5,760 kWp Plant labelled the axis 174, 347, 521 — every figure
    exact and none of them readable. This side draws no gridlines of its own,
    so its labels need not sit on the power side's.
  */
  const radiationValues = scales
    ? (() => {
        const step = niceStep((scales.radiation.max - scales.radiation.min) / 5);
        const out: number[] = [];
        for (let at = Math.ceil(scales.radiation.min / step) * step; at <= scales.radiation.max + 1e-9; at += step) {
          out.push(Number(at.toFixed(6)));
        }
        return out;
      })()
    : [];
  const radiationTicks = radiationValues.map(radiationTick);

  const plottable = (entry: ComparisonSeries) => entry.points.filter((point) => point.value !== null).length;
  const anyPlottable = drawn.some((entry) => plottable(entry) > 0);

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 320,
    grid: {
      left: gutter(powerTicks) + 20,
      right: hasRadiation ? gutter(radiationTicks) + 20 : 22,
      top: 16,
      bottom: 34,
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      axisPointer: {
        type: "line",
        lineStyle: { color: token("ink-faint"), width: 1, type: "solid" },
        label: { show: false },
      },
      formatter: (params: unknown) => {
        const rows = (Array.isArray(params) ? params : [params]) as {
          seriesIndex?: number;
          value?: [string, number | null];
          axisValue?: string | number;
        }[];
        const at = rows[0]?.value?.[0] ?? rows[0]?.axisValue;
        const lines = rows.map((row) => {
          const entry = drawn[row.seriesIndex ?? -1];
          if (!entry) return "";
          const value = row.value?.[1] ?? null;
          return (
            `<span style="color:${slotColor(entry.slot)}">●</span> ${entry.label}: ` +
            (value === null
              ? `<span style="opacity:.7">no data</span>`
              : `<strong>${formatValue(value, entry.unit ?? undefined)}</strong>`)
          );
        });
        return `${formatBucket(at, tier, timezone)}<br/>${lines.filter(Boolean).join("<br/>")}`;
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: token("chart-grid") } },
      axisTick: { show: false },
      splitLine: { show: false },
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
    yAxis: [
      {
        type: "value",
        name: powerUnit ? `Power (${powerUnit})` : "Power",
        nameLocation: "middle",
        nameRotate: 90,
        nameGap: gutter(powerTicks) + 4,
        nameTextStyle: { color: token("ink-muted"), fontSize: 11, fontWeight: 600 },
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: theme.splitLine,
        axisLabel: {
          fontSize: 10,
          color: token("ink-faint"),
          formatter: (value: number) => axisTickLabel(value),
        },
        ...(scales ? scales.power : { scale: false }),
      },
      ...(scales
        ? [
            {
              type: "value" as const,
              position: "right" as const,
              name: radiationUnit ? `Radiation (${radiationUnit})` : "Radiation",
              nameLocation: "middle" as const,
              nameRotate: 90,
              nameGap: gutter(radiationTicks) + 4,
              nameTextStyle: { color: token("ink-muted"), fontSize: 11, fontWeight: 600 },
              axisLine: { show: false },
              axisTick: { show: false },
              // The power side's gridlines are this side's too — the lock
              // gives both the same divisions — so drawing them twice would
              // only thicken them.
              splitLine: { show: false },
              axisLabel: {
                fontSize: 10,
                color: token("ink-faint"),
                formatter: radiationTick,
                customValues: radiationValues,
              },
              min: scales.radiation.min,
              max: scales.radiation.max,
            },
          ]
        : []),
    ],
    dataZoom: [
      {
        type: "inside",
        throttle: 60,
        zoomOnMouseWheel: true,
        moveOnMouseMove: true,
        start: zoom.current.start,
        end: zoom.current.end,
      },
      {
        type: "slider",
        start: zoom.current.start,
        end: zoom.current.end,
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
        labelFormatter: "",
      },
    ],
    series: drawn.map((entry, index) => {
      const color = slotColor(entry.slot);
      const sparse = plottable(entry) > 0 && plottable(entry) < 3;
      return {
        name: entry.label,
        type: "line" as const,
        yAxisIndex: entry.axis === "radiation" && scales ? 1 : 0,
        data: entry.points.map((point) => [point.at, point.value] as [string, number | null]),
        // One or two readings with no symbol draw nothing at all.
        showSymbol: sparse,
        symbolSize: 6,
        // ⚠ Never `connectNulls`: a hole is a Plant that did not report.
        connectNulls: false,
        smooth: 0.18,
        sampling: "lttb" as const,
        // Measured power on top of everything it is compared with.
        z: index === 0 ? 4 : entry.axis === "radiation" ? 2 : 3,
        lineStyle: { width: entry.line === "solid" ? 2 : 1.8, type: DASH[entry.line], color },
        itemStyle: { color },
        areaStyle: entry.fill
          ? {
              // Filled to zero, not to the bottom of the plot — see TrendChart.
              origin: 0 as const,
              color: {
                type: "linear" as const,
                x: 0,
                y: 0,
                x2: 0,
                y2: 1,
                colorStops: [
                  { offset: 0, color: withAlpha(color, index === 0 ? 0.3 : 0.2) },
                  { offset: 1, color: withAlpha(color, 0.03) },
                ],
              },
            }
          : undefined,
      };
    }),
  };

  const ref = useEcharts(
    option,
    [series, perWm2, tier, timezone, themeVersion, tableView, zoomEpoch, day?.start, day?.end],
    { datazoom: onZoom },
  );

  // Every timestamp any series has, for the table.
  const stamps = [...new Set(drawn.flatMap((entry) => entry.points.map((point) => point.at)))].sort();
  const valueAt = new Map(
    drawn.map((entry) => [entry.key, new Map(entry.points.map((point) => [point.at, point.value]))]),
  );

  return (
    <div>
      <div className="mb-1.5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {drawn.map((entry) => (
              <span
                key={entry.key}
                className="flex items-center gap-1.5 font-medium text-ink"
                title={entry.note}
              >
                <SeriesSwatch line={entry.line} color={slotColor(entry.slot)} />
                {entry.label}
                {entry.unit ? <span className="font-normal text-ink-muted">({entry.unit})</span> : null}
              </span>
            ))}
          </div>
          {provenance ? (
            <div className="mt-0.5 text-[11px] text-ink-faint" title="Which Device answered Current Power.">
              {provenance}
            </div>
          ) : null}
          {hasRadiation && dcCapacityKwp ? (
            <div className="mt-0.5 flex items-center text-[11px] text-ink-muted">
              Axes locked: {formatNumber(STC_IRRADIANCE_W_M2, { digits: 0 })} W/m² ={" "}
              {formatNumber(dcCapacityKwp, { digits: 0 })} kW, the DC nameplate
              <InfoHint
                text={
                  "The two scales are tied by the Plant's DC capacity rather than fitted separately: " +
                  "at 1,000 W/m² the array makes its nameplate. So where radiation sits against power " +
                  "means something — the gap is everything lost between nameplate and meter. Two axes " +
                  "fitted independently can be made to line up any way at all, which is why this " +
                  "platform draws no other chart with two."
                }
              />
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!tableView ? (
            <button
              type="button"
              onClick={() => {
                zoom.current = { start: 0, end: 100 };
                setZoomEpoch((epoch) => epoch + 1);
              }}
              title="Undo any zoom or pan and show the whole window."
              className="flex items-center gap-1 rounded-control border border-line px-1.5 py-1 text-[10px] font-medium text-ink-muted transition hover:text-ink"
            >
              <IconExpand size={12} />
              Show all
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setTableView((on) => !on)}
            aria-pressed={tableView}
            title={tableView ? "Back to the chart" : "Read the same numbers as a table"}
            className="flex items-center gap-1 rounded-control border border-line px-1.5 py-1 text-[10px] font-medium text-ink-muted transition hover:text-ink"
          >
            {tableView ? <IconGauge size={12} /> : <IconList size={12} />}
            {tableView ? "Chart" : "Table"}
          </button>
        </div>
      </div>

      {/* Each branch keyed: React must never reuse the node ECharts filled. */}
      {isLoading ? (
        <div
          key="loading"
          style={{ height }}
          className="flex items-center justify-center rounded-control border border-line"
        >
          <span className="text-[11px] text-ink-faint">Loading readings…</span>
        </div>
      ) : !anyPlottable && !tableView ? (
        <div
          key="empty"
          style={{ height }}
          className="flex items-center justify-center rounded-control border border-dashed border-line px-4 text-center"
        >
          <p className="text-[11px] leading-snug text-ink-faint">
            {flaggedCount > 0
              ? `No value could be plotted: all ${flaggedCount} reading${flaggedCount === 1 ? "" : "s"} in this window were flagged.`
              : "No readings in this window. That is not a reading of zero — nothing arrived to draw."}
          </p>
        </div>
      ) : tableView ? (
        <div key="table" style={{ height }} className="overflow-auto rounded-control border border-line">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-surface-sunken text-ink-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Time</th>
                {drawn.map((entry) => (
                  <th key={entry.key} className="px-2 py-1 text-right font-medium">
                    {entry.label}
                    {entry.unit ? ` (${entry.unit})` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stamps.map((at) => (
                <tr key={at} className="border-t border-line-soft">
                  <td className="px-2 py-1 text-ink-muted">{formatBucket(at, tier, timezone)}</td>
                  {drawn.map((entry) => (
                    <td key={entry.key} className="px-2 py-1 text-right font-mono tabular-nums text-ink">
                      {formatNumber(valueAt.get(entry.key)?.get(at) ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div key={`chart-${zoomEpoch}`} ref={ref} style={{ height }} />
      )}

      {flaggedCount > 0 ? (
        <p className="mt-1 text-[10px] leading-snug text-warn">
          {flaggedCount} reading{flaggedCount === 1 ? " was" : "s were"} flagged and not plotted — out
          of range, stale or unparseable. They are stored and flagged, never discarded.
        </p>
      ) : null}

      {tier ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge
            tone="neutral"
            title="The coarsest tier that covers this range and still retains it. Every tier runs with real-time aggregation, so a coarser tier costs resolution, not freshness."
          >
            {TIER_LABELS[tier]}
          </Badge>
          <span className="text-[10px] text-ink-faint">scroll to zoom · drag to pan</span>
        </div>
      ) : null}
    </div>
  );
}
