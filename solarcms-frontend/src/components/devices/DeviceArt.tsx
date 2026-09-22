/**
 * Full-colour equipment artwork, one drawing per Device Type.
 *
 * ── Why this exists beside `DeviceIcon` rather than replacing it ────────────
 * `DeviceIcon` renders a single-colour glyph tinted with `currentColor`, which
 * is exactly right for the places it is used: a row in a list, a chip in a
 * picker, a label beside a status badge. Those containers are already coloured
 * by state, and a glyph that did not follow them would be the one element on
 * the screen that stayed the same shade when a Device went offline.
 *
 * This component answers the other half. In a diagram, a stage header or a
 * Device card, the picture *is* the label — nothing else on the tile says
 * "transformer" — and a monochrome silhouette of a transformer is
 * indistinguishable from a monochrome silhouette of a switchgear cubicle at the
 * size these are drawn. So these are painted in the materials the equipment is
 * actually made of (`art/palette.ts`), and the *container* carries the status
 * colour instead.
 *
 * Both are driven from the same `device_types.code` the API sends, so neither
 * can drift from the catalogue without the other noticing.
 *
 * ── The stage codes are here too, and they are not Device Types ─────────────
 * `PV_ARRAY`, `INVERTERS`, `TRANSFORMER` and `GRID` are the four SLD *stages*
 * (`domain/sld_stages.py`), and only two of them share a spelling with a Device
 * Type. `GRID` in particular is not equipment anybody owns — it is the boundary
 * the plant exports across — so it gets the pylon, which is the one drawing in
 * the set depicting something outside the fence.
 */

import type { ReactNode } from "react";
import {
  Annunciator,
  CircuitBreaker,
  Controller,
  ControlRoom,
  DcPowerBank,
  DistributionBoard,
  FireSystem,
  GenericCabinet,
  Grid,
  Inverter,
  Isolator,
  KpiPanel,
  Meter,
  ModuleTracker,
  PvArray,
  StringBox,
  TelemetryUnit,
  Transformer,
  Ups,
  WeatherStation,
} from "./art/drawings";

/**
 * Device Type code → drawing.
 *
 * Keyed by the canonical code, never a display label. A code with no entry
 * falls through to the generic cubicle, which is drawn to the same standard as
 * everything else: a type this file has not caught up with should look
 * unremarkable, not broken.
 */
const DRAWINGS: Record<string, () => JSX.Element> = {
  // ── Generation ──────────────────────────────────────────────────────────
  PV_ARRAY: PvArray,
  SMB: StringBox,
  DCDB: () => <DistributionBoard />,
  MODULE_TRACKER: ModuleTracker,

  // ── Conversion ──────────────────────────────────────────────────────────
  INVERTER: Inverter,
  INVERTERS: Inverter, // the SLD stage
  ACDB: () => <DistributionBoard ac />,
  PPC: Controller,

  // ── Step-up and switching ───────────────────────────────────────────────
  TRANSFORMER: Transformer,
  VCB: CircuitBreaker,
  ISOLATOR: Isolator,

  // ── Metering ────────────────────────────────────────────────────────────
  MFM: () => <Meter />,
  // The seal is drawn, not captioned: this is the sealed settlement instrument
  // and Financial Reports may be computed from nothing else (I-8).
  ABT_METER: () => <Meter sealed />,
  NET_METER: () => <Meter bidirectional />,

  // ── Rooms and boundaries ────────────────────────────────────────────────
  MCR_SECTION: ControlRoom,
  ICR_SECTION: ControlRoom,
  GRID: Grid,

  // ── Instrumentation and auxiliaries ─────────────────────────────────────
  WMS: WeatherStation,
  PLANT_KPI: KpiPanel,
  UPS: Ups,
  DC_POWER_BANK: DcPowerBank,
  ANNUNCIATOR: Annunciator,
  FIRE_SYSTEM: FireSystem,
  SLDC_TELEMETRY: TelemetryUnit,
};

/** Whether a drawing exists, for callers choosing between art and a glyph. */
export function hasDeviceArt(typeCode: string): boolean {
  return typeCode in DRAWINGS;
}

export function DeviceArt({
  typeCode,
  size = 72,
  className = "",
  title,
}: {
  /** Canonical `device_types.code`, or one of the four SLD stage codes. */
  typeCode: string;
  /** Rendered width in px; the drawing is 5:4 and scales to it. */
  size?: number;
  className?: string;
  /** Set only where the drawing is the sole label; otherwise it is decorative. */
  title?: string;
}): JSX.Element {
  const Drawing = DRAWINGS[typeCode] ?? GenericCabinet;
  return (
    <svg
      width={size}
      height={size * 0.8}
      viewBox="0 0 120 96"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`shrink-0 ${className}`}
      // `visibleFill` keeps a drawing from being clipped by a parent that has
      // sized it tightly; several of these overhang their nominal box on
      // purpose (the pylon's conductors, the weather station's boom).
      style={{ overflow: "visible" }}
    >
      {title ? <title>{title}</title> : null}
      <Drawing />
    </svg>
  );
}

/**
 * A drawing on a status-coloured plinth — the form used in diagrams and on
 * Device cards.
 *
 * The status lives on the *frame*, never on the artwork. Painting the drawing
 * itself green would assert something the artwork has no access to: whether a
 * Device is reporting is known by the caller, and a transformer that turns
 * green when healthy stops looking like a transformer.
 */
export type ArtTone = "ok" | "warn" | "bad" | "idle" | "neutral";

const TONE_FRAME: Record<ArtTone, string> = {
  ok: "border-ok/40 bg-ok/[0.06]",
  warn: "border-warn/50 bg-warn/[0.07]",
  bad: "border-bad/50 bg-bad/[0.07]",
  // Registered, nothing wrong, nothing flowing — night, or a stage that simply
  // is not instrumented. Deliberately not grey-on-grey: "we have no figure" has
  // to stay distinguishable from "we have a bad one".
  idle: "border-line bg-surface-sunken",
  neutral: "border-line bg-surface",
};

export function DeviceArtTile({
  typeCode,
  size = 72,
  tone = "neutral",
  title,
  children,
  className = "",
}: {
  typeCode: string;
  size?: number;
  tone?: ArtTone;
  title?: string;
  /** Caption or figures rendered under the drawing. */
  children?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`flex flex-col items-center rounded-card border ${TONE_FRAME[tone]} ${className}`}
    >
      <div className="flex items-end justify-center px-2 pt-2">
        <DeviceArt typeCode={typeCode} size={size} title={title} />
      </div>
      {children}
    </div>
  );
}
