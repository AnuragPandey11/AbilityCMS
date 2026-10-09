/**
 * A ratio as a figure over a straight meter — for Availability.
 *
 * Chosen by the user (29 Sep 2026) over the dial for this one figure, from
 * rendered options. A length along a line is read more accurately than an
 * angle round an arc, and Availability lives in the top few percent, where a
 * nearly full ring said nothing: 97% and 99.9% drew the same shape. The number
 * leads; the meter places it.
 *
 * The same rules as `RatioDial`, which it sits beside:
 *
 * - The fill is the chart colour, turning `warn` below 80% and `bad` below 60%
 *   with a pill that says so, and the thresholds are a strip under the meter.
 *   ⚠ Shared with PR, and presentation only: for Availability 87% is a poor
 *   day that still reads as fine, and the client has not said where their
 *   lines are.
 * - Undefined is a dash over a dashed outline, never an empty meter.
 * - Implausible (Guardrail 33) is the figure unaltered in `warn` over a dashed
 *   `warn` outline — never a full bar.
 */

import type { KpiFigure } from "@/api/schemas";
import { IconWarning } from "@/components/icons";
import { formatRatioAsPercent, implausibleRatioReason, ratioIsImplausible } from "@/format/value";
import {
  RATIO_BAD_BELOW,
  RATIO_WARN_BELOW,
  ratioTone,
  ratioVerdict,
  type RatioTone,
} from "./RatioDial";

const FILL: Record<RatioTone, string> = {
  chart: "fill-chart",
  warn: "fill-warn",
  bad: "fill-bad",
};
const PILL_ICON: Record<RatioTone, string> = {
  chart: "text-chart",
  warn: "text-warn",
  bad: "text-bad",
};

const W = 200;

export function RatioMeter({
  figure,
  label,
  banded = true,
}: {
  figure: KpiFigure | null | undefined;
  label: string;
  banded?: boolean;
}): JSX.Element {
  const value = figure?.value ?? null;
  const implausible = ratioIsImplausible(value);
  const drawn = value !== null && !implausible;
  const tone = drawn ? ratioTone(value, banded) : "chart";
  const verdict = drawn ? ratioVerdict(tone) : null;
  const width = drawn ? W * Math.max(0, Math.min(1, value)) : 0;
  const text = formatRatioAsPercent(value);

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2">
        <span
          className={`figure text-[2.1rem] font-semibold leading-none tracking-tight ${
            value === null ? "text-ink-faint" : implausible ? "text-warn" : "text-ink"
          }`}
          title={implausible && value !== null ? implausibleRatioReason(value, label) : undefined}
        >
          {text.endsWith("%") ? text.slice(0, -1) : text}
          {text.endsWith("%") ? (
            <span className="ml-0.5 text-[1.05rem] font-medium tracking-normal text-ink-muted">%</span>
          ) : null}
        </span>
        {verdict ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold border ${
              tone === "bad"
                ? "border-rose-200 bg-rose-100 text-rose-800 dark:border-bad/40 dark:bg-bad/10 dark:text-bad"
                : tone === "warn"
                  ? "border-amber-300 bg-amber-100 text-amber-900 dark:border-warn/40 dark:bg-warn/10 dark:text-warn"
                  : "border-slate-200 bg-slate-100 text-slate-700 dark:border-line dark:bg-surface-sunken dark:text-ink"
            }`}
          >
            <span className={PILL_ICON[tone]}>
              <IconWarning size={11} />
            </span>
            {verdict}
          </span>
        ) : null}
      </div>

      <svg
        viewBox="0 0 200 38"
        className="block w-full overflow-visible"
        role="img"
        aria-label={`${label} ${value === null ? "not defined" : text}`}
      >
        {drawn ? (
          <>
            <rect x={0} y={7} width={W} height={10} rx={5} className="fill-line" fillOpacity={0.8} />
            {width > 0 ? (
              <rect
                x={0}
                y={7}
                width={Math.max(width, 1.5)}
                height={10}
                rx={Math.min(5, Math.max(width, 1.5) / 2)}
                className={FILL[tone]}
              />
            ) : null}
            {/* Quarter notches, cut in the card's own colour. */}
            {[0.25, 0.5, 0.75].map((quarter) => (
              <line
                key={quarter}
                x1={W * quarter}
                y1={7}
                x2={W * quarter}
                y2={17}
                className="stroke-surface-raised"
                strokeWidth={1.5}
              />
            ))}
            {banded ? (
              <g>
                <rect x={0} y={20} width={W * RATIO_BAD_BELOW - 1} height={3} rx={1.5} className="fill-bad" fillOpacity={0.55} />
                <rect
                  x={W * RATIO_BAD_BELOW + 1}
                  y={20}
                  width={W * (RATIO_WARN_BELOW - RATIO_BAD_BELOW) - 2}
                  height={3}
                  rx={1.5}
                  className="fill-warn"
                  fillOpacity={0.6}
                />
                <rect
                  x={W * RATIO_WARN_BELOW + 1}
                  y={20}
                  width={W * (1 - RATIO_WARN_BELOW) - 1}
                  height={3}
                  rx={1.5}
                  className="fill-line-strong"
                  fillOpacity={0.7}
                />
              </g>
            ) : null}
          </>
        ) : (
          <rect
            x={1}
            y={7}
            width={W - 2}
            height={10}
            rx={5}
            fill="none"
            className={implausible ? "stroke-warn" : "stroke-line-strong"}
            strokeDasharray="2 4"
          />
        )}
        <text x={0} y={35} fontSize={9.5} className="figure fill-ink-faint">
          0
        </text>
        <text x={W / 2} y={35} fontSize={9.5} textAnchor="middle" className="figure fill-ink-faint">
          50
        </text>
        <text x={W} y={35} fontSize={9.5} textAnchor="end" className="figure fill-ink-faint">
          100
        </text>
      </svg>

      {value === null ? (
        <p className="tile-note text-sm font-semibold leading-snug text-ink-faint">
          {figure?.undefined_reason
            ? `${figure.undefined_reason.charAt(0).toUpperCase()}${figure.undefined_reason.slice(1)}.`
            : "Not defined for this period."}
        </p>
      ) : implausible ? (
        <p className="text-sm font-semibold leading-snug text-warn">
          Outside 0–100%. The inputs cover different spans; check coverage.
        </p>
      ) : null}
    </div>
  );
}
