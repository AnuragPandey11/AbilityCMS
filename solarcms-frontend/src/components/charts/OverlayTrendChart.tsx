/**
 * Two or more series of **one unit** on one axis — ambient beside module
 * temperature.
 *
 * Not a dual-axis chart, and it cannot become one: it takes a single `unit`,
 * so every line is on the same scale and the distance between two lines is a
 * real difference in degrees (Guardrail 22 is about two *fitted* scales, and
 * there is only one here). Measures in different units still belong in
 * separate charts.
 *
 * What it keeps from `TrendChart`, deliberately identical: a gap is drawn as a
 * gap (Guardrail 23), a series with one or two readings shows its points
 * rather than nothing, flagged readings are counted and never drawn, a table
 * twin so no value is reachable only by hovering, every colour through
 * `theme/tokens` (Guardrail 28), and a `key` on each render branch
 * (Guardrail 32). Colours are palette slots taken in order, because the slot
 * order is the colourblind-safety mechanism; the legend names every line, so
 * identity is never carried by colour alone.
 */

import { useState } from "react";
import type { EChartsOption } from "echarts";
import type { Tier } from "@/api/schemas";
import type { TrendPoint } from "@/api/useSlotTrend";
import { DEFAULT_TIMEZONE, formatBucket } from "@/format/datetime";
import { formatNumber, formatValue } from "@/format/value";
import { chartTheme, useEcharts } from "./useEcharts";
import { axisTickLabel, dayAxis, pointsSpan, timeAxisLabel, type DayFrame } from "./TrendChart";
import { TIER_LABELS } from "./TimeSeriesChart";
import { seriesPalette, token, tokenAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { Badge } from "@/components/ui";
import { IconGauge, IconList } from "@/components/icons";

export interface OverlaySeries {
  key: string;
  label: string;
  points: TrendPoint[];
  flaggedCount?: number;
  /** Set when this line cannot be drawn at all, and why — kept in the legend, visibly off. */
  unavailableReason?: string | null;
}

export function OverlayTrendChart({
  series,
  unit,
  tier,
  timezone = DEFAULT_TIMEZONE,
  height = 220,
  day = null,
  isLoading = false,
}: {
  series: OverlaySeries[];
  /** The one unit every series shares. Verbatim from the catalogue (§4.1). */
  unit: string | null;
  tier: Tier | null;
  timezone?: string;
  height?: number;
  day?: DayFrame | null;
  isLoading?: boolean;
}): JSX.Element {
  const [tableView, setTableView] = useState(false);
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();
  const palette = seriesPalette();
  const colorOf = (index: number) => palette[index % palette.length] ?? token("chart-primary");

  const plottable = series.reduce(
    (count, entry) => count + entry.points.filter((point) => point.value !== null).length,
    0,
  );
  const flaggedTotal = series.reduce((count, entry) => count + (entry.flaggedCount ?? 0), 0);

  // The widest tick decides the gutter, as `TrendChart` sizes its own.
  let widest = 0;
  for (const entry of series) {
    for (const point of entry.points) {
      if (point.value !== null) widest = Math.max(widest, axisTickLabel(point.value).length);
    }
  }
  const gutter = Math.min(78, Math.max(44, Math.round(widest * 6.2) + 16));
  const span = Math.max(0, ...series.map((entry) => pointsSpan(entry.points)));

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 320,
    grid: { left: gutter, right: 26, top: 20, bottom: 34 },
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
        const rows = Array.isArray(params) ? params : [params];
        const first = rows[0] as { axisValue?: number } | undefined;
        const body = rows
          .map((row) => {
            const typed = row as { seriesName: string; value: unknown; color: string };
            const value = Array.isArray(typed.value) ? typed.value[1] : null;
            return value === null || value === undefined
              ? `<span style="color:${typed.color}">●</span> ${typed.seriesName}: <span style="opacity:.7">no data</span>`
              : `<span style="color:${typed.color}">●</span> ${typed.seriesName}: <strong>${formatValue(Number(value), unit ?? undefined)}</strong>`;
          })
          .join("<br/>");
        return `${formatBucket(first?.axisValue, tier, timezone)}<br/>${body}`;
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
        formatter: (value: number) => timeAxisLabel(value, tier, timezone, day, span),
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
      // Temperatures rarely reach zero, and an axis pinned there squashes two
      // lines a few degrees apart into one. Both lines share this one scale,
      // so fitting it to the data still claims nothing about their relation.
      scale: true,
      axisLabel: {
        fontSize: 10,
        color: token("ink-faint"),
        formatter: (value: number) => axisTickLabel(value),
      },
    },
    dataZoom: [
      { type: "inside", throttle: 60, zoomOnMouseWheel: true, moveOnMouseMove: true },
      {
        type: "slider",
        height: 14,
        bottom: 2,
        borderColor: "transparent",
        backgroundColor: tokenAlpha("chart-grid", 0.45),
        fillerColor: tokenAlpha("chart-primary", 0.12),
        handleStyle: { color: token("chart-primary"), borderColor: token("chart-primary") },
        moveHandleStyle: { color: token("chart-grid") },
        labelFormatter: "",
      },
    ],
    series: series.map((entry, index) => {
      const drawn = entry.points.filter((point) => point.value !== null).length;
      return {
        name: entry.label,
        type: "line" as const,
        data: entry.points.map((point) => [point.at, point.value]),
        // One point on a line with no symbol draws nothing; see `TrendChart`.
        showSymbol: drawn > 0 && drawn < 3,
        symbolSize: 7,
        // ⚠ Never `connectNulls` (Guardrail 23).
        connectNulls: false,
        smooth: 0.18,
        sampling: "lttb" as const,
        lineStyle: { width: 2, color: colorOf(index) },
        itemStyle: { color: colorOf(index) },
      };
    }),
  };

  const ref = useEcharts(option, [series, unit, tier, timezone, themeVersion, tableView, day?.start, day?.end]);

  // The table's rows: every bucket any series has, in time order.
  const times = [...new Set(series.flatMap((entry) => entry.points.map((point) => point.at)))].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const byKey = new Map(
    series.map((entry) => [entry.key, new Map(entry.points.map((point) => [point.at, point.value]))]),
  );
  const tableRows = times.filter((at) =>
    series.some((entry) => (byKey.get(entry.key)?.get(at) ?? null) !== null),
  );

  return (
    <div>
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {series.map((entry, index) => (
            <span
              key={entry.key}
              className={`flex items-center gap-1.5 ${entry.unavailableReason ? "text-ink-faint" : "font-medium text-ink"}`}
              title={entry.unavailableReason ?? undefined}
            >
              <span
                aria-hidden
                className="h-0.5 w-4 shrink-0 rounded-full"
                style={{ backgroundColor: entry.unavailableReason ? token("ink-faint") : colorOf(index) }}
              />
              {entry.label}
              {entry.unavailableReason ? <span className="font-normal">· not reported</span> : null}
            </span>
          ))}
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

      {/* ⚠ Each branch carries its own `key` — see `TrendChart` (Guardrail 32). */}
      {isLoading ? (
        <div
          key="loading"
          style={{ height }}
          className="flex items-center justify-center rounded-control border border-line"
        >
          <span className="text-[11px] text-ink-faint">Loading readings…</span>
        </div>
      ) : plottable === 0 && !tableView ? (
        <div
          key="empty"
          style={{ height }}
          className="flex items-center justify-center rounded-control border border-dashed border-line px-4 text-center"
        >
          <p className="text-[11px] leading-snug text-ink-faint">
            {flaggedTotal > 0
              ? `No value could be plotted: all ${flaggedTotal} reading${flaggedTotal === 1 ? "" : "s"} in this window were flagged out of range, stale or unparseable.`
              : "No readings in this window. That is not a reading of zero — nothing arrived to draw."}
          </p>
        </div>
      ) : tableView ? (
        <div key="table" style={{ height }} className="overflow-auto rounded-control border border-line">
          <table className="w-full text-[11px]">
            <thead className="sticky top-0 bg-surface-sunken text-ink-muted">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Time</th>
                {series.map((entry) => (
                  <th key={entry.key} className="px-2 py-1 text-right font-medium">
                    {entry.label}
                    {unit ? ` (${unit})` : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.length === 0 ? (
                <tr>
                  <td colSpan={series.length + 1} className="px-2 py-3 text-center text-ink-faint">
                    No readings in this period.
                  </td>
                </tr>
              ) : (
                tableRows.map((at) => (
                  <tr key={at} className="border-t border-line-soft">
                    <td className="px-2 py-1 text-ink-muted">{formatBucket(at, tier, timezone)}</td>
                    {series.map((entry) => (
                      <td key={entry.key} className="px-2 py-1 text-right font-mono tabular-nums text-ink">
                        {formatNumber(byKey.get(entry.key)?.get(at) ?? null)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div key="chart" ref={ref} style={{ height }} />
      )}

      {series
        .filter((entry) => (entry.flaggedCount ?? 0) > 0)
        .map((entry) => (
          <p key={entry.key} className="mt-1 text-[10px] leading-snug text-warn">
            {entry.label}: {entry.flaggedCount} reading{entry.flaggedCount === 1 ? " was" : "s were"} flagged
            and {entry.points.length === 0 ? "none could be plotted" : "are not plotted"} — out of range,
            stale or unparseable.
          </p>
        ))}

      {tier ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge
            tone="neutral"
            title="The finest tier that answers this window within the server's point limit. Every tier runs with real-time aggregation, so a coarser tier costs resolution, not freshness."
          >
            {TIER_LABELS[tier]}
          </Badge>
          <span className="text-[10px] text-ink-faint">scroll to zoom · drag to pan</span>
        </div>
      ) : null}
    </div>
  );
}
