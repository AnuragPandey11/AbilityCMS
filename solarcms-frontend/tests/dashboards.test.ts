/**
 * A-3: which routes exist at all. The codes come from the database, and the
 * component map is keyed by code — never by Plant (F-14).
 */

import { describe, expect, it } from "vitest";
import { DASHBOARD_CODES, dashboardLabel } from "@/auth/useDashboard";

describe("dashboard codes", () => {
  it("matches the eight seeded in the database", () => {
    expect([...DASHBOARD_CODES]).toEqual([
      "portfolio",
      "plant_overview",
      "plant_list",
      "single_plant",
      "sld",
      "inverter_monitoring",
      "alarms",
      "reports",
    ]);
  });

  it("falls back to the code, so a dashboard added as a row still renders", () => {
    expect(dashboardLabel("portfolio")).toBe("Portfolio");
    expect(dashboardLabel("some_new_dashboard")).toBe("some new dashboard");
  });
});
