/**
 * The interface icon set.
 *
 * ── Why these are drawn here rather than installed ──────────────────────────
 * A general-purpose icon pack gives you a bell, a gear and a chart, and then
 * leaves you to represent "single line diagram", "performance ratio",
 * "communication loss" and "the plant's electrical boundary" with whatever is
 * nearest. What arrives is a sun for irradiance, a lightning bolt for anything
 * electrical, and the same bar chart on four screens that mean different
 * things — which is how an interface ends up looking assembled rather than
 * designed, and why the icons stop carrying information.
 *
 * Every icon below is drawn for the concept it labels in this platform's
 * vocabulary, and the domain ones are drawn as the *thing*: the SLD icon is a
 * one-line schematic, the inverter icon is DC going in and AC coming out, the
 * availability icon is a clock with a segment missing.
 *
 * ── The constraints that make twenty icons look like a set ──────────────────
 * - 24px grid, `currentColor`, stroke only, no fills. They inherit type colour
 *   and sit on the text baseline like a letter.
 * - **1.7px stroke, round caps and joins**, everywhere. The single most
 *   common way a mixed icon set gives itself away is two stroke weights.
 * - Optical weight matched, not geometric: a circle at r=8 looks heavier than
 *   a square at 16, so circles are drawn slightly smaller.
 * - Nothing smaller than a 2px gap, because at 16px rendered a 1px gap fills
 *   in and the icon becomes a blob.
 *
 * `size` defaults to 18: the size these sit at in navigation and buttons.
 */

export interface IconProps {
  size?: number;
  className?: string;
  /** Set only where the icon is the sole label. Otherwise it stays decorative. */
  title?: string;
  strokeWidth?: number;
}

function Svg({
  size = 18,
  className = "",
  title,
  strokeWidth = 1.7,
  children,
}: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : "presentation"}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={`shrink-0 ${className}`}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

// ── Navigation: the monitoring altitudes ───────────────────────────────────

/** Portfolio — the fleet. Stacked plates, because a portfolio is Plants summed. */
export const IconPortfolio = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 21 8l-9 4.5L3 8Z" />
    <path d="M3 12.4 12 17l9-4.6" />
    <path d="M3 16.6 12 21.2l9-4.6" />
  </Svg>
);

/** Plant Overview — one card per Plant, ordered by which needs attention. */
export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3.6" width="8" height="7.4" rx="1.6" />
    <rect x="13" y="3.6" width="8" height="7.4" rx="1.6" />
    <rect x="3" y="13" width="8" height="7.4" rx="1.6" />
    <rect x="13" y="13" width="8" height="7.4" rx="1.6" />
  </Svg>
);

/** Plant List — the table. Rows with a sort handle. */
export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 6h17M3.5 12h17M3.5 18h11" />
    <path d="M18 15.6 20.4 18 18 20.4" />
  </Svg>
);

/**
 * Single Plant — a plant, seen as its array and its mast.
 * Not a sun: a sun is irradiance, which is a different thing that also has an
 * icon in this file, and the two must not be interchangeable.
 */
export const IconPlant = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 15.5 6.8 7.6h10.6l4.2 7.9Z" />
    <path d="M2.6 15.5h19.2M9.4 7.6 7.6 15.5M14.6 7.6l1.8 7.9" />
    <path d="M12 15.8V21M8.6 21h6.8" />
  </Svg>
);

/**
 * Single Line Diagram — a one-line: source, a transformer coupling, a breaker
 * gap, the busbar. It is literally the diagram it opens.
 */
export const IconSld = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 4.2v4.4M4 15.4v4.4" />
    <circle cx="4" cy="12" r="3.2" />
    <path d="M9.4 12h3.4" />
    <path d="M15.6 13.6 19 10" />
    <circle cx="14.6" cy="14.2" r="1.1" />
    <circle cx="19.8" cy="9.2" r="1.1" />
    <path d="M20.6 12.6V20M17 20h7" />
  </Svg>
);

/**
 * Inverter Monitoring — the conversion itself: flat DC in, a sine out.
 * The machine's entire identity is that transition, so that is the drawing.
 */
export const IconInverter = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.8" y="4.4" width="18.4" height="15.2" rx="2.4" />
    <path d="M12 4.4v15.2" strokeDasharray="1.6 2.2" />
    <path d="M5.6 12h3.8" />
    <path d="M14.6 14.2c.9-3.2 2.2-3.2 3.1 0" />
    <path d="M17.7 14.2c.9 3.2 2.2 3.2 3.1 0" transform="translate(-3.1 0)" />
  </Svg>
);

/** Alarms. A bell with a clapper — never a triangle, which means "caution". */
export const IconAlarm = (p: IconProps) => (
  <Svg {...p}>
    <path d="M18 9.4a6 6 0 1 0-12 0c0 4.3-1.5 5.7-2 6.4-.3.5 0 1.2.6 1.2h14.8c.6 0 .9-.7.6-1.2-.5-.7-2-2.1-2-6.4Z" />
    <path d="M10.2 20.2a2.1 2.1 0 0 0 3.6 0" />
  </Svg>
);

/** Reports — a document whose content is a chart, because that is what these are. */
export const IconReport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 2.8h8l5 5v13.4H6Z" />
    <path d="M14 2.8v5h5" />
    <path d="M9.4 17.6v-3.4M12.4 17.6v-6M15.4 17.6v-4.6" />
  </Svg>
);

/** Device Health — a pulse that flatlines, which is what a silent Device is. */
export const IconHealth = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 12.6h3.6l2-5.2 3 10.4 2.2-6.4 1.6 3.4h2.2" />
    <path d="M18.8 12.6h2.6" strokeDasharray="1.4 2" />
  </Svg>
);

/**
 * Irradiance / weather. A sun with a sensor dome under it, not a bare sun:
 * this is the *measurement*, and the measurement is the denominator of every
 * performance figure on this platform.
 */
export const IconIrradiance = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="7.4" r="3.2" />
    <path d="M12 1.8v1.4M12 11.6v1.2M6.4 7.4H5M19 7.4h-1.4M8.1 3.5 7.1 2.5M15.9 3.5l1-1M8.1 11.3l-1 1M15.9 11.3l1 1" />
    <path d="M7 19.2a5 5 0 0 1 10 0Z" />
    <path d="M4.8 19.2h14.4" />
  </Svg>
);

// ── Administration ─────────────────────────────────────────────────────────

/** Clients. A building, because a Client is an organisation, not a person. */
export const IconClient = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 20.6V5.4a1.6 1.6 0 0 1 1.6-1.6h7.2a1.6 1.6 0 0 1 1.6 1.6v15.2" />
    <path d="M14 10h4.8a1.6 1.6 0 0 1 1.6 1.6v9" />
    <path d="M2.4 20.6h19.2" />
    <path d="M6.8 8h3.6M6.8 12h3.6M6.8 16h3.6M17 14h1.2M17 17.4h1.2" />
  </Svg>
);

/** Plants & Devices — equipment in a cabinet. */
export const IconDevices = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="3.4" width="17.2" height="17.2" rx="2.2" />
    <path d="M3.4 9.4h17.2M3.4 15h17.2" />
    <path d="M6.6 6.4h2M6.6 12.2h2M6.6 17.8h2" />
    <path d="M17.4 6.4h-4M17.4 12.2h-4M17.4 17.8h-4" />
  </Svg>
);

/** Wiring & Diagram — nodes and the edges between them. */
export const IconWiring = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="4.6" r="2.4" />
    <circle cx="5" cy="19" r="2.4" />
    <circle cx="19" cy="19" r="2.4" />
    <path d="M12 7v4.4M12 11.4H5.6a.6.6 0 0 0-.6.6v4.6M12 11.4h6.4a.6.6 0 0 1 .6.6v4.6" />
  </Svg>
);

/** Tag Mapping — a payload key bound to a Tag. Two links, joined. */
export const IconMapping = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.6 14.4 14.4 9.6" />
    <path d="M13 6.2 15 4.2a4 4 0 0 1 5.7 5.7l-2 2" />
    <path d="M11 17.8 9 19.8a4 4 0 0 1-5.7-5.7l2-2" />
  </Svg>
);

/** System. A server stack with a live lamp. */
export const IconSystem = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="3.6" width="17.6" height="6" rx="1.8" />
    <rect x="3.2" y="14.4" width="17.6" height="6" rx="1.8" />
    <path d="M6.8 6.6h.01M6.8 17.4h.01" strokeWidth={2.4} />
    <path d="M11 6.6h6M11 17.4h6" />
  </Svg>
);

/** Users. */
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9.4" cy="8" r="3.6" />
    <path d="M2.8 20.2a6.6 6.6 0 0 1 13.2 0" />
    <path d="M16.4 5.2a3.4 3.4 0 0 1 0 6.6" />
    <path d="M18 14.6a5.6 5.6 0 0 1 3.4 5.6" />
  </Svg>
);

// ── Actions and chrome ─────────────────────────────────────────────────────

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}><path d="M14.6 5.4 8 12l6.6 6.6" /></Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="M9.4 5.4 16 12l-6.6 6.6" /></Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="M5.4 9.4 12 16l6.6-6.6" /></Svg>
);
export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}><path d="M5.4 14.6 12 8l6.6 6.6" /></Svg>
);

/** Open the detailed view of a summary — the drill-down affordance. */
export const IconExpand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4.4h5.6V10" />
    <path d="M10 19.6H4.4V14" />
    <path d="M19.6 4.4 13.6 10.4M4.4 19.6l6-6" />
  </Svg>
);

export const IconCollapse = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19 10h-5V4.6" />
    <path d="M5 14h5v5.4" />
    <path d="M14 10l5.6-5.6M10 14l-5.6 5.6" />
  </Svg>
);

export const IconExport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.4v11.2" />
    <path d="M7.8 10.4 12 14.6l4.2-4.2" />
    <path d="M4.2 17v2.2a1.6 1.6 0 0 0 1.6 1.6h12.4a1.6 1.6 0 0 0 1.6-1.6V17" />
  </Svg>
);

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="5" width="17.2" height="15.6" rx="2.2" />
    <path d="M3.4 9.8h17.2M8 2.8v4M16 2.8v4" />
    <path d="M7.6 13.6h2M11 13.6h2M14.4 13.6h2M7.6 17h2M11 17h2" />
  </Svg>
);

export const IconLocation = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21.4s7-5.8 7-11a7 7 0 1 0-14 0c0 5.2 7 11 7 11Z" />
    <circle cx="12" cy="10.2" r="2.6" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.6" cy="10.6" r="6.6" />
    <path d="M15.6 15.6 20.6 20.6" />
  </Svg>
);

export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 5.4h17.2l-6.6 7.8v6.2l-4 1.8v-8Z" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 11.4a8 8 0 1 0-.6 4.2" />
    <path d="M20.6 20.2v-5h-5" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.6" />
    <path d="M12 7.2V12l3.2 2" />
  </Svg>
);

/** Availability: a clock with a segment missing — time the Plant did not have. */
export const IconAvailability = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.4a8.6 8.6 0 1 1-6.1 2.5" />
    <path d="M12 3.4v5.2l3.6-3.6" strokeDasharray="1.6 1.8" />
    <path d="M12 7.6V12l3 1.9" />
  </Svg>
);

/** A gauge — performance ratio, CUF, anything bounded 0..1. */
export const IconGauge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 17.4a8.8 8.8 0 1 1 16.8 0" />
    <path d="M12 17.4 16 11" />
    <circle cx="12" cy="17.4" r="1.4" />
  </Svg>
);

/** Energy — a counter that only goes up. */
export const IconEnergy = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 20.4h16.8" />
    <path d="M6.6 20.4v-5.2M11 20.4V9.8M15.4 20.4v-7.4M19.8 20.4V5.6" />
  </Svg>
);

/** Power — instantaneous. A bolt, used for this and nothing else. */
export const IconPower = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.4 2.6 4.6 13.4h6L9.8 21.4l9-11.2h-6.2Z" />
  </Svg>
);

/**
 * Nameplate capacity — a PV module with its rating plate.
 *
 * Deliberately *not* `IconPlant` (which is a whole installation, used for a
 * count of Plants) and not a location pin, which was the placeholder here and
 * says "where" about a figure that means "how big". Capacity is the size of the
 * array, so the icon is the array.
 */
export const IconCapacity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 4.6h17.2l-1.8 10.2H5.2Z" />
    <path d="M4.2 8.2h15.6M3.9 11.6h16.2" />
    <path d="M9.4 4.6 8.4 14.8M14.6 4.6l1 10.2" />
    <path d="M12 14.8v4.6M8.6 19.4h6.8" />
  </Svg>
);

/**
 * CO₂ avoided — a leaf.
 *
 * The one place a natural metaphor is right: the figure is an environmental
 * claim, not an electrical one, and every other icon in this set is equipment
 * or instrumentation. A cloud would read as weather, which this platform
 * measures for real elsewhere.
 */
export const IconLeaf = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.6 19.4c-1.8-5.2.4-10.6 5-13 2.6-1.4 6-1.6 9.4-1.2.5 3.6.2 7.2-1.4 10-2.3 4-6.6 5.8-11 4.6Z" />
    <path d="M4.6 19.4c1.6-4.6 4.6-8 8.6-10.2" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.8" />
    <path d="M12 11v5.4" />
    <path d="M12 7.7h.01" strokeWidth={2.2} />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.6 22 20.4H2Z" />
    <path d="M12 9.8v4.6" />
    <path d="M12 17.4h.01" strokeWidth={2.2} />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="M4.6 12.6 9.6 17.6 19.4 6.8" /></Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4" /></Svg>
);

export const IconMenu = (p: IconProps) => (
  <Svg {...p}><path d="M3.6 6.6h16.8M3.6 12h16.8M3.6 17.4h16.8" /></Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.6 3.8H5.8a1.8 1.8 0 0 0-1.8 1.8v12.8a1.8 1.8 0 0 0 1.8 1.8h3.8" />
    <path d="M15.4 16.2 19.6 12l-4.2-4.2" />
    <path d="M19.6 12H9" />
  </Svg>
);

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4.2" />
    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4 17 7M7 17l-1.6 1.6" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20.4 14.2A8.8 8.8 0 0 1 9.8 3.6a8.8 8.8 0 1 0 10.6 10.6Z" />
  </Svg>
);

/** Communication — the link itself, which is what a Collector failure breaks. */
export const IconSignal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 18.6h.01" strokeWidth={2.4} />
    <path d="M8.6 15.2a4.8 4.8 0 0 1 6.8 0" />
    <path d="M5.4 11.8a9.4 9.4 0 0 1 13.2 0" />
    <path d="M2.4 8.4a13.8 13.8 0 0 1 19.2 0" />
  </Svg>
);

/** A Collector — an enclosure. Dashed, because it is drawn *around* things. */
export const IconCollector = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.2" y="5.6" width="17.6" height="13.6" rx="2" strokeDasharray="3 2.4" />
    <rect x="7" y="9.6" width="4.4" height="5.6" rx="0.8" />
    <rect x="13" y="9.6" width="4" height="5.6" rx="0.8" />
  </Svg>
);
