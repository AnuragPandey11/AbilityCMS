/**
 * The graphics under the Portfolio's four headline figures.
 *
 * Every one draws the numbers its figure was made from and nothing else. The
 * capacity, energy and CO₂ totals are sums over Plants, so their donuts are
 * those Plants; the live figure is a sum of each Plant's Current Power, so its
 * ring is those same values laid against the AC capacity of the Plants that
 * reported them. Only current values — a timeline would need a day of
 * uninterrupted history to look like anything but breakage.
 *
 * ── A Plant is one colour on the whole row ──────────────────────────────────
 * Colour follows the Plant, never its rank in a particular donut: Plants are
 * ordered once, by DC capacity, and slot *n* of the validated categorical
 * palette goes to the *n*th. So a Plant that is a fifth of the capacity and a
 * tenth of the energy is the same colour in both, and the difference is
 * visible at a glance. Past five Plants the tail folds into one grey "Other",
 * which is not a Plant and is not coloured as one — a generated sixth hue is
 * indistinguishable under CVD by construction. Identity is never colour
 * alone: every segment is named in the legend beside it.
 */

import {
  UNDEFINED_DISPLAY,
  formatHeadline,
  formatRatioAsPercent,
  ratioIsImplausible,
} from "@/format/value";

/** One graphic's height, so the four in a row end level. */
export const HEADLINE_CHART_HEIGHT = 112;

// ── Plants and their colours ────────────────────────────────────────────────

/** A Plant as the row draws it. */
export interface FleetPlant {
  id: number;
  name: string;
  code: string;
}

export type MarkKey = number | "other";

/** One segment and one legend row: a Plant, or every Plant past the fifth. */
export interface PlantMark {
  key: MarkKey;
  label: string;
  short: string;
  colour: string;
  /** null where no Plant this mark stands for reported a figure. */
  value: number | null;
  /** The Plants this mark stands for — one, or several for Other. */
  plantIds: number[];
}

/** The most marks a donut draws; past it, the tail is "Other". */
const MAX_MARKS = 5;
const OTHER_COLOUR = "rgb(var(--c-line-strong))";

/**
 * The marks for one figure, in the caller's fixed Plant order.
 *
 * The order and the colours depend only on `plants`, never on the values, so
 * every donut on the row agrees about who is which colour — and so does
 * membership of "Other".
 */
export function plantMarks(
  plants: FleetPlant[],
  valueOf: (plantId: number) => number | null | undefined,
): PlantMark[] {
  const coloured = plants.length <= MAX_MARKS ? plants : plants.slice(0, MAX_MARKS - 1);
  const rest = plants.slice(coloured.length);
  const marks: PlantMark[] = coloured.map((plant, index) => ({
    key: plant.id,
    label: plant.name,
    short: plant.code,
    colour: `rgb(var(--c-series-${index + 1}))`,
    value: valueOf(plant.id) ?? null,
    plantIds: [plant.id],
  }));
  if (rest.length > 0) {
    const known = rest
      .map((plant) => valueOf(plant.id))
      .filter((value): value is number => value !== null && value !== undefined);
    marks.push({
      key: "other",
      label: `Other (${rest.length} Plants)`,
      short: "Other",
      colour: OTHER_COLOUR,
      value: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
      plantIds: rest.map((plant) => plant.id),
    });
  }
  return marks;
}

/** An amount in a column of them: whole units, so the digits line up. */
function amountText(value: number): string {
  return formatHeadline(value, { digits: Math.abs(value) >= 10 ? 0 : 1 }).text;
}

function shareText(share: number): string {
  return formatRatioAsPercent(share, share > 0 && share < 0.1 ? 1 : 0);
}

// ── Donut ───────────────────────────────────────────────────────────────────

const RING_RADIUS = 38;
const RING_WIDTH = 13;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** The surface-coloured gap between segments, in the ring's own units. */
const RING_GAP = 1.6;

/**
 * A figure split by Plant: the ring, and a legend naming every segment.
 *
 * With a `capacity`, the whole ring stands for that capacity instead of for
 * the total, so the filled part is how much of it is in use and the empty
 * track is what is not — the live-generation form. The legend then carries
 * each Plant's amount rather than its share, because a share of what would be
 * ambiguous. A ratio past the ring's end is never drawn clamped (Guardrail
 * 33): it is shown in the centre, flagged, with no fill at all.
 *
 * Part-to-whole with at most five segments, which is the case a donut is
 * legitimate for. The centre names the largest share until the pointer names
 * another. Pointing at a Plant — on the ring or in the legend — lights that
 * Plant in every donut on the row; clicking opens it.
 *
 * It will not split nothing. A total of zero, which is every energy figure
 * before sunrise, is an empty track and a sentence rather than a ring of
 * equal slices; and a Plant with no figure is a dash in the legend, never a
 * zero-width segment that looks measured.
 */
export function PlantDonut({
  marks,
  unit,
  label,
  capacity = null,
  loading = false,
  empty,
  highlight,
  onHighlight,
  onSelect,
}: {
  marks: PlantMark[];
  unit: string;
  /** What the figure is, for the accessible name. */
  label: string;
  /** Draw against this instead of the total: the ring is the capacity. */
  capacity?: number | null;
  loading?: boolean;
  /** What the centre says when there is nothing to split. */
  empty: string;
  highlight: MarkKey | null;
  onHighlight: (key: MarkKey | null) => void;
  onSelect?: (plantId: number) => void;
}): JSX.Element {
  const positive = marks.filter((mark) => mark.value !== null && mark.value > 0);
  const total = positive.reduce((sum, mark) => sum + (mark.value ?? 0), 0);
  const allUndefined = marks.length > 0 && marks.every((mark) => mark.value === null);
  const ofCapacity = capacity !== null && capacity > 0;
  const used = ofCapacity ? total / capacity : null;
  const offScale = used !== null && ratioIsImplausible(used);
  // Against a capacity, zero output is a reading (0% in use); as a split, a
  // total of zero is nothing to split.
  const drawn = !loading && !allUndefined && (ofCapacity ? !offScale : total > 0);
  // A little over capacity is physically possible and fills the ring exactly
  // once, with the true figure in the centre; the ring cannot lap itself.
  const whole = ofCapacity && used !== null && used <= 1 ? capacity : total;

  // The largest *Plant*: "Other" is several Plants added up, and naming it
  // as the biggest contributor would say nothing about any of them.
  const largest = positive
    .filter((mark) => mark.key !== "other")
    .reduce<PlantMark | null>(
      (best, mark) => (best === null || (mark.value ?? 0) > (best.value ?? 0) ? mark : best),
      null,
    );
  const focus = marks.find((mark) => mark.key === highlight) ?? null;
  const centreMark = focus ?? largest;
  const shareOf = (mark: PlantMark) =>
    total > 0 && mark.value !== null && mark.value > 0
      ? shareText(mark.value / total)
      : UNDEFINED_DISPLAY;
  const amount = (mark: PlantMark) =>
    mark.value === null ? "no figure" : `${formatHeadline(mark.value).text} ${unit}`;
  const legendValue = (mark: PlantMark) =>
    ofCapacity
      ? mark.value === null
        ? UNDEFINED_DISPLAY
        : amountText(mark.value)
      : shareOf(mark);

  const gap = positive.length > 1 ? RING_GAP : 0;
  let offset = 0;
  const segments = drawn
    ? positive.map((mark) => {
        const length = ((mark.value ?? 0) / whole) * RING_CIRCUMFERENCE;
        const segment = { mark, length: Math.max(0.6, length - gap), offset };
        offset += length;
        return segment;
      })
    : [];

  const hoverProps = (mark: PlantMark) => ({
    onMouseEnter: () => onHighlight(mark.key),
    onMouseLeave: () => onHighlight(null),
    onFocus: () => onHighlight(mark.key),
    onBlur: () => onHighlight(null),
  });
  const dimmed = (mark: PlantMark) => highlight !== null && highlight !== mark.key;

  return (
    <div className="flex items-center gap-4" style={{ height: HEADLINE_CHART_HEIGHT }}>
      <div className="relative h-[6.25rem] w-[6.25rem] shrink-0">
        <svg
          viewBox="0 0 100 100"
          className="chart-spin-in h-full w-full"
          role="img"
          aria-label={`${label}${
            used !== null ? `, ${formatRatioAsPercent(used, 0)} of capacity` : ""
          } by Plant: ${marks.map((mark) => `${mark.label} ${legendValue(mark)}`).join(", ")}`}
        >
          {/* Rotated in SVG, not CSS, so the entry animation's transform cannot fight it. */}
          <g transform="rotate(-90 50 50)">
            <circle
              cx="50"
              cy="50"
              r={RING_RADIUS}
              fill="none"
              strokeWidth={RING_WIDTH}
              className="stroke-surface-sunken"
            />
            {segments.map(({ mark, length, offset: start }) => (
              <circle
                key={mark.key}
                cx="50"
                cy="50"
                r={RING_RADIUS}
                fill="none"
                strokeWidth={dimmed(mark) ? RING_WIDTH : RING_WIDTH + (highlight === mark.key ? 3 : 0)}
                stroke={mark.colour}
                strokeDasharray={`${length} ${RING_CIRCUMFERENCE - length}`}
                strokeDashoffset={-start}
                className={`cursor-pointer transition-[opacity,stroke-width] duration-150 ${
                  dimmed(mark) ? "opacity-25" : ""
                }`}
                {...hoverProps(mark)}
                onClick={
                  onSelect && mark.key !== "other" ? () => onSelect(mark.key as number) : undefined
                }
              />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {loading ? (
            <span className="figure text-lg font-semibold text-ink-faint">…</span>
          ) : ofCapacity && !allUndefined && !(focus && drawn) ? (
            <span
              className="flex flex-col items-center"
              title={
                offScale
                  ? "Live output is outside the AC capacity of the Plants reporting it — check each Plant's capacity and its power source."
                  : undefined
              }
            >
              <span
                className={`figure text-[1.35rem] font-semibold leading-none ${
                  offScale ? "text-warn" : "text-ink"
                }`}
              >
                {formatRatioAsPercent(used, 0)}
              </span>
              <span className="mt-1 text-[9px] leading-none text-ink-muted">of capacity</span>
            </span>
          ) : drawn && centreMark ? (
            <>
              <span className="figure text-[1.35rem] font-semibold leading-none text-ink">
                {ofCapacity ? amountText(centreMark.value ?? 0) : shareOf(centreMark)}
              </span>
              <span className="mt-1 max-w-[3.75rem] truncate font-mono text-[9px] leading-none text-ink-muted">
                {centreMark.short}
              </span>
            </>
          ) : (
            <span className="max-w-[4rem] text-[10px] leading-tight text-ink-faint">
              {allUndefined ? "No figure" : empty}
            </span>
          )}
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-1">
        {marks.map((mark) => {
          const plantId = mark.key === "other" ? null : mark.key;
          return (
            <li key={mark.key}>
              <button
                type="button"
                {...hoverProps(mark)}
                onClick={plantId !== null && onSelect ? () => onSelect(plantId) : undefined}
                title={`${mark.label}: ${amount(mark)}${
                  total > 0 && mark.value ? ` · ${shareOf(mark)} of the total` : ""
                }`}
                className={`flex w-full items-center gap-2 rounded px-1 py-[3px] text-left text-xs transition-opacity duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  dimmed(mark) ? "opacity-40" : ""
                } ${highlight === mark.key ? "bg-surface-sunken" : ""}`}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: mark.colour }}
                />
                {/* The code, not the name: "Warehouse 1 Rooftop" and "Warehouse 2
                    Rooftop" both truncate to "Warehou…" in a quarter-width tile. */}
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
                  {mark.short}
                </span>
                <span className="figure shrink-0 font-semibold text-ink">
                  {loading ? "…" : legendValue(mark)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
