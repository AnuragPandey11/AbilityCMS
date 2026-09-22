/**
 * The equipment drawings.
 *
 * One function per Device Type, each returning the contents of a
 * `120 × 96` viewBox with the ground line at `y = 88`. They are drawn to a
 * shared scale, so an Inverter next to a Transformer next to a meter reads at
 * the relative sizes an engineer expects rather than each filling its own box.
 *
 * ── The rules that keep twenty drawings looking like one set ────────────────
 *
 * 1. **Light comes from the upper left**, always. Every face gradient runs from
 *    its lit edge to its shaded one in that direction, and every top edge
 *    carries a 1px rim in `RIM`. Mixed light directions is the single thing
 *    that makes a hand-drawn set look assembled from clip art.
 * 2. **Three tones per material minimum** — lit face, body, shaded face. Two
 *    reads as flat vector; the third is what makes a box look like a cabinet.
 * 3. **No outline stroke around the silhouette.** Form comes from value, not
 *    from a keyline. A keyline is what makes an illustration look like an icon.
 * 4. **A contact shadow under everything that stands on the ground**, in
 *    `SHADOW`, which is a theme variable — the shadow is the one part of the
 *    drawing that has to know whether the page behind it is white or near
 *    black.
 * 5. **Nothing is drawn in a status colour.** A green lamp on a cabinet is a
 *    lamp; whether the Device is reporting is said by its container, which is
 *    the component that actually knows. Painting the drawing itself green
 *    would assert a fact the artwork has no access to.
 *
 * Geometry is authored at integer or half-integer coordinates wherever an edge
 * is vertical or horizontal, so edges stay crisp at the sizes these are used
 * at (40–160px) rather than landing on a half pixel and blurring.
 */

import { CELL, COPPER, GALV, LIVE, PORCELAIN, RIM, SCREEN, SHADOW, STEEL, TANK } from "./palette";

/** A contact shadow. Everything that stands on the ground gets one. */
export function Ground({ cx = 60, rx = 44, ry = 4.5, y = 88.5 }: {
  cx?: number; rx?: number; ry?: number; y?: number;
}): JSX.Element {
  return <ellipse cx={cx} cy={y} rx={rx} ry={ry} fill={SHADOW} />;
}

/** The rim light along a top edge. */
function Rim({ d, width = 1 }: { d: string; width?: number }): JSX.Element {
  return <path d={d} stroke={RIM} strokeWidth={width} fill="none" strokeLinecap="round" />;
}

// ────────────────────────────────────────────────────────────────────────────
// Generation
// ────────────────────────────────────────────────────────────────────────────

/**
 * A tilted module array on a fixed-tilt table.
 *
 * Drawn as the *table*, not as one panel: a PV Array is the stage that answers
 * "how much light arrived", and a single panel reads as a product photo. The
 * cell grid is real 6×10 mono cells rather than a texture, because at 120px the
 * regular grid is the thing that says "photovoltaic" and a blurred texture says
 * "blue rectangle".
 */
export function PvArray(): JSX.Element {
  // The module plane as a parallelogram: one vector up the tilt, one along the
  // row. Every cell line is derived from these two rather than drawn by hand,
  // which is what keeps the grid parallel to the frame — a hand-placed grid on
  // a tilted plane is the classic way this drawing goes wrong, and it reads
  // immediately as "not a real panel".
  const ox = 12, oy = 63;           // front-low corner
  const ux = 63, uy = -23;          // up the tilt, toward the back
  const rx = 39, ry = 10;           // along the row
  const pt = (u: number, r: number) => `${ox + ux * u + rx * r} ${oy + uy * u + ry * r}`;
  const plane = `M${pt(0, 0)} L${pt(1, 0)} L${pt(1, 1)} L${pt(0, 1)} Z`;

  return (
    <>
      <defs>
        <linearGradient id="pv-glass" x1="0.1" y1="0" x2="0.75" y2="1">
          <stop offset="0%" stopColor={CELL.light} />
          <stop offset="35%" stopColor={CELL.mid} />
          <stop offset="100%" stopColor={CELL.deep} />
        </linearGradient>
        <linearGradient id="pv-sheen" x1="0" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.34" />
          <stop offset="30%" stopColor="#ffffff" stopOpacity="0.08" />
          <stop offset="65%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pv-frame" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#eef2f6" />
          <stop offset="55%" stopColor={GALV.mid} />
          <stop offset="100%" stopColor={GALV.dark} />
        </linearGradient>
        <linearGradient id="pv-post" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={GALV.light} />
          <stop offset="45%" stopColor={GALV.mid} />
          <stop offset="100%" stopColor={GALV.edge} />
        </linearGradient>
        {/* The grid is clipped to the plane. Without this the lines run past
            the frame and the table stops looking like a manufactured object. */}
        <clipPath id="pv-clip">
          <path d={plane} />
        </clipPath>
      </defs>

      <Ground cx={62} rx={46} ry={4} />

      {/* Posts. Back pair tall, front pair short — that difference is the tilt,
          and it is the only thing in the drawing that states the array is
          fixed-tilt rather than flat. */}
      <rect x="72" y="42" width="3.6" height="46" rx="1.2" fill="url(#pv-post)" />
      <rect x="104" y="51" width="3.6" height="37" rx="1.2" fill="url(#pv-post)" />
      <rect x="14" y="65" width="3.6" height="23" rx="1.2" fill="url(#pv-post)" />
      <rect x="46" y="74" width="3.6" height="14" rx="1.2" fill="url(#pv-post)" />
      {/* Torque tube along the row, and the rafters across it. */}
      <path d={`M${pt(0.5, -0.06)} L${pt(0.5, 1.06)}`} stroke={GALV.dark}
            strokeWidth="2.8" strokeLinecap="round" />
      <path d={`M${pt(-0.03, 0.18)} L${pt(1.03, 0.18)}`} stroke={GALV.dark}
            strokeWidth="1.8" strokeLinecap="round" opacity="0.8" />
      <path d={`M${pt(-0.03, 0.82)} L${pt(1.03, 0.82)}`} stroke={GALV.dark}
            strokeWidth="1.8" strokeLinecap="round" opacity="0.8" />

      {/* Frame, then the glass inset inside it. */}
      <path d={plane} fill="url(#pv-frame)" />
      <path
        d={`M${pt(0.035, 0.03)} L${pt(0.965, 0.03)} L${pt(0.965, 0.97)} L${pt(0.035, 0.97)} Z`}
        fill="url(#pv-glass)"
      />

      <g clipPath="url(#pv-clip)">
        {/* Cell rows across the tilt. */}
        <g stroke={CELL.grid} strokeWidth="0.75" opacity="0.42">
          {[1, 2, 3, 4, 5].map((i) => (
            <path key={i} d={`M${pt(i / 6, 0)} L${pt(i / 6, 1)}`} />
          ))}
        </g>
        {/* Cell columns along the row. */}
        <g stroke={CELL.grid} strokeWidth="0.75" opacity="0.42">
          {[1, 2, 3].map((j) => (
            <path key={j} d={`M${pt(0, j / 4)} L${pt(1, j / 4)}`} />
          ))}
        </g>
        {/* Busbars: the fine bright lines running the length of each cell. */}
        <g stroke="#b9d5ec" strokeWidth="0.34" opacity="0.3">
          {[0.125, 0.375, 0.625, 0.875].map((j) => (
            <path key={j} d={`M${pt(0, j)} L${pt(1, j)}`} />
          ))}
        </g>
      </g>

      {/* Specular sheen across the upper-left of the glass. */}
      <path
        d={`M${pt(0.035, 0.03)} L${pt(0.965, 0.03)} L${pt(0.965, 0.97)} L${pt(0.035, 0.97)} Z`}
        fill="url(#pv-sheen)"
      />
      {/* Rim along the two lit edges only — the back edge and the left end. */}
      <Rim d={`M${pt(0, 0)} L${pt(1, 0)} L${pt(1, 1)}`} width={1.2} />
    </>
  );
}

/**
 * A string monitoring box: a wall-mounted enclosure with the string conduits
 * entering underneath. The conduits are the identifying feature — a plain box
 * is every other box in the set.
 */
export function StringBox(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="smb-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="55%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.shade} />
        </linearGradient>
        <linearGradient id="smb-door" x1="0" y1="0" x2="0.9" y2="1">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={34} ry={3.6} />

      {/* String conduits sweeping into the gland plate. Curved rather than
          vertical: four straight stubs under a box read as legs, and a wall
          box standing on legs is not a thing that exists. */}
      <g stroke={GALV.dark} strokeWidth="3.4" strokeLinecap="round" fill="none">
        <path d="M40 72 Q 36 82 26 86" />
        <path d="M50 72 Q 48 82 41 87" />
        <path d="M70 72 Q 72 82 79 87" />
        <path d="M80 72 Q 84 82 94 86" />
      </g>
      <g stroke={GALV.light} strokeWidth="0.9" strokeLinecap="round" fill="none" opacity="0.55">
        <path d="M39.2 72.6 Q 35.4 82 26 85.3" />
        <path d="M49.2 72.6 Q 47.4 82 41 86.3" />
        <path d="M69 72.6 Q 71 82 79 86.3" />
        <path d="M79 72.6 Q 83 82 94 85.3" />
      </g>
      {/* Gland plate the conduits land in. */}
      <rect x="34" y="68" width="52" height="5" rx="1.4" fill={STEEL.dark} />
      <rect x="34" y="68" width="52" height="1.2" rx="0.6" fill={RIM} opacity="0.3" />
      {[40, 50, 60, 70, 80].map((x) => (
        <circle key={x} cx={x} cy="70.5" r="1.9" fill={STEEL.edge} />
      ))}

      {/* Enclosure: side face, then the door, so the box has depth. */}
      <path d="M30 22 L36 18 L36 64 L30 68 Z" fill={STEEL.edge} />
      <rect x="30" y="22" width="60" height="46" rx="2" fill="url(#smb-body)" />
      <rect x="33.5" y="25.5" width="53" height="39" rx="1.4" fill="url(#smb-door)" />
      <rect x="33.5" y="25.5" width="53" height="39" rx="1.4" fill="none"
            stroke={STEEL.edge} strokeWidth="0.7" opacity="0.5" />

      {/* Fuse ways behind the door, drawn as a louvre so the box reads as full. */}
      <g fill={STEEL.shade} opacity="0.55">
        <rect x="38" y="31" width="44" height="2.4" rx="1.2" />
        <rect x="38" y="37" width="44" height="2.4" rx="1.2" />
        <rect x="38" y="43" width="44" height="2.4" rx="1.2" />
        <rect x="38" y="49" width="44" height="2.4" rx="1.2" />
      </g>
      {/* Latch. */}
      <rect x="84.5" y="41" width="2.6" height="8" rx="1.3" fill={STEEL.edge} />
      <circle cx="46" cy="59" r="2" fill={LIVE.glow} opacity="0.85" />
      <circle cx="46" cy="59" r="0.9" fill={LIVE.core} />
      <Rim d="M30.6 22.4 L89.4 22.4 M30 22 L36 18" />
    </>
  );
}

/**
 * A distribution board — DC or AC. The identifying feature is the DIN rail of
 * MCBs behind a hinged door, so the door is drawn open.
 */
export function DistributionBoard({ ac }: { ac?: boolean }): JSX.Element {
  const rows = ac ? 3 : 2;
  return (
    <>
      <defs>
        <linearGradient id="db-body" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="60%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.shade} />
        </linearGradient>
        <linearGradient id="db-inner" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={STEEL.shade} />
          <stop offset="100%" stopColor={STEEL.edge} />
        </linearGradient>
        <linearGradient id="db-door" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.light} />
        </linearGradient>
      </defs>

      <Ground cx={58} rx={38} ry={3.8} />

      {/* Carcass. */}
      <path d="M24 20 L30 16 L30 80 L24 84 Z" fill={STEEL.edge} />
      <rect x="24" y="20" width="58" height="64" rx="2.5" fill="url(#db-body)" />
      <rect x="28" y="24" width="50" height="56" rx="1.5" fill="url(#db-inner)" />

      {/* MCB rows on rail. */}
      {Array.from({ length: rows }).map((_, row) => (
        <g key={row} transform={`translate(0 ${row * 17})`}>
          <rect x="31" y="29" width="44" height="2" fill={GALV.dark} />
          {Array.from({ length: 9 }).map((_, i) => (
            <g key={i} transform={`translate(${31 + i * 4.9} 0)`}>
              <rect x="0.4" y="31" width="4" height="9" rx="0.8" fill={STEEL.light} />
              <rect x="1.2" y="32.4" width="2.4" height="2.6" rx="0.5"
                    fill={i % 3 === 2 ? "#c94f4f" : "#2f7d4f"} />
              <rect x="0.4" y="37.6" width="4" height="1" fill={STEEL.dark} opacity="0.6" />
            </g>
          ))}
        </g>
      ))}
      {/* Cable trunking at the bottom. */}
      <rect x="31" y="70" width="44" height="6" rx="1" fill={STEEL.dark} opacity="0.8" />

      {/* The open door, hinged right, seen at an angle. */}
      <path d="M82 20 L96 27 L96 77 L82 84 Z" fill="url(#db-door)" />
      <path d="M84 24 L94 29 L94 75 L84 80 Z" fill="none" stroke={STEEL.edge}
            strokeWidth="0.7" opacity="0.45" />
      <Rim d="M24.6 20.4 L81.4 20.4 M24 20 L30 16" />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Conversion
// ────────────────────────────────────────────────────────────────────────────

/**
 * A central inverter: two coupled cabinets on a plinth, vented, with an HMI.
 *
 * Two cabinets rather than one because that is what a central inverter is —
 * a power section and a control section bolted together — and because it
 * distinguishes the drawing from the distribution board at a glance, which a
 * single cabinet does not.
 */
export function Inverter(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="inv-face" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="46%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
        <linearGradient id="inv-face2" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.shade} />
        </linearGradient>
        <linearGradient id="inv-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f2f5f8" />
          <stop offset="100%" stopColor={STEEL.mid} />
        </linearGradient>
        <linearGradient id="inv-screen" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor={SCREEN.lit} />
          <stop offset="100%" stopColor={SCREEN.glass} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={42} ry={4} />

      {/* Top deck, drawn as a shallow parallelogram — the only face that says
          this is a three-dimensional cabinet rather than a rectangle. */}
      <path d="M22 20 L30 14 L102 14 L94 20 Z" fill="url(#inv-top)" />
      <path d="M94 20 L102 14 L102 78 L94 82 Z" fill={STEEL.edge} />

      {/* Power section (wide) and control section (narrow). */}
      <rect x="22" y="20" width="46" height="62" rx="1.6" fill="url(#inv-face)" />
      <rect x="68" y="20" width="26" height="62" rx="1.6" fill="url(#inv-face2)" />
      <path d="M68 20 68 82" stroke={STEEL.edge} strokeWidth="0.8" opacity="0.6" />

      {/* Ventilation louvres — the heat this machine makes is its whole life. */}
      <g fill={STEEL.shade} opacity="0.62">
        {Array.from({ length: 7 }).map((_, i) => (
          <rect key={i} x="27" y={46 + i * 4.2} width="36" height="2.2" rx="1.1" />
        ))}
      </g>
      <g stroke={RIM} strokeWidth="0.5" opacity="0.5">
        {Array.from({ length: 7 }).map((_, i) => (
          <path key={i} d={`M27 ${45.6 + i * 4.2} H63`} />
        ))}
      </g>

      {/* HMI: lit, because an inverter's display is on whenever it is alive. */}
      <rect x="27" y="26" width="24" height="14" rx="1.4" fill={STEEL.edge} />
      <rect x="28.4" y="27.4" width="21.2" height="11.2" rx="0.9" fill="url(#inv-screen)" />
      <g fill={SCREEN.text} opacity="0.85">
        <rect x="30.5" y="30" width="11" height="1.5" rx="0.7" />
        <rect x="30.5" y="33.2" width="16" height="2.6" rx="0.8" opacity="0.65" />
      </g>

      {/* Status lamps on the control section. */}
      <circle cx="75" cy="28" r="2.1" fill={LIVE.glow} />
      <circle cx="75" cy="28" r="0.9" fill={LIVE.core} />
      <circle cx="82" cy="28" r="2.1" fill={STEEL.edge} opacity="0.7" />
      <circle cx="89" cy="28" r="2.1" fill={STEEL.edge} opacity="0.7" />
      {/* Isolator handle — every inverter cabinet has one and nothing else does. */}
      <circle cx="81" cy="48" r="6" fill={STEEL.edge} />
      <circle cx="81" cy="48" r="4.4" fill="#d34b3c" />
      <path d="M81 48 84.6 44.6" stroke="#5c1c14" strokeWidth="1.6" strokeLinecap="round" />
      <g fill={STEEL.shade} opacity="0.5">
        <rect x="73" y="60" width="16" height="2" rx="1" />
        <rect x="73" y="65" width="16" height="2" rx="1" />
        <rect x="73" y="70" width="16" height="2" rx="1" />
      </g>

      {/* Plinth. */}
      <rect x="20" y="82" width="76" height="4.5" rx="1" fill={STEEL.edge} />
      <Rim d="M22 20 L30 14 L102 14" width={1.1} />
    </>
  );
}

/** A power plant controller: a rack-mount unit on a slim floor stand. */
export function Controller(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="ppc-rack" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.shade} />
        </linearGradient>
        <linearGradient id="ppc-unit" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3b444f" />
          <stop offset="100%" stopColor="#242b33" />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={34} ry={3.6} />

      <path d="M30 18 L36 14 L36 84 L30 88 Z" fill={STEEL.edge} />
      <rect x="30" y="18" width="56" height="70" rx="2" fill="url(#ppc-rack)" />

      {/* Three 19-inch units. The middle one is the controller proper. */}
      {[24, 42, 60].map((y, idx) => (
        <g key={y}>
          <rect x="34" y={y} width="48" height="14" rx="1.2" fill="url(#ppc-unit)" />
          <rect x="34" y={y} width="48" height="1.2" rx="0.6" fill={RIM} opacity="0.35" />
          {/* Ears. */}
          <rect x="34" y={y + 2} width="2.6" height="10" rx="0.6" fill={STEEL.dark} opacity="0.5" />
          <rect x="79.4" y={y + 2} width="2.6" height="10" rx="0.6" fill={STEEL.dark} opacity="0.5" />
          {idx === 1 ? (
            <>
              <rect x="40" y={y + 3.4} width="18" height="7.4" rx="0.8" fill={SCREEN.glass} />
              <rect x="42" y={y + 5.4} width="11" height="1.4" rx="0.7" fill={SCREEN.text} opacity="0.8" />
              <rect x="42" y={y + 8} width="14" height="1.2" rx="0.6" fill={SCREEN.text} opacity="0.45" />
            </>
          ) : null}
          <g>
            {Array.from({ length: 6 }).map((_, i) => (
              <circle key={i} cx={63 + i * 3.2} cy={y + 7} r="1.05"
                      fill={i < 2 ? LIVE.glow : "#5b6573"} opacity={i < 2 ? 0.95 : 0.8} />
            ))}
          </g>
        </g>
      ))}
      {/* Blanking plate + vent at the bottom. */}
      <rect x="34" y="78" width="48" height="6" rx="1" fill={STEEL.dark} opacity="0.65" />
      <Rim d="M30.6 18.4 L85.4 18.4 M30 18 L36 14" />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Step-up and switching
// ────────────────────────────────────────────────────────────────────────────

/**
 * An oil-filled step-up transformer.
 *
 * Three things make a transformer recognisable and all three are drawn: the
 * radiator fins down both flanks, the conservator drum across the top, and the
 * HV bushings standing proud of the tank. Without the bushings it is a boiler.
 */
export function Transformer(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="tx-tank" x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0%" stopColor={TANK.light} />
          <stop offset="45%" stopColor={TANK.mid} />
          <stop offset="100%" stopColor={TANK.dark} />
        </linearGradient>
        <linearGradient id="tx-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#cdd2d7" />
          <stop offset="100%" stopColor={TANK.mid} />
        </linearGradient>
        <linearGradient id="tx-drum" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfd4d9" />
          <stop offset="45%" stopColor={TANK.mid} />
          <stop offset="100%" stopColor={TANK.edge} />
        </linearGradient>
        <linearGradient id="tx-bush" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={PORCELAIN.light} />
          <stop offset="60%" stopColor={PORCELAIN.mid} />
          <stop offset="100%" stopColor={PORCELAIN.dark} />
        </linearGradient>
        <linearGradient id="tx-fin" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={TANK.light} />
          <stop offset="100%" stopColor={TANK.dark} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={46} ry={4.2} />

      {/* HV bushings: porcelain sheds on a stack, with the terminal on top. */}
      {[38, 52, 66].map((x, i) => (
        <g key={x}>
          <rect x={x - 1.1} y="10" width="2.2" height="8" fill={COPPER.mid} />
          <circle cx={x} cy="9" r="2.4" fill={COPPER.light} />
          <circle cx={x} cy="9" r="2.4" fill="none" stroke={COPPER.dark} strokeWidth="0.5" />
          {[16, 20.5, 25, 29.5].map((y, j) => (
            <ellipse key={y} cx={x} cy={y} rx={5.2 - j * 0.25} ry="1.7" fill="url(#tx-bush)" />
          ))}
          <rect x={x - 3} y="15" width="6" height="16" fill="url(#tx-bush)" opacity="0.9" />
          <text x={x} y="9" fontSize="0" aria-hidden>{i}</text>
        </g>
      ))}
      {/* LV bushings — shorter, to the right, which is what says step-up. */}
      {[84, 93].map((x) => (
        <g key={x}>
          <rect x={x - 0.9} y="22" width="1.8" height="6" fill={COPPER.mid} />
          <circle cx={x} cy="21.5" r="1.8" fill={COPPER.light} />
          {[27, 30].map((y, j) => (
            <ellipse key={y} cx={x} cy={y} rx={3.6 - j * 0.3} ry="1.3" fill="url(#tx-bush)" />
          ))}
        </g>
      ))}

      {/* Conservator drum on its cradle. */}
      <rect x="22" y="24" width="30" height="9" rx="4.5" fill="url(#tx-drum)" />
      <ellipse cx="22" cy="28.5" rx="1.6" ry="4.5" fill={TANK.dark} />
      <path d="M26 33 26 37 M46 33 46 37" stroke={TANK.dark} strokeWidth="1.6" />

      {/* Radiator fins, both flanks. */}
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={`l${i}`} x={16 + i * 2.6} y="42" width="1.7" height="34" rx="0.8"
              fill="url(#tx-fin)" />
      ))}
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={`r${i}`} x={94 + i * 2.6} y="42" width="1.7" height="34" rx="0.8"
              fill="url(#tx-fin)" />
      ))}
      <rect x="15" y="40" width="14" height="2.6" rx="1.3" fill={TANK.dark} />
      <rect x="93" y="40" width="14" height="2.6" rx="1.3" fill={TANK.dark} />
      <rect x="15" y="75" width="14" height="2.6" rx="1.3" fill={TANK.dark} />
      <rect x="93" y="75" width="14" height="2.6" rx="1.3" fill={TANK.dark} />

      {/* The tank. */}
      <path d="M26 36 L32 31 L100 31 L94 36 Z" fill="url(#tx-top)" />
      <path d="M94 36 L100 31 L100 78 L94 83 Z" fill={TANK.edge} />
      <rect x="26" y="36" width="68" height="47" rx="2" fill="url(#tx-tank)" />
      {/* Stiffener ribs — heavy plant is never a plain panel. */}
      <g stroke={TANK.edge} strokeWidth="0.8" opacity="0.4">
        <path d="M44 36 44 83 M60 36 60 83 M76 36 76 83" />
      </g>
      {/* Rating plate and the oil temperature gauge, which is what this Device
          actually reports on this platform (OTI / WTI). */}
      <rect x="31" y="62" width="13" height="9" rx="1" fill={STEEL.light} opacity="0.85" />
      <circle cx="84" cy="45" r="5.6" fill={STEEL.light} />
      <circle cx="84" cy="45" r="4.4" fill="#f6f8f9" stroke={TANK.dark} strokeWidth="0.6" />
      <path d="M84 45 86.6 41.8" stroke="#c2413b" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="84" cy="45" r="0.9" fill={TANK.edge} />

      {/* Skid and rollers. */}
      <rect x="24" y="83" width="72" height="4" rx="1" fill={TANK.edge} />
      <Rim d="M26 36 L32 31 L100 31" width={1.1} />
    </>
  );
}

/**
 * A vacuum circuit breaker in a withdrawable cubicle.
 *
 * Drawn as the *panel*, with the truck's wheels visible at the bottom and the
 * three vacuum interrupters behind a mesh — a VCB in a solar plant is a
 * switchgear cubicle, not a pole-top recloser.
 */
export function CircuitBreaker(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="vcb-face" x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="50%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
        <linearGradient id="vcb-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f0f4f7" />
          <stop offset="100%" stopColor={STEEL.mid} />
        </linearGradient>
        <linearGradient id="vcb-pole" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#4a535f" />
          <stop offset="45%" stopColor="#2d343d" />
          <stop offset="100%" stopColor="#171c22" />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={36} ry={3.8} />

      <path d="M28 16 L35 11 L92 11 L85 16 Z" fill="url(#vcb-top)" />
      <path d="M85 16 L92 11 L92 80 L85 85 Z" fill={STEEL.edge} />
      <rect x="28" y="16" width="57" height="69" rx="2" fill="url(#vcb-face)" />

      {/* Relay / control compartment. */}
      <rect x="33" y="21" width="47" height="18" rx="1.4" fill={STEEL.shade} opacity="0.5" />
      <rect x="36" y="24" width="17" height="12" rx="1" fill={SCREEN.glass} />
      <rect x="38" y="26.5" width="9" height="1.4" rx="0.7" fill={SCREEN.text} opacity="0.85" />
      <rect x="38" y="29.5" width="12" height="1.2" rx="0.6" fill={SCREEN.text} opacity="0.5" />
      {/* Open / closed indicators — red closed, green open, as switchgear is. */}
      <circle cx="61" cy="27" r="2.4" fill="#d34b3c" />
      <circle cx="61" cy="27" r="1" fill="#ffb4aa" />
      <circle cx="69" cy="27" r="2.4" fill={LIVE.dim} />
      <circle cx="61" cy="34" r="2.4" fill={STEEL.edge} opacity="0.65" />
      <circle cx="69" cy="34" r="2.4" fill={STEEL.edge} opacity="0.65" />

      {/* The three vacuum interrupter poles behind a barrier. */}
      <rect x="33" y="43" width="47" height="26" rx="1.4" fill={STEEL.edge} opacity="0.85" />
      {[42, 56, 70].map((x) => (
        <g key={x}>
          <rect x={x - 3.4} y="46" width="6.8" height="20" rx="3.4" fill="url(#vcb-pole)" />
          <rect x={x - 4.6} y="48.5" width="9.2" height="2" rx="1" fill={COPPER.mid} />
          <rect x={x - 4.6} y="61" width="9.2" height="2" rx="1" fill={COPPER.mid} />
          <rect x={x - 1.1} y="47" width="1.2" height="18" fill={RIM} opacity="0.22" />
        </g>
      ))}

      {/* Racking handle and the truck's wheels. */}
      <rect x="45" y="73" width="23" height="4" rx="2" fill={STEEL.edge} />
      <circle cx="40" cy="83" r="3.2" fill="#2d343d" />
      <circle cx="40" cy="83" r="1.2" fill={STEEL.dark} />
      <circle cx="74" cy="83" r="3.2" fill="#2d343d" />
      <circle cx="74" cy="83" r="1.2" fill={STEEL.dark} />
      <Rim d="M28 16 L35 11 L92 11" width={1.1} />
    </>
  );
}

/** A three-phase isolator: post insulators and open blades on a frame. */
export function Isolator(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="iso-post" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={PORCELAIN.light} />
          <stop offset="62%" stopColor={PORCELAIN.mid} />
          <stop offset="100%" stopColor={PORCELAIN.dark} />
        </linearGradient>
        <linearGradient id="iso-frame" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={GALV.light} />
          <stop offset="100%" stopColor={GALV.edge} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={40} ry={3.8} />

      {/* Base frame. */}
      <rect x="20" y="72" width="80" height="5" rx="1.5" fill="url(#iso-frame)" />
      <rect x="26" y="77" width="5" height="10" fill={GALV.dark} />
      <rect x="89" y="77" width="5" height="10" fill={GALV.dark} />

      {[34, 60, 86].map((x) => (
        <g key={x}>
          {/* Fixed post. */}
          {[64, 58, 52, 46].map((y, j) => (
            <ellipse key={y} cx={x} cy={y} rx={6 - j * 0.4} ry="2.1" fill="url(#iso-post)" />
          ))}
          <rect x={x - 3.4} y="44" width="6.8" height="22" fill="url(#iso-post)" opacity="0.92" />
          {/* Top contact. */}
          <rect x={x - 5} y="40" width="10" height="4" rx="1.2" fill={COPPER.mid} />
          {/* The open blade — an isolator's identity is the visible air gap. */}
          <path d={`M${x - 4} 42 L${x + 9} 26`} stroke={COPPER.mid} strokeWidth="2.6"
                strokeLinecap="round" />
          <circle cx={x - 4} cy="42" r="1.7" fill={COPPER.dark} />
          <circle cx={x + 12} cy="24" r="1.7" fill={COPPER.dark} />
        </g>
      ))}
      {/* Operating linkage across all three poles. */}
      <path d="M34 68 H86" stroke={GALV.dark} strokeWidth="2" strokeLinecap="round" />
      <Rim d="M20.6 72.4 H99.4" />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Metering and grid
// ────────────────────────────────────────────────────────────────────────────

/**
 * A panel-mounted meter.
 *
 * `sealed` adds the lead seal and wire that distinguishes the settlement
 * instrument from operational metering — the one distinction on this platform
 * that money depends on (I-8), so it is drawn rather than left to a label.
 */
export function Meter({ sealed, bidirectional }: {
  sealed?: boolean; bidirectional?: boolean;
}): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="mtr-body" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="55%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
        <linearGradient id="mtr-face" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#2a3d47" />
          <stop offset="100%" stopColor={SCREEN.glass} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={32} ry={3.4} />

      {/* Case: a deep bezel, because a panel meter is mostly bezel. */}
      <path d="M28 22 L34 17 L92 17 L86 22 Z" fill="#eef2f6" />
      <path d="M86 22 L92 17 L92 72 L86 77 Z" fill={STEEL.edge} />
      <rect x="28" y="22" width="58" height="55" rx="3" fill="url(#mtr-body)" />
      <rect x="32.5" y="26.5" width="49" height="34" rx="2" fill={STEEL.edge} />
      <rect x="34" y="28" width="46" height="31" rx="1.4" fill="url(#mtr-face)" />

      {/* A live display: a big reading, a small one, and the phase bars. */}
      <g fill={SCREEN.text}>
        <rect x="37" y="32" width="26" height="4.6" rx="1" opacity="0.92" />
        <rect x="66" y="33" width="10" height="2.6" rx="0.8" opacity="0.5" />
        <rect x="37" y="40" width="17" height="2.6" rx="0.8" opacity="0.6" />
        <rect x="37" y="46" width="39" height="1.6" rx="0.8" opacity="0.28" />
        <rect x="37" y="50" width="30" height="1.6" rx="0.8" opacity="0.28" />
      </g>
      {bidirectional ? (
        <g stroke={SCREEN.text} strokeWidth="1.1" fill="none" opacity="0.85"
           strokeLinecap="round" strokeLinejoin="round">
          <path d="M62 44 H74 M71 41.6 74 44 71 46.4" />
          <path d="M74 52 H62 M65 49.6 62 52 65 54.4" />
        </g>
      ) : null}

      {/* Keypad. */}
      <g fill={STEEL.shade}>
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={35 + i * 12} y="64" width="9" height="6" rx="1.4" opacity="0.75" />
        ))}
      </g>
      <circle cx="82" cy="67" r="2" fill={LIVE.glow} />

      {sealed ? (
        // Lead seal on a twisted wire through the cover screws: the physical
        // fact that makes this meter the settlement authority.
        <g>
          <path d="M31 77 Q 27 83 33 85" stroke={GALV.dark} strokeWidth="0.9" fill="none" />
          <circle cx="34.5" cy="85.5" r="3.2" fill={GALV.mid} />
          <circle cx="34.5" cy="85.5" r="3.2" fill="none" stroke={GALV.edge} strokeWidth="0.6" />
          <circle cx="34.5" cy="85.5" r="1.2" fill={GALV.edge} opacity="0.7" />
        </g>
      ) : null}
      <Rim d="M28 22 L34 17 L92 17" width={1.1} />
    </>
  );
}

/** The grid: a lattice tower carrying the conductors away. */
export function Grid(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="grd-steel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={GALV.light} />
          <stop offset="50%" stopColor={GALV.mid} />
          <stop offset="100%" stopColor={GALV.edge} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={34} ry={3.6} />

      {/* Conductors, drawn beyond the tower on both sides so the line reads as
          continuing rather than terminating here. */}
      <g stroke={GALV.dark} strokeWidth="1.1" fill="none" opacity="0.75">
        <path d="M0 32 Q 30 40 60 31" />
        <path d="M60 31 Q 90 40 120 32" />
        <path d="M0 46 Q 30 55 60 45" />
        <path d="M60 45 Q 90 55 120 46" />
      </g>

      <g fill="url(#grd-steel)">
        {/* Crossarms. */}
        <rect x="26" y="29.5" width="68" height="2.6" rx="1.3" />
        <rect x="34" y="43.5" width="52" height="2.6" rx="1.3" />
        {/* Mast: two legs splaying to the base. */}
        <path d="M53 14 L56.5 14 L68 86 L62.5 86 Z" />
        <path d="M67 14 L63.5 14 L52 86 L57.5 86 Z" />
        <rect x="52" y="12" width="16" height="2.4" rx="1.2" />
      </g>
      {/* Lattice bracing — the diagonals are what make it a pylon. */}
      <g stroke={GALV.dark} strokeWidth="1" opacity="0.9">
        <path d="M56 24 64 24 M55 34 65 34 M53.5 48 66.5 48 M52 62 68 62 M50.5 74 69.5 74" />
        <path d="M56 24 65 34 M64 24 55 34 M55 34 66.5 48 M65 34 53.5 48
                 M53.5 48 68 62 M66.5 48 52 62 M52 62 69.5 74 M68 62 50.5 74" />
      </g>
      {/* Insulator strings hanging from the arms. */}
      {[[30, 31], [90, 31], [38, 45], [82, 45]].map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <path d={`M${x} ${y} ${x} ${y + 8}`} stroke={PORCELAIN.dark} strokeWidth="0.8" />
          {[2.2, 4.4, 6.6].map((d) => (
            <ellipse key={d} cx={x} cy={y + d} rx="2.1" ry="0.9" fill={PORCELAIN.mid} />
          ))}
        </g>
      ))}
      <Rim d="M26 29.5 H94 M34 43.5 H86" width={0.8} />
    </>
  );
}

/**
 * A control room: a lineup of switchgear cubicles seen from the front.
 *
 * ⚠ This is the drawing for `MCR_SECTION` / `ICR_SECTION` as a **Device Type**
 * — the equipment lineup. A *Collector* is an enclosure and is never drawn as a
 * node at all (Guardrail 12); it is the dashed outline around its occupants,
 * which is drawn by the diagram, not by this file.
 */
export function ControlRoom(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="mcr-panel" x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="55%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
        <linearGradient id="mcr-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f2f5f8" />
          <stop offset="100%" stopColor={STEEL.mid} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={46} ry={4} />

      <path d="M14 22 L21 17 L106 17 L99 22 Z" fill="url(#mcr-top)" />
      <path d="M99 22 L106 17 L106 82 L99 86 Z" fill={STEEL.edge} />
      <rect x="14" y="22" width="85" height="64" rx="1.6" fill="url(#mcr-panel)" />

      {/* Four cubicles. The repetition is the point — a lineup, not a cabinet. */}
      {[0, 1, 2, 3].map((i) => {
        const x = 16 + i * 21;
        return (
          <g key={i}>
            <rect x={x} y="24" width="19" height="60" rx="1" fill={STEEL.mid} />
            <rect x={x + 1.4} y="25.4" width="16.2" height="57.2" rx="0.8"
                  fill={STEEL.light} opacity="0.35" />
            {/* Relay window. */}
            <rect x={x + 3.5} y="28" width="12" height="8" rx="0.8" fill={SCREEN.glass} />
            <rect x={x + 5} y="30.4" width="6" height="1.4" rx="0.7"
                  fill={SCREEN.text} opacity="0.8" />
            {/* Indicator pair. */}
            <circle cx={x + 6} cy="41" r="1.6" fill={i === 3 ? "#d34b3c" : LIVE.glow} />
            <circle cx={x + 12} cy="41" r="1.6" fill={STEEL.edge} opacity="0.6" />
            {/* Control switch. */}
            <circle cx={x + 9.5} cy="52" r="3.4" fill={STEEL.edge} />
            <path d={`M${x + 9.5} 52 ${x + 11.9} 49.6`} stroke={STEEL.light}
                  strokeWidth="1.2" strokeLinecap="round" />
            {/* Ventilation at the bottom of each cubicle. */}
            <g fill={STEEL.shade} opacity="0.55">
              <rect x={x + 3.5} y="64" width="12" height="1.8" rx="0.9" />
              <rect x={x + 3.5} y="68" width="12" height="1.8" rx="0.9" />
              <rect x={x + 3.5} y="72" width="12" height="1.8" rx="0.9" />
            </g>
            <path d={`M${x + 19} 24 ${x + 19} 84`} stroke={STEEL.edge}
                  strokeWidth="0.7" opacity="0.5" />
          </g>
        );
      })}
      <rect x="12" y="84" width="89" height="3.6" rx="1" fill={STEEL.edge} />
      <Rim d="M14 22 L21 17 L106 17" width={1.1} />
    </>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Instrumentation and auxiliaries
// ────────────────────────────────────────────────────────────────────────────

/**
 * A weather monitoring station.
 *
 * The pyranometer gets the most drawing effort of anything in this set relative
 * to its size, because it is the denominator of Performance Ratio: every
 * performance figure on this platform is a ratio whose bottom half comes off
 * this one instrument, and an operator should be able to find it at a glance.
 */
export function WeatherStation(): JSX.Element {
  return (
    <>
      <defs>
        <radialGradient id="wms-dome" cx="0.35" cy="0.3" r="0.75">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="45%" stopColor="#bcd8ea" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#5e87a3" stopOpacity="0.9" />
        </radialGradient>
        <linearGradient id="wms-mast" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={GALV.light} />
          <stop offset="50%" stopColor={GALV.mid} />
          <stop offset="100%" stopColor={GALV.edge} />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={30} ry={3.4} />

      {/* Mast and base. */}
      <rect x="58" y="20" width="4" height="66" rx="1" fill="url(#wms-mast)" />
      <path d="M46 86 L58 62 L62 62 L74 86 Z" fill={GALV.dark} opacity="0.22" />
      <rect x="46" y="85" width="28" height="3" rx="1" fill={GALV.edge} />

      {/* Anemometer: three cups on a spider at the top. */}
      <g>
        <rect x="59.2" y="14" width="1.6" height="8" fill={GALV.dark} />
        <g stroke={GALV.dark} strokeWidth="1.2" fill="none">
          <path d="M60 15 L50 12 M60 15 L70 12 M60 15 L60 8" />
        </g>
        <ellipse cx="48.5" cy="11.5" rx="3.4" ry="2.8" fill={STEEL.light} />
        <ellipse cx="48.5" cy="11.5" rx="3.4" ry="2.8" fill="none" stroke={STEEL.dark} strokeWidth="0.5" />
        <ellipse cx="71.5" cy="11.5" rx="3.4" ry="2.8" fill={STEEL.mid} />
        <ellipse cx="60" cy="6.5" rx="3.4" ry="2.8" fill={STEEL.light} />
        <circle cx="60" cy="15" r="1.8" fill={GALV.edge} />
      </g>

      {/* Wind vane on a boom. */}
      <g transform="translate(0 6)">
        <path d="M62 24 H84" stroke={GALV.mid} strokeWidth="1.6" />
        <path d="M84 24 L92 20.5 L92 27.5 Z" fill={STEEL.mid} />
        <circle cx="84" cy="24" r="1.6" fill={GALV.edge} />
      </g>

      {/* Pyranometer: glass dome, white body, levelling feet, on its own boom. */}
      <g transform="translate(0 4)">
        <path d="M58 40 H34" stroke={GALV.mid} strokeWidth="1.8" />
        <ellipse cx="30" cy="42.5" rx="11" ry="3" fill={STEEL.dark} opacity="0.5" />
        <rect x="19.5" y="38" width="21" height="5" rx="2.4" fill="#f4f7f9" />
        <rect x="19.5" y="38" width="21" height="5" rx="2.4" fill="none"
              stroke={STEEL.dark} strokeWidth="0.5" opacity="0.6" />
        {/* The sun-facing dome. */}
        <path d="M22.5 38.4 A 7.5 7.5 0 0 1 37.5 38.4 Z" fill="url(#wms-dome)" />
        <path d="M25.5 35.5 A 4.6 4.6 0 0 1 29.5 32.6" stroke="#ffffff" strokeWidth="1.2"
              fill="none" opacity="0.75" strokeLinecap="round" />
        {/* Spirit level and desiccant, in miniature. */}
        <circle cx="35.5" cy="43.8" r="1.5" fill={STEEL.light} stroke={STEEL.dark} strokeWidth="0.4" />
        <rect x="21" y="43" width="4" height="3.4" rx="1" fill={STEEL.mid} />
      </g>

      {/* Ambient / module temperature sensor and the logger enclosure. */}
      <rect x="62" y="52" width="16" height="4" rx="2" fill={STEEL.light} />
      <rect x="62" y="52" width="16" height="4" rx="2" fill="none" stroke={STEEL.dark}
            strokeWidth="0.5" opacity="0.5" />
      <rect x="47" y="62" width="26" height="18" rx="2" fill={STEEL.mid} />
      <rect x="49" y="64" width="22" height="14" rx="1.2" fill={STEEL.light} opacity="0.55" />
      <circle cx="52" cy="76" r="1.5" fill={LIVE.glow} />
      <g fill={STEEL.shade} opacity="0.5">
        <rect x="56" y="67" width="13" height="1.6" rx="0.8" />
        <rect x="56" y="70.5" width="13" height="1.6" rx="0.8" />
      </g>
      <Rim d="M58.4 20.4 58.4 84" width={0.8} />
    </>
  );
}

/**
 * The Plant KPI panel — the client's `DASHBOARD` row.
 *
 * Deliberately drawn as a *screen on a stand*, not as equipment: this Device is
 * synthetic. It carries the Plant's own computed figures and will never be a
 * machine anybody can walk up to, and drawing it as a cabinet would put a box
 * in the operator's head that does not exist in the plant.
 */
export function KpiPanel(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="kpi-bezel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3f4855" />
          <stop offset="100%" stopColor="#1e242c" />
        </linearGradient>
        <linearGradient id="kpi-glass" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor="#14313f" />
          <stop offset="100%" stopColor="#0a1620" />
        </linearGradient>
      </defs>

      <Ground cx={60} rx={30} ry={3.4} />

      {/* Stand. */}
      <path d="M52 70 H68 L72 84 H48 Z" fill="#2b323b" />
      <rect x="44" y="83" width="32" height="4" rx="2" fill="#3f4855" />
      <rect x="57" y="62" width="6" height="10" fill="#343c46" />

      {/* Screen. */}
      <rect x="18" y="14" width="84" height="50" rx="3.5" fill="url(#kpi-bezel)" />
      <rect x="21.5" y="17.5" width="77" height="41" rx="2" fill="url(#kpi-glass)" />

      {/* What is on it: a gauge arc and a trend, which is what this panel is. */}
      <path d="M31 47 A 13 13 0 0 1 57 47" fill="none" stroke="#1d3b4a" strokeWidth="3.4"
            strokeLinecap="round" />
      <path d="M31 47 A 13 13 0 0 1 49.5 35.3" fill="none" stroke={LIVE.glow} strokeWidth="3.4"
            strokeLinecap="round" />
      <circle cx="44" cy="47" r="1.6" fill={SCREEN.text} />
      <path d="M44 47 50.5 39.5" stroke={SCREEN.text} strokeWidth="1.2" strokeLinecap="round" />

      <g opacity="0.9">
        <path d="M63 50 Q 70 50 74 42 T 84 28 L92 25" fill="none" stroke={SCREEN.text}
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M63 50 Q 70 50 74 42 T 84 28 L92 25 L92 50 Z" fill={SCREEN.text} opacity="0.14" />
      </g>
      <g fill={SCREEN.text} opacity="0.55">
        <rect x="63" y="21" width="16" height="2" rx="1" />
        <rect x="63" y="25" width="9" height="1.5" rx="0.75" opacity="0.6" />
      </g>
      <circle cx="96" cy="61" r="1.4" fill={LIVE.glow} />
      <Rim d="M21 15 H99" width={0.9} />
    </>
  );
}

/** An uninterruptible power supply: a cabinet whose identity is its battery. */
export function Ups(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="ups-face" x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="55%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
      </defs>
      <Ground cx={60} rx={34} ry={3.6} />
      <path d="M30 18 L36 14 L90 14 L84 18 Z" fill="#f0f4f7" />
      <path d="M84 18 L90 14 L90 82 L84 86 Z" fill={STEEL.edge} />
      <rect x="30" y="18" width="54" height="68" rx="2" fill="url(#ups-face)" />
      <rect x="35" y="23" width="20" height="13" rx="1.2" fill={SCREEN.glass} />
      <rect x="37" y="26" width="10" height="1.6" rx="0.8" fill={SCREEN.text} opacity="0.85" />
      <rect x="37" y="29.5" width="14" height="1.4" rx="0.7" fill={SCREEN.text} opacity="0.5" />
      {/* Battery cells behind a vented door. */}
      <rect x="35" y="42" width="44" height="34" rx="1.4" fill={STEEL.shade} opacity="0.45" />
      {[0, 1, 2].map((r) =>
        [0, 1, 2, 3].map((c) => (
          <g key={`${r}-${c}`}>
            <rect x={37.5 + c * 10} y={45 + r * 10.5} width="8" height="7.6" rx="0.8"
                  fill="#2f3944" />
            <rect x={39 + c * 10} y={44.2 + r * 10.5} width="1.6" height="1.4" fill={COPPER.mid} />
            <rect x={42.5 + c * 10} y={44.2 + r * 10.5} width="1.6" height="1.4" fill={COPPER.dark} />
          </g>
        )),
      )}
      <circle cx="62" cy="30" r="2.1" fill={LIVE.glow} />
      <circle cx="69" cy="30" r="2.1" fill="#e0a33a" />
      <circle cx="76" cy="30" r="2.1" fill={STEEL.edge} opacity="0.6" />
      <Rim d="M30 18 L36 14 L90 14" width={1.1} />
    </>
  );
}

/** A battery / DC power bank: a rack of cells, open-fronted. */
export function DcPowerBank(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="dcb-rack" x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0%" stopColor={GALV.light} />
          <stop offset="100%" stopColor={GALV.dark} />
        </linearGradient>
      </defs>
      <Ground cx={60} rx={38} ry={3.8} />
      <rect x="24" y="16" width="72" height="70" rx="2" fill="url(#dcb-rack)" />
      <rect x="27" y="19" width="66" height="64" rx="1.2" fill={STEEL.edge} opacity="0.45" />
      {[0, 1, 2, 3].map((r) => (
        <g key={r}>
          <rect x="27" y={19 + r * 16} width="66" height="2" fill={GALV.dark} />
          {[0, 1, 2, 3, 4].map((c) => (
            <g key={c}>
              <rect x={29 + c * 12.8} y={22.5 + r * 16} width="10.6" height="12" rx="1"
                    fill="#39434f" />
              <rect x={29 + c * 12.8} y={22.5 + r * 16} width="10.6" height="1.2" rx="0.6"
                    fill={RIM} opacity="0.3" />
              <rect x={31 + c * 12.8} y={21.2 + r * 16} width="2" height="1.8" fill={COPPER.mid} />
              <rect x={36 + c * 12.8} y={21.2 + r * 16} width="2" height="1.8" fill="#4a5462" />
            </g>
          ))}
        </g>
      ))}
      {/* Inter-tier links, which is what makes a rack a bank. */}
      <g stroke={COPPER.mid} strokeWidth="1.4" opacity="0.85" strokeLinecap="round">
        <path d="M32 21 H90" transform="translate(0 16)" />
        <path d="M32 21 H90" transform="translate(0 48)" />
      </g>
      <Rim d="M24.6 16.4 H95.4" />
    </>
  );
}

/** An annunciator: a matrix of lamp windows, some alarmed. */
export function Annunciator(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="ann-body" x1="0" y1="0" x2="1" y2="0.4">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
      </defs>
      <Ground cx={60} rx={34} ry={3.4} />
      <path d="M22 26 L28 21 L98 21 L92 26 Z" fill="#f0f4f7" />
      <path d="M92 26 L98 21 L98 68 L92 73 Z" fill={STEEL.edge} />
      <rect x="22" y="26" width="70" height="47" rx="2.5" fill="url(#ann-body)" />
      {[0, 1, 2].map((r) =>
        [0, 1, 2, 3].map((c) => {
          const lit = (r === 0 && c === 2) || (r === 2 && c === 0);
          const warn = r === 1 && c === 3;
          return (
            <g key={`${r}-${c}`}>
              <rect x={26 + c * 16.5} y={30 + r * 13.5} width="14" height="10.5" rx="1"
                    fill={lit ? "#d34b3c" : warn ? "#e0a33a" : "#dfe6ec"} />
              <rect x={26 + c * 16.5} y={30 + r * 13.5} width="14" height="10.5" rx="1"
                    fill="none" stroke={STEEL.edge} strokeWidth="0.7" opacity="0.6" />
              <g fill={lit || warn ? "#ffffff" : STEEL.dark} opacity={lit || warn ? 0.85 : 0.45}>
                <rect x={28.5 + c * 16.5} y={33 + r * 13.5} width="9" height="1.3" rx="0.65" />
                <rect x={28.5 + c * 16.5} y={36 + r * 13.5} width="6.5" height="1.3" rx="0.65" />
              </g>
            </g>
          );
        }),
      )}
      {/* Accept / reset / test pushbuttons. */}
      <g>
        {[36, 52, 68, 84].map((x, i) => (
          <circle key={x} cx={x} cy="78" r="3.4"
                  fill={i === 0 ? "#3f7fbf" : i === 1 ? "#d34b3c" : STEEL.dark} />
        ))}
      </g>
      <Rim d="M22 26 L28 21 L98 21" width={1.1} />
    </>
  );
}

/** A fire detection and suppression panel. */
export function FireSystem(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="fire-body" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0%" stopColor="#d9534a" />
          <stop offset="55%" stopColor="#b03a32" />
          <stop offset="100%" stopColor="#7e2822" />
        </linearGradient>
      </defs>
      <Ground cx={60} rx={32} ry={3.4} />
      <path d="M28 20 L34 15 L92 15 L86 20 Z" fill="#e8776d" />
      <path d="M86 20 L92 15 L92 76 L86 81 Z" fill="#6d221d" />
      <rect x="28" y="20" width="58" height="61" rx="2.5" fill="url(#fire-body)" />
      <rect x="33" y="25" width="30" height="16" rx="1.4" fill={SCREEN.glass} />
      <rect x="35.5" y="28.5" width="15" height="1.8" rx="0.9" fill={SCREEN.text} opacity="0.85" />
      <rect x="35.5" y="32.5" width="22" height="1.5" rx="0.75" fill={SCREEN.text} opacity="0.5" />
      <rect x="35.5" y="36" width="18" height="1.5" rx="0.75" fill={SCREEN.text} opacity="0.35" />
      {/* Zone lamps. */}
      <g>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <circle key={i} cx={36 + (i % 3) * 11} cy={49 + Math.floor(i / 3) * 9} r="2.4"
                  fill={i === 0 ? LIVE.glow : "#f0c9c5"} opacity={i === 0 ? 1 : 0.6} />
        ))}
      </g>
      {/* Break-glass call point. */}
      <rect x="69" y="46" width="13" height="13" rx="1.4" fill="#f2f4f6" />
      <path d="M71 57.5 80 47.5" stroke="#b03a32" strokeWidth="1" opacity="0.6" />
      <circle cx="75.5" cy="52.5" r="3" fill="#d9534a" />
      {/* Sounder. */}
      <path d="M33 68 L40 68 L46 63 L46 79 L40 74 L33 74 Z" fill="#f2f4f6" opacity="0.9" />
      <g stroke="#f2f4f6" strokeWidth="1.1" fill="none" opacity="0.7" strokeLinecap="round">
        <path d="M50 66 Q 54 71 50 76" />
        <path d="M55 63 Q 61 71 55 79" />
      </g>
      <Rim d="M28 20 L34 15 L92 15" width={1.1} />
    </>
  );
}

/** A single-axis tracker: the row drive and its actuator. */
export function ModuleTracker(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="trk-panel" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor={CELL.light} />
          <stop offset="100%" stopColor={CELL.deep} />
        </linearGradient>
        <linearGradient id="trk-steel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={GALV.light} />
          <stop offset="100%" stopColor={GALV.edge} />
        </linearGradient>
      </defs>
      <Ground cx={60} rx={40} ry={3.8} />
      {/* Pier. */}
      <rect x="57" y="44" width="6" height="44" rx="1" fill="url(#trk-steel)" />
      {/* The rotating table, caught mid-tilt — a tracker's identity is the angle. */}
      <g transform="rotate(-24 60 42)">
        <rect x="18" y="38" width="84" height="8" rx="1.6" fill={GALV.mid} />
        <rect x="19.5" y="32.5" width="81" height="7" rx="1" fill="url(#trk-panel)" />
        <rect x="19.5" y="44.5" width="81" height="7" rx="1" fill="url(#trk-panel)" opacity="0.85" />
        <g stroke={CELL.grid} strokeWidth="0.5" opacity="0.4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <path key={i} d={`M${28 + i * 10} 32.5 V 51.5`} />
          ))}
        </g>
        <rect x="19.5" y="32.5" width="81" height="1" fill={RIM} opacity="0.45" />
      </g>
      {/* Slew drive at the pivot. */}
      <circle cx="60" cy="42" r="7" fill={STEEL.dark} />
      <circle cx="60" cy="42" r="4.6" fill={STEEL.mid} />
      <circle cx="60" cy="42" r="1.8" fill={STEEL.edge} />
      <g stroke={STEEL.edge} strokeWidth="0.8" opacity="0.7">
        {[0, 45, 90, 135].map((a) => (
          <path key={a} d="M53.5 42 H66.5" transform={`rotate(${a} 60 42)`} />
        ))}
      </g>
      {/* Actuator motor and its cable. */}
      <rect x="64" y="52" width="14" height="8" rx="2" fill={STEEL.mid} />
      <rect x="64" y="52" width="14" height="8" rx="2" fill="none" stroke={STEEL.edge}
            strokeWidth="0.6" opacity="0.6" />
      <path d="M71 60 Q 74 72 66 86" stroke={STEEL.edge} strokeWidth="1.4" fill="none" />
      <Rim d="M57.4 44.4 57.4 87" width={0.8} />
    </>
  );
}

/** An SLDC telemetry unit: an RTU with its antenna. */
export function TelemetryUnit(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="rtu-body" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="55%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
      </defs>
      <Ground cx={60} rx={32} ry={3.4} />
      {/* Whip antenna with its propagation arcs — the only thing that makes an
          RTU look different from every other small box. */}
      <rect x="83" y="16" width="2" height="26" rx="1" fill={GALV.dark} />
      <circle cx="84" cy="14.5" r="2" fill={GALV.mid} />
      <g stroke={LIVE.glow} strokeWidth="1.2" fill="none" strokeLinecap="round" opacity="0.7">
        <path d="M89 18 Q 93 22 89 26" />
        <path d="M94 14 Q 100 22 94 30" />
        <path d="M79 18 Q 75 22 79 26" opacity="0.5" />
      </g>
      <path d="M26 38 L32 33 L88 33 L82 38 Z" fill="#f0f4f7" />
      <path d="M82 38 L88 33 L88 74 L82 79 Z" fill={STEEL.edge} />
      <rect x="26" y="38" width="56" height="41" rx="2.5" fill="url(#rtu-body)" />
      <rect x="31" y="43" width="22" height="12" rx="1.2" fill={SCREEN.glass} />
      <rect x="33" y="46" width="11" height="1.5" rx="0.75" fill={SCREEN.text} opacity="0.85" />
      <rect x="33" y="49.5" width="15" height="1.3" rx="0.65" fill={SCREEN.text} opacity="0.5" />
      <g>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <circle key={i} cx={59 + (i % 4) * 6} cy={45 + Math.floor(i / 4) * 6} r="1.5"
                  fill={i < 3 ? LIVE.glow : "#6b7683"} opacity={i < 3 ? 0.95 : 0.75} />
        ))}
      </g>
      {/* Terminal block along the bottom — an RTU is mostly terminals. */}
      <rect x="31" y="62" width="46" height="11" rx="1.2" fill={STEEL.shade} opacity="0.5" />
      {Array.from({ length: 12 }).map((_, i) => (
        <rect key={i} x={32.5 + i * 3.8} y="64" width="2.4" height="7" rx="0.5"
              fill={COPPER.mid} opacity="0.75" />
      ))}
      <Rim d="M26 38 L32 33 L88 33" width={1.1} />
    </>
  );
}

/**
 * The fallback: a generic cubicle.
 *
 * Reached by any Device Type with no drawing of its own, which is the normal
 * state for a type a Client adds tomorrow. Drawn to the same standard as the
 * rest so an unrecognised type looks *unremarkable* rather than broken — a
 * question mark here would report a gap in our artwork as a gap in their plant.
 */
export function GenericCabinet(): JSX.Element {
  return (
    <>
      <defs>
        <linearGradient id="gen-face" x1="0" y1="0" x2="1" y2="0.35">
          <stop offset="0%" stopColor={STEEL.light} />
          <stop offset="55%" stopColor={STEEL.mid} />
          <stop offset="100%" stopColor={STEEL.dark} />
        </linearGradient>
      </defs>
      <Ground cx={60} rx={34} ry={3.6} />
      <path d="M30 20 L36 15 L90 15 L84 20 Z" fill="#f0f4f7" />
      <path d="M84 20 L90 15 L90 80 L84 85 Z" fill={STEEL.edge} />
      <rect x="30" y="20" width="54" height="65" rx="2" fill="url(#gen-face)" />
      <rect x="34" y="24" width="46" height="57" rx="1.4" fill="none"
            stroke={STEEL.edge} strokeWidth="0.8" opacity="0.45" />
      <g fill={STEEL.shade} opacity="0.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <rect key={i} x="38" y={54 + i * 5} width="38" height="2.2" rx="1.1" />
        ))}
      </g>
      <rect x="38" y="29" width="20" height="12" rx="1.2" fill={STEEL.edge} opacity="0.55" />
      <circle cx="66" cy="35" r="2.1" fill={LIVE.glow} />
      <circle cx="73" cy="35" r="2.1" fill={STEEL.edge} opacity="0.6" />
      <rect x="80.5" y="48" width="2.4" height="9" rx="1.2" fill={STEEL.edge} />
      <Rim d="M30 20 L36 15 L90 15" width={1.1} />
    </>
  );
}
