/**
 * The data behind `plant_list` and `plant_overview` (§6.2).
 *
 * Both dashboards answer questions about the same set of Plants — Overview at a
 * glance, List in detail — so the fetching lives here once and the two
 * components differ only in how they draw it. Splitting the *presentation* was
 * the point; duplicating the *queries* would have doubled the request volume
 * for a User granted both codes, since each dashboard asks every Plant for its
 * KPIs.
 *
 * `GET /plants` is cursor-paginated and `useAllPlants` follows `next_cursor`.
 * Never construct an offset — the backend has no offset parameter and inventing
 * one silently repeats rows as the fleet grows.
 */

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useAlarms, useAllPlants, useDeviceHealth } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as plantsApi from "@/api/endpoints/plants";
import type {
  Alarm,
  DeviceHealth,
  KpiPeriod,
  PlantKpis,
  PlantListItem,
} from "@/api/schemas";
import { isOnboarding } from "@/components/domain";
import { useLiveSocket } from "@/live/LiveSocket";

/** Worst first, so `Math.min` over an Alarm set picks the one that matters. */
const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface PlantFleetEntry {
  plant: PlantListItem;
  /** `undefined` while the per-Plant KPI query is still in flight. */
  kpis: PlantKpis | undefined;
  health: DeviceHealth[];
  alarms: Alarm[];
  /**
   * The severity of the worst open Alarm, or `null` for none. A card tinted by
   * this is reading the Alarm set, never inferring distress from a KPI.
   */
  worstSeverity: string | null;
  /**
   * Devices that have sent a live frame **in this browser session**. Zero means
   * "nothing heard here yet", not "the Plant is down" — values may still exist
   * over REST, which is why it renders as "—" rather than 0.
   */
  liveDeviceCount: number;
}

export interface PlantFleet {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
  /** Every visible Plant, in the order `GET /plants` returned them. */
  plants: PlantListItem[];
  /** Excludes `draft` and `commissioning` (MASTER §6.5). */
  active: PlantListItem[];
  onboarding: PlantListItem[];
  entryFor: (plantId: number) => PlantFleetEntry | undefined;
  entries: PlantFleetEntry[];
}

export function usePlantFleet(period: KpiPeriod): PlantFleet {
  const plantsQuery = useAllPlants();
  const healthQuery = useDeviceHealth();
  const alarmsQuery = useAlarms({ state: "active", limit: 500 });
  const { devices: liveDevices } = useLiveSocket();

  const plants = useMemo(() => plantsQuery.data ?? [], [plantsQuery.data]);

  const kpiQueries = useQueries({
    queries: plants.map((plant) => ({
      queryKey: qk.plantKpis(plant.id, period),
      queryFn: () => plantsApi.plantKpis(plant.id, period),
      staleTime: 30_000,
    })),
  });

  // `useQueries` preserves the order it was given, so index i is plants[i].
  const kpiData = kpiQueries.map((query) => query.data as PlantKpis | undefined);
  const health = healthQuery.data;
  const alarms = alarmsQuery.data;

  /**
   * Grouped once rather than filtered per Plant: the table reaches for health
   * and alarms in every row of every column that shows them, and that repeated
   * scan is O(plants x devices) on each paint.
   *
   * Only the grouping is memoised. `entries` itself is rebuilt each render
   * because the per-Plant KPI results arrive as a fresh array every time — a
   * dependency list containing them would change *size* as the fleet loads,
   * which React does not support.
   */
  const grouped = useMemo(() => {
    const healthByPlant = new Map<number, DeviceHealth[]>();
    for (const record of health ?? []) {
      const bucket = healthByPlant.get(record.plant_id);
      if (bucket) bucket.push(record);
      else healthByPlant.set(record.plant_id, [record]);
    }

    const alarmsByPlant = new Map<number, Alarm[]>();
    for (const alarm of alarms ?? []) {
      if (alarm.plant_id === null) continue;
      const bucket = alarmsByPlant.get(alarm.plant_id);
      if (bucket) bucket.push(alarm);
      else alarmsByPlant.set(alarm.plant_id, [alarm]);
    }

    const liveByPlant = new Map<number, number>();
    for (const device of Object.values(liveDevices)) {
      liveByPlant.set(device.plantId, (liveByPlant.get(device.plantId) ?? 0) + 1);
    }

    return { healthByPlant, alarmsByPlant, liveByPlant };
  }, [health, alarms, liveDevices]);

  const entries: PlantFleetEntry[] = [];
  const byId = new Map<number, PlantFleetEntry>();
  plants.forEach((plant, index) => {
    const plantAlarms = grouped.alarmsByPlant.get(plant.id) ?? [];
    let worst: string | null = null;
    for (const alarm of plantAlarms) {
      const rank = SEVERITY_ORDER[alarm.severity] ?? 9;
      if (worst === null || rank < (SEVERITY_ORDER[worst] ?? 9)) {
        worst = alarm.severity;
      }
    }
    const entry: PlantFleetEntry = {
      plant,
      kpis: kpiData[index],
      health: grouped.healthByPlant.get(plant.id) ?? [],
      alarms: plantAlarms,
      worstSeverity: worst,
      liveDeviceCount: grouped.liveByPlant.get(plant.id) ?? 0,
    };
    entries.push(entry);
    byId.set(plant.id, entry);
  });

  return {
    // Only the Plant list gates the screen. Health, alarms and KPIs fill in
    // afterwards — blocking on them would hold an otherwise usable list behind
    // the slowest of N+3 requests.
    isLoading: plantsQuery.isLoading,
    isError: plantsQuery.isError,
    error: plantsQuery.error,
    refetch: () => void plantsQuery.refetch(),
    plants,
    active: plants.filter((plant) => !isOnboarding(plant.status)),
    onboarding: plants.filter((plant) => isOnboarding(plant.status)),
    entryFor: (plantId: number) => byId.get(plantId),
    entries,
  };
}
