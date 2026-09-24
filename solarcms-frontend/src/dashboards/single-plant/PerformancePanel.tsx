/**
 * Period performance: PR, CUF, Availability, CO₂ — and what they are worth.
 *
 * Three parts. `PerformanceTiles` puts the three gauges in the headline strip,
 * beside Current Power — the part read at a glance, so it costs no click.
 * `PerformanceDetailsButton` is the way into the drawer, carrying the period's
 * coverage so it stays in the same row as the figures it qualifies.
 * `PerformancePanel` is the drawer: each figure's variant spelled out, the
 * energy the ratios were computed from, the coverage in full, the tier and the
 * assumptions.
 *
 * ⚠ They share a row with a live figure, so every tile says its period. Current
 * Power is *now*, read from the equipment this second; these are computed over
 * the chosen Period from aggregates, and every one is provisional pending the
 * client's own definitions (OPEN-16). The period on each footnote is what stops
 * a measured figure and a derived one being read as the same kind of number
 * because they sit at the same size.
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

import type { ComponentType } from "react";
import type { KpiFigure, KpiPeriod, PlantKpis } from "@/api/schemas";
import { Gauge } from "@/components/charts/Gauge";
import { RailTile } from "@/components/charts/RailTile";
import { CoverageBadge, CoverageBar } from "@/components/dashboard/CoverageBadge";
import { ErrorState, Skeleton } from "@/components/state";
import {
  IconAvailability,
  IconChevronRight,
  IconGauge,
  type IconProps,
} from "@/components/icons";
import {
  UNDEFINED_DISPLAY,
  formatNumber,
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
} from "@/format/value";
import { formatDate } from "@/format/datetime";

/**
 * Where the figures begin, in the Plant's own calendar — so "month" reads as
 * "since the 1st" rather than leaving the reader to guess between that and the
 * last thirty days. A Plant younger than the period says when it was first
 * heard, because that, not the 1st, is where CUF's hours are counted from.
 */
export function periodSince(
  kpis: PlantKpis | undefined,
  period: string,
  timeZone?: string,
): string | null {
  const start = kpis?.period_start;
  if (!start) return null;
  if (period === "lifetime") return `since the first reading, ${formatDate(start, timeZone)}`;
  const since = period === "today" ? "since midnight" : `since ${formatDate(start, timeZone)}`;
  const first = kpis?.measured_since;
  return first && Date.parse(first) > Date.parse(start)
    ? `${since} (first reading ${formatDate(first, timeZone)})`
    : since;
}

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

/** The height of a gauge inside its tile, matched to the Current Power dial. */
const GAUGE_HEIGHT = 150;

const PERIOD_LABEL: Record<KpiPeriod, string> = {
  today: "Today",
  month: "This month",
  year: "This year",
  lifetime: "Lifetime",
};

function RatioTile({
  figure,
  label,
  icon,
  period,
  banded = true,
}: {
  figure: KpiFigure;
  label: string;
  icon: ComponentType<IconProps>;
  period: KpiPeriod;
  banded?: boolean;
}): JSX.Element {
  return (
    <RailTile
      icon={icon}
      label={label}
      visual={<Gauge figure={figure} label={label} height={GAUGE_HEIGHT} banded={banded} bare />}
      footnote={
        <span title={figure.variant ? variantNote(figure.variant) : undefined}>
          {PERIOD_LABEL[period]}
          {figure.variant ? ` · ${figure.variant.replace(/_/g, " ")}` : ""}
        </span>
      }
    />
  );
}

/**
 * The on-page half: three gauges, as three tiles of the headline strip. A
 * fragment, so the strip's grid places them.
 *
 * A gauge is the right form only because these genuinely have a fixed 0..100%
 * range — a gauge around an unbounded quantity invents a maximum.
 */
export function PerformanceTiles({
  kpis,
  period,
  isLoading,
  error,
  retry,
}: {
  kpis: PlantKpis | undefined;
  period: KpiPeriod;
  isLoading: boolean;
  error: unknown;
  retry: () => void;
}): JSX.Element {
  if (isLoading) {
    // Tiles at their final height, so the strip does not move when data lands.
    return (
      <>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="rounded-card" style={{ minHeight: GAUGE_HEIGHT + 120 }} />
        ))}
      </>
    );
  }
  if (!kpis) {
    // Never three "not defined" gauges: that would state a fact about the
    // period when the truth is that the request failed.
    return (
      <div className="sm:col-span-2 xl:col-span-3">
        <ErrorState error={error} retry={retry} />
      </div>
    );
  }
  return (
    <>
      <RatioTile figure={kpis.performance_ratio} label="Performance Ratio" icon={IconGauge} period={period} />
      <RatioTile figure={kpis.cuf} label="CUF" icon={IconGauge} period={period} banded={false} />
      <RatioTile figure={kpis.availability} label="Availability" icon={IconAvailability} period={period} />
    </>
  );
}

/**
 * The way into the drawer, and the gauges' coverage with it.
 *
 * ⚠ The badge is Guardrail 18, not decoration. A ratio over a period with a
 * hole in it is low, plausible and wrong, and nothing on the gauge says so;
 * this badge, in the same row as the gauges, is the one thing on the first
 * screen that does. The full sentence is on its tooltip and in the drawer.
 */
export function PerformanceDetailsButton({
  kpis,
  period,
  timeZone,
  onOpen,
}: {
  kpis: PlantKpis | undefined;
  period: KpiPeriod;
  /** The Plant's zone, for the date the period began. */
  timeZone?: string;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div className="space-y-2">
      {/* Its own line, not inside the button: in a fifth of the row the badge
          and the label do not both fit, and the label is the one people use. */}
      <div className="flex items-center justify-between gap-2 text-xs text-ink-faint">
        <span
          className="truncate"
          title="How much of the period the three gauges — PR, CUF and availability — actually saw."
        >
          Gauges
        </span>
        {kpis ? <CoverageBadge coverage={kpis.coverage} /> : null}
      </div>
      <button
        type="button"
        onClick={onOpen}
        title={
          `PR, CUF and availability computed ${periodSince(kpis, period, timeZone) ?? "over the selected period"}, ` +
          "in the Plant's time, from aggregates. Every formula is provisional pending OPEN-16."
        }
        className="flex w-full items-center justify-between gap-1 rounded-control border border-line px-3 py-1.5 text-sm font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
      >
        Performance details
        <IconChevronRight size={14} />
      </button>
    </div>
  );
}

/**
 * The drawer half. No gauges: they are on the page, and a second copy of the
 * same three rings one click away would be the repetition the dashboard's
 * layout exists to remove. What is here is what the gauges cannot say.
 */
export function PerformancePanel({
  kpis,
  period,
}: {
  kpis: PlantKpis | undefined;
  period: string;
}): JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <FigureRow
          label={`Energy (${period})`}
          figure={{ value: kpis?.energy_kwh ?? null, variant: null, undefined_reason: null }}
          kind="quantity"
          unit="kWh"
          note="From aggregates (the tier is named below) — Reports and KPIs never query raw Readings."
        />
        <FigureRow
          label="Specific yield"
          figure={kpis?.specific_yield ?? undefined}
          kind="quantity"
          unit="kWh/kWp"
          note="The period's energy over the Plant's DC capacity."
        />
        <FigureRow label="Performance ratio" figure={kpis?.performance_ratio} kind="ratio" />
        <FigureRow label="CUF" figure={kpis?.cuf} kind="ratio" />
        <FigureRow
          label="Availability"
          figure={kpis?.availability}
          kind="ratio"
          note="Time-weighted over the period from each Device's recorded communication status. A Collector failure is communication loss, not generation downtime."
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
