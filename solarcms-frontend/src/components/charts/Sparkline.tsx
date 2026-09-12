/**
 * A miniature trend. Bad-quality points are dropped rather than drawn: at this
 * size a marker is illegible, and drawing them as line vertices would be exactly
 * the defect Guardrail 4 forbids. The full chart is where flagged points are
 * inspected.
 */

import type { EChartsOption } from "echarts";
import { isGoodQuality } from "@/format/quality";
import type { ReadingPoint } from "@/api/schemas";
import { useEcharts } from "./useEcharts";
import { token } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

export function Sparkline({
  points,
  color,
  height = 36,
}: {
  points: ReadingPoint[];
  /** Defaults to the theme's accent; a caller may pass a series colour. */
  color?: string;
  height?: number;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  // Resolved here rather than as a default argument: a default is evaluated
  // against whichever theme was active at module load.
  const stroke = color ?? token("accent");
  const data = points
    .filter((point) => isGoodQuality(point.quality) && point.value !== null)
    .map((point) => [point.bucket, point.value]);

  const option: EChartsOption = {
    backgroundColor: "transparent",
    grid: { left: 0, right: 0, top: 2, bottom: 2 },
    xAxis: { type: "time", show: false },
    yAxis: { type: "value", show: false, scale: true },
    tooltip: { show: false },
    series: [
      {
        type: "line",
        showSymbol: false,
        sampling: "lttb",
        lineStyle: { width: 1.5, color: stroke },
        areaStyle: { color: stroke, opacity: 0.12 },
        data,
      },
    ],
  };

  const ref = useEcharts(option, [points, stroke, themeVersion]);
  return <div ref={ref} style={{ height }} />;
}
