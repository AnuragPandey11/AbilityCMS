/**
 * A filled position as a compact tile: a small icon and the label on one line,
 * the figure and its unit under it.
 *
 * Compact on purpose (28 Sep 2026, after the client's reference): the screens
 * about one Device put nine or fourteen of these in a row, and at the size of
 * a headline `RailTile` they read as a wall of boxes rather than an instrument
 * panel. A missing value is a faint dash with "no reading" where the unit
 * would be and the reason one hover away — a footnote line would make that
 * tile taller than its neighbours, and a long reason would stretch the row.
 */

import type { IconComponent } from "@/components/layout/navigation";
import { FittedFigure } from "@/components/charts/FittedFigure";
import { InfoHint } from "@/components/ui";
import { UNDEFINED_DISPLAY, digitsForUnit, formatHeadline } from "@/format/value";
import { NOT_A_UNIT, type Filled } from "./InverterView";

export function ReadingTile({
  icon: Icon,
  label,
  filled,
}: {
  icon: IconComponent;
  label: string;
  filled: Filled;
}): JSX.Element {
  const missing = filled.value === null;
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
    <div className="surface-card min-w-0 rounded-card border border-line px-3.5 py-3" title={title}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="icon-well flex h-6 w-6 shrink-0 items-center justify-center rounded-control">
          <Icon size={14} />
        </span>
        <span className="field-label min-w-0 truncate">{label}</span>
        {missing && filled.reason ? <InfoHint text={filled.reason} /> : null}
      </div>
      <div className="mt-2">
        {missing ? (
          <span className="flex items-baseline gap-1.5">
            <span className="figure text-2xl font-semibold leading-tight text-ink-faint">{UNDEFINED_DISPLAY}</span>
            <span className="text-xs text-ink-faint">no reading</span>
          </span>
        ) : (
          <FittedFigure
            value={headline.text}
            unit={unit}
            className="figure text-2xl font-semibold text-ink"
            unitClassName="ml-0.5 text-xs font-medium text-ink-muted"
          />
        )}
      </div>
    </div>
  );
}
