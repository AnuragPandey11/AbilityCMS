/**
 * Period performance: PR, CUF, Availability, CO₂ — and what they are worth.
 *
 * Three parts. `PerformanceTiles` puts PR and CUF as dials, each marked with
 * the previous period to the same point, and Availability as a figure over a
 * meter, in the headline strip beside Current Power — the part read at a
 * glance, so it costs no click.
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

import type { ReactNode } from "react";
import type { Irradiation, KpiFigure, KpiPeriod, PlantKpis, PrBasis } from "@/api/schemas";
import { RatioDial, type DialComparison } from "@/components/charts/RatioDial";
import { RatioMeter } from "@/components/charts/RatioMeter";
import { RailTile } from "@/components/charts/RailTile";
import { CoverageBadge, CoverageBar } from "@/components/dashboard/CoverageBadge";
import { ErrorState, Skeleton } from "@/components/state";
import {
  IconAvailability,
  IconChevronRight,
  IconGauge,
  IconUtilisation,
} from "@/components/icons";
import {
  UNDEFINED_DISPLAY,
  formatNumber,
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
  variantWords,
} from "@/format/value";
import { formatDate, formatDateTime } from "@/format/datetime";
import { combineNotes, prBasisNote, spanWords, stationSourceWords, sunlightNote } from "@/format/sunlight";

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

/** A tile's height while its figures load, so the strip does not move when they land. */
const TILE_MIN_HEIGHT = 210;

const PERIOD_LABEL: Record<KpiPeriod, string> = {
  today: "Today",
  month: "This month",
  year: "This year",
  lifetime: "Lifetime",
};

/**
 * What the dials compare against, in words. Lifetime has no previous period,
 * so it has no entry and its dials carry no comparison.
 */
const COMPARISON_LABEL: Partial<Record<KpiPeriod, string>> = {
  today: "Yesterday, same time",
  month: "Last month, same date",
  year: "Last year, same date",
};

/** The footnote: the period, then what the figure is measured against. */
function footnote(
  figure: KpiFigure,
  period: KpiPeriod,
  measuredLater: boolean,
): ReactNode {
  const words = variantWords(figure.variant, period, measuredLater);
  return (
    <span title={figure.variant ? variantNote(figure.variant) : undefined}>
      {/* The weight is the tile's (bold in the headline strip); the period
          stands out by its shade alone, so it is never lighter than the rest. */}
      <span className="text-ink-muted">{PERIOD_LABEL[period]}</span>
      {words ? ` · ${words}` : ""}
    </span>
  );
}

/**
 * PR's footnote, and — only when PR left part of the period out, or the
 * sunlight was not simply each station's own daily total — one more line
 * saying so. A PR from the morning alone, or divided by live GHI we added up,
 * or by one station because the other read nothing, is a different claim from
 * the one the dial normally makes.
 */
function prFootnote(
  kpis: PlantKpis,
  period: KpiPeriod,
  measuredLater: boolean,
  timeZone: string | undefined,
): ReactNode {
  const note = combineNotes(
    prBasisNote(kpis.pr_basis, timeZone),
    sunlightNote(kpis.irradiation_kwh_m2),
  );
  if (!note) return footnote(kpis.performance_ratio, period, measuredLater);
  return (
    <>
      {footnote(kpis.performance_ratio, period, measuredLater)}
      <span
        className={`mt-0.5 block truncate ${note.warn ? "text-warn" : "text-ink-faint"}`}
        title={note.title}
      >
        {note.text}
      </span>
    </>
  );
}

/**
 * The drawer's account of PR's denominator: the Plant's sunlight and each
 * station's part in it — its own total, its live GHI added up, or left out.
 */
function SunlightDetail({ irradiation }: { irradiation: Irradiation | null | undefined }): JSX.Element | null {
  if (!irradiation || irradiation.stations.length === 0) return null;
  const note = sunlightNote(irradiation);
  return (
    <div className="space-y-1 border-b border-line-soft py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink">Sunlight (GHI)</span>
        <span className="shrink-0 font-mono text-sm tabular-nums text-ink">
          {irradiation.value === null ? UNDEFINED_DISPLAY : formatNumber(irradiation.value, { digits: 2 })}
          <span className="ml-0.5 text-[10px] text-ink-muted">kWh/m²</span>
        </span>
      </div>
      <ul className="space-y-0.5">
        {irradiation.stations.map((station) => (
          <li
            key={station.device_id}
            className={`flex items-baseline justify-between gap-3 text-[10px] leading-snug ${
              station.excluded_reason !== null ? "text-warn" : "text-ink-faint"
            }`}
            title={station.excluded_reason ?? undefined}
          >
            <span className="min-w-0 truncate">
              <span className="font-mono">{station.device_code}</span> · {stationSourceWords(station)}
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              {station.kwh_m2 === null ? UNDEFINED_DISPLAY : formatNumber(station.kwh_m2, { digits: 2 })}
            </span>
          </li>
        ))}
      </ul>
      {note ? (
        <p className={`text-[10px] leading-snug ${note.warn ? "text-warn" : "text-ink-faint"}`}>
          {note.title}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The drawer's account of what PR stands on, when it is not the whole period:
 * how much of the energy, the stretches left out, and any station set aside.
 */
function PrBasisDetail({
  basis,
  timeZone,
}: {
  basis: PrBasis | null | undefined;
  timeZone?: string;
}): JSX.Element | null {
  const note = prBasisNote(basis, timeZone);
  if (!basis || !note) return null;
  const share = basis.energy_share;
  return (
    <div className="space-y-1 border-b border-line-soft py-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-ink">PR worked out from</span>
        <span className="shrink-0 text-sm tabular-nums text-warn">
          {share === null ? UNDEFINED_DISPLAY : `${Math.round(share * 100)}% of the energy`}
        </span>
      </div>
      <ul className="space-y-0.5">
        {basis.left_out.map((run) => (
          <li
            key={`${run.from}-${run.reason}`}
            className="flex items-baseline justify-between gap-3 text-[10px] leading-snug text-ink-faint"
          >
            <span className="min-w-0 truncate">
              {spanWords(run.from, run.to, timeZone)} · {run.words}
            </span>
            {run.energy_kwh > 0 ? (
              <span className="shrink-0 font-mono tabular-nums">
                {formatNumber(run.energy_kwh, { digits: 0 })} kWh
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[10px] leading-snug text-warn">{note.title}</p>
    </div>
  );
}

/**
 * The comparison one dial draws: the previous period's figure to the same
 * point, or — where the period has one but the Plant cannot answer it — an
 * empty comparison that says so, rather than a line that vanishes and leaves
 * the reader wondering whether the feature exists.
 */
function comparisonFor(
  kpis: PlantKpis,
  key: "performance_ratio" | "cuf",
  period: KpiPeriod,
  timeZone: string | undefined,
): DialComparison | null {
  const label = COMPARISON_LABEL[period];
  if (!label) return null;
  const previous = kpis.previous;
  if (!previous) {
    return {
      label,
      figure: {
        value: null,
        variant: null,
        undefined_reason: "the Plant had not reported by then, so there is nothing to compare with",
      },
      coverage: null,
    };
  }
  // A previous PR from part of its period says so, as today's does.
  const share = key === "performance_ratio" ? previous.pr_basis?.energy_share ?? null : null;
  return {
    label,
    figure: previous[key],
    coverage: previous.coverage,
    span: `${formatDateTime(previous.period_start, timeZone)} to ${formatDateTime(previous.period_end, timeZone)}`,
    basis:
      share !== null && (previous.pr_basis?.left_out.length ?? 0) > 0
        ? `from ${Math.round(share * 100)}% of the energy`
        : null,
  };
}

/**
 * The on-page half: PR and CUF as dials marked with the previous period, and
 * Availability as a figure over a meter, as three tiles of the headline strip.
 * A fragment, so the strip's grid places them.
 *
 * Dial or meter, each is the right form only because these genuinely have a
 * fixed 0..100% range — a scale around an unbounded quantity invents a maximum.
 * Availability takes the meter (the user's choice, 29 Sep 2026) because it
 * lives in the top few percent, where a nearly full ring cannot show a change.
 */
export function PerformanceTiles({
  kpis,
  period,
  isLoading,
  error,
  retry,
  timeZone,
}: {
  kpis: PlantKpis | undefined;
  period: KpiPeriod;
  isLoading: boolean;
  error: unknown;
  retry: () => void;
  /** The Plant's zone, for when the comparison window ran. */
  timeZone?: string;
}): JSX.Element {
  if (isLoading) {
    // Tiles at their final height, so the strip does not move when data lands.
    return (
      <>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="rounded-card" style={{ minHeight: TILE_MIN_HEIGHT }} />
        ))}
      </>
    );
  }
  if (!kpis) {
    // Never three "not defined" figures: that would state a fact about the
    // period when the truth is that the request failed.
    return (
      <div className="sm:col-span-2 xl:col-span-3">
        <ErrorState error={error} retry={retry} />
      </div>
    );
  }
  // A Plant younger than the period counts CUF's hours from its first reading.
  const measuredLater =
    !!kpis.measured_since &&
    !!kpis.period_start &&
    Date.parse(kpis.measured_since) > Date.parse(kpis.period_start);
  return (
    <>
      <RailTile
        dense
        icon={IconGauge}
        label="Performance Ratio"
        visual={
          <RatioDial
            figure={kpis.performance_ratio}
            label="Performance Ratio"
            comparison={comparisonFor(kpis, "performance_ratio", period, timeZone)}
          />
        }
        footnote={prFootnote(kpis, period, measuredLater, timeZone)}
      />
      <RailTile
        dense
        icon={IconUtilisation}
        label="CUF"
        visual={
          <RatioDial
            figure={kpis.cuf}
            label="CUF"
            // A PV Plant's CUF physically tops out near 25–30%, so 80/60 bands
            // would draw every healthy Plant red.
            banded={false}
            comparison={comparisonFor(kpis, "cuf", period, timeZone)}
          />
        }
        footnote={footnote(kpis.cuf, period, measuredLater)}
      />
      <RailTile
        dense
        icon={IconAvailability}
        label="Availability"
        visual={<RatioMeter figure={kpis.availability} label="Availability" />}
        footnote={footnote(kpis.availability, period, measuredLater)}
      />
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
    <div className="space-y-1.5">
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
        className="flex w-full items-center justify-between gap-1 rounded-control border border-line px-2.5 py-1 text-xs font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
      >
        Performance details
        <IconChevronRight size={12} />
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
  timeZone,
}: {
  kpis: PlantKpis | undefined;
  period: string;
  /** The Plant's zone, for the stretches PR left out. */
  timeZone?: string;
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
        <PrBasisDetail basis={kpis?.pr_basis} timeZone={timeZone} />
        <SunlightDetail irradiation={kpis?.irradiation_kwh_m2} />
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

      {kpis?.computed_at ? (
        <p
          className="text-[10px] leading-snug text-ink-faint"
          title="The server works these figures out once a minute and every screen reads that copy, so they cost the same however many people are watching."
        >
          Worked out at {formatDateTime(kpis.computed_at)}; refreshed once a minute.
        </p>
      ) : null}

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
