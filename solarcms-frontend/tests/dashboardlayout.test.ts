/**
 * The two pure rules the single-screen dashboard rests on.
 *
 * Both decide what the operator *does not* see, which is exactly the kind of
 * rule that fails silently: a panel wrongly judged a duplicate simply is not
 * there, and nothing on the screen says so.
 */

import { describe, expect, it } from "vitest";
import { fullyDuplicated, sourceSignature } from "@/dashboards/single-plant/duplication";
import { groupDashboards, NAV_GROUPS } from "@/components/layout/navigation";
import type { ResolvedSlot } from "@/api/schemas";

function slot(
  code: string,
  source: Partial<NonNullable<ResolvedSlot["source"]>> | null,
): ResolvedSlot {
  return {
    slot_code: code,
    label: code,
    position: 1,
    value: 1,
    unit: "kWh",
    undefined_reason: null,
    source: source
      ? {
          kind: "device_tag",
          device_type_code: "INVERTER",
          tag_code: "ENERGY_TODAY",
          aggregate: "sum",
          device_count: 17,
          is_aggregated: true,
          degraded: false,
          ...source,
        }
      : null,
  };
}

describe("panel deduplication", () => {
  it("treats two slots as the same claim when the resolved source matches", () => {
    // The real case on KULAR_GREEN: `kpi.energy_today` and
    // `energy.generated_today` are different catalogue positions with
    // different labels that resolve to the identical sum over the identical
    // seventeen Inverters. Rendered together they are one figure twice under
    // two names, which invites the reader to look for a difference.
    const headline = [slot("kpi.energy_today", {})];
    const panel = [slot("energy.generated_today", {})];
    expect(fullyDuplicated(panel, headline)).toBe(true);
  });

  it("keeps a panel that holds even one distinct figure", () => {
    // It never hides a *figure*, only a second copy of one. Dropping the
    // duplicate row from inside a panel would leave a hole in a list whose
    // order is catalogue configuration.
    const headline = [slot("kpi.energy_today", {})];
    const panel = [
      slot("energy.generated_today", {}),
      slot("energy.exported", { tag_code: "ENERGY_EXPORT_TODAY" }),
    ];
    expect(fullyDuplicated(panel, headline)).toBe(false);
  });

  it("separates the same Tag measured on a different Device Type", () => {
    // Energy summed from the Inverters and energy read at the meter are two
    // different claims about the same quantity, and the gap between them is a
    // real loss somebody is paid to look at.
    const headline = [slot("kpi.energy_today", { device_type_code: "INVERTER" })];
    const panel = [
      slot("energy.metered", { device_type_code: "MFM", is_aggregated: false, device_count: 1 }),
    ];
    expect(fullyDuplicated(panel, headline)).toBe(false);
  });

  it("separates the same source over a different number of Devices", () => {
    // Four of seventeen Inverters answering is not the same claim as all
    // seventeen — which is the normal state part-way through commissioning.
    const headline = [slot("kpi.energy_today", { device_count: 17 })];
    const panel = [slot("energy.generated_today", { device_count: 4 })];
    expect(fullyDuplicated(panel, headline)).toBe(false);
  });

  it("never collapses two slots that have no source", () => {
    // Two positions this Plant cannot answer are two separate commissioning
    // gaps. Collapsing them hides the second behind the first.
    const a = slot("a", null);
    const b = slot("b", null);
    expect(sourceSignature(a)).toBeNull();
    expect(fullyDuplicated([b], [a])).toBe(false);
  });
});

describe("navigation grouping", () => {
  it("keeps only the dashboards the server granted", () => {
    // A-3: a User who lacks a dashboard has no entry and no route — not a
    // hidden link, an absent one.
    const groups = groupDashboards(["portfolio", "single_plant"]);
    expect(groups.flatMap((g) => g.codes)).toEqual(["portfolio", "single_plant"]);
  });

  it("drops a group whose every dashboard was withheld", () => {
    const groups = groupDashboards(["alarms"]);
    expect(groups.map((g) => g.label)).toEqual(["Operations"]);
  });

  it("keeps a dashboard no group claims, in the server's own order", () => {
    // Adding a dashboard is a database row. One this file has not heard of
    // must still be reachable without a frontend release.
    const groups = groupDashboards(["portfolio", "brand_new", "another_new"]);
    const more = groups.find((g) => g.label === "More");
    expect(more?.codes).toEqual(["brand_new", "another_new"]);
  });

  it("lists no dashboard twice", () => {
    const all = NAV_GROUPS.flatMap((g) => g.codes);
    expect(new Set(all).size).toBe(all.length);
  });

  it("returns nothing at all when nothing was granted", () => {
    // Zero assignments means zero, never all (I-5, Guardrail 7).
    expect(groupDashboards([])).toEqual([]);
  });
});

describe("navigation never offers a dashboard that refuses", () => {
  const ALL = [
    "portfolio", "plant_overview", "plant_list", "single_plant",
    "sld", "inverter_monitoring", "alarms", "reports",
  ];

  it("hides Reports from a session without report.generate", () => {
    // A Guest is granted the `reports` dashboard by the database, and the
    // Reports screen then requires `report.generate`. The menu entry led
    // straight to "this requires the report.generate permission" — a dead
    // flow, and the kind that makes somebody doubt the rest of the menu.
    const guest = groupDashboards(ALL, (p) => p === "dashboard.view");
    expect(guest.flatMap((g) => g.codes)).not.toContain("reports");
  });

  it("keeps Reports for a session that holds the permission", () => {
    const admin = groupDashboards(ALL, () => true);
    expect(admin.flatMap((g) => g.codes)).toContain("reports");
  });

  it("hides nothing else — a missing action must not remove a whole screen", () => {
    // Only a dashboard whose screen cannot function at all belongs in
    // DASHBOARD_REQUIRES. Hiding a screen because one button is unavailable
    // takes away the reading a Guest is entitled to.
    const guest = groupDashboards(ALL, (p) => p === "dashboard.view").flatMap((g) => g.codes);
    for (const code of ALL.filter((c) => c !== "reports" && c !== "plant_list")) {
      expect(guest, `${code} was hidden from a viewer`).toContain(code);
    }
  });

  it("shows every granted dashboard except the one merged away", () => {
    // `plant_list` renders the same screen as `plant_overview`, so the menu
    // carries one entry for the pair.
    const codes = groupDashboards(ALL).flatMap((g) => g.codes);
    expect(codes).toHaveLength(ALL.length - 1);
    expect(codes).toContain("plant_overview");
    expect(codes).not.toContain("plant_list");
  });
});

describe("dashboards that share one screen", () => {
  it("shows one entry when a User holds both codes", () => {
    // Two menu entries for one destination is the duplication the merge
    // removed — and the question it provoked ("which of these is the real
    // one?") is the one a menu should never raise.
    const codes = groupDashboards(["plant_overview", "plant_list"]).flatMap((g) => g.codes);
    expect(codes).toEqual(["plant_overview"]);
  });

  it("still shows the merged-away code when it is the only one granted", () => {
    // A Client granted only `plant_list` must still get in. The code stands in
    // for the pair rather than vanishing from the menu.
    const codes = groupDashboards(["plant_list"]).flatMap((g) => g.codes);
    expect(codes).toEqual(["plant_list"]);
  });

  it("leaves a User granted only the survivor untouched", () => {
    const codes = groupDashboards(["plant_overview"]).flatMap((g) => g.codes);
    expect(codes).toEqual(["plant_overview"]);
  });
});
