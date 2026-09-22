/**
 * Every themed class a component uses must actually exist.
 *
 * This guards a failure mode that is invisible in review and invisible at
 * runtime: Tailwind silently emits **nothing** for a colour it does not know,
 * so `border-line-strong` against an undefined `line-strong` does not throw, does
 * not warn, and does not render a missing border. It falls back to whatever the
 * cascade supplies — Tailwind's own hardcoded `#e5e7eb` for a border, which
 * reads as a pale outline in light mode and a glaring near-white one in dark,
 * and `currentColor` for text, which paints an SLD connector at full ink weight.
 *
 * `line-strong` was used in fifteen places across the SLD, the hierarchy editor
 * and the Plant screens before anyone noticed it had never been defined. The
 * dashed Collector outlines and one connector tick were wrong in dark mode the
 * whole time. A test is the only thing that catches this, because the broken
 * result looks like a design decision.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { qualityColor, seriesPalette, token, tokenAlpha, withAlpha } from "@/theme/tokens";
import { parse as parseColor } from "zrender/lib/tool/color.js";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const CONFIG_SOURCE = readFileSync(join(ROOT, "tailwind.config.js"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

/**
 * The colour names the Tailwind config defines, as Tailwind sees them.
 *
 * Read out of the config's *source* rather than imported. The config is plain
 * JavaScript with no type declaration, so importing it fails the project's
 * `tsc --noEmit`, and relaxing `allowJs` for one test would weaken the
 * typecheck for the whole app. Parsing is enough here: the shape is two levels
 * deep and entirely mechanical.
 *
 * Both forms are handled — `ok: token("ok")` yields `ok`, and a nested group
 * yields `line` for its `DEFAULT` plus `line-soft`, `line-strong` for the rest.
 * The key, not the token name, is what Tailwind turns into a class.
 */
function definedColorNames(): Set<string> {
  // Past the opening brace, so the `colors:` line is not itself read as a group.
  const block = CONFIG_SOURCE.slice(
    CONFIG_SOURCE.indexOf("colors: {") + "colors: {".length,
    CONFIG_SOURCE.indexOf("boxShadow:"),
  );
  const names = new Set<string>();
  let group: string | null = null;

  for (const line of block.split("\n")) {
    const nested = line.match(/^\s*([a-z0-9]+):\s*\{\s*$/);
    if (nested) {
      group = nested[1];
      names.add(group);
      continue;
    }
    if (/^\s*\},?\s*$/.test(line)) {
      group = null;
      continue;
    }
    // A one-line group: `line: { DEFAULT: token("line"), soft: token(...) }`.
    const inline = line.match(/^\s*([a-z0-9]+):\s*\{(.+)\}/);
    if (inline) {
      names.add(inline[1]);
      for (const key of inline[2].matchAll(/([a-zA-Z0-9]+):\s*token\(/g)) {
        if (key[1] !== "DEFAULT") names.add(`${inline[1]}-${key[1]}`);
      }
      continue;
    }
    const entry = line.match(/^\s*([a-zA-Z0-9]+):\s*token\(/);
    if (!entry) continue;
    if (group === null) names.add(entry[1]);
    else if (entry[1] !== "DEFAULT") names.add(`${group}-${entry[1]}`);
  }
  return names;
}

/** Utilities that take a colour. `divide`/`ring` included — same failure. */
const UTILITIES = "bg|text|border|ring|fill|stroke|divide|from|via|to|shadow|outline|accent";
/** Only the semantic families; `text-sm` and `border-2` must not be swept up. */
const FAMILIES = "surface|line|ink|accent|ok|warn|bad|info|q[0-3]";

describe("themed utility classes resolve to a defined token", () => {
  const defined = definedColorNames();
  const files = sourceFiles(join(ROOT, "src"));

  it("finds the source tree and a non-trivial palette", () => {
    // A guard on the guard: a broken glob here would make every assertion below
    // pass by finding nothing at all.
    expect(files.length).toBeGreaterThan(50);
    expect(defined.size).toBeGreaterThan(10);
  });

  it("uses no colour the Tailwind config does not define", () => {
    const pattern = new RegExp(`\\b(?:${UTILITIES})-(${FAMILIES})(?:-[a-z]+)?\\b`, "g");
    const offenders: string[] = [];

    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(pattern)) {
        const utility = match[0].slice(0, match[0].indexOf("-"));
        const colour = match[0].slice(utility.length + 1);
        if (!defined.has(colour)) {
          offenders.push(`${file.replace(`${ROOT}/`, "")}: ${match[0]}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("every token the config references is defined in every theme", () => {
  const css = readFileSync(join(ROOT, "src/index.css"), "utf8");

  // The light default, the `prefers-color-scheme` block, and the explicit
  // `[data-theme="dark"]` block. A token added to one and forgotten in another
  // is a colour that changes to black the moment somebody toggles the theme.
  const blocks = [
    css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")),
    css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf(':root[data-theme="dark"]')),
    css.slice(css.indexOf(':root[data-theme="dark"]')),
  ];

  it("splits index.css into three populated theme blocks", () => {
    for (const block of blocks) expect(block).toContain("--c-surface");
  });

  it("defines every --c-* variable the config names, in all three", () => {
    const referenced = [...CONFIG_SOURCE.matchAll(/token\("([a-z0-9-]+)"\)/g)]
      .map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(10);

    const missing: string[] = [];
    referenced.forEach((name) => {
      blocks.forEach((block, index) => {
        if (!block.includes(`--c-${name}:`)) missing.push(`--c-${name} (block ${index})`);
      });
    });
    expect(missing).toEqual([]);
  });
});

describe("withAlpha", () => {
  it("adds an alpha channel, in the legacy comma syntax", () => {
    // Two bugs are guarded here at once.
    //
    // The first: appending hex alpha to an `rgb()` string — the reflex from
    // hex — produces `rgb(57,135,229)44`, which the canvas rejects at
    // `addColorStop`, throwing inside ECharts so the whole chart fails to
    // paint with an error naming neither the chart nor the caller.
    //
    // The second: emitting `rgb(r g b / a)`. That is valid CSS and the canvas
    // renders it, but zrender's parser returns `undefined` for it, and the
    // chart then vanishes the moment anything interpolates the colour.
    expect(withAlpha("rgb(57,135,229)", 0.26)).toBe("rgba(57,135,229,0.26)");
    // A space-separated input is normalised rather than passed through, so a
    // hand-edited token cannot reintroduce the unparseable form.
    expect(withAlpha("rgb(57 135 229)", 0.26)).toBe("rgba(57,135,229,0.26)");
  });

  it("leaves a colour it does not recognise untouched", () => {
    // Better a fully opaque mark than a mangled colour string that throws.
    expect(withAlpha("#2a78d6", 0.5)).toBe("#2a78d6");
    expect(withAlpha("", 0.5)).toBe("");
  });

  it("never produces a value the canvas would reject", () => {
    const canvasSafe = /^(rgba?\([\d.,]+\)|#[0-9a-f]{3,8})$/i;
    for (const color of seriesPalette()) {
      expect(withAlpha(color, 0.14)).toMatch(canvasSafe);
    }
  });
});

/**
 * The same silent failure as an undefined colour, in the spacing scale.
 *
 * Tailwind's default spacing has fractional steps only at 0.5, 1.5, 2.5 and
 * 3.5. `h-4.5` looks entirely plausible, compiles, lints, and emits **nothing**
 * — the element simply has no height and takes whatever its content gives it.
 * It shipped once here, on an icon chip that was meant to be a fixed square.
 */
describe("spacing scale", () => {
  const VALID_FRACTIONS = new Set(["0.5", "1.5", "2.5", "3.5"]);

  it("uses no fractional spacing step Tailwind does not define", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      // w-, h-, m-, p-, gap-, inset-, top- … followed by a fractional step.
      for (const match of source.matchAll(
        /\b(?:-)?(w|h|m[trblxy]?|p[trblxy]?|gap(?:-[xy])?|inset|top|right|bottom|left|space-[xy])-(\d+\.\d+)\b/g,
      )) {
        if (!VALID_FRACTIONS.has(match[2])) {
          offenders.push(`${file.replace(ROOT, "")}: ${match[0]}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});


/**
 * Every colour handed to a chart must be readable by the charting library.
 *
 * This guards the strangest bug the app has had. The tokens are stored as
 * space-separated channels because Tailwind needs them that way, and emitting
 * them in the same shape — `rgb(42 120 214)`, CSS Color Level 4 — yields a
 * string the browser parses happily. Canvas filled with it, every chart drew
 * correctly, and everything looked fine.
 *
 * zrender's own colour parser predates Level 4 and returns `undefined` for it.
 * Nothing broke until something *interpolated* a colour — which is what
 * hovering a series does — and then `interpolate1DArray` threw
 * `Cannot read properties of undefined (reading 'length')` and the chart
 * disappeared. A rendering test would never have caught it; only parsing does.
 */
describe("chart colours are parseable by the charting library", () => {
  const names = [
    "surface", "surface-raised", "surface-sunken",
    "line", "line-soft", "line-strong",
    "ink", "ink-muted", "ink-faint",
    "accent", "accent-strong", "accent-soft",
    "ok", "warn", "bad", "info",
    "q0", "q1", "q2", "q3",
    "chart-grid", "chart-axis", "chart-tooltip-bg", "chart-tooltip-border",
  ] as const;

  it("parses every opaque token", () => {
    for (const name of names) {
      const color = token(name);
      expect(parseColor(color), `${name} -> ${color}`).toBeDefined();
    }
  });

  it("parses every token at partial opacity", () => {
    for (const name of names) {
      for (const alpha of [0, 0.12, 0.5, 1]) {
        const color = tokenAlpha(name, alpha);
        expect(parseColor(color), `${name}@${alpha} -> ${color}`).toBeDefined();
      }
    }
  });

  it("parses every categorical series colour, plain and faded", () => {
    for (const color of seriesPalette()) {
      expect(parseColor(color), color).toBeDefined();
      expect(parseColor(withAlpha(color, 0.26)), withAlpha(color, 0.26)).toBeDefined();
    }
  });

  it("parses every quality colour", () => {
    for (const code of [0, 1, 2, 3]) {
      const color = qualityColor(code);
      expect(parseColor(color), `q${code} -> ${color}`).toBeDefined();
    }
  });

  it("never emits the space-separated form anywhere", () => {
    const level4 = /rgba?\([^),]*\s[^),]*\)/;
    const emitted = [
      ...names.map((n) => token(n)),
      ...names.map((n) => tokenAlpha(n, 0.4)),
      ...seriesPalette(),
      ...seriesPalette().map((c) => withAlpha(c, 0.3)),
      ...[0, 1, 2, 3].map((c) => qualityColor(c)),
    ];
    for (const color of emitted) {
      expect(color, `${color} uses CSS Level 4 syntax`).not.toMatch(level4);
    }
  });
});
