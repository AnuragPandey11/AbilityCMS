/**
 * A Device screen's tile says "Not Available" only where the Device is known
 * not to measure the figure — never for a sensor that is there and quiet, never
 * where this session cannot read the bindings, and never for a calculated Tag,
 * which is never bound (1 Nov 2026).
 */

import { describe, expect, it } from "vitest";
import type { Tag } from "@/api/schemas";
import { fillPosition } from "@/components/devices/InverterView";

const tag = (id: number, code: string, formula: string | null = null): Tag => ({
  id,
  code,
  name: code,
  unit: "%",
  category: "environmental",
  rollup_method: "avg",
  scale_default: 1,
  valid_min: 0,
  valid_max: 100,
  min_interval_s: 60,
  is_cumulative: false,
  formula,
  derived_scope: formula ? "device" : null,
});

const tagsByCode = new Map([
  ["CLOUD_COVER", tag(1, "CLOUD_COVER")],
  ["AC_VOLTAGE_AVG", tag(2, "AC_VOLTAGE_AVG", "(AC_VOLTAGE_RY + AC_VOLTAGE_YB + AC_VOLTAGE_BR) / 3")],
]);

const fill = (codes: string[], bound: Set<string> | null) =>
  fillPosition(
    { label: "Figure", codes },
    { tagsByCode, values: new Map(), bound, isLoading: false, subject: "this weather station" },
  );

describe("fillPosition's Not Available", () => {
  it("is said where the Device is not bound to the Tag", () => {
    const filled = fill(["CLOUD_COVER"], new Set(["AMBIENT_TEMPERATURE"]));
    expect(filled.unavailable).toBe(true);
    expect(filled.reason).toMatch(/Tag Mapping/);
  });

  it("is not said for a bound sensor with nothing received", () => {
    expect(fill(["CLOUD_COVER"], new Set(["CLOUD_COVER"])).unavailable).toBe(false);
  });

  it("is not said where the bindings cannot be read", () => {
    expect(fill(["CLOUD_COVER"], null).unavailable).toBe(false);
  });

  it("is not said for a calculated Tag, which is never bound", () => {
    expect(fill(["AC_VOLTAGE_AVG"], new Set(["AC_VOLTAGE_RY"])).unavailable).toBe(false);
  });

  it("is not said while the readings are loading", () => {
    const filled = fillPosition(
      { label: "Figure", codes: ["CLOUD_COVER"] },
      { tagsByCode, values: new Map(), bound: new Set(), isLoading: true, subject: "it" },
    );
    expect(filled.unavailable).toBe(false);
  });
});
