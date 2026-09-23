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

import type { ComponentType, ReactNode } from "react";
import type { KpiFigure } from "@/api/schemas";
import type { IconProps } from "@/components/icons";
import {
  UNDEFINED_DISPLAY,
  formatHeadline,
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
} from "@/format/value";
import { InfoHint } from "@/components/ui";
import { FittedFigure } from "./FittedFigure";


/**
 * The tile's icon chip.
 *
 * ⚠ The icon has to be a *logical* match for the quantity, not decoration. A
 * location pin beside a capacity says "where" about a figure that means "how
 * big"; a bolt beside an energy total says "rate" about a figure that is an
 * accumulation. Both were in place and both quietly taught the wrong thing.
 * The mapping lives with each dashboard, because only the caller knows what the
 * number means.
 *
 * One hue — the brand accent — because status owns green, amber and red on this
 * platform and a tinted chip beside a figure would read as a judgement about it.
 * A `tone` is honoured only where the caller has *already* made a judgement.
 */
function TileIcon({
  icon: Icon,
  tone,
}: {
  icon?: ComponentType<IconProps>;
  tone?: "default" | "ok" | "warn" | "bad";
}): JSX.Element | null {
  if (!Icon) return null;
  const chrome =
    tone === "bad"
      ? "bg-bad/12 text-bad"
      : tone === "warn"
        ? "bg-warn/12 text-warn"
        : tone === "ok"
          ? "bg-ok/12 text-ok"
          : "icon-well";
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${chrome}`}>
      <Icon size={12} />
    </span>
  );
}

export function KpiTile({
  label,
  figure,
  kind,
  unit,
  hint,
  icon,
}: {
  label: string;
  figure: KpiFigure | null | undefined;
  /** A logical match for the quantity — see `TileIcon`. */
  icon?: ComponentType<IconProps>;
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

  // A ratio outside its physical range is a fault in the inputs, not a result.
  // Flagged rather than corrected or hidden — see `ratioIsImplausible`.
  const implausible = kind === "ratio" && ratioIsImplausible(value);

  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-raised p-4">
      <div className="flex items-center gap-1.5 text-xs text-ink-muted">
        <TileIcon icon={icon} />
        <span className="min-w-0 truncate">{label}</span>
        {hint ? <InfoHint text={hint} /> : null}
      </div>
      <div className="mt-1">
        <FittedFigure
          value={rendered}
          unit={unitLabel}
          className={`figure text-2xl ${
            isUndefined ? "text-ink-faint" : implausible ? "text-warn" : "text-ink"
          }`}
          title={
            isUndefined
              ? undefinedReason
              : implausible && value !== null
                ? implausibleRatioReason(value, label)
                : exactTitle
          }
        />
      </div>
      {isUndefined ? (
        <p className="mt-1 text-[11px] leading-snug text-ink-faint">{undefinedReason}</p>
      ) : implausible ? (
        <p className="mt-1 text-[11px] leading-snug text-warn">
          Outside the range this quantity can take. The numerator and denominator cover
          different spans — check the coverage for this period.
        </p>
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
  digits,
  icon,
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
  /** A logical match for the quantity — see `TileIcon`. */
  icon?: ComponentType<IconProps>;
  /**
   * Decimal places. Pass `0` for a tally.
   *
   * The default rule is magnitude-based, which is right for a measurement and
   * wrong for a count: it gave two decimals below 1, so zero open Alarms
   * rendered as "0.00". A count has no fractional part to round.
   */
  digits?: number;
}): JSX.Element {
  const tones: Record<string, string> = {
    default: "text-ink",
    ok: "text-ok",
    warn: "text-warn",
    bad: "text-bad",
  };
  const headline = numeric === undefined ? null : formatHeadline(numeric, { digits });
  const isNumeric = headline !== null;
  const undefinedNumeric = isNumeric && headline.text === UNDEFINED_DISPLAY;

  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-raised p-4">
      <div className="flex items-center gap-1.5 text-xs text-ink-muted">
        <TileIcon icon={icon} tone={tone} />
        <span className="min-w-0 truncate">{label}</span>
        {hint ? <InfoHint text={hint} /> : null}
      </div>
      <div className="mt-1">
        <FittedFigure
          value={isNumeric ? headline.text : (value ?? UNDEFINED_DISPLAY)}
          unit={isNumeric && !undefinedNumeric ? unit : null}
          className={`figure text-2xl ${
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
