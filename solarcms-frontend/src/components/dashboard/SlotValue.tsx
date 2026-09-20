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
import { UNDEFINED_DISPLAY, formatHeadline, formatNumber } from "@/format/value";
import { InfoHint } from "@/components/ui";
import { FittedFigure } from "@/components/charts/FittedFigure";

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
  return slot.unit === "ratio"
    ? formatNumber(slot.value, { digits: 3 })
    : formatNumber(slot.value);
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
    slot.unit === "ratio" ? null : formatHeadline(slot.value);
  const text = headline ? headline.text : slotText(slot);
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-raised p-4">
      <div className="flex items-center text-xs uppercase tracking-wide text-ink-muted">
        {slot.label}
        {slot.override_note ? (
          <InfoHint text={`Source overridden for this Plant: ${slot.override_note}`} />
        ) : null}
      </div>
      <div className="mt-1">
        <FittedFigure
          value={text}
          unit={isUndefined ? null : slot.unit}
          className={`font-mono text-2xl ${isUndefined ? "text-ink-faint" : "text-ink"}`}
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
          className={`whitespace-nowrap font-mono ${isUndefined ? "text-ink-faint" : "text-ink"}`}
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
