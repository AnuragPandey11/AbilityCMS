/**
 * The full-colour equipment artwork.
 *
 * Three things are held still here, each of which failed silently before it
 * was pinned down:
 *
 * 1. **Every Device Type the catalogue defines has a drawing**, and an
 *    unrecognised one still renders. A missing drawing does not throw — it
 *    leaves a blank where a machine should be, which reads as equipment that
 *    failed to load rather than as a type nobody has drawn.
 * 2. **The drawings are distinct.** The entire argument for full-colour artwork
 *    over the monochrome glyph set is that a transformer and a switchgear
 *    cubicle are different shapes at 40px. If two types render identical
 *    geometry, that argument is false and the artwork is costing bundle size
 *    for nothing.
 * 3. **The status colours stay out of the artwork.** Status belongs on the
 *    container, which is the component that actually knows it. A drawing that
 *    paints itself with `currentColor`, or with a theme status token, would
 *    assert a fact it has no access to.
 */

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { DeviceArt, hasDeviceArt } from "@/components/devices/DeviceArt";

/** Every `device_types.code` the platform seeds, plus the four SLD stages. */
const DEVICE_TYPES = [
  "ABT_METER", "ACDB", "ANNUNCIATOR", "DCDB", "DC_POWER_BANK", "FIRE_SYSTEM",
  "ICR_SECTION", "INVERTER", "ISOLATOR", "MCR_SECTION", "MFM", "MODULE_TRACKER",
  "PLANT_KPI", "PPC", "PV_ARRAY", "SLDC_TELEMETRY", "SMB", "TRANSFORMER",
  "UPS", "VCB", "WMS", "NET_METER",
];
const STAGE_CODES = ["PV_ARRAY", "INVERTERS", "TRANSFORMER", "GRID"];

function geometryOf(code: string): string {
  const { container, unmount } = render(<DeviceArt typeCode={code} size={80} />);
  const svg = container.querySelector("svg");
  expect(svg, `${code} rendered no svg`).not.toBeNull();
  const markup = svg!.innerHTML;
  unmount();
  return markup;
}

describe("DeviceArt", () => {
  it("draws every Device Type the catalogue defines", () => {
    for (const code of DEVICE_TYPES) {
      expect(hasDeviceArt(code), `${code} has no drawing registered`).toBe(true);
      const markup = geometryOf(code);
      expect(markup.length, `${code} drew nothing`).toBeGreaterThan(200);
    }
  });

  it("draws all four SLD stages, including the Grid", () => {
    // `GRID` is not a Device Type — it is the boundary the Plant exports
    // across — and `INVERTERS` (the stage) is not `INVERTER` (the type). Both
    // are easy to lose when the registry is edited.
    for (const code of STAGE_CODES) {
      expect(hasDeviceArt(code), `stage ${code} has no drawing`).toBe(true);
    }
  });

  it("falls back to a cabinet for a type it has never heard of", () => {
    // A Client adding a Device Type tomorrow must not get an empty box. The
    // fallback is drawn to the same standard so it reads as unremarkable
    // rather than broken.
    expect(hasDeviceArt("SOMETHING_NEW")).toBe(false);
    const markup = geometryOf("SOMETHING_NEW");
    expect(markup.length).toBeGreaterThan(200);
  });

  /**
   * Type pairs allowed to share a drawing, and why.
   *
   * Kept as an explicit list rather than loosening the check: a *deliberate*
   * pair is a design decision with a reason, an accidental one is two machines
   * an operator cannot tell apart. Adding a row here should require saying why.
   */
  const MAY_SHARE: [string, string, string][] = [
    [
      "MCR_SECTION",
      "ICR_SECTION",
      "Both are a lineup of switchgear cubicles seen from the front, and that " +
        "is what both rooms physically are. They fold into different SLD " +
        "stages and are always drawn beside their own label, so the room they " +
        "name is never in doubt.",
    ],
  ];

  it("gives equipment that must not be confused distinct geometry", () => {
    const shared = new Set(MAY_SHARE.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
    const seen = new Map<string, string>();
    for (const code of DEVICE_TYPES) {
      const markup = geometryOf(code);
      const clash = seen.get(markup);
      if (clash && shared.has(`${clash}|${code}`)) continue;
      // ACDB and DCDB share a drawing function but differ by row count, and
      // the meters differ by seal and arrows — all must still be distinct.
      expect(clash, `${code} draws exactly the same as ${clash}`).toBeUndefined();
      seen.set(markup, code);
    }
  });

  it("keeps the deliberately shared pairs actually shared", () => {
    // The other half of the rule above. If somebody differentiates one of
    // these later that is fine — but the exception should then be deleted,
    // not left behind claiming a sameness that is no longer true.
    for (const [a, b] of MAY_SHARE) {
      expect(geometryOf(a), `${a} and ${b} no longer share a drawing`).toBe(geometryOf(b));
    }
  });

  it("never paints itself in a status colour", () => {
    // Status lives on the container. A transformer that turns green when
    // healthy stops looking like a transformer, and the drawing has no access
    // to whether the Device is reporting in the first place.
    for (const code of DEVICE_TYPES) {
      const markup = geometryOf(code);
      expect(markup, `${code} uses currentColor`).not.toContain("currentColor");
      for (const token of ["--c-ok", "--c-warn", "--c-bad", "--c-accent"]) {
        expect(markup, `${code} reaches for ${token}`).not.toContain(token);
      }
    }
  });

  it("uses the theme only for the rim light and the contact shadow", () => {
    // Those two are the drawing's relationship to the page behind it, not a
    // material, so they must invert with the theme while the tank stays grey.
    const markup = geometryOf("TRANSFORMER");
    expect(markup).toContain("--art-shadow");
    expect(markup).toContain("--art-rim");
  });

  it("is decorative unless given a title", () => {
    const { container: bare } = render(<DeviceArt typeCode="INVERTER" />);
    expect(bare.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");

    const { container: labelled } = render(
      <DeviceArt typeCode="INVERTER" title="Inverter" />,
    );
    const svg = labelled.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBeNull();
    expect(svg.getAttribute("aria-label")).toBe("Inverter");
  });
});
