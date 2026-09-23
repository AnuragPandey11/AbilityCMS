/**
 * What the Portfolio says about a Plant's condition, and how it adds up live
 * power across Plants.
 *
 * Every judgement here reads a *state the platform is sure of* — open Alarms
 * and Device communication status — and never a KPI: an undefined PR is the
 * normal night-time condition of every Plant, and a fleet that turned amber at
 * dusk would teach operators that the colour means nothing.
 *
 * The words are the reference screens' — Online / Warning / Fault / Offline —
 * with one added: **No Devices**, for a Plant with nothing registered, which is
 * neither online nor offline and must not be counted as either.
 */

import type { Alarm, DeviceHealth, ResolvedSlot } from "@/api/schemas";

export type PlantCondition = "online" | "warning" | "fault" | "offline" | "unmonitored";

export const CONDITIONS: readonly PlantCondition[] = [
  "online",
  "warning",
  "fault",
  "offline",
  "unmonitored",
];

export const CONDITION_LABEL: Record<PlantCondition, string> = {
  online: "Online",
  warning: "Warning",
  fault: "Fault",
  offline: "Offline",
  unmonitored: "No Devices",
};

export const CONDITION_DETAIL: Record<PlantCondition, string> = {
  online: "Every registered Device is reporting and no Alarm is open.",
  warning: "A medium or low Alarm is open, or some Devices are late or offline.",
  fault: "A critical or high Alarm is open.",
  offline: "No registered Device is reporting. Communication loss, not proven downtime.",
  unmonitored: "No Device is registered, so nothing can be said about it.",
};

export function plantCondition(entry: {
  health: Pick<DeviceHealth, "comm_status">[];
  alarms: Pick<Alarm, "severity">[];
}): PlantCondition {
  if (entry.alarms.some((a) => a.severity === "critical" || a.severity === "high")) {
    return "fault";
  }
  if (entry.alarms.length > 0) return "warning";
  if (entry.health.length === 0) return "unmonitored";
  const reporting = entry.health.filter((d) => d.comm_status === "online").length;
  const offline = entry.health.filter((d) => d.comm_status === "offline").length;
  if (reporting === 0 && offline > 0) return "offline";
  if (reporting < entry.health.length) return "warning";
  return "online";
}

export function conditionCounts(conditions: PlantCondition[]): Record<PlantCondition, number> {
  const counts: Record<PlantCondition, number> = {
    online: 0,
    warning: 0,
    fault: 0,
    offline: 0,
    unmonitored: 0,
  };
  for (const condition of conditions) counts[condition] += 1;
  return counts;
}

/** The fleet in one word, from the condition counts. */
export function fleetStatusWord(
  counts: Record<PlantCondition, number>,
  total: number,
): { word: string; tone: "ok" | "warn" | "bad" | "neutral"; detail: string } {
  if (total === 0) return { word: "NO PLANTS", tone: "neutral", detail: "No active Plant is visible." };
  if (counts.fault > 0) {
    return {
      word: "FAULT",
      tone: "bad",
      detail: `${counts.fault} Plant(s) with a critical or high Alarm open.`,
    };
  }
  if (counts.offline > 0 || counts.warning > 0) {
    return {
      word: "DEGRADED",
      tone: "warn",
      detail: `${counts.offline} offline, ${counts.warning} with a warning.`,
    };
  }
  if (counts.online === total) {
    return { word: "NORMAL", tone: "ok", detail: "Every active Plant is reporting with no Alarm open." };
  }
  // Only "No Devices" Plants remain beside the online ones. Not a fault, and
  // not normal either: part of the fleet cannot be seen at all.
  return {
    word: "PARTIAL",
    tone: "neutral",
    detail: `${counts.unmonitored} Plant(s) have no Devices registered.`,
  };
}

/**
 * Live generation across the fleet: the sum of every Plant's resolved Current
 * Power slot, with how many Plants had one to add.
 *
 * `null` when no Plant has a defined figure — never 0, which would claim the
 * fleet is generating nothing when the truth is that nothing has been heard.
 * Units are never converted: Plants reporting in different units are not
 * summed at all, rather than summed wrongly.
 */
export function sumLivePower(slots: (ResolvedSlot | null | undefined)[]): {
  value: number | null;
  unit: string | null;
  contributing: number;
  total: number;
  mixedUnits: boolean;
} {
  let value: number | null = null;
  let unit: string | null = null;
  let contributing = 0;
  let mixedUnits = false;
  for (const slot of slots) {
    if (!slot || slot.value === null) continue;
    if (unit === null) unit = slot.unit;
    else if (slot.unit !== unit) mixedUnits = true;
    value = (value ?? 0) + slot.value;
    contributing += 1;
  }
  return { value: mixedUnits ? null : value, unit, contributing, total: slots.length, mixedUnits };
}
