/**
 * React Query keys, in one place.
 *
 * They deliberately do **not** encode `client_id`. A Client switch clears the
 * whole cache rather than partitioning it by key (§3.1, Guardrail 10) — keying
 * by Client would leave the previous Client's entries resident and one cache-hit
 * away from being displayed.
 */

import type { AlarmQuery } from "./endpoints/alarms";
import type { ReadingsQuery } from "./endpoints/readings";
import type { KpiPeriod } from "./schemas";

export const qk = {
  me: () => ["me"] as const,

  // The catalogue changes monthly; cached hard for the session (§9).
  tags: () => ["catalog", "tags"] as const,
  deviceTypes: () => ["catalog", "device-types"] as const,
  deviceTableColumns: () => ["catalog", "device-table-columns"] as const,
  deviceModels: (typeCode?: string | null) =>
    ["catalog", "device-models", typeCode ?? null] as const,
  deviceModelTags: (modelId: number, stringCount?: number | null) =>
    ["catalog", "device-models", modelId, "tags", stringCount ?? null] as const,

  plants: (params?: unknown) => ["plants", params ?? {}] as const,
  allPlants: () => ["plants", "all"] as const,
  plant: (id: number) => ["plants", id] as const,
  plantKpis: (id: number, period: KpiPeriod) =>
    ["plants", id, "kpis", period] as const,
  plantBlocks: (id: number) => ["plants", id, "blocks"] as const,
  plantDevices: (id: number, blockId?: number | null) =>
    ["plants", id, "devices", blockId ?? null] as const,
  plantSld: (id: number) => ["plants", id, "sld"] as const,
  plantDashboard: (id: number) => ["plants", id, "dashboard"] as const,
  plantOperatingStatus: (id: number) => ["plants", id, "operating-status"] as const,
  blockKpis: (id: number, period: KpiPeriod) =>
    ["blocks", id, "kpis", period] as const,

  plantCommissioning: (id: number) => ["plants", id, "commissioning"] as const,

  device: (id: number) => ["devices", id] as const,
  deviceOperatingStatus: (id: number) => ["devices", id, "operating-status"] as const,
  bindings: (id: number) => ["devices", id, "bindings"] as const,
  unmappedKeys: (id: number) => ["devices", id, "unmapped-keys"] as const,

  readings: (query: ReadingsQuery) => ["readings", query] as const,

  alarms: (query: AlarmQuery) => ["alarms", query] as const,
  alarmRules: () => ["alarm-rules"] as const,

  deviceHealth: (plantId?: number | null) =>
    ["health", "devices", plantId ?? null] as const,
  systemHealth: () => ["health", "system"] as const,

  reportDefinitions: () => ["reports", "definitions"] as const,
  reportRun: (id: number) => ["reports", "runs", id] as const,

  users: () => ["users"] as const,
  clients: () => ["clients"] as const,
  regions: () => ["regions"] as const,
  audit: (params?: unknown) => ["audit", params ?? {}] as const,
};
