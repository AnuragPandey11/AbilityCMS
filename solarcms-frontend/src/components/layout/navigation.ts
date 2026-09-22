/**
 * How the navigation is organised.
 *
 * ── Why the dashboards are grouped ─────────────────────────────────────────
 * The tender names eight dashboards and the server grants them individually,
 * so the list is data and stays data. But eight peer entries in one flat column
 * make the user work out the relationships themselves, and three of them —
 * Portfolio, Plant Overview, Plant List — are the *same data at three
 * altitudes*. Flat, they read as three unrelated screens and the obvious
 * question is "which one is the real one". Grouped under one heading they read
 * as what they are: three lenses on the fleet, pick the one that matches what
 * you are doing.
 *
 * The grouping is keyed by dashboard `code`, exactly as the component map is,
 * and never by Client or Plant (Guardrail 2). A code this file has not heard of
 * falls into `MORE` rather than disappearing — a dashboard added as a database
 * row must still be reachable without a frontend release.
 */

import type { ComponentType } from "react";
import type { IconProps } from "@/components/icons";
import type { Permission } from "@/auth/usePermission";
import {
  IconAlarm,
  IconClient,
  IconDevices,
  IconGauge,
  IconInverter,
  IconList,
  IconMapping,
  IconOverview,
  IconPlant,
  IconPortfolio,
  IconReport,
  IconSld,
  IconSystem,
  IconUsers,
  IconWiring,
} from "@/components/icons";

export type IconComponent = ComponentType<IconProps>;

export const DASHBOARD_ICONS: Record<string, IconComponent> = {
  portfolio: IconPortfolio,
  plant_overview: IconOverview,
  plant_list: IconList,
  single_plant: IconPlant,
  sld: IconSld,
  inverter_monitoring: IconInverter,
  alarms: IconAlarm,
  reports: IconReport,
};

/** The fallback, so an unknown dashboard code still gets a legible entry. */
export const DEFAULT_DASHBOARD_ICON: IconComponent = IconGauge;

export interface NavGroup {
  /** Shown as the column heading. */
  label: string;
  /** Dashboard codes, in the order they should appear inside the group. */
  codes: string[];
}

/**
 * The groups, in order.
 *
 * "Fleet" before "This Plant" because the fleet answers *where do I go* and the
 * Plant screens answer *what is wrong there* — the order somebody actually
 * moves in. A single-Plant Client sees the Fleet group hold one row, which is
 * honest: they have one Plant, and the screen that lists Plants still exists.
 */
export const NAV_GROUPS: NavGroup[] = [
  { label: "Fleet", codes: ["portfolio", "plant_overview", "plant_list"] },
  { label: "This Plant", codes: ["single_plant", "sld", "inverter_monitoring"] },
  { label: "Operations", codes: ["alarms", "reports"] },
];

/**
 * Split the granted dashboards into groups, dropping empty ones.
 *
 * Takes the granted list rather than reading it, so this stays a pure function
 * and the ordering rule is testable without a session.
 */
export function groupDashboards(granted: string[]): NavGroup[] {
  const claimed = new Set(NAV_GROUPS.flatMap((group) => group.codes));
  const groups = NAV_GROUPS.map((group) => ({
    label: group.label,
    codes: group.codes.filter((code) => granted.includes(code)),
  })).filter((group) => group.codes.length > 0);

  // Anything the server granted that no group claims. Kept in the server's own
  // order, which is `dashboards.sort_order`.
  const rest = granted.filter((code) => !claimed.has(code));
  if (rest.length > 0) groups.push({ label: "More", codes: rest });
  return groups;
}

export interface AdminLink {
  to: string;
  label: string;
  permission: Permission;
  icon: IconComponent;
}

/**
 * Administration.
 *
 * Every entry is a **noun naming the thing it owns**, and each owns both
 * creating and editing it. Two were previously named after tables rather than
 * tasks — "Plant Hierarchy" and "Device Bindings" describe `parent_device_id`
 * and `device_tag_bindings`; "Wiring & Diagram" and "Tag Mapping" describe what
 * somebody is actually trying to do.
 */
export const ADMIN_LINKS: AdminLink[] = [
  { to: "/admin/clients", label: "Clients", permission: "system.admin", icon: IconClient },
  { to: "/admin/plant-setup", label: "Plants & Devices", permission: "plant.manage", icon: IconDevices },
  { to: "/admin/hierarchy", label: "Wiring & Diagram", permission: "plant.manage", icon: IconWiring },
  { to: "/admin/bindings", label: "Tag Mapping", permission: "config.modify", icon: IconMapping },
  { to: "/admin/alarm-rules", label: "Alarm Rules", permission: "config.modify", icon: IconAlarm },
  { to: "/admin/users", label: "Users", permission: "user.manage", icon: IconUsers },
  { to: "/admin/system", label: "System", permission: "system.admin", icon: IconSystem },
];
