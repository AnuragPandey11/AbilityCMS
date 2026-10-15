/**
 * A filled position as a compact tile: the label with its icon at the right
 * edge on one line, the figure and its unit under it.
 *
 * Compact on purpose (28 Sep 2026, after the client's reference): the screens
 * about one Device put nine or fourteen of these in a row, and at the size of
 * a headline `RailTile` they read as a wall of boxes rather than an instrument
 * panel. A missing value is a faint dash with "no reading" where the unit
 * would be and the reason one hover away — a footnote line would make that
 * tile taller than its neighbours, and a long reason would stretch the row.
 */

import type { IconComponent } from "@/components/layout/navigation";
import { iconWell } from "@/components/icons/wells";
import { FittedFigure } from "@/components/charts/FittedFigure";
import { InfoHint } from "@/components/ui";
import { UNDEFINED_DISPLAY, digitsForUnit, formatHeadline } from "@/format/value";
import { NOT_A_UNIT, type Filled } from "./InverterView";

/** Every class a literal, so Tailwind emits them. */
const SIZES = {
  md: { frame: "px-3 py-2.5", well: "h-7 w-7", icon: 15, figure: "text-xl", gap: "mt-1" },
  sm: { frame: "px-3 py-2", well: "h-6 w-6", icon: 13, figure: "text-lg", gap: "mt-1" },
  xs: { frame: "px-3 py-1.5", well: "h-5 w-5", icon: 12, figure: "text-base", gap: "mt-0.5" },
} as const;

export function ReadingTile({
  icon: Icon,
  label,
  filled,
  size = "md",
}: {
  icon: IconComponent;
  label: string;
  filled: Filled;
  /** `sm`, or a shorter `xs`, for a screen that wants more of its figures above the fold. */
  size?: "xs" | "sm" | "md";
}): JSX.Element {
  const missing = filled.value === null;
  const fit = SIZES[size];
  const figureSize = fit.figure;
  const unit = filled.tag?.unit && !NOT_A_UNIT.has(filled.tag.unit) ? filled.tag.unit : undefined;
  const headline = formatHeadline(filled.value, { digits: digitsForUnit(filled.tag?.unit) });
  // Which Tag answered, and the exact figure where the tile shows it compacted.
  const title = missing
    ? undefined
    : [
        filled.tag ? `${filled.tag.name} · ${filled.tag.code}` : null,
        headline.compacted ? `${headline.exact}${unit ? ` ${unit}` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" — ") || undefined;
  return (
    <div
      className={`surface-card min-w-0 rounded-card border border-line ${fit.frame}`}
      title={title}
    >
      <div className="flex min-w-0 items-start gap-1.5">
        <span className="field-label min-w-0 flex-1 truncate pt-0.5" title={label}>
          {label}
        </span>
        {missing && filled.reason ? <InfoHint text={filled.reason} /> : null}
        <span
          className={`${iconWell(Icon)} flex shrink-0 items-center justify-center rounded-control ${
            fit.well
          }`}
        >
          <Icon size={fit.icon} />
        </span>
      </div>
      <div className={fit.gap}>
        {missing ? (
          <span className="flex items-baseline gap-1.5">
            <span className={`figure ${figureSize} font-semibold leading-tight text-ink-faint`}>{UNDEFINED_DISPLAY}</span>
            <span className="text-xs text-ink-faint">no reading</span>
          </span>
        ) : (
          <FittedFigure
            value={headline.text}
            unit={unit}
            className={`figure ${figureSize} font-semibold text-ink`}
            unitClassName="ml-0.5 text-xs font-medium text-ink-muted"
          />
        )}
      </div>
    </div>
  );
}
