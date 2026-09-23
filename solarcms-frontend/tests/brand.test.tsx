/**
 * The brand palette's load-bearing relationships.
 *
 * These assert *relationships* between tokens — a distance, a contrast ratio —
 * never a hex value, so a palette tweak that keeps the properties passes and
 * one that breaks them fails. Each property is one that a plausible edit breaks
 * silently:
 *
 *  - The accent was green until 23 Sep 2026 and was the same RGB as `--c-ok`,
 *    so every selected tab and active menu item said "healthy". Nothing about
 *    that looks broken on screen, which is why it is asserted.
 *  - The brand orange is 3.5 ΔE from `--c-warn`; the rule that keeps it out of
 *    the UI is "the accent may not sit near any status colour", checked here.
 *  - White text on the dark accent is 2.2:1. `--c-on-accent` exists so a
 *    primary button is readable in both themes.
 *  - `FALLBACK` in `theme/tokens.ts` must mirror the light palette; a stale
 *    entry paints jsdom and the first frame in last season's colours.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BrandMark } from "@/components/layout/BrandMark";
import { ThemeProvider } from "@/theme/ThemeProvider";
import { seriesPalette, token, type TokenName } from "@/theme/tokens";

type Rgb = [number, number, number];

const css = readFileSync(join(__dirname, "..", "src/index.css"), "utf8");
const BLOCKS = {
  light: css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")),
  "dark (system)": css.slice(
    css.indexOf("@media (prefers-color-scheme: dark)"),
    css.indexOf(':root[data-theme="dark"]'),
  ),
  "dark (chosen)": css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf("  body {")),
};

function tokensOf(block: string): Map<string, Rgb> {
  const out = new Map<string, Rgb>();
  for (const m of block.matchAll(/--c-([a-z0-9-]+):\s*(\d+)\s+(\d+)\s+(\d+)\s*;/g)) {
    out.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return out;
}

const linear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab ΔE ×100 — the scale the palette validator and `index.css` quote. */
function deltaE(a: Rgb, b: Rgb): number {
  const lab = ([r, g, b]: Rgb): Rgb => {
    const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
    const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [p, q] = [lab(a), lab(b)];
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** `fg` at `alpha` over `bg` — what `bg-accent/10` actually paints. */
function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb;
}

describe.each(Object.entries(BLOCKS))("brand palette — %s", (_name, block) => {
  const t = tokensOf(block);
  const get = (name: string): Rgb => {
    const value = t.get(name);
    if (!value) throw new Error(`--c-${name} is not defined in this block`);
    return value;
  };

  it("keeps the accent clearly apart from every status colour", () => {
    // 15 is the palette validator's normal-vision floor: below it, a
    // full-colour reader cannot reliably tell two marks apart.
    const tooClose = (["ok", "warn", "bad", "info"] as const)
      .map((status) => [status, deltaE(get("accent"), get(status))] as const)
      .filter(([, distance]) => distance < 15)
      .map(([status, distance]) => `${status} ${distance.toFixed(1)}`);
    expect(tooClose).toEqual([]);
  });

  it("keeps accent text readable wherever it is drawn", () => {
    const sunken = get("surface-sunken");
    expect(contrast(get("accent"), get("surface-raised"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get("accent"), sunken)).toBeGreaterThanOrEqual(4.5);
    // The active menu item: accent text on an accent/10 tint over the sidebar.
    expect(contrast(get("accent"), over(get("accent"), 0.1, sunken))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps text on an accent fill readable, at rest and on hover", () => {
    expect(contrast(get("on-accent"), get("accent"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(get("on-accent"), get("accent-strong"))).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps body and secondary text readable on every ground", () => {
    for (const ground of ["surface", "surface-raised", "surface-sunken"]) {
      expect(contrast(get("ink"), get(ground))).toBeGreaterThanOrEqual(7);
      expect(contrast(get("ink-muted"), get(ground))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the navy sidebar readable from top to foot of its gradient", () => {
    for (const ground of ["nav", "nav-deep"]) {
      expect(contrast(get("nav-ink"), get(ground))).toBeGreaterThanOrEqual(7);
      expect(contrast(get("nav-muted"), get(ground))).toBeGreaterThanOrEqual(4.5);
      // The 10px group headings: faint by design, never below 4:1.
      expect(contrast(get("nav-faint"), get(ground))).toBeGreaterThanOrEqual(4);
      expect(contrast(get("nav-accent"), get(ground))).toBeGreaterThanOrEqual(4.5);
    }
    // The active item: accent text on its own 14% tint.
    const tint = over(get("nav-accent"), 0.14, get("nav"));
    expect(contrast(get("nav-accent"), tint)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the runtime fallback mirrors the light palette", () => {
  const light = tokensOf(BLOCKS.light);
  // The names `token()` accepts, read from the union itself. A CSS-only token
  // such as `--c-edge-top` is never read at runtime and has no fallback.
  const source = readFileSync(join(__dirname, "..", "src/theme/tokens.ts"), "utf8");
  const union = source.slice(
    source.indexOf("export type TokenName"),
    source.indexOf(";", source.indexOf("export type TokenName")),
  );
  const runtimeNames = [...union.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);

  it("returns the light value of every token when no stylesheet applies", () => {
    expect(runtimeNames.length).toBeGreaterThan(10);
    // jsdom applies no stylesheet, so `token()` answers from FALLBACK here.
    const stale: string[] = [];
    runtimeNames.forEach((name) => {
      const value = light.get(name);
      if (!value) {
        stale.push(`${name}: not defined in the light block`);
        return;
      }
      const [r, g, b] = value;
      const expected = `rgb(${r},${g},${b})`;
      const actual = token(name as TokenName);
      if (actual !== expected) stale.push(`${name}: ${actual} ≠ ${expected}`);
    });
    expect(stale).toEqual([]);
  });

  it("returns the light series colours in order", () => {
    const expected = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
      const [r, g, b] = light.get(`series-${n}`) ?? [0, 0, 0];
      return `rgb(${r},${g},${b})`;
    });
    expect(seriesPalette()).toEqual(expected);
  });
});

describe("the logo follows the theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  const src = () =>
    screen.getByRole("img", { name: /Ability Automation/ }).getAttribute("src") ?? "";

  it("draws the navy lettering on a light ground", () => {
    localStorage.setItem("solarcms.theme", "light");
    render(
      <ThemeProvider>
        <BrandMark />
      </ThemeProvider>,
    );
    expect(src()).toMatch(/ability-logo\.png$/);
  });

  it("draws the reversed lettering on a dark ground, where navy would vanish", () => {
    localStorage.setItem("solarcms.theme", "dark");
    render(
      <ThemeProvider>
        <BrandMark />
      </ThemeProvider>,
    );
    expect(src()).toMatch(/ability-logo-reversed\.png$/);
  });

  it("uses the symbol alone in the compact rail", () => {
    localStorage.setItem("solarcms.theme", "dark");
    render(
      <ThemeProvider>
        <BrandMark compact />
      </ThemeProvider>,
    );
    expect(src()).toMatch(/ability-mark-reversed\.png$/);
  });
});
