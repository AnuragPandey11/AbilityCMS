/**
 * Part-to-whole across Plants — which of them produced the fleet's output.
 *
 * ── The rules a donut has to obey to be worth drawing ───────────────────────
 * A pie is only legitimate for *part-to-whole at a glance*, with few enough
 * segments that adjacent ones are still distinguishable. Past about six the
 * slices blur, the categorical palette runs out of separated hues, and the
 * reader is doing a comparison job a bar chart does better. So:
 *
 * - **At most `maxSlices` segments**, and the tail folds into one "Other"
 *   slice that names how many Plants it holds. Never a ninth generated hue —
 *   a colour past the validated eight is indistinguishable under CVD by
 *   construction.
 * - **"Other" is grey**, deliberately outside the categorical order. It is not
 *   an entity, it is the absence of room for one, and giving it a series hue
 *   would make it look like a Plant.
 * - **Colour follows the entity, not the rank.** Slices are coloured by their
 *   position in the *sorted* list, which is stable for as long as the ranking
 *   is — and the legend carries the name beside every swatch, so identity is
 *   never colour alone.
 *
 * ── What it refuses to do ───────────────────────────────────────────────────
 * It will not draw a share of nothing. When every Plant reports zero — which
 * is every fleet at night — a donut of equal slices is a picture of a fleet
 * splitting nothing evenly, which is worse than no chart. It says so instead.
 */

import { useMemo } from "react";
import type { EChartsOption } from "echarts";
import { chartTheme, useEcharts } from "./useEcharts";
import { seriesPalette, token, tokenAlpha } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { formatHeadline, formatValue } from "@/format/value";

export interface ShareSlice {
  /** Stable identity, so a click can navigate to the thing. */
  id: number;
  label: string;
  value: number;
}

export function SharePie({
  slices,
  unit,
  total: totalLabel,
  maxSlices = 6,
  height = 220,
  onSelect,
}: {
  slices: ShareSlice[];
  unit: string | null;
  /** What the centre reads. Defaults to the summed value. */
  total?: string;
  maxSlices?: number;
  height?: number;
  onSelect?: (id: number) => void;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  const theme = chartTheme();
  const palette = seriesPalette();

  const { shown, total, folded } = useMemo(() => {
    const positive = slices.filter((slice) => Number.isFinite(slice.value) && slice.value > 0);
    const sum = positive.reduce((running, slice) => running + slice.value, 0);
    const sorted = [...positive].sort((a, b) => b.value - a.value);
    if (sorted.length <= maxSlices) return { shown: sorted, total: sum, folded: 0 };
    const head = sorted.slice(0, maxSlices - 1);
    const tail = sorted.slice(maxSlices - 1);
    return {
      shown: [
        ...head,
        {
          id: -1,
          label: `Others (${tail.length} Plants)`,
          value: tail.reduce((running, slice) => running + slice.value, 0),
        },
      ],
      total: sum,
      folded: tail.length,
    };
  }, [slices, maxSlices]);

  const colorFor = (index: number, id: number): string =>
    id === -1 ? tokenAlpha("ink-faint", 0.55) : (palette[index % palette.length] ?? token("accent"));

  const option: EChartsOption = {
    backgroundColor: "transparent",
    textStyle: theme.textStyle,
    animationDuration: 320,
    tooltip: {
      trigger: "item",
      backgroundColor: theme.tooltipBackground,
      borderColor: theme.tooltipBorder,
      borderWidth: 1,
      padding: [7, 10],
      textStyle: { color: token("ink"), fontSize: 11 },
      formatter: (params: unknown) => {
        const typed = params as { dataIndex: number; percent?: number };
        const slice = shown[typed.dataIndex];
        if (!slice) return "";
        return (
          `<strong>${slice.label}</strong><br/>` +
          `${formatValue(slice.value, unit ?? undefined)} · ${(typed.percent ?? 0).toFixed(1)}%`
        );
      },
    },
    series: [
      {
        type: "pie",
        radius: ["62%", "88%"],
        center: ["50%", "50%"],
        avoidLabelOverlap: true,
        // No labels on the ring: at six slices they collide, and the legend
        // beside the chart already carries name, value and share.
        label: { show: false },
        labelLine: { show: false },
        itemStyle: {
          // A 2px ring of the surface between segments, rather than a border
          // drawn around each — a keyline thickens every mark and turns a
          // dense ring into one solid blob.
          borderColor: token("surface-raised"),
          borderWidth: 2,
          borderRadius: 3,
        },
        data: shown.map((slice, index) => ({
          name: slice.label,
          value: slice.value,
          itemStyle: { color: colorFor(index, slice.id) },
        })),
      },
    ],
  };

  const ref = useEcharts(option, [shown, unit, themeVersion]);
  const headline = formatHeadline(total);

  if (shown.length === 0) {
    return (
      <p className="py-8 text-center text-xs leading-snug text-ink-faint">
        Every Plant reported zero for this period, so there is no share to draw. A ring of
        equal slices would be a picture of a fleet splitting nothing evenly.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <div className="relative shrink-0" style={{ width: height, height }}>
        <div ref={ref} style={{ width: height, height }} />
        {/* The total, in the hole. A donut's centre is the one place a
            part-to-whole chart can state the whole. */}
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wide text-ink-faint">
            {totalLabel ? "" : "Total"}
          </span>
          <span className="text-base font-semibold leading-tight text-ink">
            {totalLabel ?? headline.text}
          </span>
          {!totalLabel && unit ? (
            <span className="text-[10px] text-ink-muted">{unit}</span>
          ) : null}
        </div>
      </div>

      {/* The legend is always present and always carries the value, so nothing
          here is encoded by colour alone. */}
      <ul className="min-w-0 flex-1 space-y-1">
        {shown.map((slice, index) => {
          const share = total > 0 ? (slice.value / total) * 100 : 0;
          const interactive = onSelect !== undefined && slice.id >= 0;
          return (
            <li key={`${slice.id}-${slice.label}`}>
              <button
                type="button"
                disabled={!interactive}
                onClick={() => interactive && onSelect?.(slice.id)}
                className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px] transition ${
                  interactive ? "hover:bg-surface-sunken" : "cursor-default"
                }`}
              >
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: colorFor(index, slice.id) }}
                />
                <span className="min-w-0 flex-1 truncate text-ink-muted">{slice.label}</span>
                <span className="shrink-0 font-mono tabular-nums text-ink">
                  {share.toFixed(1)}%
                </span>
              </button>
            </li>
          );
        })}
        {folded > 0 ? (
          <li className="px-1 pt-0.5 text-[9px] leading-snug text-ink-faint">
            The {folded} smallest Plants are folded into one slice — past six segments
            adjacent colours stop being distinguishable.
          </li>
        ) : null}
      </ul>
    </div>
  );
}
