/**
 * A summary tile with an icon well — the stat tile of the Plants and Inverter
 * Monitoring screens.
 *
 * A well's hue comes from its icon (`icons/wells.ts`): in light mode the bolt
 * and the sun are yellow, energy and CO₂ green, Alarms and temperature red,
 * the rest the accent. Tiles used to take a hue each from the caller (green,
 * amber, violet, blue) down a coloured left rail, which made the same quantity
 * a different colour on each screen; keyed on the icon, it cannot be. A
 * verdict is still the figure's colour, which the caller sets separately and
 * only where it has made one (zero open Alarms is green).
 *
 * The rules every figure on the platform keeps hold here too: `null` is "—",
 * never 0; a compacted number keeps its exact digits on the tooltip; a unit is
 * shown beside its figure and never converted.
 */

import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@/components/icons";
import { iconWell } from "@/components/icons/wells";
import { InfoHint } from "@/components/ui";
import { UNDEFINED_DISPLAY, formatHeadline } from "@/format/value";
import { FittedFigure } from "./FittedFigure";

export type RailTone = "accent" | "ok" | "warn" | "violet" | "info" | "blue";


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
  dense = false,
  inline = false,
}: {
  /** Kept for existing callers and ignored: the well's hue comes from `icon`. */
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
  /** Tighter padding and a smaller icon well, for a strip of five across. */
  dense?: boolean;
  /**
   * One short row: the icon beside the label, the figure under the label, and
   * the footnote on one truncated line. For a strip of counts that frames the
   * page rather than headlines it; long explanations belong in `hint`.
   */
  inline?: boolean;
}): JSX.Element {
  const well = iconWell(Icon);
  if (inline) {
    return (
      <div className="surface-card flex min-w-0 items-center gap-3 rounded-card border border-line px-3.5 py-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control ${well}`}>
          <Icon size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center">
            <span className="tile-label min-w-0 truncate">{label}</span>
            {hint ? <InfoHint text={hint} /> : null}
          </div>
          {children !== undefined && children !== null ? (
            <div className={`mt-0.5 ${FIGURE[figureTone]}`}>{children}</div>
          ) : null}
          {footnote ? (
            <p
              className="mt-0.5 truncate text-[11px] leading-snug text-ink-faint"
              title={typeof footnote === "string" ? footnote : undefined}
            >
              {footnote}
            </p>
          ) : null}
        </div>
      </div>
    );
  }
  const gap = dense ? "mt-2" : "mt-3";
  return (
    <div
      className={`surface-card flex min-w-0 flex-col rounded-card border border-line ${
        dense ? "p-3.5" : "p-5 xl:p-4 2xl:p-5"
      }`}
    >
      {/* The icon well sets the row's height, so a label that wraps to two
          lines does not push its figure below its neighbours'. */}
      <div className={`flex items-center ${dense ? "min-h-7 gap-2" : "min-h-9 gap-3 xl:gap-2.5 2xl:gap-3"}`}>
        <span
          className={`flex shrink-0 items-center justify-center rounded-control ${dense ? "h-7 w-7" : "h-9 w-9"} ${well}`}
        >
          <Icon size={dense ? 15 : 18} />
        </span>
        <span className="tile-label min-w-0">
          {label}
        </span>
        {hint ? <InfoHint text={hint} /> : null}
      </div>
      {children !== undefined && children !== null ? (
        <div className={`${dense ? "mt-3" : "mt-4"} ${FIGURE[figureTone]}`}>{children}</div>
      ) : null}
      {visual ? <div className={`${gap} flex min-h-0 flex-1 flex-col justify-center`}>{visual}</div> : null}
      {footnote ? (
        <p className={`${visual ? gap : "mt-2"} text-xs leading-snug text-ink-faint`}>{footnote}</p>
      ) : null}
      {action ? <div className={gap}>{action}</div> : null}
    </div>
  );
}

/** A tile figure: compacted when large, exact on the tooltip, unit beside it. */
export function RailFigure({
  value,
  unit,
  digits,
  size = "md",
}: {
  value: number | null | undefined;
  unit?: string;
  /** `0` for a tally. */
  digits?: number;
  /** `sm` for an `inline` tile. */
  size?: "sm" | "md";
}): JSX.Element {
  const headline = formatHeadline(value, { digits });
  const undefinedFigure = headline.text === UNDEFINED_DISPLAY;
  return (
    <FittedFigure
      value={headline.text}
      unit={undefinedFigure ? null : unit}
      className={`figure ${size === "sm" ? "text-xl" : "text-[1.9rem]"} font-semibold leading-none tracking-tight ${
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
export function RailText({ value, size = "md" }: { value: string; size?: "sm" | "md" }): JSX.Element {
  return (
    <FittedFigure
      value={value}
      className={`${size === "sm" ? "text-lg" : "text-[1.75rem]"} font-semibold leading-none tracking-tight`}
    />
  );
}
