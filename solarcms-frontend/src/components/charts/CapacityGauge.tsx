/**
 * A live rate against the nameplate that bounds it — current power over the
 * Plant's AC capacity, as a half-ring.
 *
 * ── Why this is not `Gauge` ─────────────────────────────────────────────────
 * `Gauge` draws a *ratio the backend computed* (PR, CUF, availability) and can
 * band it ok/warn/bad. This draws a *measurement* against a *registered fact*,
 * and the arc is only the one divided by the other, so it states a proportion
 * and makes no judgement — accent only, never a status colour. A Plant at 40%
 * of capacity at 09:00 is doing exactly what it should.
 *
 * ── Three ways it declines to draw an arc ───────────────────────────────────
 * - **No value.** No arc and no zero — a ring sitting at zero is the most
 *   convincing way to render "unknown" as "stopped".
 * - **No capacity recorded.** There is nothing to draw the figure against, so
 *   the figure stands alone and says why.
 * - **Units that do not match.** The figure's unit comes from the Tag catalogue
 *   and the capacity's from the column name (`ac_capacity_kw`). Where those
 *   differ they are not compared: dividing kW by MW is the factor-of-1000 error
 *   §4.1 exists to prevent, and nothing here may rescale a unit.
 *
 * The figure itself is always the measured value, unaltered. Above capacity, or
 * below zero, the arc stops at its end and a note says so (Guardrail 33).
 */

import type { ReactNode } from "react";
import type { EChartsOption } from "echarts";
import { digitsForUnit, formatHeadline, formatNumber, UNDEFINED_DISPLAY } from "@/format/value";
import { token } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";
import { useEcharts } from "./useEcharts";

/*
  The ring is laid out in pixels on a fixed 288×150 canvas rather than in
  percentages, so the HTML labels under its two ends — `0` and the capacity —
  sit under the ends and not wherever a percentage radius happened to land.
  288px is the narrowest a drawer gets (a 320px phone less its padding).
*/
const WIDTH = 288;
const HEIGHT = 150;
const BAND = 16;
const RADIUS = 134;
const CENTRE_Y = 142;

/** The arc alone. Split out so the ECharts hook is called unconditionally. */
function Arc({ fraction }: { fraction: number }): JSX.Element {
  const { version: themeVersion } = useTheme();
  const option: EChartsOption = {
    backgroundColor: "transparent",
    series: [
      {
        type: "gauge",
        startAngle: 180,
        endAngle: 0,
        min: 0,
        max: 1,
        center: [WIDTH / 2, CENTRE_Y],
        radius: RADIUS,
        progress: { show: true, width: BAND, itemStyle: { color: token("accent") } },
        axisLine: { lineStyle: { width: BAND, color: [[1, token("chart-grid")]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        title: { show: false },
        detail: { show: false },
        data: [{ value: Math.max(0, Math.min(1, fraction)) }],
      },
    ],
  };
  const ref = useEcharts(option, [fraction, themeVersion]);
  return <div ref={ref} className="shrink-0" style={{ width: WIDTH, height: HEIGHT }} />;
}

export function CapacityGauge({
  value,
  unit,
  capacity,
  capacityUnit,
  label,
  source,
  undefinedReason,
}: {
  value: number | null;
  /** The figure's unit, verbatim from the catalogue. */
  unit: string | null;
  capacity: number | null;
  /** The capacity's unit, which its column name states. */
  capacityUnit: string;
  label: string;
  /** Where the figure came from — "ABT Meter", "Σ 17 Inverter". Always shown. */
  source?: ReactNode;
  /** Why the figure is blank, in words an operator can act on. */
  undefinedReason?: string;
}): JSX.Element {
  if (value === null) {
    return (
      <div className="flex h-[184px] flex-col items-center justify-center rounded-card border border-dashed border-line px-4 text-center">
        <span className="figure text-3xl text-ink-faint">{UNDEFINED_DISPLAY}</span>
        <span className="mt-1 text-sm font-medium text-ink-muted">{label}</span>
        <span className="mt-1 max-w-[18rem] text-[11px] leading-snug text-ink-faint">
          {undefinedReason ?? "Nothing is reporting this figure."}
        </span>
      </div>
    );
  }

  const figure = formatHeadline(value, { digits: digitsForUnit(unit) });
  const noArcReason =
    capacity === null || capacity <= 0
      ? "No AC capacity is recorded for this Plant, so there is nothing to draw the figure against."
      : unit !== capacityUnit
        ? `The figure is in ${unit ?? "no stated unit"} and the capacity in ${capacityUnit}. They are not compared: rescaling one to match the other is a factor-of-1000 error waiting to happen.`
        : null;

  const figureBlock = (
    <div className="flex flex-col items-center leading-none">
      <span
        className="figure text-[2.1rem] font-semibold tracking-tight text-ink"
        title={figure.compacted ? `${figure.exact}${unit ? ` ${unit}` : ""}` : String(value)}
      >
        {figure.text}
      </span>
      {unit ? <span className="mt-1.5 text-sm font-medium text-ink-muted">{unit}</span> : null}
    </div>
  );

  if (noArcReason) {
    return (
      <div className="flex flex-col items-center rounded-card border border-line bg-surface-sunken px-4 py-5 text-center">
        {figureBlock}
        <span className="mt-2 text-sm font-medium text-ink-muted">{label}</span>
        {source ? <span className="mt-0.5 text-[11px]">{source}</span> : null}
        <span className="mt-2 max-w-[18rem] text-[11px] leading-snug text-ink-faint">
          {noArcReason}
        </span>
      </div>
    );
  }

  const cap = capacity as number;
  const fraction = value / cap;
  const capacityText = formatNumber(cap, { digits: cap >= 1000 ? 0 : 1 });

  return (
    <div className="flex flex-col items-center rounded-card border border-line bg-surface-sunken px-4 pb-3 pt-4">
      <div className="relative" style={{ width: WIDTH }}>
        <Arc fraction={fraction} />
        {/* Inside the ring, on its chord — where the reference puts it. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-2">{figureBlock}</div>
      </div>
      {/* The scale's two ends, under the ends of the band. */}
      <div className="flex items-baseline justify-between px-1 text-xs" style={{ width: WIDTH }}>
        <span className="figure text-ink-muted">0</span>
        <span className="text-sm font-medium text-ink">{label}</span>
        <span className="figure text-ink-muted" title="AC capacity, from the Plant record.">
          {capacityText}
          <span className="ml-0.5 text-[10px]">{capacityUnit}</span>
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline justify-center gap-x-2 text-[11px] text-ink-faint">
        {source}
        {value >= 0 ? <span>{formatNumber(fraction * 100, { digits: 0 })}% of AC capacity</span> : null}
      </div>
      {fraction > 1 ? (
        <p className="mt-1.5 max-w-[18rem] text-center text-[11px] leading-snug text-warn">
          Above the recorded AC capacity. Shown as measured; check the capacity in the Plant
          record.
        </p>
      ) : value < 0 ? (
        <p className="mt-1.5 max-w-[18rem] text-center text-[11px] leading-snug text-ink-faint">
          Below zero, shown as measured. The arc starts at zero.
        </p>
      ) : null}
    </div>
  );
}
