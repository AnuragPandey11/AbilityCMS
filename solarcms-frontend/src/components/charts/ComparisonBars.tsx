/**
 * One bar per Device, for comparing peers on a single measure.
 *
 * ── Why one colour and not a ramp ───────────────────────────────────────────
 * The tempting rendering is darker-where-bigger. It is wrong twice: it
 * double-encodes bar length as hue, spending the only free channel on
 * information the bar already carries, and a lightness ramp across nominal
 * categories asserts an order the categories do not have. One series, one
 * colour — slot 1 of the categorical palette. The *sort* carries the ranking,
 * which is what sorting is for.
 *
 * The one exception is a bar the caller marks `attention`, which takes the
 * status colour. That is not a series colour standing in for a value; it is a
 * statement that this Device needs looking at, and it ships with a visible
 * label rather than relying on the colour alone.
 *
 * ── Horizontal, because the labels are Device codes ─────────────────────────
 * `INVERTER_14` at the foot of a vertical bar is either rotated 45° or
 * truncated, and seventeen of them is a fringe. Horizontal gives every label a
 * full line at reading angle, and the bar length still runs left-to-right,
 * which is the direction magnitude is read in.
 *
 * A gap, not a border, separates the bars: a keyline around each mark thickens
 * everything and makes a dense series read as one solid block.
 */

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { chartTheme, useEcharts } from "./useEcharts";
import { seriesPalette, token, tokenAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { formatValue } from "@/format/value";

export interface ComparisonRow {
  /** Stable identity — the colour and the sort follow the entity, not the row. */
  id: number;
  label: string;
  /** null is not zero: the Device reported nothing, which is not "it made none". */
  value: number | null;
  /** Draws this bar in the warning colour and labels it. */
  attention?: boolean;
  attentionReason?: string;
}

export function ComparisonBars({
  rows,
  unit,
  metricLabel,
  height = 240,
  noun = "Device",
}: {
  rows: ComparisonRow[];
  unit: string | null;
  metricLabel: string;
  height?: number;
  /**
   * What the rows are, singular. The same chart ranks Inverters within a Plant
   * and Plants within a fleet, and a note that says "2 Devices reported no
   * value" under a chart of Plants is the kind of small wrongness that makes a
   * reader distrust the rest of the screen.
   */
  noun?: string;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();
  const base = seriesPalette()[0] ?? token("accent");

  /**
   * Devices that reported, sorted by the measure; then the silent ones.
   *
   * The silent ones are kept and drawn as a labelled gap rather than dropped.
   * A Device missing from a comparison of its peers is the single most
   * important row on the chart — it is the one nobody can account for — and
   * sorting it to the bottom as "no value" is how it stays visible without
   * being ranked as though it had produced nothing.
   */
  const { ordered, silent } = useMemo(() => {
    const reported = rows.filter((row) => row.value !== null);
    const quiet = rows.filter((row) => row.value === null);
    reported.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    // Ascending down the axis: ECharts draws a category axis bottom-up, so the
    // largest has to be last for it to land at the top.
    return { ordered: [...quiet, ...reported.slice().reverse()], silent: quiet.length };
  }, [rows]);

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 320,
    grid: { left: 4, right: 56, top: 6, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      formatter: (params: unknown) => {
        const typed = params as { dataIndex: number };
        const row = ordered[typed.dataIndex];
        if (!row) return "";
        if (row.value === null) {
          return `<strong>${row.label}</strong><br/><span style="opacity:.75">reported nothing in this window — not zero</span>`;
        }
        return (
          `<strong>${row.label}</strong><br/>${metricLabel}: ` +
          `<strong>${formatValue(row.value, unit ?? undefined)}</strong>` +
          (row.attentionReason
            ? `<br/><span style="opacity:.75">${row.attentionReason}</span>`
            : "")
        );
      },
    },
    xAxis: {
      type: "value",
      name: unit ?? "",
      nameLocation: "end",
      nameTextStyle: { color: token("ink-faint"), fontSize: 9 },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: theme.splitLine,
      axisLabel: { fontSize: 9, color: token("ink-faint") },
    },
    yAxis: {
      type: "category",
      data: ordered.map((row) => row.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        fontSize: 10,
        color: token("ink-muted"),
        // The codes are the identity; never truncate them to fit a bar.
        width: 96,
        overflow: "truncate",
      },
    },
    series: [
      {
        type: "bar",
        // Zero rather than null, because ECharts cannot place a category with
        // no datum — the bar is length 0 and the *label* says what happened.
        data: ordered.map((row) => ({
          value: row.value ?? 0,
          itemStyle: {
            color:
              row.value === null
                ? tokenAlpha("ink-faint", 0.25)
                : row.attention
                  ? token("warn")
                  : base,
            // Rounded at the data end only; the end meeting the axis stays
            // square so the baseline reads as a straight line.
            borderRadius: [0, 4, 4, 0],
          },
        })),
        barMaxWidth: 13,
        barCategoryGap: "34%",
        // Direct labels at the bar end — selective by construction, since a
        // horizontal bar chart has one label per row rather than one per point.
        label: {
          show: true,
          position: "right",
          distance: 6,
          fontSize: 10,
          color: token("ink-muted"),
          formatter: (params: { dataIndex: number }) => {
            const row = ordered[params.dataIndex];
            if (!row) return "";
            return row.value === null ? "no value" : formatValue(row.value, undefined);
          },
        },
      },
    ],
  };

  const ref = useEcharts(option, [ordered, unit, metricLabel, themeVersion]);

  return (
    <div>
      <div ref={ref} style={{ height }} />
      {silent > 0 ? (
        <p className="mt-1 text-[10px] leading-snug text-ink-faint">
          {silent} {noun}
          {silent === 1 ? "" : "s"} reported no value for {metricLabel} in this window and{" "}
          {silent === 1 ? "is" : "are"} shown with an empty bar. That is not a reading of
          zero — nobody knows what {silent === 1 ? "it" : "they"} produced.
        </p>
      ) : null}
    </div>
  );
}
