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
function GaugeCanvas({
  value,
  height,
  banded,
}: {
  value: number;
  height: number;
  banded: boolean;
}): JSX.Element {
  const { version: themeVersion } = useTheme();
  // ⚠ Clamped for the arc only. A gauge cannot draw 389%, so it drew a *full*
  // ring beside a label reading "389.2%" — the ring said "perfect" and the
  // number said "impossible", and the ring is what gets read at a glance. An
  // implausible figure never reaches this component; see `Gauge` below.
  const percent = Math.max(0, Math.min(100, value * 100));
  // Banding thresholds are presentation, not a client-confirmed judgement about
  // a good PR — the figure itself carries the caveat (§4.3). An unbanded gauge
  // wears the accent: it states a figure and makes no judgement about it.
  const colour = !banded
    ? token("accent")
    : percent >= 80
      ? token("ok")
      : percent >= 60
        ? token("warn")
        : token("bad");

  const option: EChartsOption = {
    backgroundColor: "transparent",
    series: [
      {
        type: "gauge",
        startAngle: 200,
        endAngle: -20,
        min: 0,
        max: 100,
        // A 220° arc is 1.34 radii tall, so at a centred 92% radius it left a
        // third of the canvas empty under the chord and pushed the label away
        // from its figure. Sized and dropped so the arc fills the height.
        center: ["50%", "70%"],
        radius: "128%",
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
          fontSize: 22,
          fontWeight: 600,
          // The UI face, as `.figure` uses — a monospace headline reads like a
          // terminal line. Same stack as the chart theme in `theme/tokens`.
          fontFamily: "Inter, system-ui, sans-serif",
          color: token("ink"),
          offsetCenter: [0, "-8%"],
          formatter: () => formatRatioAsPercent(value),
        },
        data: [{ value: percent }],
      },
    ],
  };

  const ref = useEcharts(option, [value, themeVersion]);
  // `w-full`: the tile centres its children, and an unsized canvas container
  // in a centring flex column collapses to zero width.
  return <div ref={ref} className="w-full" style={{ height }} />;
}

export function Gauge({
  figure,
  label,
  height = 160,
  banded = true,
}: {
  figure: KpiFigure | null | undefined;
  label: string;
  height?: number;
  /**
   * Colour the arc ok/warn/bad by 80/60%. Off for a ratio those bands mean
   * nothing for: a PV Plant's CUF physically tops out near 25–30%, so banding
   * it would draw every healthy Plant red.
   */
  banded?: boolean;
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
        <span className="figure text-xl text-ink-faint">—</span>
        <span className="mt-1 text-sm font-medium text-ink-muted">{label}</span>
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
        <span className="figure text-xl font-semibold text-warn">{formatRatioAsPercent(value)}</span>
        <span className="mt-1 text-sm font-medium text-ink-muted">{label}</span>
        <span className="mt-1 max-w-[15rem] px-2 text-[10px] leading-snug text-ink-faint">
          Outside the range this quantity can take — the numerator and denominator cover
          different spans. Check coverage.
        </span>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col items-center justify-center rounded-lg border border-line bg-surface-raised p-2 text-center"
      style={{ height }}
    >
      <GaugeCanvas value={value} height={height - 52} banded={banded} />
      <div className="mt-1 text-sm font-medium text-ink">{label}</div>
      {/* The variant alone; "provisional pending OPEN-16" is said once by
          whoever frames these, not three times across a row. */}
      {figure?.variant ? (
        <div
          className="mt-0.5 max-w-full truncate text-[11px] text-ink-faint"
          title={variantNote(figure.variant)}
        >
          {figure.variant.replace(/_/g, " ")}
        </div>
      ) : null}
    </div>
  );
}
