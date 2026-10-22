/**
 * Which figure moves each link of the four-stage schematic (`components/sld/flow`).
 *
 * The case this exists for: the Transformer stage has no power or current
 * figure, so before 21 Oct 2026 its link into the Grid never moved — at midday,
 * on every Plant.
 */
import { describe, expect, it } from "vitest";
import type { ResolvedSlot, SldStage } from "@/api/schemas";
import { FLOW_FLOOR, linkFlow, plantCapacityKw } from "@/components/sld/flow";

function slot(slot_code: string, label: string, value: number | null, unit: string): ResolvedSlot {
  return {
    slot_code,
    label,
    position: 1,
    value,
    unit,
    undefined_reason: value === null ? "no_value" : null,
    source: null,
  };
}

function stage(code: SldStage["code"], label: string, slots: ResolvedSlot[]): SldStage {
  return {
    code,
    label,
    position: 1,
    device_count: 1,
    online_count: 1,
    instrumented: true,
    health: "ok",
    devices: [],
    slots,
  };
}

const pv = (kw: number | null) =>
  stage("PV_ARRAY", "PV Array", [
    slot("sld.pv.capacity", "DC Capacity", 2000, "kWp"),
    slot("sld.pv.dc_power", "DC Power", kw, "kW"),
  ]);
const inverters = (kw: number | null) =>
  stage("INVERTERS", "Inverters", [slot("sld.inv.ac_power", "AC Power", kw, "kW")]);
const transformer = stage("TRANSFORMER", "Transformer", [
  slot("sld.tx.hv_voltage", "HV Voltage", 11.04, "kV"),
  slot("sld.tx.oil_temperature", "Oil Temp.", 49, "°C"),
]);
const grid = (kw: number | null) =>
  stage("GRID", "Grid", [slot("sld.grid.export_power", "Export Power", kw, "kW")]);

describe("linkFlow", () => {
  it("moves the Transformer → Grid link on the Grid meter's export", () => {
    const flow = linkFlow(transformer, grid(1373), 2000);
    expect(flow.moving).toBe(true);
    expect(flow.basis).toBe("Export Power (Grid)");
    expect(flow.share).toBeCloseTo(1373 / 2000);
  });

  it("reads the stage the power leaves when it has a figure", () => {
    const flow = linkFlow(inverters(1148), transformer, 2000);
    expect(flow).toEqual({ moving: true, share: 1148 / 2000, basis: "AC Power" });
  });

  it("is still at night, on a healthy Plant", () => {
    expect(linkFlow(inverters(0), transformer, 2000).moving).toBe(false);
    expect(linkFlow(pv(0), inverters(0), 2000).moving).toBe(false);
  });

  it("treats float noise as nothing", () => {
    expect(linkFlow(transformer, grid(1.5e-17), 2000).moving).toBe(false);
    expect(linkFlow(transformer, grid(FLOW_FLOOR), 2000).moving).toBe(false);
  });

  it("does not run a link toward the grid while the Plant imports", () => {
    expect(linkFlow(transformer, grid(-42), 2000).moving).toBe(false);
  });

  it("does not borrow a neighbour's figure when its own has gone quiet", () => {
    const flow = linkFlow(inverters(null), grid(1373), 2000);
    expect(flow).toEqual({ moving: false, share: null, basis: null });
  });

  it("moves without a pace when no capacity is recorded", () => {
    expect(linkFlow(inverters(800), transformer, null)).toEqual({
      moving: true,
      share: null,
      basis: "AC Power",
    });
  });

  it("converts MW and caps the share at the nameplate", () => {
    const mw = stage("INVERTERS", "Inverters", [slot("sld.inv.ac_power", "AC Power", 2.5, "MW")]);
    expect(linkFlow(mw, transformer, 2000).share).toBe(1);
  });
});

describe("plantCapacityKw", () => {
  it("reads the PV Array's DC capacity, in kW", () => {
    expect(plantCapacityKw([pv(10), inverters(10)])).toBe(2000);
    const mwp = stage("PV_ARRAY", "PV Array", [slot("sld.pv.capacity", "DC Capacity", 2, "MWp")]);
    expect(plantCapacityKw([mwp])).toBe(2000);
  });

  it("is null when nothing is recorded", () => {
    expect(plantCapacityKw([inverters(10)])).toBeNull();
  });
});
