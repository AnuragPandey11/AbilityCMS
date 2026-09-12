/**
 * Time series for one or more Tags.
 *
 * Two obligations this component exists to meet:
 *
 * 1. **Bad-quality points are not plotted as data** (§4.2, Guardrail 4). Points
 *    with quality ≠ 0 are cut out of the line and re-drawn as marked scatter in
 *    the quality's own colour, with the reason on hover. A silently-plotted
 *    denormalised float looks like a real excursion and gets reported as one.
 * 2. **The tier is stated** (§9). A chart of a year is daily averages; unlabelled,
 *    an operator reads a smoothed line as a measurement.
 *
 * Units are never mixed on one axis and never converted. A second axis appears
 * when a second unit is present; beyond two, the caller should split the chart.
 */

import type { EChartsOption } from "echarts";
import type { ReadingPoint, Tag, Tier } from "@/api/schemas";
import { formatAxisLabel, formatDateTime, DEFAULT_TIMEZONE } from "@/format/datetime";
import { formatValue } from "@/format/value";
import { isGoodQuality, quality, summariseQuality } from "@/format/quality";
import { chartTheme, useEcharts } from "./useEcharts";
import { token } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { Badge } from "@/components/ui";

export interface ChartSeries {
  tagId: number;
  tagCode: string;
  name: string;
  /** Verbatim from the API. Never derived from the Tag's name (§4.1). */
  unit: string;
  points: ReadingPoint[];
}

export const TIER_LABELS: Record<Tier, string> = {
  readings: "raw readings",
  agg_1m: "1-minute averages",
  agg_15m: "15-minute averages",
  agg_1h: "hourly averages",
  agg_1d: "daily averages",
};

/** Build chart series from a readings response and the Tag catalogue. */
export function toChartSeries(points: ReadingPoint[], tags: Tag[]): ChartSeries[] {
  const byTag = new Map<number, ReadingPoint[]>();
  for (const point of points) {
    const bucket = byTag.get(point.tag_id);
    if (bucket) bucket.push(point);
    else byTag.set(point.tag_id, [point]);
  }
  const out: ChartSeries[] = [];
  for (const [tagId, tagPoints] of byTag) {
    const tag = tags.find((candidate) => candidate.id === tagId);
    out.push({
      tagId,
      tagCode: tag?.code ?? tagPoints[0]?.tag_code ?? String(tagId),
      name: tag?.name ?? tagPoints[0]?.tag_code ?? String(tagId),
      unit: tag?.unit ?? "",
      points: tagPoints,
    });
  }
  return out;
}

export function TimeSeriesChart({
  series,
  tier,
  timezone = DEFAULT_TIMEZONE,
  height = 320,
}: {
  series: ChartSeries[];
  tier: Tier;
  /** The Plant's timezone, not the browser's (Guardrail 11). */
  timezone?: string;
  height?: number;
}): JSX.Element {
  const units = [...new Set(series.map((s) => s.unit).filter(Boolean))];
  const allQuality = series.flatMap((s) => s.points.map((p) => p.quality));
  const flagged = summariseQuality(allQuality);

  // Re-read on every render: `version` changes when the theme does, which is
  // what re-runs this component and repaints the canvas in the new palette.
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();

  const axisIndexFor = (unit: string): number => Math.min(units.indexOf(unit), 1);

  const lineSeries = series.map((entry, index) => ({
    name: entry.name,
    type: "line" as const,
    yAxisIndex: axisIndexFor(entry.unit),
    showSymbol: false,
    // LTTB keeps the shape of a 20,000-point series without drawing 20,000
    // symbols. It is downsampling for display only; the data is unchanged.
    sampling: "lttb" as const,
    large: true,
    lineStyle: { width: 1.5 },
    color: theme.palette[index % theme.palette.length],
    data: entry.points.map((point) => [
      point.bucket,
      // A bad point becomes a gap in the line, not a vertex. The value is not
      // discarded — it is re-drawn below in the quality's colour.
      isGoodQuality(point.quality) ? point.value : null,
    ]),
  }));

  const qualitySeries = series.flatMap((entry) => {
    const bad = entry.points.filter((point) => !isGoodQuality(point.quality));
    if (bad.length === 0) return [];
    return [
      {
        name: `${entry.name} — flagged`,
        type: "scatter" as const,
        yAxisIndex: axisIndexFor(entry.unit),
        symbol: "diamond",
        symbolSize: 7,
        // Colour by the point's own quality code, so out-of-range and
        // unparseable are distinguishable at a glance.
        itemStyle: {
          color: (params: { dataIndex: number }) =>
            quality(bad[params.dataIndex]?.quality).color,
        },
        data: bad.map((point) => [point.bucket, point.value]),
        tooltip: {
          formatter: (params: { dataIndex: number }) => {
            const point = bad[params.dataIndex];
            const descriptor = quality(point?.quality);
            return [
              `<strong>${entry.name}</strong>`,
              formatDateTime(point?.bucket, timezone),
              `${formatValue(point?.value, entry.unit)}`,
              `<span style="color:${descriptor.color}">${descriptor.label}</span>`,
              `<div style="max-width:260px;white-space:normal;opacity:.75">${descriptor.explanation}</div>`,
            ].join("<br/>");
          },
        },
      },
    ];
  });

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    grid: { left: 56, right: units.length > 1 ? 56 : 16, top: 28, bottom: 44 },
    legend: {
      type: "scroll",
      top: 0,
      textStyle: { color: token("ink-muted"), fontSize: 11 },
      // The flagged scatter series are explained by the badges under the chart;
      // listing them doubles the legend for no information.
      data: series.map((entry) => entry.name),
    },
    tooltip: {
      trigger: "axis",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      textStyle: { color: token("ink"), fontSize: 11 },
      axisPointer: { type: "cross", label: { backgroundColor: token("chart-grid") } },
      formatter: (params: unknown) => {
        const rows = Array.isArray(params) ? params : [params];
        const first = rows[0] as { axisValue?: string } | undefined;
        const header = formatDateTime(first?.axisValue, timezone);
        const body = rows
          .filter((row) => {
            const value = (row as { value?: unknown[] }).value;
            return Array.isArray(value) && value[1] !== null && value[1] !== undefined;
          })
          .map((row) => {
            const typed = row as {
              seriesName: string;
              value: unknown[];
              color: string;
            };
            const entry = series.find((candidate) => candidate.name === typed.seriesName);
            return (
              `<span style="color:${typed.color}">●</span> ${typed.seriesName}: ` +
              `<strong>${formatValue(Number(typed.value[1]), entry?.unit)}</strong>`
            );
          })
          .join("<br/>");
        return `${header}<br/>${body}`;
      },
    },
    xAxis: {
      type: "time",
      axisLine: theme.axisLine,
      splitLine: { show: false },
      axisLabel: {
        fontSize: 10,
        formatter: (value: number) => formatAxisLabel(new Date(value), tier, timezone),
      },
    },
    // One axis per unit, up to two. Units are never combined — the client's own
    // schedule mixes kWh and MWh inside one Device (§4.1).
    yAxis: units.slice(0, 2).map((unit, index) => ({
      type: "value" as const,
      name: unit,
      position: index === 0 ? ("left" as const) : ("right" as const),
      nameTextStyle: { color: token("ink-faint"), fontSize: 10 },
      axisLine: theme.axisLine,
      splitLine: index === 0 ? theme.splitLine : { show: false },
      axisLabel: { fontSize: 10 },
      scale: true,
    })),
    dataZoom: [
      { type: "inside", throttle: 50 },
      { type: "slider", height: 16, bottom: 8, borderColor: token("chart-grid") },
    ],
    series: [...lineSeries, ...qualitySeries],
  };

  const ref = useEcharts(option, [series, tier, timezone, themeVersion]);

  return (
    <div>
      <div ref={ref} style={{ height }} />
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-faint">
        {/* §9: say which tier served this, or a smoothed line reads as a measurement. */}
        <Badge tone="info" title="The server chose the coarsest tier that covers this range and still retains it.">
          {TIER_LABELS[tier]}
        </Badge>
        {units.length > 2 ? (
          <Badge tone="warn" title="More than two units in one chart; split it by unit.">
            {units.length} units — showing two axes
          </Badge>
        ) : null}
        {flagged.map((descriptor) => (
          <Badge key={descriptor.code} tone="warn" title={descriptor.explanation}>
            ◆ {descriptor.label}
          </Badge>
        ))}
      </div>
    </div>
  );
}
