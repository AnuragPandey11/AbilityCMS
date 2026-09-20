/**
 * One icon per Device Type, in one place.
 *
 * Every screen that draws equipment reaches for this: the schematic's stages,
 * the live Device cards, the hierarchy rows. Previously the only set lived
 * inside `PlantFlow` as a local `switch`, so a Device looked like one thing in
 * the diagram and like nothing at all everywhere else.
 *
 * ── Why the drawings are *electrical* rather than decorative ────────────────
 * The icon carries meaning here. An operator scanning twenty rows is matching
 * shapes, not reading type codes, so a Transformer has to look like two coupled
 * windings and a breaker has to look like a gap in a line. A generic box with a
 * dash in it — which is what most of these were — makes every Device the same
 * shape and turns the icon into decoration that costs vertical space.
 *
 * ── Supplied artwork overrides the built-in drawing ─────────────────────────
 * Drop an SVG into `public/icons/devices/` and name it in `SUPPLIED_ICONS`, and
 * that file is used instead. It is rendered as a **CSS mask tinted with
 * `currentColor`**, not as an `<img>`: an `<img>` cannot inherit the theme, and
 * these icons sit inside containers that are already coloured by status — green
 * when every Device of the stage is reporting, red when none is. A fixed-colour
 * PNG or SVG in that slot would be the one element on the screen that stays the
 * same shade in both themes and through every state change.
 *
 * The consequence to know about: masking uses the file's *shape* and discards
 * its colours, so a multicolour icon arrives here monochrome. That is the right
 * trade for status-tinted chrome, and it is why the built-in set is drawn as
 * single-weight strokes in the first place.
 *
 * A type with no entry falls back to the drawing below, so the app is never
 * waiting on artwork to render correctly.
 */

import type { CSSProperties } from "react";

/**
 * Device Type code → file name inside `public/icons/devices/`.
 *
 * Empty by design. Add one line per file supplied:
 *
 * ```ts
 * INVERTER: "inverter.svg",
 * ```
 *
 * The key must be the canonical `device_types.code`, which is what the API
 * sends — never a display label. `public/icons/devices/README.md` lists every
 * code the platform currently defines.
 */
export const SUPPLIED_ICONS: Record<string, string> = {};

const BASE = "/icons/devices";

/** Stroke geometry shared by the whole set, so no icon looks heavier than another. */
const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/**
 * The built-in drawings, on a 24px grid.
 *
 * Grouped by what the equipment *does*, because that is what the shapes encode
 * and what keeps related types visually related — every board is a cabinet with
 * bus bars, every meter is a dial, every enclosure is a room.
 */
function builtIn(typeCode: string): JSX.Element {
  switch (typeCode) {
    // ── Generation ──────────────────────────────────────────────────────────
    case "PV_ARRAY":
      return (
        <>
          <path d="M3.6 14.5 6 7.5h12l2.4 7Z" />
          <path d="M3.6 14.5h16.8M9.4 7.5 8.2 14.5M14.6 7.5l1.2 7" />
          <path d="M12 17.4v3M8.5 20.4h7" />
        </>
      );
    case "SMB":
      // A string combiner: several DC strings converging into one outgoing pair.
      return (
        <>
          <rect x="9.5" y="7" width="11" height="10" rx="1.6" />
          <path d="M3.5 9h6M3.5 12h6M3.5 15h6" />
          <path d="M13 11h4M13 13.6h4" />
        </>
      );
    case "DCDB":
      return (
        <>
          <rect x="4" y="4.5" width="16" height="15" rx="1.8" />
          <path d="M7.5 9h9M7.5 12h9" />
          <path d="M9 15.5h6" />
        </>
      );

    // ── Conversion ──────────────────────────────────────────────────────────
    case "INVERTER":
      // DC in, AC out: a flat line entering, a sine leaving. The whole identity
      // of the machine is that transition, so the icon is that transition.
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2" />
          <path d="M6.5 9.5h4" />
          <path d="M13 15.2c.9-2.6 2-2.6 2.9 0" />
          <path d="M6.5 15.2h4M15.9 15.2c.9 2.6 2 2.6 2.9 0" />
          <path d="M12 5v14" strokeDasharray="1.5 2" />
        </>
      );
    case "ACDB":
      return (
        <>
          <rect x="4" y="4.5" width="16" height="15" rx="1.8" />
          <path d="M6.8 10.2c1-2.2 2.2-2.2 3.2 0s2.2 2.2 3.2 0 2.2-2.2 3.2 0" />
          <path d="M7.5 15h9" />
        </>
      );

    // ── Step-up and switching ───────────────────────────────────────────────
    case "TRANSFORMER":
      // Two coupled windings with the core between them.
      return (
        <>
          <path d="M9 7.5a4.5 4.5 0 0 0 0 9" />
          <path d="M15 7.5a4.5 4.5 0 0 1 0 9" />
          <path d="M11.2 6v12M12.8 6v12" />
          <path d="M4.5 12h2.2M17.3 12h2.2" />
        </>
      );
    case "VCB":
      // A breaker is a *gap* in a conductor — the open contact is the icon.
      return (
        <>
          <path d="M4 17h4M16 17h4" />
          <circle cx="8" cy="17" r="1.5" />
          <circle cx="16" cy="17" r="1.5" />
          <path d="M9.2 16 16 8.5" />
          <path d="M14.2 5.8h3.4v3.4" />
        </>
      );
    case "ISOLATOR":
      return (
        <>
          <path d="M4 16h4.5M15.5 16H20" />
          <circle cx="8.5" cy="16" r="1.4" />
          <circle cx="15.5" cy="16" r="1.4" />
          <path d="M9.7 15 15 9.5" />
        </>
      );

    // ── Metering ────────────────────────────────────────────────────────────
    case "MFM":
    case "NET_METER":
      return (
        <>
          <circle cx="12" cy="12" r="8.2" />
          <path d="M12 12l3.4-2.4" />
          <path d="M12 5.4v1.4M18.6 12h-1.4M12 18.6v-1.4M5.4 12h1.4" />
        </>
      );
    case "ABT_METER":
      // The settlement instrument, and the only sealed one (I-8): the seal is
      // what distinguishes it from every other meter on the plant.
      return (
        <>
          <circle cx="12" cy="11" r="7" />
          <path d="M12 11l3-2.2" />
          <path d="M8.6 19.4c1-.8 5.8-.8 6.8 0" />
          <path d="M12 18.4v1.6" />
        </>
      );

    // ── Enclosures. Rooms, not components (Guardrail 12). ───────────────────
    case "MCR_SECTION":
    case "ICR_SECTION":
      return (
        <>
          <path d="M3.5 9.5 12 4.5l8.5 5" />
          <path d="M5.2 10.6v8.9h13.6v-8.9" strokeDasharray="2.6 2" />
          <rect x="9.5" y="13" width="5" height="6.5" rx="0.8" />
        </>
      );

    // ── Instrumentation and control ─────────────────────────────────────────
    case "WMS":
      // Irradiance sensor on a mast — the denominator of Performance Ratio.
      return (
        <>
          <circle cx="12" cy="7.5" r="3" />
          <path d="M12 2.6v1.3M12 11.1v1.3M7.1 7.5H5.8M18.2 7.5h-1.3M8.5 4l-.9-.9M15.5 4l.9-.9" />
          <path d="M12 12.4v7.2M8.4 19.6h7.2" />
        </>
      );
    case "PPC":
      return (
        <>
          <rect x="6.5" y="6.5" width="11" height="11" rx="1.8" />
          <path d="M10 10.5h4v3h-4z" />
          <path d="M9.5 3.8v2.7M14.5 3.8v2.7M9.5 17.5v2.7M14.5 17.5v2.7" />
          <path d="M3.8 9.5h2.7M3.8 14.5h2.7M17.5 9.5h2.7M17.5 14.5h2.7" />
        </>
      );
    case "PLANT_KPI":
      // Synthetic: the Plant's own figures, never a machine.
      return (
        <>
          <path d="M4.2 16.5a8 8 0 1 1 15.6 0" />
          <path d="M12 16.5l4-4.4" />
          <circle cx="12" cy="16.5" r="1.3" />
        </>
      );

    default:
      return (
        <>
          <rect x="4.5" y="4.5" width="15" height="15" rx="2" />
          <path d="M8.5 12h7" />
        </>
      );
  }
}

export function DeviceIcon({
  typeCode,
  size = 22,
  className = "",
  title,
}: {
  /** Canonical `device_types.code`, exactly as the API sends it. */
  typeCode: string;
  size?: number;
  className?: string;
  /** Only set where the icon is the sole label; otherwise it stays decorative. */
  title?: string;
}): JSX.Element {
  const supplied = SUPPLIED_ICONS[typeCode];

  if (supplied) {
    const url = `url("${BASE}/${supplied}")`;
    // `currentColor` through a mask, so supplied artwork tracks the status tint
    // of whatever container it sits in exactly as the drawn set does.
    const style: CSSProperties = {
      width: size,
      height: size,
      backgroundColor: "currentColor",
      WebkitMaskImage: url,
      maskImage: url,
      WebkitMaskRepeat: "no-repeat",
      maskRepeat: "no-repeat",
      WebkitMaskPosition: "center",
      maskPosition: "center",
      WebkitMaskSize: "contain",
      maskSize: "contain",
    };
    return (
      <span
        role={title ? "img" : "presentation"}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        title={title}
        style={style}
        className={`inline-block shrink-0 ${className}`}
      />
    );
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...STROKE}
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`shrink-0 ${className}`}
    >
      {title ? <title>{title}</title> : null}
      {builtIn(typeCode)}
    </svg>
  );
}
