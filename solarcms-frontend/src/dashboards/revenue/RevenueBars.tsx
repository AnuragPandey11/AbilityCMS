/**
 * Revenue (or exported energy) per day, month or financial year, as bars.
 *
 * One series, the chart colour (design rule 4). A period still under way is
 * the same colour at lower opacity and says "so far" — a part-month drawn at
 * full strength reads as a bad month. A period with nothing read has **no
 * bar** (Guardrail 23): an empty slot, and the tooltip says why, never a bar
 * of ₹0. Colours go through `theme/tokens` (Guardrail 28) and the chart's
 * lifecycle is `useEcharts`' callback ref (Guardrail 31).
 */

import type { EChartsOption } from "echarts";
import type { RevenueTrendPoint } from "@/api/endpoints/revenue";
import { chartTheme, useEcharts } from "@/components/charts/useEcharts";
import { token, tokenAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { formatCompact, formatNumber, formatRupees } from "@/format/value";

export type RevenueMeasure = "revenue" | "exported";

function valueOf(point: RevenueTrendPoint, measure: RevenueMeasure): number | null {
  return measure === "revenue" ? point.revenue_inr : point.exported_kwh;
}

export function RevenueBars({
  points,
  measure,
  height = 300,
}: {
  points: RevenueTrendPoint[];
  measure: RevenueMeasure;
  height?: number;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();
  const money = measure === "revenue";
  const format = (value: number) => (money ? formatRupees(value) : `${formatNumber(value, { digits: 0 })} kWh`);

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 320,
    grid: { left: 8, right: 12, top: 16, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      formatter: (params: unknown) => {
        const point = points[(params as { dataIndex: number }).dataIndex];
        if (!point) return "";
        const value = valueOf(point, measure);
        const lines = [`<strong>${point.label}</strong>${point.in_progress ? " · so far" : ""}`];
        if (value === null) {
          lines.push(
            `<span style="opacity:.75">${
              money && point.exported_kwh !== null
                ? point.revenue_reason ?? "no revenue figure"
                : "nothing read in this period — not zero"
            }</span>`,
          );
        } else {
          lines.push(`${money ? "Revenue" : "Exported"}: <strong>${format(value)}</strong>`);
          if (money && point.exported_kwh !== null) {
            lines.push(`Exported: ${formatNumber(point.exported_kwh, { digits: 0 })} kWh`);
          }
          if (point.generated_kwh !== null) {
            lines.push(`Generated: ${formatNumber(point.generated_kwh, { digits: 0 })} kWh`);
          }
          if (point.basis === "estimate") {
            lines.push('<span style="opacity:.75">Estimate — from the MFM, not the settlement meter</span>');
          }
        }
        return lines.join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: points.map((point) => point.label),
      axisLine: theme.axisLine,
      axisTick: { show: false },
      axisLabel: { fontSize: 10, color: token("ink-faint"), hideOverlap: true },
    },
    yAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: theme.splitLine,
      axisLabel: {
        fontSize: 10,
        color: token("ink-faint"),
        // Compacted, uppercase suffix (`formatCompact`); the unit is the prefix.
        formatter: (value: number) => (money ? `₹${formatCompact(value)}` : formatCompact(value)),
      },
      name: money ? "" : "kWh",
      nameTextStyle: { color: token("ink-faint"), fontSize: 9 },
    },
    series: [
      {
        type: "bar",
        data: points.map((point) => {
          const value = valueOf(point, measure);
          return {
            // "-" is ECharts' empty value: no bar at all, never a bar of zero.
            value: value ?? "-",
            itemStyle: {
              color: point.in_progress ? tokenAlpha("chart-primary", 0.55) : token("chart-primary"),
              borderRadius: [4, 4, 0, 0],
            },
          };
        }),
        barMaxWidth: 34,
        barCategoryGap: "30%",
      },
    ],
  };

  const ref = useEcharts(option, [points, measure, themeVersion]);
  return <div ref={ref} style={{ height }} />;
}
