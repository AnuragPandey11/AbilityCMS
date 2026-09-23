/**
 * How a headline register accrued — per hour today, or per day this month.
 *
 * Reads the same slot the headline figure does (`useSlotSource`), so the
 * spokes and columns are the tile's own claim: same Device Type, same Tag,
 * same Devices. Only the arithmetic lives elsewhere, in the pure
 * `registerSteps`, which says why days are built from hourly steps rather than
 * read off the daily tier.
 *
 * ⚠ A month of hourly buckets is `devices × 744` points against the server's
 * 20,000 cap, which twenty-seven Inverters would exceed. The window is split
 * into requests sized to stay under it, rather than widened to a tier that
 * cannot answer the question.
 *
 * The split also falls at the Plant's midnight: the days before today are one
 * set of requests whose keys hold still all day and are re-asked every fifteen
 * minutes, and today is the only part asked for every minute. Re-reading a
 * month of hourly buckets once a minute to learn about the last hour would be
 * the whole cost of this view, paid for nothing.
 */

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { qk } from "./queryKeys";
import * as readingsApi from "./endpoints/readings";
import type { ReadingPoint, ReadingsResponse } from "./schemas";
import { provenanceOf, useSlotSource } from "./useSlotTrend";
import {
  hourlyPeriods,
  placeRegisterSteps,
  type Period,
  type PeriodEnergy,
  type RegisterReading,
} from "@/dashboards/single-plant/registerSteps";
import { dayInZone, daysOfMonthInZone, recentDaysInZone } from "@/format/datetime";

/**
 * `day` — the hours of the Plant's today. `month` — the days of its month so
 * far. `{ days }` — its last `days` calendar days, today included.
 */
export type StepSpan = "day" | "month" | { days: number };

const HOUR_MS = 3_600_000;
/** Under the server's 20,000-point cap, with room for its own estimate's rounding. */
const POINT_BUDGET = 18_000;
/** How often the days before today are re-asked for — late readings still land. */
const HISTORY_REFRESH_MS = 15 * 60_000;

export interface SlotSteps {
  periods: PeriodEnergy[];
  /** The energy placed in some period. The headline figure minus this could not be. */
  placed: number;
  backwardsSteps: number;
  /** Readings in the window not used because their quality was flagged. */
  flaggedCount: number;
  /** The Plant-local day or month the periods span. */
  frame: Period | null;
  timeZone: string | undefined;
  /** Verbatim from the slot — never derived from the Tag's name (§4.1). */
  unit: string | null;
  /** `sum of 12 INVERTER`, `ABT_METER` — the same claim the tile makes. */
  provenance: string | null;
  unavailableReason: string | null;
  isLoading: boolean;
  isError: boolean;
}

export function useSlotSteps(
  plantId: number | null,
  slotCode: string,
  span: StepSpan,
  {
    enabled: wanted = true,
    resetsExpected = false,
  }: {
    /** False while nothing on screen shows it: nothing is fetched. */
    enabled?: boolean;
    /** The register restarts from zero by design — see `placeRegisterSteps`. */
    resetsExpected?: boolean;
  } = {},
): SlotSteps {
  const { slot, source, tag, deviceIds, timeZone, unavailableReason, isLoading } = useSlotSource(
    plantId,
    slotCode,
  );
  // Plain values, so the memo below keys on what the span *is* rather than on
  // an object literal that is new every render.
  const spanKind = typeof span === "string" ? span : "days";
  const dayCount = typeof span === "object" ? span.days : 1;

  // Per-Device steps summed across Devices is the slot's own figure only when
  // the slot sums them, or when there is one Device to begin with.
  const aggregateReason =
    source && !["sum", "first", "last"].includes(source.aggregate)
      ? `The figure is the ${source.aggregate} of its Devices, not a total that accrues.`
      : null;

  // The top of the minute, so request keys hold still for sixty seconds.
  const now = Math.floor(Date.now() / 60_000) * 60_000;

  const { frame, periods, today } = useMemo(() => {
    if (!timeZone) return { frame: null, periods: [] as Period[], today: null };
    const today = dayInZone(now, timeZone).start;
    const spanned =
      spanKind === "day"
        ? [dayInZone(now, timeZone)]
        : spanKind === "month"
          ? daysOfMonthInZone(now, timeZone)
          : recentDaysInZone(now, dayCount, timeZone);
    if (spanned.length === 0) return { frame: null, periods: [] as Period[], today };
    const frame = { start: spanned[0].start, end: spanned[spanned.length - 1].end };
    return {
      frame,
      periods:
        spanKind === "day"
          ? hourlyPeriods(frame.start, frame.end, HOUR_MS)
          : spanned.map(({ start, end }) => ({ start, end })),
      today,
    };
  }, [spanKind, dayCount, timeZone, now]);

  const enabled =
    wanted &&
    frame !== null &&
    today !== null &&
    tag !== undefined &&
    deviceIds.length > 0 &&
    aggregateReason === null;

  // Chunks start at the frame's own start and break at the Plant's midnight,
  // so every request before today keeps its key all day.
  const requests = useMemo<{ query: readingsApi.ReadingsQuery; live: boolean }[]>(() => {
    if (!enabled || !frame || today === null || !tag) return [];
    const chunkMs = Math.max(24, Math.floor(POINT_BUDGET / deviceIds.length)) * HOUR_MS;
    const out: { query: readingsApi.ReadingsQuery; live: boolean }[] = [];
    const chunk = (start: number, end: number, live: boolean): void => {
      for (let from = start; from < end; from += chunkMs) {
        out.push({
          live,
          query: {
            deviceIds,
            tagIds: [tag.id],
            from: new Date(from).toISOString(),
            to: new Date(Math.min(from + chunkMs, end)).toISOString(),
            resolution: "agg_1h",
          },
        });
      }
    };
    chunk(frame.start, Math.max(frame.start, today), false);
    chunk(Math.max(frame.start, today), now, true);
    return out;
  }, [enabled, frame, today, tag, deviceIds, now]);

  const results = useQueries({
    queries: requests.map(({ query, live }) => ({
      queryKey: qk.readings(query),
      queryFn: () => readingsApi.getReadings(query),
      retry: false,
      staleTime: live ? 60_000 : HISTORY_REFRESH_MS,
      refetchInterval: live ? 60_000 : HISTORY_REFRESH_MS,
      // Today's key moves with the minute; keep its previous answer on screen
      // meanwhile, rather than blanking the card once a minute.
      placeholderData: (previous: ReadingsResponse | undefined) => previous,
    })),
  });

  const settled = results.length > 0 && results.every((result) => result.data !== undefined);
  const dataStamp = results.map((result) => result.dataUpdatedAt).join(",");

  const placement = useMemo(() => {
    if (!settled) return null;
    const readings: RegisterReading[] = [];
    let flagged = 0;
    for (const result of results) {
      for (const point of (result.data?.items ?? []) as ReadingPoint[]) {
        // A flagged reading is stored and flagged, never used as data (§4.2).
        if (point.quality !== null && point.quality !== 0) {
          flagged += 1;
          continue;
        }
        if (point.value === null) continue;
        readings.push({ deviceId: point.device_id, bucket: Date.parse(point.bucket), value: point.value });
      }
    }
    return {
      ...placeRegisterSteps(readings, periods, { stepMs: HOUR_MS, now, resetsExpected }),
      flagged,
    };
    // `results` is a new array every render; its data changes only with `dataStamp`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, dataStamp, periods, now, resetsExpected]);

  return {
    periods: placement?.periods ?? [],
    placed: placement?.placed ?? 0,
    backwardsSteps: placement?.backwardsSteps ?? 0,
    flaggedCount: placement?.flagged ?? 0,
    frame,
    timeZone,
    unit: slot?.unit ?? tag?.unit ?? null,
    provenance: provenanceOf(slot),
    unavailableReason: unavailableReason ?? aggregateReason,
    isLoading: isLoading || (enabled && !settled && !results.some((result) => result.isError)),
    isError: results.some((result) => result.isError),
  };
}
