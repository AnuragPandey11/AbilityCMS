/**
 * A ratio as an instrument dial, for PR and CUF — with the previous period,
 * to the same point, marked on it.
 *
 * ── What replaced what ──────────────────────────────────────────────────────
 * `Gauge` drew a bare 220° ring with the figure in it: no ticks, no ends, so
 * the arc's length could not be read and it was a frame around the number
 * rather than a scale. It also painted "nothing wrong" full green, which made
 * good news the loudest thing in the row. Here (28–29 Sep 2026, chosen by the
 * user from rendered options):
 *
 * - **A scale.** Ticks every 5%, 0 and 100 at the ends, a bead at the value.
 * - **Colour only for news.** The arc is the chart colour; below 80% it turns
 *   `warn` and below 60% `bad`, and a pill says so in words, so colour is never
 *   the only signal. The thresholds sit as a thin band outside the scale,
 *   where the reader can see them before the Plant reaches them. ⚠ 80/60 are
 *   presentation, not a client-confirmed judgement (§4.3) — they came with the
 *   old gauge and are still the client's to set.
 * - **The comparison.** A tick across the arc at the previous period's figure
 *   to the same point, the change in points under the number, and the figure
 *   itself beneath with its coverage when that was incomplete (Guardrail 18: a
 *   hole in yesterday moves the delta as surely as a hole today moves the
 *   figure). Not the whole previous period — see `KpiComparisonSchema`.
 *
 * ── What it declines to draw ────────────────────────────────────────────────
 * - **Undefined:** a dashed track and a dash, no arc and no bead. The dial
 *   keeps its shape so the row does not look broken, and still cannot be read
 *   as 0% — a dial at zero is the most convincing way to render "undefined" as
 *   "failed" (§4.3).
 * - **Implausible** (Guardrail 33): the figure unaltered in `warn` over a
 *   dashed `warn` track, never clamped into an arc. A ring cannot draw 389%,
 *   and the old gauge drew it full.
 * - **A comparison against either of those:** no tick and no delta. A change
 *   measured from an impossible figure is itself impossible.
 *
 * Plain SVG, not ECharts: a dial is a handful of paths, and drawn directly it
 * sits outside the chart-lifecycle traps `useEcharts` guards against
 * (Guardrails 31–32), and themes through the same Tailwind tokens as the page.
 */

import type { KpiCoverage, KpiFigure } from "@/api/schemas";
import { IconWarning } from "@/components/icons";
import { formatRatioAsPercent, implausibleRatioReason, ratioIsImplausible } from "@/format/value";

/** Where the arc turns amber, and red. Presentation only — see the header. */
export const RATIO_WARN_BELOW = 0.8;
export const RATIO_BAD_BELOW = 0.6;

export type RatioTone = "chart" | "warn" | "bad";

/** The tone a ratio is drawn in: the chart colour unless there is news. */
export function ratioTone(value: number, banded: boolean): RatioTone {
  if (!banded) return "chart";
  if (value < RATIO_BAD_BELOW) return "bad";
  if (value < RATIO_WARN_BELOW) return "warn";
  return "chart";
}

/** The verdict in words, for the pill beside the colour. Null when there is none. */
export function ratioVerdict(tone: RatioTone): string | null {
  if (tone === "bad") return `Below ${RATIO_BAD_BELOW * 100}%`;
  if (tone === "warn") return `Below ${RATIO_WARN_BELOW * 100}%`;
  return null;
}

/** Signed change in percentage points, one decimal; "no change" under 0.05. */
export function pointsChange(value: number, previous: number): string {
  const points = (value - previous) * 100;
  if (Math.abs(points) < 0.05) return "no change";
  return `${points > 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pts`;
}

/** Coverage worth mentioning: incomplete and below the badge's 98% line. */
export function partialCoverage(coverage: KpiCoverage | null | undefined): string | null {
  if (!coverage || coverage.complete) return null;
  if (coverage.ratio === null || coverage.expected_samples === 0) return null;
  const percent = Math.max(0, Math.min(1, coverage.ratio)) * 100;
  if (percent >= 98) return null;
  return `${percent.toFixed(percent < 10 ? 1 : 0)}% coverage`;
}

// Full class names, never assembled: Tailwind emits only what appears literally.
const STROKE: Record<RatioTone, string> = {
  chart: "stroke-chart",
  warn: "stroke-warn",
  bad: "stroke-bad",
};
const GLOW: Record<RatioTone, string> = {
  chart: "dial-glow-chart",
  warn: "dial-glow-warn",
  bad: "dial-glow-bad",
};
const PILL_ICON: Record<RatioTone, string> = {
  chart: "text-chart",
  warn: "text-warn",
  bad: "text-bad",
};

// ── Geometry: degrees clockwise from twelve o'clock ─────────────────────────

/** The sweep each side of twelve o'clock: 240° in all, open at the bottom. */
const SWEEP = 120;
const CX = 100;
const CY = 84;
const R = 62;

function angle(fraction: number): number {
  return -SWEEP + 2 * SWEEP * Math.max(0, Math.min(1, fraction));
}

function point(radius: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [CX + radius * Math.sin(radians), CY - radius * Math.cos(radians)];
}

function arc(radius: number, from: number, to: number): string {
  const end = to - from < 0.01 ? from + 0.01 : to;
  const [x0, y0] = point(radius, from);
  const [x1, y1] = point(radius, end);
  const large = end - from > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${radius} ${radius} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function Radial({
  inner,
  outer,
  degrees,
  className,
  width,
  opacity,
}: {
  inner: number;
  outer: number;
  degrees: number;
  className: string;
  width: number;
  opacity?: number;
}): JSX.Element {
  const [x1, y1] = point(inner, degrees);
  const [x2, y2] = point(outer, degrees);
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      className={className}
      strokeWidth={width}
      strokeOpacity={opacity}
      strokeLinecap="round"
    />
  );
}

/** The figure with its unit set smaller, centred at `y`. */
function Figure({ text, y, className }: { text: string; y: number; className: string }): JSX.Element {
  const number = text.endsWith("%") ? text.slice(0, -1) : text;
  return (
    <text x={CX} y={y} textAnchor="middle" className={`figure ${className}`}>
      <tspan fontSize={27} fontWeight={600}>
        {number}
      </tspan>
      {text.endsWith("%") ? (
        <tspan fontSize={13.5} fontWeight={500} dx={1.5} className="fill-ink-muted">
          %
        </tspan>
      ) : null}
    </text>
  );
}

function ScaleEnds(): JSX.Element {
  const [lx, ly] = point(R, -SWEEP);
  const [rx, ry] = point(R, SWEEP);
  return (
    <>
      <text x={lx} y={ly + 18} textAnchor="middle" fontSize={9.5} className="figure fill-ink-faint">
        0
      </text>
      <text x={rx} y={ry + 18} textAnchor="middle" fontSize={9.5} className="figure fill-ink-faint">
        100
      </text>
    </>
  );
}

export interface DialComparison {
  /** What it is, in words — "Yesterday, same time". */
  label: string;
  figure: KpiFigure | null | undefined;
  coverage: KpiCoverage | null | undefined;
  /** The window it covers, in the Plant's time, for the tooltip. */
  span?: string;
}

export function RatioDial({
  figure,
  label,
  banded = true,
  comparison,
}: {
  figure: KpiFigure | null | undefined;
  label: string;
  /** Band at 80/60. Off for CUF, whose healthy range never reaches either. */
  banded?: boolean;
  comparison?: DialComparison | null;
}): JSX.Element {
  const value = figure?.value ?? null;
  const implausible = ratioIsImplausible(value);
  const previous = comparison?.figure?.value ?? null;
  const previousImplausible = ratioIsImplausible(previous);
  const compared =
    value !== null && !implausible && previous !== null && !previousImplausible ? previous : null;
  const tone = value !== null && !implausible ? ratioTone(value, banded) : "chart";
  const verdict = value !== null && !implausible ? ratioVerdict(tone) : null;

  const aria =
    `${label} ${value === null ? "not defined" : formatRatioAsPercent(value)}` +
    (compared !== null && comparison
      ? `; ${comparison.label} ${formatRatioAsPercent(compared)}`
      : "");

  return (
    <div className="flex w-full flex-col items-center gap-1">
      <svg
        viewBox="0 0 200 138"
        className="block w-full max-w-[220px] overflow-visible"
        role="img"
        aria-label={aria}
      >
        {value === null || implausible ? (
          <>
            <path
              d={arc(R, -SWEEP, SWEEP)}
              fill="none"
              className={implausible ? "stroke-warn" : "stroke-line-strong"}
              strokeOpacity={implausible ? 0.8 : 1}
              strokeWidth={2}
              strokeDasharray="2 5"
              strokeLinecap="round"
            />
            {value === null ? (
              <text x={CX} y={CY + 10} textAnchor="middle" fontSize={30} className="figure fill-ink-faint">
                —
              </text>
            ) : (
              <Figure text={formatRatioAsPercent(value)} y={CY + 9} className="fill-warn" />
            )}
          </>
        ) : (
          <>
            {banded ? (
              <g fill="none" strokeWidth={3}>
                <path d={arc(R + 10, -SWEEP, angle(RATIO_BAD_BELOW) - 1)} className="stroke-bad" strokeOpacity={0.55} />
                <path
                  d={arc(R + 10, angle(RATIO_BAD_BELOW) + 1, angle(RATIO_WARN_BELOW) - 1)}
                  className="stroke-warn"
                  strokeOpacity={0.6}
                />
                <path d={arc(R + 10, angle(RATIO_WARN_BELOW) + 1, SWEEP)} className="stroke-line-strong" strokeOpacity={0.7} />
              </g>
            ) : null}
            {Array.from({ length: 21 }, (_, index) => {
              const major = index % 5 === 0;
              return (
                <Radial
                  key={index}
                  inner={R - 8}
                  outer={major ? R - 15 : R - 11.5}
                  degrees={angle(index / 20)}
                  className="stroke-ink-faint"
                  width={major ? 1.4 : 1}
                  opacity={major ? 0.9 : 0.45}
                />
              );
            })}
            <path
              d={arc(R, -SWEEP, SWEEP)}
              fill="none"
              className="stroke-line"
              strokeOpacity={0.8}
              strokeWidth={8}
              strokeLinecap="round"
            />
            {value > 0 ? (
              <path
                d={arc(R, -SWEEP, angle(value))}
                fill="none"
                className={`${STROKE[tone]} ${GLOW[tone]}`}
                strokeWidth={8}
                strokeLinecap="round"
              />
            ) : null}
            {compared !== null ? (
              <g>
                <title>{`${comparison?.label ?? "Previous"}: ${formatRatioAsPercent(compared)}`}</title>
                <Radial inner={R - 7} outer={R + 13} degrees={angle(compared)} className="stroke-surface-raised" width={5.5} />
                <Radial inner={R - 7} outer={R + 13} degrees={angle(compared)} className="stroke-ink" width={2.2} />
              </g>
            ) : null}
            <circle
              cx={point(R, angle(value))[0]}
              cy={point(R, angle(value))[1]}
              r={5}
              strokeWidth={2.6}
              className={`fill-surface-raised ${STROKE[tone]}`}
            />
            <ScaleEnds />
            <Figure text={formatRatioAsPercent(value)} y={CY + 9} className="fill-ink" />
            {compared !== null ? (
              <text x={CX} y={CY + 29} textAnchor="middle" fontSize={11} fontWeight={500} className="figure fill-ink-muted">
                {pointsChange(value, compared)}
              </text>
            ) : null}
          </>
        )}
      </svg>

      {/* Held open when empty, so every tile's footnote sits on one line.
          14px and bold, white in dark mode (`.tile-note`), like the tile's own
          footnote; the amber warning below keeps its colour. */}
      <div className="tile-note flex min-h-5 flex-col items-center text-center text-sm font-semibold leading-snug text-ink-faint">
        {value === null ? (
          <span>{sentence(figure?.undefined_reason) ?? "Not defined for this period."}</span>
        ) : implausible ? (
          <span className="text-warn" title={implausibleRatioReason(value, label)}>
            Outside 0–100%. The inputs cover different spans; check coverage.
          </span>
        ) : verdict ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-[11px] font-semibold text-ink ring-1 ring-inset ring-line">
            <span className={PILL_ICON[tone]}>
              <IconWarning size={11} />
            </span>
            {verdict}
          </span>
        ) : null}
      </div>

      {comparison ? <ComparisonLine comparison={comparison} label={label} /> : null}
    </div>
  );
}

function ComparisonLine({ comparison, label }: { comparison: DialComparison; label: string }): JSX.Element {
  const value = comparison.figure?.value ?? null;
  const implausible = ratioIsImplausible(value);
  const partial = partialCoverage(comparison.coverage);
  const title =
    value === null
      ? `${comparison.label}: not defined${comparison.figure?.undefined_reason ? ` (${comparison.figure.undefined_reason})` : ""}.`
      : implausible
        ? implausibleRatioReason(value, `${label} for the comparison period`)
        : `${label} ${comparison.label.toLowerCase()}${comparison.span ? `, ${comparison.span}` : ""}: ` +
          `${formatRatioAsPercent(value)}. The same formula over the same share of the period, so the two can be compared.` +
          (partial ? ` Only ${partial} over that span, so the comparison is only as good as that.` : "");
  return (
    <div className="tile-note flex flex-col items-center text-sm font-semibold leading-snug text-ink-muted" title={title}>
      <span className="inline-flex flex-wrap items-center justify-center gap-x-1.5">
        <svg width="6" height="14" viewBox="0 0 6 14" aria-hidden="true">
          <line x1="3" y1="1.5" x2="3" y2="12.5" className="stroke-ink" strokeWidth={2.2} strokeLinecap="round" />
        </svg>
        <span>{comparison.label}</span>
        <span className={`figure font-semibold ${implausible ? "text-warn" : value === null ? "text-ink-faint" : "text-ink"}`}>
          {formatRatioAsPercent(value)}
        </span>
      </span>
      {/* Its own line: in a fifth of the row it wraps anyway, and a line that
          opens on a separator reads as a fragment. */}
      {partial ? <span className="text-ink-faint">at {partial}</span> : null}
    </div>
  );
}

/** A backend reason as a sentence: capitalised and stopped. */
function sentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
