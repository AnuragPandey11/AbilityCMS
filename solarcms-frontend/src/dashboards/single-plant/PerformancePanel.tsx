/**
 * Period performance: PR, CUF, Availability, CO₂ — and what they are worth.
 *
 * Two halves. `PerformanceBand` sits on the page under the headline strip and
 * carries the three gauges, the period's coverage and CO₂ avoided — the part
 * that is read at a glance, so it costs no click. `PerformancePanel` is the
 * drawer behind it: each figure's variant spelled out, the energy the ratios
 * were computed from, the tier and the assumptions. The gauges used to live
 * only in the drawer, which hid the most visual reading of the Plant behind a
 * card that summarised it in three lines of text.
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

import type { KpiFigure, KpiPeriod, PlantKpis } from "@/api/schemas";
import { Gauge } from "@/components/charts/Gauge";
import { CoverageBar } from "@/components/dashboard/CoverageBadge";
import { Panel } from "@/components/ui";
import { ErrorState, Skeleton } from "@/components/state";
import { IconChevronRight } from "@/components/icons";
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

/** Every tile in the band is this tall, so the row reads as one strip. */
const BAND_TILE_HEIGHT = 168;

/**
 * The on-page half: three gauges and what qualifies them, in one row.
 *
 * Its own panel, titled with the period and the OPEN-16 caveat, rather than
 * more tiles in the headline strip above it — see the module note. It sits
 * directly under that strip because both answer "how is the Plant doing"
 * before the schematic and charts answer "why", and because the Period
 * control that scopes it is in the header just above.
 */
export function PerformanceBand({
  kpis,
  period,
  isLoading,
  error,
  retry,
  onOpen,
  timeZone,
}: {
  kpis: PlantKpis | undefined;
  period: KpiPeriod;
  /** The Plant's zone, for the date the period began. */
  timeZone?: string;
  isLoading: boolean;
  error: unknown;
  retry: () => void;
  /** Opens the drawer with every figure's variant, the energy and the tier. */
  onOpen: () => void;
}): JSX.Element {
  let body: JSX.Element;
  if (isLoading) {
    // Tiles at their final height, so the page does not move when data lands.
    body = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="rounded-lg" style={{ height: BAND_TILE_HEIGHT }} />
        ))}
      </div>
    );
  } else if (!kpis) {
    // Never three "not defined" gauges: that would state a fact about the
    // period when the truth is that the request failed.
    body = <ErrorState error={error} retry={retry} />;
  } else {
    body = (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {/* The three bounded ratios, as gauges. A gauge is the right form only
            because these genuinely have a fixed 0..100% range — a gauge around
            an unbounded quantity invents a maximum. */}
        <Gauge figure={kpis.performance_ratio} label="Performance ratio" height={BAND_TILE_HEIGHT} />
        <Gauge figure={kpis.cuf} label="CUF" height={BAND_TILE_HEIGHT} banded={false} />
        <Gauge figure={kpis.availability} label="Availability" height={BAND_TILE_HEIGHT} />

        {/* Coverage beside the gauges, not under a click (Guardrail 18): a
            ratio over a period with a hole in it is low, plausible and wrong,
            and nothing on the gauge itself says so. */}
        <div
          className="flex flex-col justify-between rounded-lg border border-line bg-surface-raised p-4 md:col-span-3 xl:col-span-1"
          style={{ minHeight: BAND_TILE_HEIGHT }}
        >
          <CoverageBar coverage={kpis.coverage} compact />
          <div
            className="mt-3 flex items-baseline justify-between gap-3 border-t border-line pt-3"
            title={
              kpis.co2_avoided_kg.value === null
                ? (kpis.co2_avoided_kg.undefined_reason ??
                  "No grid emission factor is recorded for this Region.")
                : "Uses the Region's grid emission factor."
            }
          >
            <span className="text-sm text-ink-muted">CO₂ avoided</span>
            {kpis.co2_avoided_kg.value === null ? (
              <span className="figure text-base text-ink-faint">{UNDEFINED_DISPLAY}</span>
            ) : (
              <span className="figure text-base font-semibold text-ink">
                {formatNumber(kpis.co2_avoided_kg.value)}
                <span className="ml-1 text-xs font-normal text-ink-muted">kg</span>
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <Panel
      title={
        <span className="text-lg">
          Performance <span className="font-normal capitalize text-ink-muted">— {period}</span>
        </span>
      }
      subtitle={
        <span className="text-sm">
          Computed {periodSince(kpis, period, timeZone) ?? "over the selected period"}, in the
          Plant's time, from aggregates. Every formula is provisional pending OPEN-16.
        </span>
      }
      actions={
        <button
          type="button"
          onClick={onOpen}
          className="flex items-center gap-1 rounded-control border border-line px-3 py-1.5 text-sm font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
        >
          Details
          <IconChevronRight size={14} />
        </button>
      }
    >
      {body}
    </Panel>
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
