/**
 * Stage grouping for the plant schematic.
 *
 * The rule the whole view rests on: Devices of the same type, the same distance
 * from the grid, are one stage. Get that wrong and twelve Inverters either
 * become twelve boxes (the detailed tree's job, not this one) or collapse
 * together with a meter that happens to sit beside them.
 *
 * No Plant shape is assumed anywhere — these cases deliberately include a meter
 * mid-chain, two transformers in parallel, and an unwired Plant, because all
 * three are things a real site does.
 */

import { describe, expect, it } from "vitest";
import { buildStages } from "@/components/sld/PlantFlow";
import type { DeviceListItem } from "@/api/schemas";

function device(
  id: number,
  code: string,
  type_code: string,
  parent_device_id: number | null = null,
  extra: Partial<DeviceListItem> = {},
): DeviceListItem {
  return {
    id,
    code,
    name: `${code} name`,
    status: "active",
    block_id: null,
    parent_device_id,
    reports_via_device_id: null,
    source_address: null,
    expected_interval_s: 60,
    type_code,
    in_power_path: true,
    variant: null,
    comm_status: "online",
    last_seen_at: null,
    frozen_tag_count: null,
    ...extra,
  };
}

describe("buildStages", () => {
  it("collapses same-type siblings into one stage", () => {
    // Twelve Inverters into one Transformer is the case the whole view exists
    // for: one box reading 12 / 12, not twelve boxes.
    const inverters = Array.from({ length: 12 }, (_, i) =>
      device(i + 10, `INV-${i + 1}`, "INVERTER", 1),
    );
    const stages = buildStages([device(1, "TXF-01", "TRANSFORMER"), ...inverters]);

    expect(stages.map((s) => s.typeCode)).toEqual(["INVERTER", "TRANSFORMER"]);
    expect(stages[0].devices).toHaveLength(12);
    expect(stages[0].online).toBe(12);
  });

  it("orders stages generation-first, grid-last", () => {
    // The pointer runs child → parent ("what do I feed into"), but every
    // engineer reads a single line diagram the other way.
    const stages = buildStages([
      device(1, "MFM-01", "MFM"),
      device(2, "TXF-01", "TRANSFORMER", 1),
      device(3, "INV-01", "INVERTER", 2),
    ]);
    expect(stages.map((s) => s.typeCode)).toEqual([
      "INVERTER",
      "TRANSFORMER",
      "MFM",
    ]);
  });

  it("keeps the same type at different depths as separate stages", () => {
    // A meter on the transformer's LV side and another at the grid tie are two
    // stages, not one — they are at different points in the chain.
    const stages = buildStages([
      device(1, "MFM-HV", "MFM"),
      device(2, "TXF-01", "TRANSFORMER", 1),
      device(3, "MFM-LV", "MFM", 2),
    ]);
    expect(stages.map((s) => s.typeCode)).toEqual(["MFM", "TRANSFORMER", "MFM"]);
    expect(stages[0].devices[0].code).toBe("MFM-LV");
    expect(stages[2].devices[0].code).toBe("MFM-HV");
  });

  it("does not put a Device outside the power path in the chain", () => {
    // A Weather Station is real and monitored; electricity does not flow
    // through it, so it has no place in an electrical diagram.
    const stages = buildStages([
      device(1, "MFM-01", "MFM"),
      device(2, "WMS-01", "WMS", null, { in_power_path: false }),
    ]);
    expect(stages).toHaveLength(1);
    expect(stages[0].typeCode).toBe("MFM");
  });

  it("counts only the Devices actually reporting", () => {
    const stages = buildStages([
      device(1, "TXF-01", "TRANSFORMER"),
      device(2, "INV-01", "INVERTER", 1),
      device(3, "INV-02", "INVERTER", 1, { comm_status: "offline" }),
      device(4, "INV-03", "INVERTER", 1, { comm_status: "degraded" }),
    ]);
    const inverters = stages.find((s) => s.typeCode === "INVERTER");
    expect(inverters?.devices).toHaveLength(3);
    expect(inverters?.online).toBe(1);
  });

  it("renders an unwired Plant as one stage per type rather than nothing", () => {
    // Before anyone has set the hierarchy, every Device is its own root. That
    // should read as "not wired yet", never as an empty diagram.
    const stages = buildStages([
      device(1, "MFM-01", "MFM"),
      device(2, "MFM-MAIN", "MFM"),
      device(3, "INV-01", "INVERTER"),
    ]);
    expect(stages.map((s) => s.typeCode).sort()).toEqual(["INVERTER", "MFM"]);
    expect(stages.find((s) => s.typeCode === "MFM")?.devices).toHaveLength(2);
  });

  it("puts the PV Array first even before the Plant is wired", () => {
    // The state every Plant is in the moment its Devices are registered: no
    // hierarchy yet, so everything sits at depth zero. Ordered by depth alone
    // the array would fall alphabetically among the rest and land beside the
    // Grid — the opposite end from where generation begins.
    const stages = buildStages([
      device(1, "INV-01", "INVERTER"),
      device(2, "MFM-01", "MFM"),
      device(3, "PV-01", "PV_ARRAY"),
    ]);
    expect(stages[0].typeCode).toBe("PV_ARRAY");
  });

  it("keeps the PV Array first in a correctly wired chain too", () => {
    const stages = buildStages([
      device(1, "MFM-01", "MFM"),
      device(2, "INV-01", "INVERTER", 1),
      device(3, "PV-01", "PV_ARRAY", 2),
    ]);
    expect(stages.map((s) => s.typeCode)).toEqual([
      "PV_ARRAY",
      "INVERTER",
      "MFM",
    ]);
  });

  it("keeps the PV Array first even if it is mis-wired downstream", () => {
    // Someone points the array at nothing and the inverter at the array's
    // parent — depth would drag the array rightwards. Generation still starts
    // at the array.
    const stages = buildStages([
      device(1, "PV-01", "PV_ARRAY"),
      device(2, "INV-01", "INVERTER"),
      device(3, "TXF-01", "TRANSFORMER", 2),
    ]);
    expect(stages[0].typeCode).toBe("PV_ARRAY");
  });

  it("survives a ring in the data without hanging", () => {
    // build_sld on the server detaches rings and reports them; this render must
    // not spin on one either.
    const stages = buildStages([
      device(1, "A", "MFM", 2),
      device(2, "B", "MFM", 3),
      device(3, "C", "MFM", 1),
    ]);
    expect(stages.length).toBeGreaterThan(0);
  });
});
