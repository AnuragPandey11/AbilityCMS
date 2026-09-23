/**
 * Rendering one resolved slot — a tile, a table row, and the provenance both show.
 *
 * Three rules, all of which exist because the alternative is a number that lies:
 *
 * 1. **`null` renders as "—", never as 0.** The same rule `KpiTile` enforces
 *    (Guardrail 3). A PR of zero and an unknown PR mean opposite things.
 * 2. **The three ways of being undefined are told apart.** `no_source` is a
 *    commissioning gap, `no_value` is a fault happening right now, and only the
 *    second is somebody's problem this minute. They are the same blank tile
 *    otherwise.
 * 3. **Provenance is shown, not hidden.** 6.32 MW is a different claim depending
 *    on whether a settlement meter measured it or twelve Inverters were added
 *    together, and the person deciding whether to trust it needs to know which.
 *    The frontend never *decides* provenance — it arrives with the value.
 */

import type { ResolvedSlot, SlotSource } from "@/api/schemas";
import {
  UNDEFINED_DISPLAY,
  digitsForUnit,
  formatHeadline,
  formatNumber,
} from "@/format/value";
import type { ComponentType } from "react";
import type { IconProps } from "@/components/icons";
import { InfoHint } from "@/components/ui";
import { FittedFigure } from "@/components/charts/FittedFigure";
import { RailTile, type RailTone } from "@/components/charts/RailTile";

/** Why a slot is blank, in words an operator can act on. */
export function undefinedExplanation(slot: ResolvedSlot): string {
  switch (slot.undefined_reason) {
    case "no_source":
      return "No Device on this Plant is bound to a Tag that could answer this.";
    case "no_value":
      return sourceLabel(slot.source)
        ? `${sourceLabel(slot.source)} is registered here but is reporting nothing.`
        : "The source is registered here but is reporting nothing.";
    case "unconfigured":
      return "This position has no sources configured.";
    default:
      return "";
  }
}

/** "ABT Meter", "Σ 8 Inverters", "Plant record" — where the number came from. */
export function sourceLabel(source: SlotSource | null): string {
  if (!source) return "";
  if (source.kind === "plant_attribute") return "Plant record";
  const type = titleCase(source.device_type_code ?? "");
  if (source.kind === "device_count") return type;
  if (!source.is_aggregated) return type;
  const symbol = source.aggregate === "sum" ? "Σ" : source.aggregate;
  return `${symbol} ${source.device_count} ${type}`;
}

function titleCase(code: string): string {
  // ABT_METER → "ABT Meter". Purely presentational: the canonical code is what
  // travels, and it is what a support conversation quotes.
  return code
    .split("_")
    .map((part) =>
      part.length <= 3 ? part : part[0] + part.slice(1).toLowerCase(),
    )
    .join(" ");
}

/**
 * Precision follows magnitude, as `formatNumber` does everywhere else: three
 * decimals for a ratio, two below 100, none above 1,000. A fixed two decimals
 * made `1,241,466.00 kWh` — two digits that say nothing and a figure that no
 * longer fits its tile. The full value is still on the tooltip.
 */
export function slotText(slot: ResolvedSlot): string {
  if (slot.value === null) return UNDEFINED_DISPLAY;
  // The unit decides where it can: three decimals for a ratio, none for a
  // count — "17.00 count" invites the reader to look for a precision that
  // cannot exist. Everything else follows magnitude.
  return formatNumber(slot.value, { digits: digitsForUnit(slot.unit) });
}

function Provenance({ slot }: { slot: ResolvedSlot }): JSX.Element | null {
  const label = sourceLabel(slot.source);
  if (!label) return null;
  return (
    <span
      className={slot.source?.degraded ? "text-warn" : "text-ink-faint"}
      title={
        slot.source?.degraded
          ? "The preferred source for this position is registered but silent, so a " +
            "lower-ranked one answered. The value is real; the instrument is not the usual one."
          : `Resolved from ${label}${slot.source?.tag_code ? ` · ${slot.source.tag_code}` : ""}`
      }
    >
      {label}
      {slot.source?.degraded ? " (fallback)" : ""}
    </span>
  );
}

/** A headline tile. Large figure, unit, and where it came from. */
export function SlotTile({ slot }: { slot: ResolvedSlot }): JSX.Element {
  const isUndefined = slot.value === null;
  const explanation = undefinedExplanation(slot);
  // A ratio is three decimals and always short; a quantity can be a lifetime
  // energy counter, which is compacted rather than scaled down to fit. The unit
  // the backend supplied is passed through untouched either way (§4.1).
  const headline =
    slot.unit === "ratio" ? null : formatHeadline(slot.value, { digits: digitsForUnit(slot.unit) });
  const text = headline ? headline.text : slotText(slot);
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-raised p-4">
      <div className="tile-label flex items-center">
        {slot.label}
        {slot.override_note ? (
          <InfoHint text={`Source overridden for this Plant: ${slot.override_note}`} />
        ) : null}
      </div>
      <div className="mt-1">
        <FittedFigure
          value={text}
          unit={isUndefined ? null : slot.unit}
          className={`figure text-2xl ${isUndefined ? "text-ink-faint" : "text-ink"}`}
          title={isUndefined ? explanation : String(slot.value)}
        />
      </div>
      <p className="mt-1 text-[11px] leading-snug text-ink-faint">
        {isUndefined ? explanation : <Provenance slot={slot} />}
      </p>
    </div>
  );
}

/** One line of a list panel: label on the left, value and source on the right. */
export function SlotRow({ slot }: { slot: ResolvedSlot }): JSX.Element {
  const isUndefined = slot.value === null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0 truncate text-ink-muted" title={slot.label}>
        {slot.label}
      </span>
      <span className="flex shrink-0 flex-wrap items-baseline justify-end gap-x-2">
        <Provenance slot={slot} />
        <span
          className={`figure whitespace-nowrap font-medium ${isUndefined ? "text-ink-faint" : "text-ink"}`}
          title={isUndefined ? undefinedExplanation(slot) : undefined}
        >
          {slotText(slot)}
          {slot.unit && !isUndefined ? (
            <span className="ml-1 text-xs text-ink-muted">{slot.unit}</span>
          ) : null}
        </span>
      </span>
    </div>
  );
}

/**
 * A headline slot as a `RailTile`: the icon well, a large figure, and — kept,
 * never dropped — where the figure came from.
 *
 * The figure is only ever ink or faint here, because a slot carries no
 * judgement of its own; the well is the brand accent like every tile's.
 */
export function SlotRailTile({
  slot,
  icon,
  tone,
}: {
  slot: ResolvedSlot;
  icon: ComponentType<IconProps>;
  /** Accepted for callers that still pass one; `RailTile` renders every tone alike. */
  tone?: RailTone;
}): JSX.Element {
  const isUndefined = slot.value === null;
  const explanation = undefinedExplanation(slot);
  const headline =
    slot.unit === "ratio" ? null : formatHeadline(slot.value, { digits: digitsForUnit(slot.unit) });
  const text = headline ? headline.text : slotText(slot);
  return (
    <RailTile
      tone={tone}
      icon={icon}
      label={slot.label}
      hint={slot.override_note ? `Source overridden for this Plant: ${slot.override_note}` : undefined}
      footnote={isUndefined ? explanation : <Provenance slot={slot} />}
    >
      <FittedFigure
        value={text}
        unit={isUndefined ? null : slot.unit}
        className={`figure text-[1.9rem] font-semibold leading-none tracking-tight ${
          isUndefined ? "text-ink-faint" : "text-ink"
        }`}
        unitClassName="ml-1.5 text-sm font-medium text-ink-muted"
        title={
          isUndefined
            ? explanation
            : headline?.compacted
              ? `${headline.exact}${slot.unit ? ` ${slot.unit}` : ""}`
              : String(slot.value)
        }
      />
    </RailTile>
  );
}

/**
 * The dense variant of `SlotTile`, for the dashboard's headline strip.
 *
 * Same content, roughly half the height. The dashboard fits one screen only if
 * the row that never changes — capacity, current power, today, month, lifetime
 * — costs about 80px rather than about 150px. What is given up is the tile's
 * generous padding, and nothing else: the figure, the unit and the provenance
 * are all still here, because dropping provenance would make 6.32 MW measured
 * and 6.32 MW summed the same claim, which is exactly the distinction the slot
 * catalogue exists to keep.
 *
 * `icon` is decorative and optional. It labels the *kind* of figure — power,
 * energy, a ratio — so the strip can be scanned by shape before it is read.
 */
export function SlotStat({
  slot,
  icon: Icon,
}: {
  slot: ResolvedSlot;
  icon?: ComponentType<IconProps>;
}): JSX.Element {
  const isUndefined = slot.value === null;
  const explanation = undefinedExplanation(slot);
  const headline =
    slot.unit === "ratio" ? null : formatHeadline(slot.value, { digits: digitsForUnit(slot.unit) });
  const text = headline ? headline.text : slotText(slot);

  return (
    <div className="surface-tile min-w-0 rounded-card border border-line px-3 py-2">
      <div className="flex items-center gap-1.5">
        {/*
          The icon chip is the brand hue, and the brand hue only.
          
          It is tempting to tint each metric by kind — power amber, energy
          blue — and it is a trap: this platform spends green, amber and red on
          *status*, and a decorative tint sitting next to a figure would be read
          as a judgement about that figure. One accent, used for "this is a
          headline metric" and nothing else, adds the life a row of grey boxes
          was missing without inventing a meaning.
        */}
        {Icon ? (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-accent/10 text-accent">
            <Icon size={11} />
          </span>
        ) : null}
        <span className="truncate text-xs font-medium text-ink-muted">
          {slot.label}
        </span>
        {slot.override_note ? (
          <InfoHint text={`Source overridden for this Plant: ${slot.override_note}`} />
        ) : null}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        {/*
          Proportional figures, not `tabular-nums`: equal-width digits make a
          large standalone number look loose, and nothing in this row lines up
          vertically with anything. The tables elsewhere do use tabular figures,
          where columns of numbers genuinely need to align.
        */}
        <span
          className={`truncate text-[19px] font-semibold leading-tight ${
            isUndefined ? "text-ink-faint" : "text-ink"
          }`}
          title={
            isUndefined
              ? explanation
              : headline?.compacted
                ? `${headline.exact}${slot.unit ? ` ${slot.unit}` : ""}`
                : String(slot.value)
          }
        >
          {text}
        </span>
        {!isUndefined && slot.unit ? (
          <span className="shrink-0 text-[10px] text-ink-muted">{slot.unit}</span>
        ) : null}
      </div>
      <p className="truncate text-[9px] leading-snug text-ink-faint">
        {isUndefined ? explanation : <Provenance slot={slot} />}
      </p>
    </div>
  );
}
