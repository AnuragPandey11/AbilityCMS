/**
 * Digital Inputs (§4.5).
 *
 * Roughly a third of Tags are DI — `category: "status"`, values 0 or 1 — and the
 * whole of `VCB` and `TRANSFORMER` is DI. They are rendered as **state**, never
 * as a line chart: a trip contact plotted as a numeric series is unreadable, and
 * the thing that matters — *when did it change* — is exactly what a line hides.
 *
 * This is also why a status Tag is never throttled (`min_interval_s = 0`): a
 * 60-second window would discard a contact that opened and re-closed inside it.
 */

import type { EChartsOption } from "echarts";
import type { ReadingPoint } from "@/api/schemas";
import { formatDateTime, DEFAULT_TIMEZONE } from "@/format/datetime";
import { isGoodQuality, quality } from "@/format/quality";
import { useEcharts } from "./useEcharts";
import { token } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

/** A single labelled indicator. `null` is unknown, which is not "off". */
export function StatusIndicator({
  label,
  value,
  qualityCode,
  stale,
}: {
  label: string;
  value: number | null | undefined;
  qualityCode?: number | null;
  stale?: boolean;
}): JSX.Element {
  const unknown = value === null || value === undefined || !Number.isFinite(value);
  const on = !unknown && value !== 0;
  const descriptor = quality(qualityCode);
  const flagged = qualityCode !== undefined && !isGoodQuality(qualityCode);

  const dot = unknown
    ? "bg-ink-faint"
    : on
      ? "lamp-ok bg-ok"
      : "bg-ink-faint";

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded border border-line bg-surface px-2.5 py-1.5 ${
        stale ? "opacity-50" : ""
      }`}
      title={
        flagged
          ? `${descriptor.label}: ${descriptor.explanation}`
          : stale
            ? "No update within the Device's expected interval; this is the last known state."
            : undefined
      }
    >
      <span className="truncate text-xs text-ink-muted">{label}</span>
      <span className="flex items-center gap-1.5">
        {flagged ? <span style={{ color: descriptor.color }}>◆</span> : null}
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <span
          className={`font-mono text-[11px] ${unknown ? "text-ink-faint" : on ? "text-ok" : "text-ink-muted"}`}
        >
          {unknown ? "—" : on ? "ON" : "OFF"}
        </span>
      </span>
    </div>
  );
}

export interface StatusSeries {
  tagId: number;
  name: string;
  points: ReadingPoint[];
}

/**
 * History as a timeline of transitions, one lane per Tag.
 *
 * A transition is drawn as a bar spanning until the next differing sample, so
 * the eye reads "closed from 09:14 to 11:02" rather than a sawtooth.
 */
export function StatusTimeline({
  series,
  timezone = DEFAULT_TIMEZONE,
  height,
}: {
  series: StatusSeries[];
  timezone?: string;
  height?: number;
}): JSX.Element {
  const laneHeight = 26;
  const computedHeight = height ?? Math.max(90, series.length * laneHeight + 60);

  type Segment = [number, number, number, number];
  const segments: Segment[] = [];

  series.forEach((lane, laneIndex) => {
    const usable = lane.points
      .filter((point) => isGoodQuality(point.quality) && point.value !== null)
      .sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket));

    for (let index = 0; index < usable.length; index += 1) {
      const point = usable[index];
      const start = Date.parse(point.bucket);
      // The last sample extends to now: the contact has not changed since, which
      // is a fact about the world, not a gap in the data.
      const end =
        index + 1 < usable.length ? Date.parse(usable[index + 1].bucket) : Date.now();
      const state = point.value === 0 ? 0 : 1;
      const previous = segments[segments.length - 1];
      // Collapse runs of the same state into one bar so the tooltip reports the
      // duration of the state rather than of one sample.
      if (
        previous &&
        previous[2] === laneIndex &&
        previous[3] === state &&
        previous[1] === start
      ) {
        previous[1] = end;
      } else {
        segments.push([start, end, laneIndex, state]);
      }
    }
  });

  const { version: themeVersion } = useTheme();

  const option: EChartsOption = {
    backgroundColor: "transparent",
    grid: { left: 130, right: 16, top: 12, bottom: 36 },
    tooltip: {
      backgroundColor: token("chart-tooltip-bg"),
      borderColor: token("chart-tooltip-border"),
      textStyle: { color: token("ink"), fontSize: 11 },
      formatter: (params: unknown) => {
        const value = (params as { value: Segment }).value;
        const [start, end, laneIndex, state] = value;
        const minutes = Math.round((end - start) / 60000);
        return [
          `<strong>${series[laneIndex]?.name ?? ""}</strong>`,
          `${state === 1 ? "ON" : "OFF"} for ${minutes} min`,
          `from ${formatDateTime(new Date(start), timezone)}`,
          `to ${formatDateTime(new Date(end), timezone)}`,
        ].join("<br/>");
      },
    },
    xAxis: {
      type: "time",
      axisLine: { lineStyle: { color: token("chart-grid") } },
      splitLine: { show: true, lineStyle: { color: token("chart-grid"), type: "dashed" } },
      axisLabel: { fontSize: 10, color: token("ink-muted") },
    },
    yAxis: {
      type: "category",
      data: series.map((lane) => lane.name),
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { fontSize: 10, color: token("ink-muted"), width: 120, overflow: "truncate" },
    },
    series: [
      {
        type: "custom",
        renderItem: (_params, api) => {
          const laneIndex = api.value(2) as number;
          const state = api.value(3) as number;
          const start = api.coord([api.value(0), laneIndex]);
          const end = api.coord([api.value(1), laneIndex]);
          const barHeight = 12;
          return {
            type: "rect",
            shape: {
              x: start[0],
              y: start[1] - barHeight / 2,
              width: Math.max(1, end[0] - start[0]),
              height: barHeight,
            },
            style: api.style({
              // ON is the signal; OFF is the ground. Neither is an alarm colour —
              // whether ON is good depends entirely on the contact.
              fill: state === 1 ? token("ok") : token("chart-grid"),
            }),
          };
        },
        encode: { x: [0, 1], y: 2 },
        data: segments,
      },
    ],
  };

  const ref = useEcharts(option, [series, timezone, themeVersion]);
  return <div ref={ref} style={{ height: computedHeight }} />;
}
