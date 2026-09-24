/**
 * The power trend's comparisons: the lock between its two axes, and the two
 * reference curves. Each is a way the chart could claim something unmeasured.
 */

import { describe, expect, it } from "vitest";
import {
  expectedAcKw,
  expectedDcKw,
  kwPerWm2,
  lockedAxes,
  medianGeneratingEfficiency,
  niceStep,
} from "@/dashboards/single-plant/powerComparison";

const point = (at: string, value: number | null) => ({ at, value, contributors: 1 });

describe("the axis lock", () => {
  it("puts 1,000 W/m² level with the DC nameplate", () => {
    const perWm2 = kwPerWm2(5760)!;
    const { power, radiation } = lockedAxes([3200], [800], perWm2);
    // Every gridline shared: the same number of divisions on both sides.
    expect((power.max - power.min) / power.interval).toBeCloseTo(
      (radiation.max - radiation.min) / radiation.interval,
    );
    // And the ratio is the nameplate's, not whatever fits.
    expect(power.max / radiation.max).toBeCloseTo(5.76);
  });

  it("fits whichever side reaches higher once both are in kW", () => {
    const perWm2 = kwPerWm2(1000)!;
    // 900 W/m² on a 1,000 kWp array is 900 kW, above the 400 kW measured.
    const { power } = lockedAxes([400], [900], perWm2);
    expect(power.max).toBeGreaterThanOrEqual(900);
  });

  it("keeps a negative night reading on the scale, and both zeros level", () => {
    const { power, radiation } = lockedAxes([-6, 300], [0, 500], kwPerWm2(1000)!);
    expect(power.min).toBeLessThan(0);
    expect(power.min / power.interval).toBeCloseTo(radiation.min / radiation.interval);
  });

  it("has nothing to lock to without a DC capacity", () => {
    expect(kwPerWm2(null)).toBeNull();
    expect(kwPerWm2(0)).toBeNull();
  });

  it("frames an empty chart on the nameplate rather than on nothing", () => {
    const { power, radiation } = lockedAxes([], [], kwPerWm2(240)!);
    expect(power.max).toBeGreaterThanOrEqual(240);
    expect(radiation.max).toBeGreaterThanOrEqual(1000);
  });

  it("steps in 1, 2, 2.5 and 5", () => {
    expect(niceStep(640)).toBe(1000);
    expect(niceStep(180)).toBe(200);
    expect(niceStep(21)).toBe(25);
    expect(niceStep(0.3)).toBe(0.5);
  });
});

describe("the reference curves", () => {
  const irradiance = [
    point("2026-09-24T06:00:00Z", 500),
    point("2026-09-24T06:15:00Z", null),
    point("2026-09-24T06:30:00Z", -3),
  ];

  it("is irradiance × DC nameplate ÷ 1,000, with gaps kept as gaps", () => {
    const dc = expectedDcKw(irradiance, 5760);
    expect(dc.map((entry) => entry.value)).toEqual([2880, null, 0]);
  });

  it("never lets a sensor's night-time negative become negative power", () => {
    expect(expectedDcKw([point("2026-09-24T00:00:00Z", -3)], 1000)[0]?.value).toBe(0);
  });

  it("limits the AC reference to the AC nameplate", () => {
    const dc = expectedDcKw([point("2026-09-24T06:00:00Z", 1000)], 5760);
    expect(expectedAcKw(dc, 4800, 0.98)[0]?.value).toBe(4800);
  });

  it("puts AC below DC by the Inverters' own loss, never on top of it", () => {
    // The first version drew a lossless Inverter, and on a Plant that never
    // clips the AC line sat exactly on the DC one. No real Inverter does that.
    const dc = expectedDcKw([point("2026-09-24T06:00:00Z", 500)], 5760);
    const ac = expectedAcKw(dc, 4800, 0.98);
    expect(ac[0]?.value).toBeCloseTo(2880 * 0.98);
    expect(ac[0]!.value!).toBeLessThan(dc[0]!.value!);
  });
});

describe("the Inverters' measured efficiency", () => {
  it("is the median while generating, so a trip does not drag it to zero", () => {
    const readings = [0, 98.1, 97.9, 0, 98.4, 98.2, 0, 0].map((value, index) =>
      point(`2026-09-24T0${index}:00:00Z`, value),
    );
    expect(medianGeneratingEfficiency(readings)).toBeCloseTo(0.9815);
  });

  it("has no value where nothing was generating, and ignores impossible readings", () => {
    expect(medianGeneratingEfficiency([point("2026-09-24T00:00:00Z", 0)])).toBeNull();
    expect(medianGeneratingEfficiency([point("2026-09-24T00:00:00Z", 140)])).toBeNull();
  });
});
