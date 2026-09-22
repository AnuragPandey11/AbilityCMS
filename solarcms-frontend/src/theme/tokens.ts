/**
 * Runtime access to the theme tokens.
 *
 * ECharts paints into a canvas and the SLD builds SVG attributes, so neither
 * can inherit a CSS variable the way a Tailwind class does. Both need a real
 * colour string at render time. This reads the *computed* value off <html>, so
 * it returns whatever the active theme resolved to.
 *
 * Nothing here hard-codes a colour: `index.css` remains the single place a
 * palette is defined, exactly as `domain/assumptions.py` is for the backend.
 */

export type TokenName =
  | "surface"
  | "surface-raised"
  | "surface-sunken"
  | "line"
  | "line-soft"
  | "line-strong"
  | "ink"
  | "ink-muted"
  | "ink-faint"
  | "accent"
  | "accent-strong"
  | "accent-soft"
  | "ok"
  | "warn"
  | "bad"
  | "info"
  | "q0"
  | "q1"
  | "q2"
  | "q3"
  | "chart-grid"
  | "chart-axis"
  | "chart-tooltip-bg"
  | "chart-tooltip-border";

/**
 * Fallbacks for a render where the stylesheet has not applied — jsdom in the
 * unit tests, and the first paint if CSS is still in flight.
 *
 * This mirrors the light palette in `index.css` and must stay **complete**: a
 * missing entry silently resolves to black, which for the quality codes would
 * collapse "out of range" and "unparseable" into the same colour and defeat
 * Guardrail 4 rather than raise an error. The `format` tests assert they differ.
 */
const FALLBACK: Record<string, string> = {
  "--c-surface": "234 238 236",
  "--c-surface-raised": "255 255 255",
  "--c-surface-sunken": "244 247 245",
  "--c-line": "229 234 231",
  "--c-line-soft": "238 242 240",
  "--c-line-strong": "202 212 205",
  "--c-ink": "16 26 21",
  "--c-ink-muted": "88 103 97",
  "--c-ink-faint": "141 152 143",
  "--c-accent": "18 164 90",
  "--c-accent-strong": "10 122 65",
  "--c-accent-soft": "230 246 237",
  "--c-ok": "18 164 90",
  "--c-warn": "224 152 42",
  "--c-bad": "223 75 75",
  "--c-info": "47 127 209",
  "--c-q0": "18 164 90",
  "--c-q1": "224 152 42",
  "--c-q2": "141 152 143",
  "--c-q3": "223 75 75",
  "--c-chart-grid": "229 234 231",
  "--c-chart-axis": "141 152 143",
  "--c-chart-tooltip-bg": "255 255 255",
  "--c-chart-tooltip-border": "229 234 231",
  "--c-series-1": "42 120 214",
  "--c-series-2": "235 104 52",
  "--c-series-3": "27 175 122",
  "--c-series-4": "237 161 0",
  "--c-series-5": "232 123 164",
  "--c-series-6": "0 131 0",
  "--c-series-7": "74 58 167",
  "--c-series-8": "227 73 72",
};

function rawChannels(variable: string): string {
  const fallback = FALLBACK[variable] ?? "0 0 0";
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return fallback;
  }
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim();
  return value || fallback;
}

/** A token as an opaque `rgb(...)` string. */
export function token(name: TokenName): string {
  return `rgb(${rawChannels(`--c-${name}`)})`;
}

/** A token at partial opacity — the runtime equivalent of Tailwind's `/nn`. */
export function tokenAlpha(name: TokenName, alpha: number): string {
  return `rgb(${rawChannels(`--c-${name}`)} / ${alpha})`;
}

/**
 * The same colour at partial opacity.
 *
 * ⚠ Needed because every colour this module produces is `rgb(r g b)`, and the
 * obvious shortcut — appending two hex digits, as you would to `#2a78d6` —
 * silently produces `rgb(57 135 229)44`, which the canvas rejects at
 * `addColorStop` and which throws *inside ECharts*, so the whole chart fails to
 * paint with an error that names neither the chart nor the caller. Route every
 * translucent series fill through this.
 */
export function withAlpha(color: string, alpha: number): string {
  // `rgb(r g b)` → `rgb(r g b / a)`. Anything else is returned untouched: a
  // caller passing a hex or a named colour gets their own value back rather
  // than a mangled one.
  const match = /^rgb\(([^/)]+)\)$/.exec(color.trim());
  return match ? `rgb(${match[1].trim()} / ${alpha})` : color;
}

/** The categorical series palette, in order. */
export function seriesPalette(): string[] {
  return [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `rgb(${rawChannels(`--c-series-${n}`)})`);
}

/** Quality code → colour, so a flagged point never takes the series colour. */
export function qualityColor(code: number): string {
  const name = (["q0", "q1", "q2", "q3"] as const)[code] ?? "q3";
  return token(name);
}

/**
 * Shared ECharts chrome. A function, not a constant: a constant would be
 * evaluated once at module load and freeze the first theme in place.
 */
export function chartTheme() {
  return {
    textStyle: { color: token("ink-muted"), fontFamily: "Inter, system-ui, sans-serif" },
    axisLine: { lineStyle: { color: token("chart-grid") } },
    // A solid hairline, never dashed. A dashed rule reads as a projection or a
    // threshold — both of which this platform draws for real elsewhere — and a
    // grid that looks like a threshold is a grid nobody trusts.
    splitLine: { lineStyle: { color: token("chart-grid"), type: "solid" as const, width: 1 } },
    tooltipBackground: token("chart-tooltip-bg"),
    tooltipBorder: token("chart-tooltip-border"),
    palette: seriesPalette(),
  };
}
