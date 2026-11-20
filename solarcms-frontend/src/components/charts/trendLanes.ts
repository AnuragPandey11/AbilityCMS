/**
 * The rules behind the one-big-graph trend (`LanedTrendChart`): which
 * readings share a plot, how tall each plot is, what colour a reading wears,
 * and what is ticked when nothing has been chosen yet.
 *
 * Pure — the chart only draws what this returns, so the rules are tested here
 * (`tests/trendlanes.test.ts`), the way `stateSeries` is.
 *
 * ── Why lanes, and not one frame ────────────────────────────────────────────
 * Guardrail 22 forbids two independently fitted y-axes: the alignment between
 * two fitted scales is arbitrary, so the chart asserts a correlation nobody
 * measured. The Power trend may overlay radiation only because its second axis
 * is *derived* from the first through the DC nameplate. Weather, a meter or a
 * transformer have no such lock between W/m², °C and m/s, so:
 *
 *   - readings in **the same unit** share a plot and one axis — the distance
 *     between GHI and GTI is a real difference in W/m²;
 *   - each **different unit** gets a plot of its own, stacked on one shared
 *     time axis with one zoom and one crosshair, so "irradiance peaked here,
 *     temperature peaked there" lines up without the chart claiming a ratio;
 *   - each **contact** (TRUE/FALSE) gets a thin step plot of its own.
 *
 * ⚠ **Lanes are grouped by the unit exactly as the catalogue stores it**, never
 * by the unit a screen prints. `NOT_A_UNIT` hides `ratio`, `code` and `bool`
 * from display, so grouping by the printed unit would put a power factor and a
 * status code in one plot because both print as nothing.
 */

import type { TrendPoint } from "@/api/useSlotTrend";

export type LaneKind = "analog" | "state";

/** What the layout needs to know about a reading — no points, no data. */
export interface LaneInput {
  key: string;
  label: string;
  /** The catalogue's unit, verbatim. `null` where the Tag has none. */
  unit: string | null;
  kind: LaneKind;
  /** Set when it cannot be drawn here, and why. It stays in the menu, off. */
  unavailableReason?: string | null;
  /** A palette slot, where a screen has colours of its own (the Inverter view). */
  slot?: number;
  /** The brand accent or the muted ink, for the same reason. */
  colorToken?: "accent" | "neutral";
}

/**
 * How the measurements are laid out: `overlay` — one plot, a scale per unit;
 * `stacked` — a plot per unit; `shapes` — one plot, one scale, every reading
 * rescaled to a percentage of its own peak.
 */
export type TrendLayout = "overlay" | "stacked" | "shapes";

export interface Lane {
  /** Stable across renders while the same readings are ticked. */
  id: string;
  kind: LaneKind;
  /** The catalogue unit the lane is on; `null` for a contact or an overlay. */
  unit: string | null;
  /** The keys drawn in it, in option order. */
  members: string[];
  /**
   * Set only on the one shared plot of the overlaid layout: the units drawn in
   * it, each on a scale of its own, in the order they first appear. Readings
   * of one unit still share one scale, so the distance between GHI and GTI is
   * a real difference in W/m².
   */
  axes?: { unit: string | null; members: string[] }[];
  /**
   * Set only on the one shared plot of the `shapes` layout: every reading is
   * drawn as a percentage of its own peak on a single 0–100% scale.
   */
  normalised?: boolean;
}

// ── What is ticked ───────────────────────────────────────────────────────────

/**
 * The ticked readings, restricted to what can be drawn.
 *
 * `chosen === null` means the reader has not touched the menu: the screen's
 * defaults apply, and if none of them can be drawn here (a Plant with no GHI
 * sensor) the first reading that can be is shown, so the card never opens on
 * nothing while something is available. Once the reader has chosen, that is
 * theirs — including nothing at all, which the chart says in words.
 */
export function effectiveSelection(
  options: readonly Pick<LaneInput, "key" | "unavailableReason">[],
  chosen: ReadonlySet<string> | null,
  defaults: readonly string[],
): Set<string> {
  const available = new Set(options.filter((option) => !option.unavailableReason).map((option) => option.key));
  if (chosen !== null) return new Set([...chosen].filter((key) => available.has(key)));
  const wanted = defaults.filter((key) => available.has(key));
  if (wanted.length > 0) return new Set(wanted);
  const first = options.find((option) => available.has(option.key));
  return first ? new Set([first.key]) : new Set();
}

// ── Lanes ────────────────────────────────────────────────────────────────────

const unitId = (unit: string | null) => `unit:${unit ?? ""}`;

/**
 * The plots for what is ticked.
 *
 * `stacked`: one plot per distinct unit (in the order the units first appear
 * in the option list). `overlay`: **one** plot holding every measurement, a
 * scale per unit — so any two readings can be compared on one frame. Either
 * way each contact then gets a thin plot of its own, in option order, so the
 * step plots sit together at the bottom beside the time axis.
 */
export function buildLanes(
  options: readonly LaneInput[],
  selected: ReadonlySet<string>,
  layout: TrendLayout = "stacked",
): Lane[] {
  const chosen = options.filter((option) => selected.has(option.key) && !option.unavailableReason);
  const lanes: Lane[] = [];
  for (const option of chosen) {
    if (option.kind !== "analog") continue;
    const id = unitId(option.unit);
    const found = lanes.find((lane) => lane.id === id);
    if (found) found.members.push(option.key);
    else lanes.push({ id, kind: "analog", unit: option.unit, members: [option.key] });
  }
  if (layout === "shapes" && lanes.length > 0) {
    const shapes: Lane = {
      id: "shapes",
      kind: "analog",
      unit: null,
      members: chosen.filter((option) => option.kind === "analog").map((option) => option.key),
      normalised: true,
    };
    lanes.length = 0;
    lanes.push(shapes);
  } else if (layout === "overlay" && lanes.length > 0) {
    const overlay: Lane = {
      id: "overlay",
      kind: "analog",
      // One unit is just the plain plot and keeps it; several name none.
      unit: lanes.length === 1 ? (lanes[0]?.unit ?? null) : null,
      members: chosen.filter((option) => option.kind === "analog").map((option) => option.key),
      axes: lanes.map((lane) => ({ unit: lane.unit, members: lane.members })),
    };
    lanes.length = 0;
    lanes.push(overlay);
  }
  for (const option of chosen) {
    if (option.kind !== "state") continue;
    lanes.push({ id: `state:${option.key}`, kind: "state", unit: null, members: [option.key] });
  }
  return lanes;
}

/** A plot's heading: its unit, or — where it has none — the readings in it. */
export function laneTitle(lane: Lane, options: readonly LaneInput[]): string {
  const members = lane.members.map((key) => options.find((option) => option.key === key)?.label ?? key);
  if (lane.kind === "state") return members[0] ?? "";
  // Every reading on the one scale, as a share of its own peak.
  if (lane.normalised) return "Each reading as % of its own peak";
  // The shared plot names no single unit: each axis carries its own.
  if (lane.axes && lane.axes.length > 1) return "Each unit on its own scale";
  // A power factor's unit is `ratio`, which is a type name, not something to
  // print: the readings' names say what the plot is.
  return lane.unit && !["ratio", "code", "bool"].includes(lane.unit) ? lane.unit : members.join(" · ");
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Room above the first plot, for its heading. */
export const LANE_TOP = 22;
/** Between plots: the next plot's heading sits in it. */
export const LANE_GAP = 30;
/** Under the last plot: the time labels and the zoom slider. */
export const LANE_BOTTOM = 52;
export const ANALOG_HEIGHT_ALONE = 320;
export const ANALOG_HEIGHT_STACKED = 190;
/** The one shared plot of the overlaid layout: alone, and above contact plots. */
export const OVERLAY_HEIGHT_ALONE = 400;
export const OVERLAY_HEIGHT_STACKED = 320;
export const STATE_HEIGHT = 66;

export interface LaneLayout {
  /** Each plot's top and height in px, in lane order. */
  rects: { top: number; height: number }[];
  /** The chart's whole height. */
  total: number;
}

export function laneLayout(lanes: readonly Lane[]): LaneLayout {
  // A lone plot has the room to be read; one of several shares it.
  const analogHeight = lanes.length === 1 ? ANALOG_HEIGHT_ALONE : ANALOG_HEIGHT_STACKED;
  const overlayHeight = lanes.length === 1 ? OVERLAY_HEIGHT_ALONE : OVERLAY_HEIGHT_STACKED;
  const rects: { top: number; height: number }[] = [];
  let top = LANE_TOP;
  for (const lane of lanes) {
    const height =
      lane.kind === "state" ? STATE_HEIGHT : lane.axes || lane.normalised ? overlayHeight : analogHeight;
    rects.push({ top, height });
    top += height + LANE_GAP;
  }
  const bottom = rects.length > 0 ? top - LANE_GAP : LANE_TOP;
  return { rects, total: bottom + LANE_BOTTOM };
}

// ── Colour ───────────────────────────────────────────────────────────────────

/** How many slots the validated categorical palette has. */
export const PALETTE_SLOTS = 8;

/**
 * A reading's palette slot: its own where the screen gave one, otherwise its
 * place among the analog readings **in the option list** — never among the
 * ticked ones. Ticking GTI must not recolour GHI, and a colour the reader has
 * learned for a reading is one they can keep reading by.
 */
export function slotFor(options: readonly LaneInput[], key: string): number {
  const option = options.find((candidate) => candidate.key === key);
  if (option?.slot !== undefined) return option.slot;
  const analog = options.filter((candidate) => candidate.kind === "analog");
  const index = analog.findIndex((candidate) => candidate.key === key);
  return (index < 0 ? 0 : index) % PALETTE_SLOTS;
}

// ── Reading a value off the chart ────────────────────────────────────────────

/**
 * What an analog series says at time `at`: its value, `null` where it has a
 * hole there, or `undefined` where it has no point near enough to speak for
 * that instant (the rest of today, the other side of a different tier's
 * bucket). Distinguishing the two is the whole point — a hole is a Plant that
 * did not report, and "beyond the data" is simply the future.
 */
export function analogValueAt(
  points: readonly { at: number; value: number | null }[],
  at: number,
  toleranceMs: number,
): number | null | undefined {
  let best: { at: number; value: number | null } | null = null;
  for (const point of points) {
    if (best === null || Math.abs(point.at - at) < Math.abs(best.at - at)) best = point;
  }
  if (best === null || Math.abs(best.at - at) > toleranceMs) return undefined;
  return best.value;
}

/**
 * What a contact's step says at `at`: the state it was left in by the latest
 * point at or before it (a step holds until it changes), `null` inside a gap,
 * `undefined` before the first reading or past the last by more than the
 * tolerance (a step is not held through a silence — Guardrail 23).
 */
export function stateAt(
  points: readonly { at: number; state: 0 | 1 | null }[],
  at: number,
  toleranceMs: number,
): 0 | 1 | null | undefined {
  let held: { at: number; state: 0 | 1 | null } | null = null;
  for (const point of points) {
    if (point.at <= at && (held === null || point.at >= held.at)) held = point;
  }
  if (held === null) return undefined;
  const last = points[points.length - 1];
  if (held === last && at - held.at > toleranceMs) return undefined;
  return held.state;
}

/** ISO bucket points as epoch-ms points, parsed once rather than on every hover. */
export function toMs(points: readonly TrendPoint[]): { at: number; value: number | null }[] {
  return points.map((point) => ({ at: Date.parse(point.at), value: point.value }));
}

// ── Compare shapes ───────────────────────────────────────────────────────────

/**
 * Below this a reading's peak is float noise, not a signal. Meters at some
 * Plants send `1.5E-17` for zero, and rescaling that to 100% would draw the
 * noise as a full-height shape — the same trap that once froze a screen
 * (any comparison of a measured value with zero must allow for float noise).
 */
export const NORMALISE_MIN_PEAK = 1e-9;

/**
 * A reading's own peak: its largest magnitude over the window, which is what
 * 100% means in the `shapes` layout. `null` where it has no readings, or is
 * flat at zero (or float noise) — a flat line has no shape to compare, and
 * dividing by nothing would invent one.
 */
export function peakMagnitude(values: readonly (number | null)[]): number | null {
  let peak = 0;
  let seen = false;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    seen = true;
    peak = Math.max(peak, Math.abs(value));
  }
  return seen && peak > NORMALISE_MIN_PEAK ? peak : null;
}

/** A value as a percentage of the reading's own peak. A gap stays a gap. */
export function asPercentOfPeak(value: number | null, peak: number): number | null {
  return value === null || !Number.isFinite(value) ? null : (value / peak) * 100;
}
