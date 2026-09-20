/**
 * A KPI figure.
 *
 * The whole component exists to enforce one rule: **`null` renders as "—", never
 * as 0** (§4.3, Guardrail 3). PR is undefined at night; showing 0% drags every
 * average down and tells an operator their Plant failed.
 *
 * The second rule is nearly as important. `variant` names the formula that
 * produced the number, and every formula is provisional until the client
 * supplies theirs (OPEN-16). Surfacing it is what stops the eventual
 * recomputation from looking like a defect.
 */

import type { ReactNode } from "react";
import type { KpiFigure } from "@/api/schemas";
import {
  UNDEFINED_DISPLAY,
  formatHeadline,
  formatRatioAsPercent,
  variantNote,
} from "@/format/value";
import { InfoHint } from "@/components/ui";
import { FittedFigure } from "./FittedFigure";

export function KpiTile({
  label,
  figure,
  kind,
  unit,
  hint,
}: {
  label: string;
  figure: KpiFigure | null | undefined;
  /** `ratio` is 0..1 from the API and rendered as a percentage. */
  kind: "ratio" | "quantity";
  unit?: string;
  hint?: string;
}): JSX.Element {
  const value = figure?.value ?? null;
  const isUndefined = value === null;
  // Figure and unit are separate so the figure can shrink to fit while the
  // unit keeps its size; a percentage carries its sign as part of the figure.
  //
  // A quantity is compacted rather than shrunk: `1.24M kWh` at full type size
  // reads, where `1,241,466` scaled to fit a narrow tile does not. The unit is
  // passed through untouched — this changes the numeral, never the unit (§4.1).
  const headline = kind === "quantity" ? formatHeadline(value) : null;
  const rendered = isUndefined
    ? UNDEFINED_DISPLAY
    : kind === "ratio"
      ? formatRatioAsPercent(value)
      : (headline?.text ?? UNDEFINED_DISPLAY);
  const unitLabel = !isUndefined && kind === "quantity" ? unit : null;
  // A compacted figure is a rounded one, so the exact digits stay reachable.
  const exactTitle =
    headline?.compacted && !isUndefined
      ? `${headline.exact}${unit ? ` ${unit}` : ""}`
      : undefined;

  // The reason is the useful half: "no irradiation in period" tells an operator
  // it is night, where a bare dash tells them nothing.
  const undefinedReason =
    figure?.undefined_reason ?? "This figure is not defined for the selected period.";

  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-raised p-4">
      <div className="flex items-center text-xs text-ink-muted">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </div>
      <div className="mt-1">
        <FittedFigure
          value={rendered}
          unit={unitLabel}
          className={`font-mono text-2xl ${isUndefined ? "text-ink-faint" : "text-ink"}`}
          title={isUndefined ? undefinedReason : exactTitle}
        />
      </div>
      {isUndefined ? (
        <p className="mt-1 text-[11px] leading-snug text-ink-faint">{undefinedReason}</p>
      ) : figure?.variant ? (
        <p
          className="mt-1 text-[11px] text-ink-faint"
          title="The client's own definitions may differ by percentage points; figures will be recomputed when they arrive (OPEN-16)."
        >
          {variantNote(figure.variant)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A plain figure that is not a KPI object — a count, a capacity, a total.
 *
 * Two ways in, deliberately. `numeric` + `unit` is the one to reach for: the
 * tile then compacts a large figure itself and keeps the exact digits on the
 * tooltip, which a caller passing a pre-joined `"1,241,466 kWh"` string cannot
 * do because by then the number and its unit are one opaque blob. `value`
 * remains for the tiles whose content is not a number at all — the device
 * health strip is a row of badges, not a figure.
 */
export function StatTile({
  label,
  value,
  numeric,
  unit,
  hint,
  tone = "default",
  footnote,
}: {
  label: string;
  value?: ReactNode;
  /** A raw figure. Compacted above `COMPACT_ABOVE`, exact value on the tooltip. */
  numeric?: number | null;
  /** Rendered beside the figure at its own size. Never scaled or converted. */
  unit?: string;
  hint?: string;
  tone?: "default" | "ok" | "warn" | "bad";
  footnote?: ReactNode;
}): JSX.Element {
  const tones: Record<string, string> = {
    default: "text-ink",
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
  };
  const headline = numeric === undefined ? null : formatHeadline(numeric);
  const isNumeric = headline !== null;
  const undefinedNumeric = isNumeric && headline.text === UNDEFINED_DISPLAY;

  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-raised p-4">
      <div className="flex items-center text-xs text-ink-muted">
        {label}
        {hint ? <InfoHint text={hint} /> : null}
      </div>
      <div className="mt-1">
        <FittedFigure
          value={isNumeric ? headline.text : (value ?? UNDEFINED_DISPLAY)}
          unit={isNumeric && !undefinedNumeric ? unit : null}
          className={`font-mono text-2xl ${
            undefinedNumeric ? "text-ink-faint" : tones[tone]
          }`}
          title={
            headline?.compacted
              ? `${headline.exact}${unit ? ` ${unit}` : ""}`
              : undefined
          }
        />
      </div>
      {footnote ? (
        <p className="mt-1 text-[11px] leading-snug text-ink-faint">{footnote}</p>
      ) : null}
    </div>
  );
}
