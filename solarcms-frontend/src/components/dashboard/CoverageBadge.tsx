/**
 * How much of the period a KPI actually saw.
 *
 * ── Why this is not optional chrome ─────────────────────────────────────────
 * Guardrail 18. A gap in the data does not make a figure look wrong — it makes
 * it look *low*, which is worse, because low is plausible. An average over
 * fewer samples is still an average. A total over a hole is simply smaller. For
 * availability a gap reads as nothing having happened, which is the one
 * interpretation that is certainly false. Nothing else on the response reveals
 * any of this, so a KPI shown without its coverage is a figure presented as
 * complete when nobody checked.
 *
 * It never corrects the figure. Scaling a total up by `1 / ratio` would be
 * inventing the missing data, and the inventing would be invisible.
 *
 * ── Why a threshold at all, and why this one ────────────────────────────────
 * Below 98% something was missing; at or above it the loss is a sample or two
 * at a boundary and saying so every time would train people to ignore the
 * badge. The rendering is deliberately quiet at "complete" and loud below 80%,
 * where the figure stops being an approximation and starts being a different
 * number.
 */

import type { KpiCoverage } from "@/api/schemas";
import { Badge } from "@/components/ui";

function duration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86400).toFixed(1)} days`;
}

export function CoverageBadge({
  coverage,
  className = "",
}: {
  coverage: KpiCoverage | null | undefined;
  className?: string;
}): JSX.Element {
  if (!coverage) {
    return (
      <Badge
        tone="neutral"
        title="This response carried no coverage block, so how much of the period these figures saw is unknown. Treat them as unverified."
      >
        coverage unknown
      </Badge>
    );
  }

  // Nothing was expected, so there is no ratio to take — a Plant with no
  // Devices, or a period before it was commissioned. Saying "0% coverage"
  // would report a Plant that was never due to send anything as one that has
  // gone dark.
  if (coverage.ratio === null || coverage.expected_samples === 0) {
    return (
      <span className={className}>
        <Badge
          tone="neutral"
          title="No readings were expected in this period — this Plant has no Devices bound, or was not yet commissioned. Nothing is missing; there was nothing due."
        >
          nothing expected
        </Badge>
      </span>
    );
  }

  const percent = Math.max(0, Math.min(1, coverage.ratio)) * 100;
  const tone = coverage.complete || percent >= 98 ? "ok" : percent >= 80 ? "warn" : "bad";

  const detail =
    `${coverage.received_samples.toLocaleString()} of ${coverage.expected_samples.toLocaleString()} ` +
    `expected samples. ` +
    (coverage.missing_seconds > 0 ? `About ${duration(coverage.missing_seconds)} of the period is missing. ` : "") +
    (coverage.excluded_seconds > 0
      ? `${duration(coverage.excluded_seconds)} excluded as planned maintenance, which does not count against the figure. `
      : "") +
    "The figures are not corrected for the gap — correcting them would be inventing data.";

  return (
    <span className={className}>
      <Badge tone={tone} title={detail}>
        {percent >= 99.5 ? "full coverage" : `${percent.toFixed(percent < 10 ? 1 : 0)}% coverage`}
      </Badge>
    </span>
  );
}

/**
 * The same fact as a bar, for the detail panel where there is room to show the
 * shortfall rather than only name it.
 */
export function CoverageBar({ coverage }: { coverage: KpiCoverage | null | undefined }): JSX.Element {
  if (!coverage) {
    return (
      <p className="text-[11px] leading-snug text-ink-faint">
        No coverage was reported for this period, so how much of it these figures saw is
        unknown.
      </p>
    );
  }
  if (coverage.ratio === null || coverage.expected_samples === 0) {
    return (
      <p className="text-[11px] leading-snug text-ink-faint">
        No readings were expected in this period — this Plant has no Devices bound, or was
        not yet commissioned. Nothing is missing; there was nothing due.
      </p>
    );
  }
  const percent = Math.max(0, Math.min(1, coverage.ratio)) * 100;
  const tone = coverage.complete || percent >= 98 ? "bg-ok" : percent >= 80 ? "bg-warn" : "bg-bad";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-ink-muted">Period coverage</span>
        <span className="font-mono tabular-nums text-ink">{percent.toFixed(1)}%</span>
      </div>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
        role="img"
        aria-label={`${percent.toFixed(1)} percent of the period has data`}
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
        {coverage.received_samples.toLocaleString()} of{" "}
        {coverage.expected_samples.toLocaleString()} expected samples
        {coverage.missing_seconds > 0 ? `, about ${duration(coverage.missing_seconds)} missing` : ""}
        {coverage.excluded_seconds > 0
          ? `, ${duration(coverage.excluded_seconds)} excluded as planned maintenance`
          : ""}
        . Figures are never corrected for a gap — that would be inventing data.
      </p>
    </div>
  );
}
