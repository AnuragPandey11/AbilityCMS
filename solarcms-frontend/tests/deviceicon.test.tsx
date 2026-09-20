/**
 * The Device Type icon layer.
 *
 * Two things are worth holding still here. The fallback, because artwork
 * arriving late must never leave a Device with no icon at all — an empty slot
 * in a row of equipment reads as a Device that failed to load rather than one
 * nobody has drawn yet. And the override path, because supplied artwork is
 * rendered as a *mask* tinted with `currentColor`: swapping it for an `<img>`
 * would look identical in light mode and wrong in every status colour.
 */

import { describe, expect, it, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeviceIcon, SUPPLIED_ICONS } from "@/components/devices/DeviceIcon";

const KNOWN = [
  "PV_ARRAY", "SMB", "DCDB", "INVERTER", "ACDB", "TRANSFORMER", "VCB",
  "ISOLATOR", "MFM", "ABT_METER", "NET_METER", "MCR_SECTION", "ICR_SECTION",
  "WMS", "PPC", "PLANT_KPI",
];

afterEach(() => {
  for (const key of Object.keys(SUPPLIED_ICONS)) delete SUPPLIED_ICONS[key];
});

describe("built-in drawings", () => {
  it("renders an icon for every Device Type the platform defines", () => {
    for (const code of KNOWN) {
      const { container, unmount } = render(<DeviceIcon typeCode={code} />);
      const svg = container.querySelector("svg");
      expect(svg, `${code} rendered no svg`).not.toBeNull();
      expect(svg!.querySelectorAll("path, rect, circle").length).toBeGreaterThan(0);
      unmount();
    }
  });

  it("gives distinct shapes to equipment that must not be confused", () => {
    // A generic box for everything is the failure this set exists to correct:
    // an operator scanning rows matches silhouettes, so a Transformer and a
    // breaker sharing one shape defeats the point of drawing them at all.
    const shapes = new Set<string>();
    for (const code of KNOWN) {
      const { container, unmount } = render(<DeviceIcon typeCode={code} />);
      shapes.add(container.querySelector("svg")!.innerHTML);
      unmount();
    }
    // MFM and NET_METER deliberately share one dial, as do the two enclosures.
    expect(shapes.size).toBe(KNOWN.length - 2);
  });

  it("falls back rather than rendering nothing for an unknown type", () => {
    const { container } = render(<DeviceIcon typeCode="MODULE_TRACKER" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("is hidden from assistive technology unless it is the only label", () => {
    const { container: plain } = render(<DeviceIcon typeCode="INVERTER" />);
    expect(plain.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    const { container: labelled } = render(
      <DeviceIcon typeCode="INVERTER" title="Inverter" />,
    );
    const svg = labelled.querySelector("svg")!;
    expect(svg).not.toHaveAttribute("aria-hidden");
    expect(svg).toHaveAttribute("aria-label", "Inverter");
  });
});

describe("supplied artwork", () => {
  it("overrides the drawing and is tinted with currentColor", () => {
    SUPPLIED_ICONS.INVERTER = "inverter.svg";
    const { container } = render(<DeviceIcon typeCode="INVERTER" />);

    // No svg: the file replaced it.
    expect(container.querySelector("svg")).toBeNull();

    const span = container.querySelector("span")!;
    // `currentColor` is what lets supplied artwork follow the status tint of
    // the container it sits in, exactly as the drawn set does.
    // jsdom lower-cases CSS keywords, so compare case-insensitively.
    expect(span.style.backgroundColor.toLowerCase()).toBe("currentcolor");
    expect(span.style.getPropertyValue("mask-image")).toContain(
      "/icons/devices/inverter.svg",
    );
  });

  it("leaves every other type on its built-in drawing", () => {
    SUPPLIED_ICONS.INVERTER = "inverter.svg";
    const { container } = render(<DeviceIcon typeCode="TRANSFORMER" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("declares no override in source, so the app never waits on artwork", () => {
    // Read from source rather than from the imported object: the tests above
    // mutate the live registry, so asserting on it here would pass whatever
    // the file actually says. This is the check that a half-wired entry —
    // named here but with no file dropped in — does not reach main.
    const source = readFileSync(
      join(__dirname, "..", "src/components/devices/DeviceIcon.tsx"),
      "utf8",
    );
    const declaration = source.match(
      /SUPPLIED_ICONS: Record<string, string> = \{([^}]*)\}/,
    );
    expect(declaration, "SUPPLIED_ICONS declaration not found").not.toBeNull();
    expect(declaration![1].trim()).toBe("");
  });
});
