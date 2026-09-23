/**
 * The portfolio exclusion rule (§6.1, MASTER §6.5) and Plant scoping.
 */

import { describe, expect, it } from "vitest";
import { isOnboarding } from "@/components/domain";

describe("portfolio exclusion", () => {
  it("excludes draft and commissioning Plants from totals", () => {
    expect(isOnboarding("draft")).toBe(true);
    expect(isOnboarding("commissioning")).toBe(true);
  });

  it("counts every other status", () => {
    for (const status of ["active", "suspended", "decommissioned"]) {
      expect(isOnboarding(status)).toBe(false);
    }
  });
});

import type { ResolvedSlot } from "@/api/schemas";
import {
  conditionCounts,
  fleetStatusWord,
  plantCondition,
  sumLivePower,
} from "@/dashboards/fleet/condition";

describe("plant condition", () => {
  const online = { comm_status: "online" as const };
  const offline = { comm_status: "offline" as const };

  it("reads Alarms before communication", () => {
    expect(plantCondition({ health: [online], alarms: [{ severity: "high" }] })).toBe("fault");
    expect(plantCondition({ health: [online], alarms: [{ severity: "low" }] })).toBe("warning");
  });

  it("calls a Plant with no Devices unmonitored, never offline", () => {
    expect(plantCondition({ health: [], alarms: [] })).toBe("unmonitored");
  });

  it("separates partly reporting from entirely dark", () => {
    expect(plantCondition({ health: [online, offline], alarms: [] })).toBe("warning");
    expect(plantCondition({ health: [offline, offline], alarms: [] })).toBe("offline");
    expect(plantCondition({ health: [online, online], alarms: [] })).toBe("online");
  });

  it("does not call a fleet with an uninstrumented Plant normal", () => {
    const counts = conditionCounts(["online", "unmonitored"]);
    expect(fleetStatusWord(counts, 2).word).toBe("PARTIAL");
    expect(fleetStatusWord(conditionCounts(["online", "online"]), 2).word).toBe("NORMAL");
    expect(fleetStatusWord(conditionCounts(["online", "fault"]), 2).tone).toBe("bad");
  });
});

describe("live power sum", () => {
  const slot = (value: number | null, unit = "kW") =>
    ({ value, unit }) as unknown as ResolvedSlot;

  it("is null, not zero, when no Plant has a figure", () => {
    expect(sumLivePower([null, undefined, slot(null)]).value).toBeNull();
  });

  it("says how many Plants it summed", () => {
    const live = sumLivePower([slot(10), slot(null), slot(5)]);
    expect(live.value).toBe(15);
    expect(live.contributing).toBe(2);
    expect(live.total).toBe(3);
  });

  it("refuses to add different units", () => {
    const live = sumLivePower([slot(10, "kW"), slot(2, "MW")]);
    expect(live.value).toBeNull();
    expect(live.mixedUnits).toBe(true);
  });
});
