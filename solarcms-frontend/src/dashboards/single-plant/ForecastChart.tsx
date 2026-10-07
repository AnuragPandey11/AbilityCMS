/**
 * A forecast drawn against what happened: measured output as a solid line,
 * the forecast dashed, and the Plant's usual range for that time of day as a
 * faint band behind them.
 *
 * One measure on one axis (Guardrail 22 does not arise). Gaps stay gaps — no
 * `connectNulls` (Guardrail 23) — and the band is drawn only where the history
 * defines it. Colours come from the validated palette through `theme/tokens`
 * (Guardrail 28).
 */

import type { EChartsOption } from "echarts";
import { formatBucket } from "@/format/datetime";
import { formatValue } from "@/format/value";
import { chartTheme, useEcharts } from "@/components/charts/useEcharts";
import { axisTickLabel, dayAxis, pointsSpan, timeAxisLabel, type DayFrame } from "@/components/charts/TrendChart";
import { seriesPalette, token, withAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { SeriesSwatch } from "./PowerComparisonChart";

export interface ForecastLine {
  key: string;
  label: string;
  points: { at: string; value: number | null }[];
  /** Palette slot; the slot order is the colour-blind safety mechanism. */
  slot: number;
  line: "solid" | "dashed";
}

export interface BandPoint {
  at: string;
  low: number | null;
  high: number | null;
}

function slotColour(slot: number): string {
  return seriesPalette()[slot] ?? token("chart-primary");
}

export function ForecastChart({
  lines,
  band,
  bandLabel = "Usual range",
  unit,
  timezone,
  day,
  height = 220,
}: {
  lines: ForecastLine[];
  band?: BandPoint[];
  bandLabel?: string;
  unit: string | null;
  timezone: string;
  day?: DayFrame | null;
  height?: number;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();
  const bandColour = slotColour(lines.find((entry) => entry.line === "dashed")?.slot ?? 1);
  const bandRows = (band ?? []).map((point) => {
    const ok = point.low !== null && point.high !== null;
    return {
      at: point.at,
      low: ok ? point.low : null,
      span: ok ? (point.high as number) - (point.low as number) : null,
      high: ok ? point.high : null,
    };
  });
  const hasBand = bandRows.some((row) => row.span !== null);
  // Over more than a day the axis carries dates, or two afternoons read alike.
  const span = Math.max(0, ...lines.map((entry) => pointsSpan(entry.points)));

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 280,
    grid: { left: 54, right: 16, top: 12, bottom: 26 },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      axisPointer: { type: "line", lineStyle: { color: token("ink-faint"), width: 1 } },
      formatter: (params: unknown) => {
        const rows = (Array.isArray(params) ? params : [params]) as {
          seriesId?: string;
          dataIndex?: number;
          value?: [string, number | null];
          axisValue?: string | number;
        }[];
        const at = rows[0]?.value?.[0] ?? rows[0]?.axisValue;
        const out: string[] = [];
        for (const row of rows) {
          const entry = lines.find((candidate) => candidate.key === row.seriesId);
          if (!entry) continue;
          const value = row.value?.[1] ?? null;
          out.push(
            `<span style="color:${slotColour(entry.slot)}">●</span> ${entry.label}: ` +
              (value === null
                ? `<span style="opacity:.7">none</span>`
                : `<strong>${formatValue(value, unit ?? undefined)}</strong>`),
          );
        }
        const bandRow = rows.find((row) => row.seriesId === "band-span");
        const range = bandRow?.dataIndex !== undefined ? bandRows[bandRow.dataIndex] : undefined;
        if (range && range.low !== null && range.high !== null) {
          out.push(
            `<span style="opacity:.75">${bandLabel}: ${formatValue(range.low, unit ?? undefined)} – ${formatValue(
              range.high,
              unit ?? undefined,
            )}</span>`,
          );
        }
        return `${formatBucket(at, "agg_15m", timezone)}<br/>${out.join("<br/>")}`;
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: token("chart-grid") } },
      axisTick: { show: false },
      splitLine: { show: false },
      min: dayAxis(day).min,
      max: dayAxis(day).max,
      axisLabel: {
        fontSize: 10,
        hideOverlap: true,
        color: token("ink-faint"),
        customValues: dayAxis(day).customValues,
        formatter: (value: number) => timeAxisLabel(value, "agg_15m", timezone, day ?? null, span),
      },
    },
    yAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: theme.splitLine,
      axisLabel: { fontSize: 10, color: token("ink-faint"), formatter: (value: number) => axisTickLabel(value) },
    },
    series: [
      ...(hasBand
        ? [
            {
              id: "band-low",
              type: "line" as const,
              stack: "band",
              // A meter importing at night has a negative floor; stacking by
              // sign would draw the band from zero instead of from it.
              stackStrategy: "all" as const,
              data: bandRows.map((row) => [row.at, row.low] as [string, number | null]),
              lineStyle: { opacity: 0 },
              symbol: "none",
              connectNulls: false,
              silent: true,
              z: 1,
            },
            {
              id: "band-span",
              type: "line" as const,
              stack: "band",
              stackStrategy: "all" as const,
              data: bandRows.map((row) => [row.at, row.span] as [string, number | null]),
              lineStyle: { opacity: 0 },
              symbol: "none",
              connectNulls: false,
              areaStyle: { color: withAlpha(bandColour, 0.14) },
              z: 1,
            },
          ]
        : []),
      ...lines.map((entry) => {
        const colour = slotColour(entry.slot);
        const plotted = entry.points.filter((point) => point.value !== null).length;
        return {
          id: entry.key,
          name: entry.label,
          type: "line" as const,
          data: entry.points.map((point) => [point.at, point.value] as [string, number | null]),
          showSymbol: plotted > 0 && plotted < 3,
          symbolSize: 6,
          connectNulls: false,
          smooth: 0.15,
          z: entry.line === "solid" ? 4 : 3,
          lineStyle: { width: 2, type: entry.line === "dashed" ? ([6, 4] as number[]) : ("solid" as const), color: colour },
          itemStyle: { color: colour },
        };
      }),
    ],
  };

  const ref = useEcharts(option, [lines, band, unit, timezone, themeVersion, day?.start, day?.end]);

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        {lines.map((entry) => (
          <span key={entry.key} className="inline-flex items-center gap-1.5">
            <SeriesSwatch line={entry.line} color={slotColour(entry.slot)} />
            {entry.label}
          </span>
        ))}
        {hasBand ? (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-2.5 w-4 rounded-sm" style={{ backgroundColor: withAlpha(bandColour, 0.25) }} />
            {bandLabel}
          </span>
        ) : null}
        {unit ? <span className="ml-auto text-ink-faint">{unit}</span> : null}
      </div>
      <div ref={ref} style={{ height }} className="w-full" />
    </div>
  );
}
