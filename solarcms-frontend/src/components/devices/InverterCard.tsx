/**
 * One Inverter as a card: the client's reference card for the Inverter
 * Monitoring wall.
 *
 * Top to bottom: the drawing, the code and whether it is reporting; output
 * against the Inverter's rating as a segmented meter; efficiency and today's
 * energy; then the Type's remaining curated columns in one row.
 *
 * ── Where the figures come from ─────────────────────────────────────────────
 * Each position names catalogue Tag codes in order of preference, as
 * `InverterView` does, and the first one this Inverter has a value for wins.
 * The Device Type's curated columns come first because they carry the
 * catalogue's own name for the figure. The Tag catalogue fills the one
 * position that is not a column (lifetime energy). Positions name Tags, never
 * a Client, Plant or Device (Guardrail 2). Every other curated column still
 * appears in the row at the foot, so configuring a column still puts it on
 * the card.
 *
 * ── Load is output over the *recorded* rating, and only that ────────────────
 * `rated_capacity_kw` is the nameplate somebody recorded, and nothing here
 * estimates one. With no rating the meter stays empty and says why: a Plant's
 * capacity divided by its Inverter count would be a figure nobody measured.
 * Units are never converted (§4.1), so a power Tag in anything but kW gets no
 * load rather than a silent factor of 1000. A load above 100% is shown as it
 * is and flagged (Guardrail 33): either the Inverter is running over its
 * nameplate or the recorded rating is wrong, and only a person can say which.
 *
 * ── Two sizes, chosen by the card's own width ────────────────────────────
 * The carousel gives a card anything from ~300px (a phone, or two beside the
 * chart on a 1280px laptop) to ~520px, and the viewport says little about
 * which. So the card is a size container: compact by default, the reference's
 * proportions once its content is 20rem wide. Below that the code, today's energy and the
 * lifetime total truncated.
 *
 * ── Colour ──────────────────────────────────────────────────────────────────
 * The reference paints efficiency green and energy amber. Here those are
 * status colours, so a tile in them would read as a verdict nobody made
 * (design rule 2, Guardrail 34). Identity is the accent. The figure the
 * comparison chart is sorted on takes the accent too, so the eye can go from a
 * bar to its card and find the same number. The frame lights up only for bad
 * news, and that news is about communication, never equipment (Guardrail 16).
 */

import type { DeviceListItem, DeviceTableColumn, Tag } from "@/api/schemas";
import { COMM_CARD_STYLE } from "./DeviceCard";
import { DeviceArt } from "./DeviceArt";
import { IconChevronRight } from "@/components/icons";
import {
  UNDEFINED_DISPLAY,
  digitsForUnit,
  formatDigital,
  formatHeadline,
  formatNumber,
} from "@/format/value";
import { ageSeconds, formatAge } from "@/format/datetime";

/** Each position and the Tags that can fill it, preferred first. */
const POSITIONS = {
  power: ["AC_ACTIVE_POWER"],
  efficiency: ["INVERTER_EFFICIENCY"],
  // Calculated from AC output over efficiency (`tags.formula`), so undefined
  // at night. That is correct: DC power is unknown then, not zero.
  dcInput: ["DC_POWER"],
  energyToday: ["ENERGY_TODAY"],
  energyTotal: ["ENERGY_TOTAL", "ENERGY_CUMULATIVE_MWH"],
} as const satisfies Record<string, readonly string[]>;

/** Segments in the load meter. 24 puts a boundary at every quarter. */
const SEGMENTS = 24;

/** How many of the remaining curated columns fit the row at the foot. */
const MAX_OTHERS = 3;

/** Units that are type names rather than units, and are not printed as one. */
const NOT_A_UNIT = new Set(["ratio", "code", "bool"]);

const STATUS_TEXT = {
  online: "text-ok",
  degraded: "text-warn",
  offline: "text-bad",
  unknown: "text-ink-faint",
} as const;

/**
 * Every Tag id a card may show beyond the Type's columns, for the caller's
 * latest-values request. Without this the lifetime figure has no value to show.
 */
export function inverterCardTagIds(tagsByCode: ReadonlyMap<string, Tag>): number[] {
  const ids: number[] = [];
  for (const codes of Object.values(POSITIONS)) {
    for (const code of codes) {
      const tag = tagsByCode.get(code);
      if (tag) ids.push(tag.id);
    }
  }
  return ids;
}

/** A figure's Tag, from whichever catalogue named it. */
interface Field {
  tagId: number;
  code: string;
  name: string;
  unit: string | null;
  category: string;
}

type Values = Record<string, number> | undefined;

function fieldFor(
  code: string,
  columns: DeviceTableColumn[],
  tagsByCode: ReadonlyMap<string, Tag>,
): Field | null {
  const column = columns.find((candidate) => candidate.tag_code === code);
  if (column) {
    return {
      tagId: column.tag_id,
      code,
      name: column.name,
      unit: column.unit,
      category: column.category,
    };
  }
  const tag = tagsByCode.get(code);
  return tag
    ? { tagId: tag.id, code, name: tag.name, unit: tag.unit, category: tag.category }
    : null;
}

/** The first preferred Tag with a value, else the first that exists at all. */
function resolve(
  codes: readonly string[],
  columns: DeviceTableColumn[],
  tagsByCode: ReadonlyMap<string, Tag>,
  values: Values,
): Field | null {
  let fallback: Field | null = null;
  for (const code of codes) {
    const field = fieldFor(code, columns, tagsByCode);
    if (!field) continue;
    if (values?.[String(field.tagId)] !== undefined) return field;
    fallback ??= field;
  }
  return fallback;
}

const valueOf = (field: Field | null, values: Values): number | undefined =>
  field ? values?.[String(field.tagId)] : undefined;

const unitOf = (field: Field | null): string | null =>
  field?.unit && !NOT_A_UNIT.has(field.unit) ? field.unit : null;

/** Why a value is missing, as specifically as the card can know. */
function missingReason(field: Field | null, codes: readonly string[]): string {
  if (!field) return `No ${codes.join(" or ")} Tag is in the catalogue.`;
  return `No recent value for ${field.name} (${field.code}). Silence is not zero.`;
}

/**
 * Output over the recorded rating, or why the card cannot say: a line short
 * enough for the meter's scale, and the whole reason for its tooltip.
 */
function loadOf(
  power: Field | null,
  value: number | undefined,
  rated: number | null,
): { load: number | null; reason: { short: string; full: string } | null } {
  if (rated === null || !(rated > 0)) {
    return {
      load: null,
      reason: {
        short: "Record a rating in Tag Mapping to show load",
        full: "No rated capacity is recorded for this Inverter, so its load cannot be shown. Nothing here estimates one. Record the nameplate in Tag Mapping.",
      },
    };
  }
  if (power && power.unit !== "kW") {
    return {
      load: null,
      reason: {
        short: `Output in ${power.unit ?? "no unit"}, rating in kW`,
        full: `Output is in ${power.unit ?? "no unit"} and the rating is in kW. Units are never converted here, so no load is shown.`,
      },
    };
  }
  // Silent, or no power Tag at all: the figure's own "—" says so.
  if (value === undefined) return { load: null, reason: null };
  return { load: value / rated, reason: null };
}

/** A small accent lamp beside the figure the comparison chart is sorted on. */
function ComparedDot(): JSX.Element {
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
      title="The comparison chart is sorted on this figure."
    />
  );
}

/** A figure with its unit, or "—" with the reason in its tooltip. */
function Figure({
  field,
  value,
  highlighted,
  missing,
  size,
}: {
  field: Field | null;
  value: number | undefined;
  highlighted: boolean;
  missing: string;
  size: string;
}): JSX.Element {
  if (value === undefined) {
    return (
      <span className={`figure font-bold leading-none text-ink-faint ${size}`} title={missing}>
        {UNDEFINED_DISPLAY}
      </span>
    );
  }
  const headline = formatHeadline(value, { digits: digitsForUnit(field?.unit) });
  const unit = unitOf(field);
  return (
    <span
      className="flex min-w-0 items-baseline gap-1.5"
      title={headline.compacted ? `${headline.exact}${unit ? ` ${unit}` : ""}` : field?.name}
    >
      <span
        className={`figure truncate font-bold leading-none ${size} ${
          highlighted ? "text-accent" : "text-ink"
        }`}
      >
        {headline.text}
      </span>
      {unit ? (
        <span
          className={`shrink-0 text-sm font-semibold ${highlighted ? "text-accent" : "text-ink-muted"}`}
        >
          {unit}
        </span>
      ) : null}
    </span>
  );
}

/** A secondary figure in its own sunken tile, with one related figure beneath. */
function FigureTile({
  label,
  field,
  codes,
  values,
  highlightTagId,
  footLabel,
  foot,
  footCodes,
}: {
  label: string;
  field: Field | null;
  codes: readonly string[];
  values: Values;
  highlightTagId: number | undefined;
  footLabel: string;
  foot: Field | null;
  footCodes: readonly string[];
}): JSX.Element {
  const highlighted = field !== null && field.tagId === highlightTagId;
  const footValue = valueOf(foot, values);
  const footUnit = unitOf(foot);
  const footHeadline = formatHeadline(footValue ?? null, { digits: digitsForUnit(foot?.unit) });
  const footHighlighted = foot !== null && foot.tagId === highlightTagId;
  return (
    <div className="flex min-w-0 flex-col rounded-card border border-line bg-surface-sunken p-3 [@container(min-width:20rem)]:p-3.5">
      <span className="field-label flex items-center gap-1.5" title={field?.name}>
        {highlighted ? <ComparedDot /> : null}
        <span className="truncate">{label}</span>
      </span>
      <div className="mt-2.5">
        <Figure
          field={field}
          value={valueOf(field, values)}
          highlighted={highlighted}
          missing={missingReason(field, codes)}
          size="text-xl [@container(min-width:20rem)]:text-2xl"
        />
      </div>
      <div
        className="mt-3 flex flex-col gap-0.5 border-t border-line pt-2 text-[11px] [@container(min-width:20rem)]:flex-row [@container(min-width:20rem)]:items-baseline [@container(min-width:20rem)]:justify-between [@container(min-width:20rem)]:gap-2"
        title={
          footValue === undefined
            ? missingReason(foot, footCodes)
            : `${foot?.name}: ${footHeadline.exact}${footUnit ? ` ${footUnit}` : ""}`
        }
      >
        <span className="shrink-0 text-ink-faint">{footLabel}</span>
        <span
          className={`figure truncate font-semibold ${
            footValue === undefined
              ? "text-ink-faint"
              : footHighlighted
                ? "text-accent"
                : "text-ink-muted"
          }`}
        >
          {footHeadline.text}
          {footValue !== undefined && footUnit ? ` ${footUnit}` : ""}
        </span>
      </div>
    </div>
  );
}

export function InverterCard({
  device,
  columns,
  tagsByCode,
  values,
  highlightTagId,
  position,
  positionNote,
  onSelect,
  selected,
}: {
  device: DeviceListItem;
  /** The INVERTER Type's curated columns, from the catalogue. */
  columns: DeviceTableColumn[];
  /** The Tag catalogue by code, for the positions that are not columns. */
  tagsByCode: ReadonlyMap<string, Tag>;
  /** Keyed by tag id as a string (§5.1). */
  values: Values;
  /** The Tag the chart is comparing on; its value takes the chart's colour. */
  highlightTagId?: number;
  /**
   * Place on the compared measure within this group; null when it reported
   * nothing. Omitted entirely where the screen compares nothing.
   */
  position?: number | null;
  positionNote?: string;
  onSelect: (device: DeviceListItem) => void;
  selected?: boolean;
}): JSX.Element {
  const comm = device.comm_status ?? "unknown";
  const style = COMM_CARD_STYLE[comm];
  const age = ageSeconds(device.last_seen_at);

  const pick = (codes: readonly string[]) => resolve(codes, columns, tagsByCode, values);
  const power = pick(POSITIONS.power);
  const efficiency = pick(POSITIONS.efficiency);
  const dcInput = pick(POSITIONS.dcInput);
  const energyToday = pick(POSITIONS.energyToday);
  const energyTotal = pick(POSITIONS.energyTotal);

  const powerValue = valueOf(power, values);
  const powerHighlighted = power !== null && power.tagId === highlightTagId;
  const rated = device.rated_capacity_kw ?? null;
  const { load, reason: loadReason } = loadOf(power, powerValue, rated);
  const over = load !== null && load > 1;
  const filled =
    load === null ? 0 : Math.max(0, Math.min(SEGMENTS, Math.round(load * SEGMENTS)));

  // The remaining curated columns. The one being compared is kept on the card
  // even when it is not among the first few, so its "#n" has a number beside it.
  const placed = new Set(
    [power, efficiency, dcInput, energyToday, energyTotal].map((field) => field?.code),
  );
  const remaining = columns.filter((column) => !placed.has(column.tag_code));
  const others = remaining.slice(0, MAX_OTHERS);
  const compared = remaining.find((column) => column.tag_id === highlightTagId);
  if (compared && !others.includes(compared)) others[others.length - 1] = compared;

  return (
    <button
      type="button"
      onClick={() => onSelect(device)}
      className={`surface-card surface-interactive group flex h-full w-full min-w-0 flex-col rounded-card border p-4 text-left [container-type:inline-size] focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        // A frame lights up only for bad news (design rule 2).
        comm === "online" ? "border-line hover:border-accent/55" : style.frame
      } ${selected ? "ring-2 ring-accent/40" : ""}`}
    >
      <div className="flex items-center gap-3.5 border-b border-line pb-4">
        {/* The drawing is the label; the status is the frame's, never the art's. */}
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-card [@container(min-width:20rem)]:h-[5.5rem] [@container(min-width:20rem)]:w-[5.5rem] border border-accent/25 bg-surface-sunken bg-[radial-gradient(circle_at_50%_40%,rgb(var(--c-accent)/0.16),transparent_70%)] shadow-[inset_0_1px_0_0_rgb(var(--c-edge-top)/var(--edge-top-alpha))]">
          <DeviceArt
            typeCode={device.type_code}
            size={76}
            className="h-auto w-[54px] [@container(min-width:20rem)]:w-[76px]"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate font-mono text-base font-bold tracking-tight text-ink [@container(min-width:20rem)]:text-lg"
            title={device.name && device.name !== device.code ? device.name : undefined}
          >
            {device.code}
          </div>
          <div
            className="mt-1 flex min-w-0 items-center gap-1.5 text-xs"
            title={`${style.note} Staleness is judged against this Device's own ${device.expected_interval_s}s interval, never a fixed clock.`}
          >
            <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
            <span className={`shrink-0 font-semibold capitalize ${STATUS_TEXT[comm]}`}>
              {style.label}
            </span>
            <span className="truncate text-ink-faint">
              · {age === null ? "never seen" : formatAge(age)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {position !== undefined ? (
            <span
              className="rounded-md border border-line bg-surface-sunken px-2 py-1 font-mono text-xs font-bold text-ink"
              title={positionNote}
            >
              {position === null ? UNDEFINED_DISPLAY : `#${position}`}
            </span>
          ) : null}
          {/* Drawn as a button, but the whole card is the button: a button
              inside a button is invalid, and would be a second tab stop to
              the same place. */}
          <span
            aria-hidden
            className="flex h-8 w-8 items-center justify-center rounded-control border border-line bg-surface-sunken text-ink-muted transition group-hover:border-accent/50 group-hover:text-accent"
          >
            <IconChevronRight size={15} />
          </span>
        </div>
      </div>

      <section className="mt-4 rounded-card border border-line bg-surface-sunken p-3.5 [@container(min-width:20rem)]:p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="tile-label flex min-w-0 items-center gap-1.5" title={power?.name}>
            {powerHighlighted ? <ComparedDot /> : null}
            <span className="truncate">AC active power</span>
          </span>
          <span className="shrink-0 text-xs font-medium text-ink-muted">
            {rated !== null ? `Rated ${formatNumber(rated, { digits: 1 })} kW` : "No rating recorded"}
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <Figure
            field={power}
            value={powerValue}
            highlighted={powerHighlighted}
            missing={missingReason(power, POSITIONS.power)}
            size="text-[1.75rem] [@container(min-width:20rem)]:text-[2rem]"
          />
          {load !== null ? (
            <span
              className={`shrink-0 rounded-md border px-2 py-0.5 text-xs font-semibold ${
                over ? "border-warn/50 bg-warn/10 text-warn" : "border-accent/35 bg-accent/10 text-accent"
              }`}
              title={
                over
                  ? "Above the recorded rating. Either the Inverter is running over its nameplate or the recorded capacity is wrong. Shown unaltered."
                  : `AC output over the recorded rating of ${formatNumber(rated, { digits: 1 })} kW.`
              }
            >
              {formatNumber(load * 100, { digits: 1 })}% load
            </span>
          ) : null}
        </div>

        <div className="mt-4 flex gap-[3px]" aria-hidden>
          {Array.from({ length: SEGMENTS }, (_, index) => (
            <span
              key={index}
              className={`h-3 flex-1 rounded-[2px] ${
                index < filled ? (over ? "bg-warn" : "bg-accent") : "bg-line/70"
              }`}
            />
          ))}
        </div>

        <div className="mt-2 flex min-h-[1.25rem] items-center justify-between gap-2 border-t border-line pt-1.5 text-[11px] text-ink-faint">
          {rated !== null && loadReason === null ? (
            [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
              const mark = rated * fraction;
              return (
                <span
                  key={fraction}
                  className={`figure ${fraction === 1 ? "font-semibold text-ink-muted" : ""}`}
                >
                  {formatNumber(mark, { digits: Number.isInteger(mark) ? 0 : 1 })} kW
                </span>
              );
            })
          ) : (
            <span className="truncate" title={loadReason?.full}>
              {loadReason?.short ?? UNDEFINED_DISPLAY}
            </span>
          )}
        </div>
      </section>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <FigureTile
          label="Efficiency"
          field={efficiency}
          codes={POSITIONS.efficiency}
          values={values}
          highlightTagId={highlightTagId}
          footLabel="DC input"
          foot={dcInput}
          footCodes={POSITIONS.dcInput}
        />
        <FigureTile
          label="Energy today"
          field={energyToday}
          codes={POSITIONS.energyToday}
          values={values}
          highlightTagId={highlightTagId}
          footLabel="Lifetime"
          foot={energyTotal}
          footCodes={POSITIONS.energyTotal}
        />
      </div>

      {/* Pinned to the bottom, so cards in one row keep their rules aligned. */}
      <div className="mt-auto pt-3">
        {device.binding_count === 0 ? (
          // Two different silences, and which one it is decides where to go.
          <p className="text-xs leading-snug text-ink-faint">
            No Tags are bound, so every message this Device sends decodes into nothing. Map
            its payload keys in Tag Mapping.
          </p>
        ) : others.length > 0 ? (
          <dl className="grid grid-cols-3 gap-3 px-1">
            {others.map((column) => {
              const value = values?.[String(column.tag_id)];
              // A Digital Input is a contact, not a quantity (§4.5): never "0.00 bool".
              const digital = column.category === "status";
              const highlighted = column.tag_id === highlightTagId;
              const unit = column.unit && !NOT_A_UNIT.has(column.unit) ? column.unit : null;
              return (
                <div key={column.tag_id} className="min-w-0">
                  <dt
                    className="flex items-center gap-1.5 truncate text-[11px] text-ink-faint"
                    title={column.name}
                  >
                    {highlighted ? <ComparedDot /> : null}
                    <span className="truncate">{column.name}</span>
                  </dt>
                  <dd
                    className={`figure mt-0.5 truncate text-sm font-semibold ${
                      value === undefined
                        ? "text-ink-faint"
                        : highlighted
                          ? "text-accent"
                          : "text-ink"
                    }`}
                    title={
                      value === undefined
                        ? "No value for this Tag yet. Silence is not zero."
                        : `${column.name}${!digital && unit ? ` (${unit})` : ""}`
                    }
                  >
                    {value === undefined
                      ? UNDEFINED_DISPLAY
                      : digital
                        ? formatDigital(value)
                        : `${formatNumber(value, { digits: digitsForUnit(column.unit) })}${unit ? ` ${unit}` : ""}`}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : null}
      </div>
    </button>
  );
}
