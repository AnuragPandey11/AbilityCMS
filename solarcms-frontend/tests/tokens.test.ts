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
import { seriesPalette, withAlpha } from "@/theme/tokens";
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
  it("adds an alpha channel to an rgb() colour", () => {
    // The bug this guards: appending hex alpha to `rgb(57 135 229)` produces
    // `rgb(57 135 229)44`, which the canvas rejects at `addColorStop` — and it
    // throws inside ECharts, so the whole chart fails to paint with an error
    // naming neither the chart nor the caller.
    expect(withAlpha("rgb(57 135 229)", 0.26)).toBe("rgb(57 135 229 / 0.26)");
  });

  it("leaves a colour it does not recognise untouched", () => {
    // Better a fully opaque mark than a mangled colour string that throws.
    expect(withAlpha("#2a78d6", 0.5)).toBe("#2a78d6");
    expect(withAlpha("", 0.5)).toBe("");
  });

  it("never produces a value the canvas would reject", () => {
    const canvasSafe = /^(rgb\([\d\s]+(\s\/\s[\d.]+)?\)|#[0-9a-f]{3,8})$/i;
    for (const color of seriesPalette()) {
      expect(withAlpha(color, 0.14)).toMatch(canvasSafe);
    }
  });
});
