/**
 * A summary tile with an icon well — the stat tile of the Plants and Inverter
 * Monitoring screens.
 *
 * Every well is the brand accent. Tiles used to take a hue each (green, amber,
 * violet, blue) down a coloured left rail, to identify *which* tile the way a
 * column colour does — but the icon and the label already say which, so the
 * hue identified nothing and a row of five tiles read as five unrelated
 * products. A verdict is still the figure's colour, which the caller sets
 * separately and only where it has made one (zero open Alarms is green).
 *
 * The rules every figure on the platform keeps hold here too: `null` is "—",
 * never 0; a compacted number keeps its exact digits on the tooltip; a unit is
 * shown beside its figure and never converted.
 */

import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@/components/icons";
import { InfoHint } from "@/components/ui";
import { UNDEFINED_DISPLAY, formatHeadline } from "@/format/value";
import { FittedFigure } from "./FittedFigure";

export type RailTone = "accent" | "ok" | "warn" | "violet" | "info" | "blue";

/**
 * The icon well. One style for every tone: `tone` is still accepted so the
 * callers that name one keep compiling, but a tile's identity is its icon, and
 * green or amber here would read as a verdict on a figure nobody judged
 * (Guardrail 34).
 */
const WELL = "icon-well";

const FIGURE = {
  ink: "text-ink",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
} as const;

export function RailTile({
  icon: Icon,
  label,
  hint,
  footnote,
  figureTone = "ink",
  visual,
  children,
  action,
}: {
  /** Kept for existing callers; every tone renders the same (see `WELL`). */
  tone?: RailTone;
  icon: ComponentType<IconProps>;
  label: string;
  hint?: string;
  footnote?: ReactNode;
  figureTone?: keyof typeof FIGURE;
  /**
   * A drawing of the figure, below it. It takes the tile's spare height, so in
   * a row of tiles with drawings of different sizes every footnote still sits
   * on the same line.
   */
  visual?: ReactNode;
  /** The figure — usually a `RailFigure`. Omitted when `visual` carries it. */
  children?: ReactNode;
  /** A control at the foot of the tile — a way into the detail behind it. */
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="surface-card flex min-w-0 flex-col rounded-card border border-line p-5 xl:p-4 2xl:p-5">
      {/* The icon well sets the row's height, so a label that wraps to two
          lines does not push its figure below its neighbours'. */}
      <div className="flex min-h-9 items-center gap-3 xl:gap-2.5 2xl:gap-3">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-control ${WELL}`}>
          <Icon size={18} />
        </span>
        <span className="tile-label min-w-0">
          {label}
        </span>
        {hint ? <InfoHint text={hint} /> : null}
      </div>
      {children !== undefined && children !== null ? (
        <div className={`mt-4 ${FIGURE[figureTone]}`}>{children}</div>
      ) : null}
      {visual ? <div className="mt-3 flex min-h-0 flex-1 flex-col justify-center">{visual}</div> : null}
      {footnote ? (
        <p className={`${visual ? "mt-3" : "mt-2"} text-xs leading-snug text-ink-faint`}>{footnote}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/** A tile figure: compacted when large, exact on the tooltip, unit beside it. */
export function RailFigure({
  value,
  unit,
  digits,
}: {
  value: number | null | undefined;
  unit?: string;
  /** `0` for a tally. */
  digits?: number;
}): JSX.Element {
  const headline = formatHeadline(value, { digits });
  const undefinedFigure = headline.text === UNDEFINED_DISPLAY;
  return (
    <FittedFigure
      value={headline.text}
      unit={undefinedFigure ? null : unit}
      className={`figure text-[1.9rem] font-semibold leading-none tracking-tight ${
        undefinedFigure ? "text-ink-faint" : ""
      }`}
      unitClassName="ml-1.5 text-sm font-medium text-ink-muted"
      title={headline.compacted ? `${headline.exact}${unit ? ` ${unit}` : ""}` : undefined}
    />
  );
}

/**
 * A tile whose "figure" is a word — the measure being compared, say.
 *
 * Proportional rather than mono: a name is not a number, and in mono
 * "Ac Active Power" is a third wider, so on a four-across row it shrank to half
 * the size of the figures beside it.
 */
export function RailText({ value }: { value: string }): JSX.Element {
  return (
    <FittedFigure
      value={value}
      className="text-[1.75rem] font-semibold leading-none tracking-tight"
    />
  );
}
