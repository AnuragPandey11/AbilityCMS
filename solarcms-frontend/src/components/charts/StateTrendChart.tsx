/**
 * A contact's history as a step line between FALSE and TRUE — the client's
 * reference (1 Nov 2026), drawn the platform's way.
 *
 * - **The state as sent.** The axis reads TRUE / FALSE, never ON/OFF or
 *   Online/Offline: which state is the fault is the Alarm Rules' to say
 *   (`equipment/flags.ts`), and "TRUE" on a trip and on "trip coil healthy"
 *   mean opposite things.
 * - **One colour.** The chart colour, as every single-series trend (design
 *   rule 4). A TRUE is never painted red here — that would be this file
 *   deciding what a fault is.
 * - **A dot at each change**, as in the reference, and a hollow ring where a
 *   bucket saw both states (`stateSeries`) — a trip that opened and closed
 *   inside one bucket is still on the chart.
 * - **A gap is a gap** (Guardrail 23): the step stops where nothing arrived.
 *
 * Every chart of a page takes the same x-axis bounds, so a row of them reads
 * as one time line and a trip on one lines up with a change on the next.
 */

import type { EChartsOption } from "echarts";
import type { Tier } from "@/api/schemas";
import type { StateSeries } from "@/dashboards/equipment/stateSeries";
import { chartTheme, useEcharts } from "./useEcharts";
import { dayAxis, timeAxisLabel, type DayFrame } from "./TrendChart";
import { token } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { DEFAULT_TIMEZONE, formatBucket } from "@/format/datetime";

const WORD = ["FALSE", "TRUE"] as const;

function spanWords(ms: number): string {
  if (ms <= 60_000) return "minute";
  if (ms <= 15 * 60_000) return "15 minutes";
  if (ms <= 3_600_000) return "hour";
  return "day";
}

export function StateTrendChart({
  series,
  label,
  tier,
  from,
  to,
  day,
  timezone = DEFAULT_TIMEZONE,
  height = 132,
}: {
  series: StateSeries;
  label: string;
  tier: Tier | null;
  /** The window's bounds, epoch ms — every chart on the page shares them. */
  from: number;
  to: number;
  day: DayFrame | null;
  timezone?: string;
  height?: number;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();
  const color = token("chart-primary");
  const axis = day ? dayAxis(day) : { min: from, max: to };
  const mixedAt = new Map(series.mixed.map((bucket) => [bucket.at, bucket]));
  const lonely = series.points.filter((point) => point.state !== null).length === 1;

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animation: false,
    grid: { left: 54, right: 16, top: 10, bottom: 24 },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      axisPointer: { type: "line", lineStyle: { color: token("ink-faint"), width: 1 }, label: { show: false } },
      formatter: (params: unknown) => {
        const rows = (Array.isArray(params) ? params : [params]) as {
          seriesIndex: number;
          dataIndex: number;
          axisValue: number;
        }[];
        const row = rows.find((entry) => entry.seriesIndex === 0) ?? rows[0];
        const point = row ? series.points[row.dataIndex] : undefined;
        if (!point || point.state === null) {
          return `${formatBucket(row?.axisValue, tier, timezone)}<br/><span style="opacity:.7">nothing received</span>`;
        }
        const mixed = mixedAt.get(point.at);
        return (
          `${formatBucket(point.at, tier, timezone)}<br/>${label}: <strong>${WORD[point.state]}</strong>` +
          (mixed
            ? `<br/><span style="opacity:.75">Both TRUE and FALSE within this ${spanWords(mixed.spanMs)}; ended ${
                WORD[mixed.last]
              }</span>`
            : "")
        );
      },
    },
    xAxis: {
      type: "time",
      min: axis.min,
      max: axis.max,
      axisLine: { lineStyle: { color: token("chart-grid") } },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: token("chart-grid"), width: 1 } },
      axisLabel: {
        fontSize: 10,
        hideOverlap: true,
        color: token("ink-faint"),
        customValues: day ? dayAxis(day).customValues : undefined,
        formatter: (value: number) => timeAxisLabel(value, tier, timezone, day, to - from),
      },
    },
    yAxis: {
      type: "category",
      data: [...WORD],
      boundaryGap: true,
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: token("chart-grid"), width: 1 } },
      axisLabel: { fontSize: 10, fontWeight: 600, color: token("ink-muted") },
    },
    series: [
      {
        type: "line",
        step: "end",
        data: series.points.map((point) => [point.at, point.state ?? "-"]),
        connectNulls: false,
        // A single reading has no second vertex; it is a dot, not nothing.
        showSymbol: lonely,
        symbolSize: 6,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        z: 2,
      },
      {
        type: "scatter",
        data: series.changes.map((point) => [point.at, point.state ?? 0]),
        symbolSize: 7,
        itemStyle: { color, borderColor: token("surface-raised"), borderWidth: 1.5 },
        z: 3,
        silent: true,
      },
      {
        // Where the bucket also saw the other state: a ring at that state.
        type: "scatter",
        data: series.mixed.map((bucket) => [bucket.at, 1 - bucket.last]),
        symbol: "circle",
        symbolSize: 8,
        itemStyle: { color: token("surface-raised"), borderColor: color, borderWidth: 1.8 },
        z: 3,
        silent: true,
      },
    ],
  };

  const ref = useEcharts(option, [series, label, tier, from, to, day?.start, themeVersion]);
  return <div ref={ref} style={{ height }} role="img" aria-label={`${label} over time`} />;
}
