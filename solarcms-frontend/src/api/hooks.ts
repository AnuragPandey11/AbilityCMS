/**
 * React Query hooks.
 *
 * Cache policy follows §9: `/catalog/*` for the session, `/plants` for ~60s,
 * `/readings` for a few seconds. The catalogue is cached hardest because every
 * unit and every Tag name in the UI comes from it and it changes monthly.
 */

import { useQueries, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import * as catalogApi from "./endpoints/catalog";
import * as regionsApi from "./endpoints/regions";
import * as plantsApi from "./endpoints/plants";
import * as devicesApi from "./endpoints/devices";
import * as readingsApi from "./endpoints/readings";
import * as alarmsApi from "./endpoints/alarms";
import * as healthApi from "./endpoints/health";
import * as reportsApi from "./endpoints/reports";
import * as usersApi from "./endpoints/users";
import { qk } from "./queryKeys";
import { useLiveSocket } from "@/live/LiveSocket";
import type { KpiPeriod, PlantKpis, Tag } from "./schemas";

const SESSION = {
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
};
const SIXTY_SECONDS = { staleTime: 60_000 };
const FEW_SECONDS = { staleTime: 5_000 };

/**
 * How often a figure that is supposed to read "now" is re-asked.
 *
 * ⚠ These are **not** a cache policy, they are the refresh rate of a monitoring
 * screen, which is a different thing and is why they live apart from the
 * `staleTime` constants above. A dashboard whose number is thirty seconds old
 * is not showing the plant; it is showing the plant as it was, without saying
 * so — and the operator has no way to tell the difference between a figure that
 * is not moving and a figure that is not being asked for.
 *
 * `staleTime` is set to match rather than left at its default, so that a
 * component mounting between ticks serves the cached value instead of firing
 * its own request; the interval, not the mount, decides the cadence.
 */
/**
 * The refresh timer when the live socket is carrying the Plant.
 *
 * With `useLiveRefresh` triggering a refetch as readings actually arrive, the
 * timer stops being how a figure stays current and becomes a safety net: it
 * catches the case where the socket is up but silent for a reason we have not
 * thought of. So it is deliberately slow — polling every 5 seconds *as well as*
 * refetching on arrival would be strictly more requests than before, which is
 * the opposite of the point.
 */
const LIVE_SOCKET_FALLBACK = { staleTime: 30_000, refetchInterval: 30_000 };

const LIVE_BACKED = {
  // `/plants/{id}/dashboard` resolves every slot against the Redis values that
  // ingest writes on each accepted message, so the data behind it is already
  // current — the only lag left was how often it was asked for.
  staleTime: 5_000,
  refetchInterval: 5_000,
};

const LIVE_KPI = {
  // `/plants/{id}/kpis` runs a handful of aggregate reads. Measured at 5–10 ms
  // per Plant against the real-time tiers (migration 0023), so a ten-second
  // cadence across a fleet is not a load question at the F-2 ceiling.
  staleTime: 10_000,
  refetchInterval: 10_000,
};

/**
 * Refetch when the tab comes back, on live figures only.
 *
 * The global default is `refetchOnWindowFocus: false`, which is right for the
 * catalogue and for configuration — refetching a Tag registry because someone
 * alt-tabbed is noise. It is wrong for a figure claiming to be current: a
 * background tab has its interval throttled to about once a minute by the
 * browser, and can be suspended outright, so the first thing an operator sees
 * on returning is a number from some unknowable time ago.
 */
const ON_RETURN = { refetchOnWindowFocus: true } as const;

// ── Catalogue ───────────────────────────────────────────────────────────────

/** The Tag registry: the only source of units in the application (§4.1). */
export { LIVE_KPI, LIVE_SOCKET_FALLBACK, ON_RETURN };

/**
 * KPIs for a set of Plants — one request each, on the live cadence.
 *
 * There is no fleet KPI endpoint by design, so every screen showing more than
 * one Plant fans out. That fan-out lives here **once**, because it did not:
 * `usePlantFleet` and `PortfolioDashboard` each grew their own copy, both with
 * `staleTime` and neither with `refetchInterval`, and the two drifted
 * independently while looking identical. Fixing one left the other frozen,
 * which is precisely how the Portfolio came to sit on figures from page load.
 *
 * `kpis` is positional — `useQueries` preserves input order, so index `i` is
 * `plants[i]`, and an entry is `undefined` until that Plant's request lands.
 * Callers render per-Plant placeholders from that rather than blocking the
 * whole screen on the slowest of N requests.
 */
export function usePlantKpiFanout(
  plants: { id: number }[],
  period: KpiPeriod,
): { kpis: (PlantKpis | undefined)[]; isLoading: boolean } {
  const results = useQueries({
    queries: plants.map((plant) => ({
      queryKey: qk.plantKpis(plant.id, period),
      queryFn: () => plantsApi.plantKpis(plant.id, period),
      ...LIVE_KPI,
      ...ON_RETURN,
    })),
  });
  return {
    kpis: results.map((query) => query.data as PlantKpis | undefined),
    // `isLoading` only — never `isFetching`. A refetch on the live interval
    // must not put the screen back into a loading state every ten seconds;
    // the figure on display stays until its replacement arrives.
    isLoading: results.some((query) => query.isLoading),
  };
}

export function useTags() {
  return useQuery({
    queryKey: qk.tags(),
    // Wrapped rather than passed directly: React Query calls the function with
    // its own context object, which `tags()` would read as a filter.
    queryFn: () => catalogApi.tags(),
    ...SESSION,
  });
}

/** Tags indexed by id — the join the live socket needs (`values` is tag_id-keyed). */
export function useTagsById(): Map<number, Tag> {
  const { data } = useTags();
  const map = new Map<number, Tag>();
  for (const tag of data ?? []) map.set(tag.id, tag);
  return map;
}

export function useDeviceTypes() {
  return useQuery({
    queryKey: qk.deviceTypes(),
    queryFn: catalogApi.deviceTypes,
    ...SESSION,
  });
}

export function useDeviceModels(deviceTypeCode?: string | null) {
  return useQuery({
    queryKey: qk.deviceModels(deviceTypeCode),
    queryFn: () => catalogApi.deviceModels(deviceTypeCode),
    ...SESSION,
  });
}

/**
 * A Model's signal schedule, optionally sliced to a string count.
 *
 * Passing the count the operator has typed shows exactly what a Device would
 * bind — "59 Tags", not "107 Tags of which some apply" — before anything is
 * created.
 */
export function useDeviceModelTags(
  modelId: number | null,
  stringCount?: number | null,
) {
  return useQuery({
    queryKey: qk.deviceModelTags(modelId ?? 0, stringCount),
    queryFn: () => catalogApi.deviceModelTags(modelId as number, stringCount),
    enabled: modelId !== null,
    ...SESSION,
  });
}

/** Regions are catalogue, but Super Admins add them mid-onboarding, so not SESSION-cached. */
export function useRegions() {
  return useQuery({ queryKey: qk.regions(), queryFn: regionsApi.listRegions });
}

// ── Plants ──────────────────────────────────────────────────────────────────

export function usePlants(params: plantsApi.ListPlantsParams = {}) {
  return useQuery({
    queryKey: qk.plants(params),
    queryFn: () => plantsApi.listPlants(params),
    ...SIXTY_SECONDS,
  });
}

/** Every visible Plant, paged through. Portfolio sums these (§6.1). */
export function useAllPlants() {
  return useQuery({
    queryKey: qk.allPlants(),
    // Wrapped: react-query calls the fn with its own context object,
    // which `listAllPlants` would read as filter parameters.
    queryFn: () => plantsApi.listAllPlants(),
    ...SIXTY_SECONDS,
  });
}

export function usePlant(plantId: number | null) {
  return useQuery({
    queryKey: qk.plant(plantId ?? 0),
    queryFn: () => plantsApi.getPlant(plantId as number),
    enabled: plantId !== null,
    ...SIXTY_SECONDS,
  });
}

export function usePlantKpis(
  plantId: number | null,
  period: KpiPeriod,
  options: Partial<UseQueryOptions> = {},
) {
  const socketOpen = useLiveSocket().status === "open";
  return useQuery({
    queryKey: qk.plantKpis(plantId ?? 0, period),
    queryFn: () => plantsApi.plantKpis(plantId as number, period),
    enabled: plantId !== null,
    ...(socketOpen ? LIVE_SOCKET_FALLBACK : LIVE_KPI),
    ...ON_RETURN,
    ...(options as object),
  });
}

/** Blocks are optional; an empty array is normal and renders no section (§6.3). */
export function usePlantBlocks(plantId: number | null) {
  return useQuery({
    queryKey: qk.plantBlocks(plantId ?? 0),
    queryFn: () => plantsApi.listBlocks(plantId as number),
    enabled: plantId !== null,
    ...SIXTY_SECONDS,
  });
}

export function usePlantDevices(
  plantId: number | null,
  blockId?: number | null,
) {
  return useQuery({
    queryKey: qk.plantDevices(plantId ?? 0, blockId),
    queryFn: () => devicesApi.listDevices(plantId as number, blockId),
    enabled: plantId !== null,
    ...SIXTY_SECONDS,
  });
}

/**
 * The fixed dashboard, resolved for one Plant.
 *
 * Refetched on the same 30s cadence as the KPI panel: every slot resolves
 * against current values, and a resolution that silently goes stale would show
 * the last source that answered rather than the one answering now.
 */
/**
 * The curated per-Device table columns. Part of the catalogue, so cached as hard
 * as the Tag registry: it changes when somebody edits the configuration, not
 * while an operator is looking at the screen.
 */
export function useDeviceTableColumns() {
  return useQuery({
    queryKey: qk.deviceTableColumns(),
    queryFn: () => catalogApi.deviceTableColumns(),
    staleTime: Infinity,
  });
}

export function usePlantDashboard(plantId: number | null) {
  // When the socket is open, `useLiveRefresh` refetches on arrival and the
  // timer is only a backstop. When it is closed — a dropped connection, a
  // User with no room assigned — the timer is the *only* thing keeping the
  // figure current, so it tightens back up to the original cadence.
  const { status } = useLiveSocket();
  return useQuery({
    queryKey: qk.plantDashboard(plantId ?? 0),
    queryFn: () => plantsApi.plantDashboard(plantId as number),
    enabled: plantId !== null,
    ...(status === "open" ? LIVE_SOCKET_FALLBACK : LIVE_BACKED),
    ...ON_RETURN,
  });
}

export function usePlantSld(plantId: number | null) {
  return useQuery({
    queryKey: qk.plantSld(plantId ?? 0),
    queryFn: () => plantsApi.plantSld(plantId as number),
    enabled: plantId !== null,
    ...SIXTY_SECONDS,
  });
}

export function useBlockKpis(blockId: number | null, period: KpiPeriod) {
  return useQuery({
    queryKey: qk.blockKpis(blockId ?? 0, period),
    queryFn: () => plantsApi.blockKpis(blockId as number, period),
    enabled: blockId !== null,
    ...LIVE_KPI,
    ...ON_RETURN,
  });
}

// ── Devices ─────────────────────────────────────────────────────────────────

export function useDevice(deviceId: number | null) {
  return useQuery({
    queryKey: qk.device(deviceId ?? 0),
    queryFn: () => devicesApi.getDevice(deviceId as number),
    enabled: deviceId !== null,
    ...SIXTY_SECONDS,
  });
}

/**
 * Which Tags a Device exposes. Guarded by `config.modify`, so `enabled` should
 * carry that permission — a 403 here is expected for a plain viewer.
 */
export function useBindings(deviceId: number | null, enabled = true) {
  return useQuery({
    queryKey: qk.bindings(deviceId ?? 0),
    queryFn: () => devicesApi.getBindings(deviceId as number),
    enabled: deviceId !== null && enabled,
    retry: false,
    ...SIXTY_SECONDS,
  });
}

/**
 * Signals a Device publishes that nothing is bound to.
 *
 * Refreshed rather than session-cached: this is what an engineer watches while
 * correcting bindings, and a stale list showing solved problems is worse than
 * no list at all.
 */
export function useUnmappedKeys(deviceId: number | null, enabled = true) {
  return useQuery({
    queryKey: qk.unmappedKeys(deviceId ?? 0),
    queryFn: () => devicesApi.unmappedKeys(deviceId as number),
    enabled: deviceId !== null && enabled,
    retry: false,
    ...FEW_SECONDS,
  });
}

/** What still stands between this Plant and going live. */
export function usePlantCommissioning(plantId: number | null, enabled = true) {
  return useQuery({
    queryKey: qk.plantCommissioning(plantId ?? 0),
    queryFn: () => plantsApi.commissioningReport(plantId as number),
    enabled: plantId !== null && enabled,
    ...FEW_SECONDS,
  });
}

// ── Readings ────────────────────────────────────────────────────────────────

export function useReadings(query: readingsApi.ReadingsQuery, enabled = true) {
  return useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    enabled: enabled && query.deviceIds.length > 0,
    // A 422 is the point cap or a validation error; retrying repeats it exactly.
    retry: false,
    ...FEW_SECONDS,
  });
}

// ── Alarms ──────────────────────────────────────────────────────────────────

export function useAlarms(query: alarmsApi.AlarmQuery = {}) {
  return useQuery({
    queryKey: qk.alarms(query),
    queryFn: () => alarmsApi.listAlarms(query),
    // Left at 30s rather than sped up: an Alarm cannot appear faster than the
    // pipeline raises one (`min_interval_s + duration_s`, BACKEND_SPEC §12.4),
    // so polling harder would only ask more often for the same answer. The
    // focus refetch is what matters — a tab restored after an hour must not
    // show an alarm count from an hour ago.
    staleTime: 15_000,
    refetchInterval: 30_000,
    ...ON_RETURN,
  });
}

export function useAlarmRules(enabled = true) {
  return useQuery({
    queryKey: qk.alarmRules(),
    queryFn: alarmsApi.listAlarmRules,
    enabled,
    retry: false,
    ...SIXTY_SECONDS,
  });
}

// ── Health ──────────────────────────────────────────────────────────────────

export function useDeviceHealth(plantId?: number | null) {
  return useQuery({
    queryKey: qk.deviceHealth(plantId),
    queryFn: () => healthApi.deviceHealth(plantId),
    // Also left at 30s: `device_health` is rewritten by the sweeper on its own
    // 60s cycle, so this already asks twice per change.
    staleTime: 20_000,
    refetchInterval: 30_000,
    ...ON_RETURN,
  });
}

export function useSystemHealth(enabled = true) {
  return useQuery({
    queryKey: qk.systemHealth(),
    queryFn: healthApi.systemHealth,
    enabled,
    retry: false,
    refetchInterval: 30_000,
  });
}

// ── Reports, Users ──────────────────────────────────────────────────────────

export function useReportDefinitions(enabled = true) {
  return useQuery({
    queryKey: qk.reportDefinitions(),
    queryFn: reportsApi.listDefinitions,
    enabled,
    retry: false,
    ...SIXTY_SECONDS,
  });
}

/**
 * Poll a run until it settles. `202` means queued; the scheduler renders it, so
 * there is no completion push to wait on (§6.7).
 */
export function useReportRun(runId: number | null) {
  return useQuery({
    queryKey: qk.reportRun(runId ?? 0),
    queryFn: () => reportsApi.getRun(runId as number),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "succeeded" || state === "failed" ? false : 2000;
    },
  });
}

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: qk.users(),
    queryFn: usersApi.listUsers,
    enabled,
    retry: false,
    ...SIXTY_SECONDS,
  });
}
