/**
 * Period performance: PR, CUF, Availability, CO₂ — and what they are worth.
 *
 * Kept deliberately separate from the live headline strip, and not merged with
 * it however well they would fit together. The strip is *what the Plant is
 * doing now*, read from the equipment this second. These are computed over a
 * chosen period from hourly aggregates, and every one of them is provisional
 * pending the client's own definitions (OPEN-16). Putting a measured figure and
 * a provisional derived one in the same row, at the same size, with the same
 * chrome, is how a placeholder gets quoted back as a commitment.
 *
 * Three things every figure here carries, and none of them are decoration:
 *
 * - **`null` renders as "—", never 0** (§4.3). PR is undefined at night;
 *   showing 0% drags every average down and tells an operator their Plant
 *   failed.
 * - **The variant is named.** Each figure came out of a specific provisional
 *   formula, and surfacing which one is what stops the eventual recomputation
 *   from looking like a defect.
 * - **Coverage sits beside them** (Guardrail 18). A period with a gap yields a
 *   figure that is low, plausible, and wrong in a way nothing else reveals.
 */

import type { KpiFigure, PlantKpis } from "@/api/schemas";
import { Gauge } from "@/components/charts/Gauge";
import { CoverageBar } from "@/components/dashboard/CoverageBadge";
import {
  UNDEFINED_DISPLAY,
  formatNumber,
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
} from "@/format/value";

function FigureRow({
  label,
  figure,
  kind,
  unit,
  note,
}: {
  label: string;
  figure: KpiFigure | undefined;
  kind: "ratio" | "quantity";
  unit?: string;
  note?: string;
}): JSX.Element {
  const value = figure?.value ?? null;
  const isUndefined = value === null;
  // A ratio outside its physical range is a fault in the inputs, not a result.
  // Shown unaltered and flagged — see `ratioIsImplausible`.
  const implausible = kind === "ratio" && ratioIsImplausible(value);
  const text = isUndefined
    ? UNDEFINED_DISPLAY
    : kind === "ratio"
      ? formatRatioAsPercent(value)
      : formatNumber(value);

  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-xs text-ink">{label}</div>
        <div
          className={`truncate text-[10px] leading-snug ${implausible ? "text-warn" : "text-ink-faint"}`}
        >
          {isUndefined
            ? (figure?.undefined_reason ??
              "This figure is not defined for the selected period.")
            : implausible
              ? "Outside the range this quantity can take — check coverage."
              : (note ?? (figure?.variant ? variantNote(figure.variant) : ""))}
        </div>
      </div>
      <div
        className={`shrink-0 font-mono text-sm tabular-nums ${
          isUndefined ? "text-ink-faint" : implausible ? "text-warn" : "text-ink"
        }`}
        title={implausible && value !== null ? implausibleRatioReason(value, label) : undefined}
      >
        {text}
        {!isUndefined && unit ? (
          <span className="ml-0.5 text-[10px] text-ink-muted">{unit}</span>
        ) : null}
      </div>
    </div>
  );
}

export function PerformancePanel({
  kpis,
  period,
}: {
  kpis: PlantKpis | undefined;
  period: string;
}): JSX.Element {
  return (
    <div className="space-y-4">
      {/* The three bounded ratios, as gauges. A gauge is the right form only
          because these genuinely have a fixed 0..100% range — a gauge around an
          unbounded quantity invents a maximum. */}
      <div className="grid grid-cols-3 gap-2">
        <Gauge figure={kpis?.performance_ratio} label="Performance ratio" />
        <Gauge figure={kpis?.cuf} label="CUF" />
        <Gauge figure={kpis?.availability} label="Availability" />
      </div>

      <div>
        <FigureRow
          label={`Energy (${period})`}
          figure={{ value: kpis?.energy_kwh ?? null, variant: null, undefined_reason: null }}
          kind="quantity"
          unit="kWh"
          note="From hourly aggregates — Reports and KPIs never query raw Readings."
        />
        <FigureRow label="Performance ratio" figure={kpis?.performance_ratio} kind="ratio" />
        <FigureRow label="CUF" figure={kpis?.cuf} kind="ratio" />
        <FigureRow
          label="Availability"
          figure={kpis?.availability}
          kind="ratio"
          note="Derived from Device communication status. A Collector failure is communication loss, not generation downtime."
        />
        <FigureRow
          label="CO₂ avoided"
          figure={kpis?.co2_avoided_kg}
          kind="quantity"
          unit="kg"
          note="Uses the Region's grid emission factor. Null means no factor is recorded, never zero."
        />
      </div>

      <div className="rounded-control border border-line bg-surface-sunken p-2.5">
        <CoverageBar coverage={kpis?.coverage} />
      </div>

      {kpis?.source_tier ? (
        <p
          className="text-[10px] leading-snug text-ink-faint"
          title="Every aggregate tier runs with real-time aggregation on, so a coarser tier costs resolution, not freshness."
        >
          Computed from <code>{kpis.source_tier}</code>.
        </p>
      ) : null}

      {kpis?.assumptions_note ? (
        <p className="text-[10px] leading-snug text-ink-faint">{kpis.assumptions_note}</p>
      ) : null}
    </div>
  );
}
