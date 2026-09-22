/**
 * A ratio gauge, for PR / CUF / availability.
 *
 * An undefined figure draws **no needle and no arc** — a gauge sitting at zero
 * is the single most convincing way to render "undefined" as "failed" (§4.3).
 */

import type { EChartsOption } from "echarts";
import type { KpiFigure } from "@/api/schemas";
import {
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
} from "@/format/value";
import { useEcharts } from "./useEcharts";
import { token } from "@/theme/tokens";
import { useTheme } from "@/theme/ThemeProvider";

/**
 * The rendering half. Split out so the ECharts hook is called unconditionally.
 *
 * The undefined branch below returns before any chart exists, and a hook behind
 * that early return would change hook order the moment a KPI flips between
 * defined and undefined — which is precisely what PR does at sunrise and sunset.
 */
function GaugeCanvas({ value, height }: { value: number; height: number }): JSX.Element {
  const { version: themeVersion } = useTheme();
  // ⚠ Clamped for the arc only. A gauge cannot draw 389%, so it drew a *full*
  // ring beside a label reading "389.2%" — the ring said "perfect" and the
  // number said "impossible", and the ring is what gets read at a glance. An
  // implausible figure never reaches this component; see `Gauge` below.
  const percent = Math.max(0, Math.min(100, value * 100));
  // Banding thresholds are presentation, not a client-confirmed judgement about
  // a good PR — the figure itself carries the caveat (§4.3).
  const colour =
    percent >= 80 ? token("ok") : percent >= 60 ? token("warn") : token("bad");

  const option: EChartsOption = {
    backgroundColor: "transparent",
    series: [
      {
        type: "gauge",
        startAngle: 200,
        endAngle: -20,
        min: 0,
        max: 100,
        radius: "92%",
        progress: { show: true, width: 10, itemStyle: { color: colour } },
        axisLine: { lineStyle: { width: 10, color: [[1, token("chart-grid")]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        anchor: { show: false },
        title: { show: false },
        detail: {
          valueAnimation: false,
          fontSize: 20,
          fontFamily: "ui-monospace, monospace",
          color: token("ink"),
          offsetCenter: [0, "0%"],
          formatter: () => formatRatioAsPercent(value),
        },
        data: [{ value: percent }],
      },
    ],
  };

  const ref = useEcharts(option, [value, themeVersion]);
  return <div ref={ref} style={{ height }} />;
}

export function Gauge({
  figure,
  label,
  height = 160,
}: {
  figure: KpiFigure | null | undefined;
  label: string;
  height?: number;
}): JSX.Element {
  const value = figure?.value ?? null;

  if (value === null) {
    // No needle and no arc. A gauge sitting at zero is the most convincing way
    // to render "undefined" as "failed" (§4.3).
    return (
      <div
        className="flex flex-col items-center justify-center rounded-lg border border-dashed border-line text-center"
        style={{ height }}
      >
        <span className="font-mono text-xl text-ink-faint">—</span>
        <span className="mt-1 text-xs text-ink-muted">{label}</span>
        <span className="mt-1 max-w-[14rem] px-2 text-[11px] leading-snug text-ink-faint">
          {figure?.undefined_reason ?? "Not defined for this period."}
        </span>
      </div>
    );
  }

  if (ratioIsImplausible(value)) {
    /*
      Shown, never drawn as an arc.

      The gauge can only sweep 0..100%, so an impossible ratio produced a *full
      ring* next to a label reading "389.2%". The ring is what gets read at a
      glance, and it said the Plant was perfect. The figure stays on screen
      unaltered — correcting it would invent data and hiding it would conceal
      the gap that produced it — but it is presented as a fault, not a result.
    */
    return (
      <div
        className="flex flex-col items-center justify-center rounded-lg border border-warn/45 bg-warn/[0.06] p-2 text-center"
        style={{ height }}
        title={implausibleRatioReason(value, label)}
      >
        <span className="font-mono text-lg text-warn">{formatRatioAsPercent(value)}</span>
        <span className="mt-1 text-xs text-ink-muted">{label}</span>
        <span className="mt-1 max-w-[15rem] px-2 text-[10px] leading-snug text-ink-faint">
          Outside the range this quantity can take — the numerator and denominator cover
          different spans. Check coverage.
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line bg-surface-raised p-2 text-center">
      <GaugeCanvas value={value} height={height - 34} />
      <div className="text-xs text-ink-muted">{label}</div>
      {figure?.variant ? (
        <div className="mt-0.5 text-[10px] text-ink-faint">{variantNote(figure.variant)}</div>
      ) : null}
    </div>
  );
}
