/**
 * A-3: dashboard access.
 *
 * `GET /auth/me` returns `dashboards: string[]` and the router maps each code to
 * a component. Adding a dashboard is a database row plus a component; a User who
 * lacks the code never sees the route at all (§2, §3.4).
 */

import { useAuth } from "./AuthProvider";

/** The codes seeded in `dashboards`, in `sort_order`. */
export const DASHBOARD_CODES = [
  "portfolio",
  "plant_overview",
  "plant_list",
  "single_plant",
  "sld",
  "inverter_monitoring",
  "alarms",
  "reports",
] as const;

export type DashboardCode = (typeof DASHBOARD_CODES)[number];

export const DASHBOARD_LABELS: Record<string, string> = {
  portfolio: "Portfolio",
  plant_overview: "Plant Overview",
  plant_list: "Plant List",
  single_plant: "Single Plant",
  sld: "Single Line Diagram",
  inverter_monitoring: "Inverter Monitoring",
  alarms: "Alarms",
  reports: "Reports",
};

/** Falls back to the code itself, so a dashboard added as a row still renders. */
export function dashboardLabel(code: string): string {
  return DASHBOARD_LABELS[code] ?? code.replace(/_/g, " ");
}

export function useDashboard(code: string): boolean {
  const { me } = useAuth();
  return me?.dashboards.includes(code) ?? false;
}

/** In the server's order, which is `dashboards.sort_order`. */
export function useDashboards(): string[] {
  const { me } = useAuth();
  return me?.dashboards ?? [];
}
