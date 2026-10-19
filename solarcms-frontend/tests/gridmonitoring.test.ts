/**
 * Which meter the MFM / Grid screen puts on top, and "last heard".
 *
 * The headline is the meter the Plant's Grid stage reads — the slot
 * catalogue's choice, ABT meter before MFM — unless somebody picked another.
 * A pick from a different Plant must not survive a Plant switch.
 */

import { describe, expect, it } from "vitest";
import type { DeviceListItem } from "@/api/schemas";
import { headlineMeter, meterName } from "@/dashboards/GridMonitoringDashboard";
import { latestOf } from "@/format/datetime";

const device = (id: number, code: string, type_code: string) =>
  ({ id, code, name: code, type_code }) as DeviceListItem;

const PLANT = [
  device(1, "INVERTER_1", "INVERTER"),
  device(2, "MFM_10", "MFM"),
  device(3, "MFM_2", "MFM"),
  device(4, "ABT", "ABT_METER"),
  device(5, "WMS", "WMS"),
];

describe("the meter on top", () => {
  it("is the Type the Grid stage reads", () => {
    expect(headlineMeter(PLANT, { chosenId: null, gridType: "MFM" })?.code).toBe("MFM_2");
    expect(headlineMeter(PLANT, { chosenId: null, gridType: "ABT_METER" })?.code).toBe("ABT");
  });

  it("falls back to the Grid stage's own order when nothing resolved", () => {
    expect(headlineMeter(PLANT, { chosenId: null, gridType: null })?.code).toBe("ABT");
  });

  it("gives way to a meter somebody chose, but never to a Device that is not a meter", () => {
    expect(headlineMeter(PLANT, { chosenId: 2, gridType: "ABT_METER" })?.code).toBe("MFM_10");
    expect(headlineMeter(PLANT, { chosenId: 1, gridType: "ABT_METER" })?.code).toBe("ABT");
  });

  it("ignores a choice from another Plant", () => {
    expect(headlineMeter(PLANT, { chosenId: 99, gridType: "MFM" })?.code).toBe("MFM_2");
  });

  it("is nothing at a Plant with no meter", () => {
    expect(headlineMeter([PLANT[0]!, PLANT[4]!], { chosenId: null, gridType: null })).toBeNull();
  });

  // SPINNING_AND_GENERAL_MILLS: `MAIN_MFM` is on the mill's own line and sorts
  // before `MFM`, the solar output (migration 0043).
  const MILL = [
    { ...device(7, "MAIN_MFM", "MFM"), measures_generation: false },
    { ...device(8, "MFM", "MFM"), measures_generation: true },
  ] as DeviceListItem[];

  it("is never by default a meter on another line than the solar output", () => {
    expect(headlineMeter(MILL, { chosenId: null, gridType: "MFM" })?.code).toBe("MFM");
    expect(headlineMeter(MILL, { chosenId: null, gridType: null })?.code).toBe("MFM");
  });

  it("is still that meter when somebody chooses it, or it is the only one", () => {
    expect(headlineMeter(MILL, { chosenId: 7, gridType: "MFM" })?.code).toBe("MAIN_MFM");
    expect(headlineMeter([MILL[0]!], { chosenId: null, gridType: null })?.code).toBe("MAIN_MFM");
  });
});

describe("a meter's name", () => {
  it("is left out where it only restates the code", () => {
    expect(meterName({ code: "ABT_METER", name: "Abt Meter" })).toBeNull();
    expect(meterName({ code: "MFM", name: "Mfm" })).toBeNull();
  });

  it("is kept where somebody gave it one", () => {
    expect(meterName({ code: "MFM_1", name: "Main MFM (Grid Incomer)" })).toBe("Main MFM (Grid Incomer)");
  });
});

describe("last heard", () => {
  it("takes the later of the sweep's contact and the live frame", () => {
    expect(latestOf("2026-09-28T10:00:00Z", "2026-09-28T10:01:00Z")).toBe("2026-09-28T10:01:00Z");
    expect(latestOf("2026-09-28T10:02:00Z", undefined)).toBe("2026-09-28T10:02:00Z");
    expect(latestOf(null, undefined)).toBeNull();
  });
});
