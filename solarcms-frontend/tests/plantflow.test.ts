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
import { buildStages, isUnwired } from "@/components/sld/PlantFlow";
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
    collector_code: null,
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

/**
 * Ordering ties by electrical position rather than alphabetically.
 *
 * This is the case that was silently wrong in production. On an unwired Plant
 * every Device sits at depth 0, so the tie-break decides the entire row — and
 * ordering by type code put the settlement meter upstream of the transformer,
 * because `MFM` sorts before `TRANSFORMER`. The row looked authoritative and
 * was alphabetical.
 */
describe("stage ordering", () => {
  const STAGES: Record<string, string> = {
    INVERTER: "INVERTERS",
    MFM: "GRID",
    TRANSFORMER: "TRANSFORMER",
    VCB: "TRANSFORMER",
  };

  function staged(
    id: number,
    code: string,
    type_code: string,
    parent: number | null = null,
  ): DeviceListItem {
    return device(id, code, type_code, parent, {
      sld_stage: STAGES[type_code] ?? null,
    });
  }

  it("orders an unwired Plant by electrical position, not by type code", () => {
    const stages = buildStages([
      staged(1, "INVERTER_1", "INVERTER"),
      staged(2, "MFM", "MFM"),
      staged(3, "TRANSFORMER", "TRANSFORMER"),
      staged(4, "VCB", "VCB"),
    ]);
    // Alphabetically this was INVERTER, MFM, TRANSFORMER, VCB — the meter
    // second, upstream of the transformer it actually sits behind.
    expect(stages.map((s) => s.typeCode)).toEqual([
      "INVERTER",
      "TRANSFORMER",
      "VCB",
      "MFM",
    ]);
  });

  it("still lets real wiring beat the stage default", () => {
    // An LT feeder meter genuinely wired upstream of the transformer: depth
    // decides, and depth outranks the tie-break.
    const stages = buildStages([
      staged(1, "INVERTER_1", "INVERTER", 2),
      staged(2, "MFM_LT", "MFM", 3),
      staged(3, "TRANSFORMER", "TRANSFORMER", null),
    ]);
    expect(stages.map((s) => s.typeCode)).toEqual([
      "INVERTER",
      "MFM",
      "TRANSFORMER",
    ]);
  });

  it("honours an accepted per-Device stage override", () => {
    const stages = buildStages([
      staged(1, "INVERTER_1", "INVERTER"),
      device(2, "MFM_LT", "MFM", null, {
        sld_stage: "GRID",
        sld_stage_override: "INVERTERS",
      }),
      staged(3, "TRANSFORMER", "TRANSFORMER"),
    ]);
    // Pinned to Inverters, so it no longer sorts out at the grid end.
    expect(stages.map((s) => s.typeCode)).toEqual([
      "INVERTER",
      "MFM",
      "TRANSFORMER",
    ]);
  });

  it("sorts a Type with no stage last rather than in front of generation", () => {
    const stages = buildStages([
      staged(1, "INVERTER_1", "INVERTER"),
      device(2, "MYSTERY", "NEW_TYPE", null, { sld_stage: null }),
    ]);
    expect(stages.map((s) => s.typeCode)).toEqual(["INVERTER", "NEW_TYPE"]);
  });
});

describe("isUnwired", () => {
  it("is true when no power-path Device is wired to anything", () => {
    expect(
      isUnwired([device(1, "INVERTER_1", "INVERTER"), device(2, "MFM", "MFM")]),
    ).toBe(true);
  });

  it("is false as soon as one edge exists", () => {
    expect(
      isUnwired([device(1, "INVERTER_1", "INVERTER", 2), device(2, "MFM", "MFM")]),
    ).toBe(false);
  });

  it("is false for a Plant with nothing in the power path to wire", () => {
    expect(
      isUnwired([device(1, "WMS", "WMS", null, { in_power_path: false })]),
    ).toBe(false);
  });
});

/**
 * A room's outgoing edge counts as its occupants' connection.
 *
 * Seventeen Inverters in an MCR do not each run a cable to the transformer, and
 * the server refuses the per-Device version of that edge outright. So the room's
 * edge is the *only* statement of what those Devices feed — and reading only
 * `parent_device_id` left a correctly wired Plant looking entirely unwired,
 * which would have sent the operator straight back to the edit the server
 * rejects.
 */
describe("collector edges", () => {
  const inMcr = (id: number, code: string, type_code: string): DeviceListItem =>
    device(id, code, type_code, null, {
      collector_code: "MCR",
      sld_stage: type_code === "INVERTER" ? "INVERTERS" : null,
    });

  const outside = (id: number, code: string, type_code: string): DeviceListItem =>
    device(id, code, type_code, null, {
      sld_stage: type_code === "TRANSFORMER" ? "TRANSFORMER" : "GRID",
    });

  it("places a collector's occupants upstream of what the room feeds", () => {
    const devices = [
      inMcr(1, "INVERTER_1", "INVERTER"),
      inMcr(2, "INVERTER_2", "INVERTER"),
      outside(20, "TRANSFORMER", "TRANSFORMER"),
    ];
    const stages = buildStages(devices, { MCR: 20 });
    expect(stages.map((s) => s.typeCode)).toEqual(["INVERTER", "TRANSFORMER"]);
    // Upstream of the transformer, not tied with it at depth 0.
    expect(stages[0].depth).toBe(1);
    expect(stages[1].depth).toBe(0);
  });

  it("is unwired when the room's edge is not recorded", () => {
    const devices = [
      inMcr(1, "INVERTER_1", "INVERTER"),
      outside(20, "TRANSFORMER", "TRANSFORMER"),
    ];
    expect(isUnwired(devices)).toBe(true);
    expect(isUnwired(devices, { MCR: null })).toBe(true);
  });

  it("is wired once the room's edge is recorded", () => {
    const devices = [
      inMcr(1, "INVERTER_1", "INVERTER"),
      outside(20, "TRANSFORMER", "TRANSFORMER"),
    ];
    expect(isUnwired(devices, { MCR: 20 })).toBe(false);
  });

  it("lets a Device's own parent win over its room's edge", () => {
    // Hierarchy within an enclosure is normal, and more specific than the box.
    const devices = [
      device(1, "INVERTER_1", "INVERTER", 2, {
        collector_code: "MCR",
        sld_stage: "INVERTERS",
      }),
      inMcr(2, "ACDB", "ACDB"),
      outside(20, "TRANSFORMER", "TRANSFORMER"),
    ];
    const stages = buildStages(devices, { MCR: 20 });
    // INVERTER_1 -> ACDB -> (MCR edge) -> TRANSFORMER: two hops, not one.
    const inverter = stages.find((s) => s.typeCode === "INVERTER");
    expect(inverter?.depth).toBe(2);
  });

  it("ignores an edge pointing at a Device that is not there", () => {
    const devices = [inMcr(1, "INVERTER_1", "INVERTER")];
    expect(() => buildStages(devices, { MCR: 999 })).not.toThrow();
    expect(buildStages(devices, { MCR: 999 })[0].depth).toBe(0);
  });

  it("does not hang when a room's edge closes a ring", () => {
    const devices = [
      inMcr(1, "INVERTER_1", "INVERTER"),
      device(2, "TX", "TRANSFORMER", 1, { sld_stage: "TRANSFORMER" }),
    ];
    expect(() => buildStages(devices, { MCR: 2 })).not.toThrow();
  });
});
