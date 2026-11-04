/**
 * The history screens' server state: a Plant's days and months, what happened
 * on the time axis, and finer readings for a zoomed span.
 *
 * Query keys sit under `["plants", id, …]`, so an edit to the Plant — its DC
 * capacity, which every specific yield and PR divides by — refreshes them
 * with everything else on screen (`api/afterWrite`).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import * as historyApi from "./endpoints/history";
import { useAlarms } from "./hooks";
import type { Alarm, AlarmSeverity } from "./schemas";
import type { ChartEvent } from "@/components/charts/TrendChart";

// ── The days and months ──────────────────────────────────────────────────────

export function usePlantHistory(
  plantId: number | null,
  dates: { first: string; last: string } | null,
  { live, enabled = true }: { live: boolean; enabled?: boolean },
) {
  return useQuery({
    queryKey: ["plants", plantId, "history", dates?.first, dates?.last] as const,
    queryFn: () => historyApi.getPlantHistory(plantId as number, dates!.first, dates!.last),
    enabled: enabled && plantId !== null && dates !== null,
    // A 422 is the period itself (over a year, past today); asking again repeats it.
    retry: false,
    // Days that are over do not change; only a period that still runs does.
    staleTime: live ? 60_000 : 10 * 60_000,
    refetchInterval: live ? 5 * 60_000 : false,
    placeholderData: (previous) => previous,
  });
}

// ── Events on the time axis ──────────────────────────────────────────────────

/** An Alarm's own severity is the verdict; this only names its colour. */
const SEVERITY_TONE: Record<AlarmSeverity, ChartEvent["tone"]> = {
  critical: "bad",
  high: "bad",
  medium: "warn",
  low: "info",
};

/** The server's ceiling on one listing. Past it the chart says so (see `alarmEvents`). */
const ALARM_LIMIT = 500;

export function alarmEvents(alarms: Alarm[], range: { from: string; to: string }): ChartEvent[] {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return alarms
    .filter((alarm) => {
      const at = Date.parse(alarm.opened_at);
      return at >= from && at < to;
    })
    .map((alarm) => ({
      key: `alarm-${alarm.id}`,
      at: Date.parse(alarm.opened_at),
      label: `${alarm.severity} · ${alarm.device_code ? `${alarm.device_code}: ` : ""}${alarm.message}`,
      tone: SEVERITY_TONE[alarm.severity],
    }));
}

export function maintenanceEvents(
  windows: historyApi.MaintenanceWindow[],
  range: { from: string; to: string },
  deviceId: number | null,
): ChartEvent[] {
  const from = Date.parse(range.from);
  const to = Date.parse(range.to);
  return windows
    // A Device's screen shows its own windows and the Plant-wide ones.
    .filter((window) => deviceId === null || window.device_id === null || window.device_id === deviceId)
    .map((window) => {
      const starts = Date.parse(window.starts_at);
      const ends = window.ends_at ? Date.parse(window.ends_at) : to;
      return { window, starts: Math.max(starts, from), ends: Math.min(ends, to) };
    })
    .filter(({ starts, ends }) => ends > starts)
    .map(({ window, starts, ends }) => ({
      key: `maintenance-${window.id}`,
      at: starts,
      end: ends,
      label: `Planned work${window.device_code ? ` · ${window.device_code}` : ""}${window.reason ? `: ${window.reason}` : ""}`,
      tone: "neutral" as const,
    }));
}

/**
 * The Alarms opened in a window, and its planned work where the session may
 * read it (`plant.manage`) — for a whole Plant, or one Device of it.
 */
export function useTimelineEvents(
  plantId: number | null,
  range: { from: string; to: string } | null,
  {
    deviceId = null,
    canReadMaintenance,
    live,
  }: { deviceId?: number | null; canReadMaintenance: boolean; live: boolean },
): { events: ChartEvent[]; capped: boolean } {
  const alarms = useAlarms(
    {
      plantId,
      deviceId,
      since: range?.from ?? null,
      until: live ? null : (range?.to ?? null),
      limit: ALARM_LIMIT,
    },
    plantId !== null && range !== null,
  );
  const maintenance = useQuery({
    queryKey: ["plants", plantId, "maintenance"] as const,
    queryFn: () => historyApi.listMaintenance(plantId as number),
    enabled: canReadMaintenance && plantId !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const events = useMemo(() => {
    if (!range) return [];
    return [
      ...maintenanceEvents(maintenance.data ?? [], range, deviceId),
      ...alarmEvents(alarms.data ?? [], range),
    ];
  }, [alarms.data, maintenance.data, range, deviceId]);
  return { events, capped: (alarms.data?.length ?? 0) >= ALARM_LIMIT };
}

export { mergeDetail, useZoomableSeries } from "./useSeries";
