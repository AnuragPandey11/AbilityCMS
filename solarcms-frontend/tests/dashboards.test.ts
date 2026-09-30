/**
 * A-3: which routes exist at all. The codes come from the database, and the
 * component map is keyed by code — never by Plant (F-14).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DASHBOARD_CODES, dashboardLabel } from "@/auth/useDashboard";

describe("dashboard codes", () => {
  it("matches the fifteen seeded in the database", () => {
    expect([...DASHBOARD_CODES]).toEqual([
      "portfolio",
      "plant_overview",
      "plant_list",
      "single_plant",
      "sld",
      "inverter_monitoring",
      "string_analysis",
      "meteorological",
      "energy_analytics",
      "grid_monitoring",
      "transformer_monitoring",
      "ppc_monitoring",
      "vcb_monitoring",
      "alarms",
      "reports",
    ]);
  });

  it("is the migrations' own list, in the order the database serves it", () => {
    // Migrations register the rows (0028 onwards); a code added there and not
    // here still routes (see below) but gets no label and no place in the menu.
    // `GET /auth/me` orders by `sort_order`, and a later screen gets its own
    // migration, so the list is every migration's rows — deduplicated by code,
    // the later upsert winning — sorted the way the database sorts them.
    const versions = join(__dirname, "..", "..", "solarcms-backend/alembic/versions");
    const registered = new Map<string, number>();
    for (const file of readdirSync(versions).filter((name) => name.endsWith(".py")).sort()) {
      const source = readFileSync(join(versions, file), "utf8");
      const start = source.indexOf("DASHBOARDS:");
      if (start < 0) continue;
      const block = source.slice(start, source.indexOf("def upgrade", start));
      for (const match of block.matchAll(/^\s*\("([a-z_]+)", "[^"]*", (\d+)\)/gm)) {
        registered.set(match[1], Number(match[2]));
      }
    }
    const ordered = [...registered.entries()].sort((a, b) => a[1] - b[1]).map(([code]) => code);
    expect(ordered).toEqual([...DASHBOARD_CODES]);
  });

  it("falls back to the code, so a dashboard added as a row still renders", () => {
    expect(dashboardLabel("portfolio")).toBe("Portfolio");
    expect(dashboardLabel("some_new_dashboard")).toBe("some new dashboard");
  });
});
