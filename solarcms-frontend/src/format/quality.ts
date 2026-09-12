/**
 * Reading quality (§4.2).
 *
 * Out-of-range and unparseable values are **stored and flagged, never
 * discarded** — the backend keeps `3.29151E-41` in a reactive-power Tag on
 * purpose, because it is diagnostic information.
 *
 * The frontend's obligation is the other half of that: a bad point must not be
 * plotted as if it were data (Guardrail 4). A silently-plotted denormalised
 * float looks like a real excursion and will be reported as one.
 */

import { qualityColor } from "@/theme/tokens";

export const QUALITY_GOOD = 0;
export const QUALITY_OUT_OF_RANGE = 1;
export const QUALITY_STALE = 2;
export const QUALITY_UNPARSEABLE = 3;

export interface QualityDescriptor {
  code: number;
  label: string;
  /** Why the point is marked, shown on hover. */
  explanation: string;
  /**
   * Chart/series colour. Bad quality is muted, never the series colour.
   *
   * A getter, not a stored string: charts paint to canvas and read this at
   * draw time, so a stored value would keep the palette of whichever theme was
   * active when this module first loaded.
   */
  readonly color: string;
  /** Tailwind classes for a badge. */
  className: string;
  isGood: boolean;
}

const DESCRIPTORS: Record<number, QualityDescriptor> = {
  [QUALITY_GOOD]: {
    code: QUALITY_GOOD,
    label: "Good",
    explanation: "Within the Tag's valid range and freshly received.",
    get color() {
      return qualityColor(0);
    },
    className: "bg-ok/10 text-ok border-ok/30",
    isGood: true,
  },
  [QUALITY_OUT_OF_RANGE]: {
    code: QUALITY_OUT_OF_RANGE,
    label: "Out of range",
    explanation:
      "Outside the Tag's valid range. Stored and flagged rather than discarded — " +
      "the value is diagnostic, not a measurement.",
    get color() {
      return qualityColor(1);
    },
    className: "bg-warn/10 text-warn border-warn/30",
    isGood: false,
  },
  [QUALITY_STALE]: {
    code: QUALITY_STALE,
    label: "Stale",
    explanation:
      "The source timestamp is older than the Device's expected interval allows; " +
      "the value was repeated rather than re-measured.",
    get color() {
      return qualityColor(2);
    },
    className: "bg-ink-faint/10 text-ink-muted border-ink-faint/30",
    isGood: false,
  },
  [QUALITY_UNPARSEABLE]: {
    code: QUALITY_UNPARSEABLE,
    label: "Unparseable",
    explanation:
      "The published payload could not be decoded into a number. Retained for " +
      "diagnosis; it is not a reading.",
    get color() {
      return qualityColor(3);
    },
    className: "bg-bad/10 text-bad border-bad/30",
    isGood: false,
  },
};

export function quality(code: number | null | undefined): QualityDescriptor {
  if (code === null || code === undefined) return DESCRIPTORS[QUALITY_UNPARSEABLE];
  return DESCRIPTORS[code] ?? DESCRIPTORS[QUALITY_UNPARSEABLE];
}

export function isGoodQuality(code: number | null | undefined): boolean {
  return code === QUALITY_GOOD;
}

/** Every non-good code present in a series, for a chart's quality legend. */
export function summariseQuality(codes: (number | null | undefined)[]): QualityDescriptor[] {
  const seen = new Set<number>();
  for (const code of codes) {
    if (!isGoodQuality(code)) seen.add(quality(code).code);
  }
  return [...seen].sort((a, b) => a - b).map((code) => DESCRIPTORS[code]);
}
