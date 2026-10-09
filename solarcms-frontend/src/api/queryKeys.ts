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
  // A comparing request is its own entry — it carries `previous` and the plain
  // one does not — but under the same prefix, so `useLiveRefresh` reaches both.
  plantKpis: (id: number, period: KpiPeriod, compare = false) =>
    compare
      ? (["plants", id, "kpis", period, "compare"] as const)
      : (["plants", id, "kpis", period] as const),
  plantBlocks: (id: number) => ["plants", id, "blocks"] as const,
  plantDevices: (id: number, blockId?: number | null) =>
    ["plants", id, "devices", blockId ?? null] as const,
  plantSld: (id: number) => ["plants", id, "sld"] as const,
  plantDashboard: (id: number) => ["plants", id, "dashboard"] as const,
  /** Every visible Plant's KPIs and dashboard, one request (the Portfolio). */
  plantSnapshots: (period: KpiPeriod) => ["plants", "snapshots", period] as const,
  plantOperatingStatus: (id: number) => ["plants", id, "operating-status"] as const,
  plantStrings: (id: number) => ["plants", id, "strings"] as const,
  blockKpis: (id: number, period: KpiPeriod) =>
    ["blocks", id, "kpis", period] as const,

  plantCommissioning: (id: number) => ["plants", id, "commissioning"] as const,
  // Under the Plant, so anything that invalidates a Plant refreshes its issues.
  dataIssues: (id: number) => ["plants", id, "data-issues"] as const,
  dataIssuesSummary: () => ["data-issues", "summary"] as const,
  // Under the Plant: what its status codes mean, and its forecast.
  statusCodes: (id: number) => ["plants", id, "status-codes"] as const,
  forecast: (id: number) => ["plants", id, "forecast"] as const,

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
  platformHealth: () => ["health", "processes"] as const,

  reportDefinitions: () => ["reports", "definitions"] as const,
  customCatalog: (plantIds: number[]) => ["reports", "custom", "catalog", plantIds] as const,
  savedReports: () => ["reports", "custom", "saved"] as const,
  customTable: (definition: unknown) => ["reports", "custom", "table", definition] as const,
  reportRun: (id: number) => ["reports", "runs", id] as const,
  reportTable: (
    kind: string,
    plantId: number,
    period: string,
    fromDate: string | null,
    toDate: string | null,
    fromTime: string | null,
    toTime: string | null,
  ) =>
    ["reports", "tables", kind, plantId, period, fromDate, toDate, fromTime, toTime] as const,

  users: () => ["users"] as const,
  clients: () => ["clients"] as const,
  regions: () => ["regions"] as const,
  audit: (params?: unknown) => ["audit", params ?? {}] as const,
};
