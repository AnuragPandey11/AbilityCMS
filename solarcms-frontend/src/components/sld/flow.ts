/**
 * What makes a link on the four-stage schematic move, and how fast.
 *
 * A link moves only while a figure says power is passing along it — never
 * because the comms are healthy, since a healthy Plant produces nothing every
 * night. Its speed and density follow that figure as a share of the Plant's DC
 * nameplate, so a morning and a midday look different at a glance.
 *
 * ── Which figure ────────────────────────────────────────────────────────────
 * The stage the power leaves, when it has a power or current figure at all.
 * ⚠ The Transformer stage has none — HV voltage, oil and winding temperature
 * and a count — so until 21 Oct 2026 the Transformer → Grid arrow could never
 * move, at midday on every Plant. Where the stage a link leaves has no such
 * figure, the stage it feeds answers instead: what the Grid meter exports has
 * come through the transformer. A stage that has the figure but has gone quiet
 * still answers, as "no reading", rather than borrowing its neighbour's: that
 * would draw flow through equipment nobody can currently see.
 *
 * Only flow toward the grid counts. A meter's export power below zero is
 * import, and a reading under `FLOW_FLOOR` is float noise — one client's
 * meters send 1.5E-17 kW for zero.
 */

import type { ResolvedSlot, SldStage } from "@/api/schemas";

/** Below this, in the figure's own unit, nothing is flowing. */
export const FLOW_FLOOR = 0.001;

const TO_KW: Record<string, number> = { w: 0.001, kw: 1, mw: 1000 };

export interface LinkFlow {
  moving: boolean;
  /** Share of the Plant's DC nameplate, 0–1. Null when nothing scales it. */
  share: number | null;
  /** The figure that decided, for the hover: "Export Power (Grid)". */
  basis: string | null;
}

const unitOf = (slot: ResolvedSlot): string => (slot.unit ?? "").toLowerCase();
const isRate = (slot: ResolvedSlot): boolean => unitOf(slot) in TO_KW || unitOf(slot) === "a";

export function linkFlow(
  from: SldStage,
  to: SldStage | undefined,
  capacityKw: number | null,
): LinkFlow {
  const own = from.slots.filter(isRate);
  const borrowed = own.length === 0;
  const candidates = borrowed ? (to?.slots.filter(isRate) ?? []) : own;
  const measured = candidates.find((slot) => slot.value !== null);
  if (!measured || measured.value === null) return { moving: false, share: null, basis: null };

  const moving = measured.value > FLOW_FLOOR;
  const factor = TO_KW[unitOf(measured)];
  const kw = factor === undefined ? null : measured.value * factor;
  const share =
    moving && kw !== null && capacityKw !== null && capacityKw > 0 ? Math.min(1, kw / capacityKw) : null;
  return {
    moving,
    share,
    basis: borrowed && to ? `${measured.label} (${to.label})` : measured.label,
  };
}

/** The Plant's DC nameplate in kW, from the PV Array box, or null. */
export function plantCapacityKw(stages: SldStage[]): number | null {
  const slot = stages
    .find((stage) => stage.code === "PV_ARRAY")
    ?.slots.find((candidate) => candidate.slot_code === "sld.pv.capacity");
  if (!slot || slot.value === null || slot.value <= 0) return null;
  const unit = unitOf(slot);
  if (unit.startsWith("mw")) return slot.value * 1000;
  if (unit.startsWith("w")) return slot.value / 1000;
  return slot.value;
}
