/**
 * Every irradiance series the Plant's weather stations sent, for the power
 * trend's "Select options" menu.
 *
 * Which ones exist is read from the data, not listed here: one request for the
 * chart's window asks the Plant's WMS Devices for every Tag the catalogue keeps
 * in W/m², and an option is whatever came back. So a station that adds a
 * sensor appears without a release, and one that sends no GTI is told so.
 *
 * Left out, on purpose:
 * - **`DIRECT_RADIATION`** — already the "Direct radiation" option, read
 *   through its dashboard slot (`env.direct_radiation`).
 * - **`*_AVG`** — the station's own running averages (TAG_CATALOGUE §2.2:
 *   "Accum. Direct" is an average in W/m²). Over what span is not stated, so
 *   drawn beside power they would read as irradiance at that moment.
 * - **kWh/m²** — daily totals, a different unit, which has no place on a W/m²
 *   axis.
 *
 * Two or more stations are averaged per bucket (irradiance does not add), and
 * the legend says how many. Flagged readings are counted, never drawn
 * (Guardrail 23).
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import * as readingsApi from "@/api/endpoints/readings";
import { usePlantDevices, useTags } from "@/api/hooks";
import type { ReadingPoint, Tag, Tier } from "@/api/schemas";
import {
  seriesFromReadings,
  tierForRange,
  trendWindow,
  type TrendPoint,
  type TrendRange,
} from "@/api/useSlotTrend";
import { IRRADIANCE_UNIT } from "./powerComparison";

const WMS_TYPE = "WMS";
/** Handled through its own slot as the "Direct radiation" option. */
const VIA_SLOT = "DIRECT_RADIATION";

export interface WmsSeries {
  tagCode: string;
  label: string;
  unit: string;
  points: TrendPoint[];
  flaggedCount: number;
}

export interface WmsIrradiance {
  /** In catalogue order of preference: GTI, GHI, then the rest by name. */
  series: WmsSeries[];
  /** Every W/m² Tag the catalogue knows, so GHI and GTI can be offered by name. */
  catalogue: Tag[];
  stationCount: number;
  tier: Tier;
  isLoading: boolean;
  isError: boolean;
}

/** Plane-of-array first (what PR divides by), then horizontal, then the rest. */
const ORDER = ["GTI", "GHI", "DIFFUSE_RADIATION"];

function rank(code: string): number {
  const index = ORDER.indexOf(code);
  return index === -1 ? ORDER.length : index;
}

export function isOfferedIrradiance(tag: Tag): boolean {
  return tag.unit === IRRADIANCE_UNIT && tag.code !== VIA_SLOT && !tag.code.endsWith("_AVG");
}

export function useWmsIrradiance(
  plantId: number | null,
  range: TrendRange,
  timeZone: string | undefined,
  enabled: boolean,
): WmsIrradiance {
  const devicesQuery = usePlantDevices(plantId);
  const tagsQuery = useTags();
  const stations = useMemo(
    () =>
      (devicesQuery.data ?? [])
        .filter((device) => device.type_code === WMS_TYPE)
        .map((device) => device.id)
        .sort((a, b) => a - b),
    [devicesQuery.data],
  );
  const catalogue = useMemo(
    () =>
      (tagsQuery.data ?? [])
        .filter(isOfferedIrradiance)
        .sort((a, b) => rank(a.code) - rank(b.code) || a.name.localeCompare(b.name)),
    [tagsQuery.data],
  );

  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const { from, to } = trendWindow(range, now, timeZone ?? "UTC");
  const tier = tierForRange(range);
  const query: readingsApi.ReadingsQuery = {
    deviceIds: stations,
    tagIds: catalogue.map((tag) => tag.id),
    from,
    to,
    resolution: tier,
  };
  const active = enabled && stations.length > 0 && catalogue.length > 0 && !!timeZone;
  const readings = useQuery({
    queryKey: qk.readings(query),
    queryFn: () => readingsApi.getReadings(query),
    enabled: active,
    retry: false,
    staleTime: 60_000,
    refetchInterval: range === "today" || range === "24h" ? 60_000 : false,
    placeholderData: (previous) => previous,
  });

  const series = useMemo(() => {
    const byTag = new Map<number, ReadingPoint[]>();
    for (const point of (readings.data?.items ?? []) as ReadingPoint[]) {
      const list = byTag.get(point.tag_id) ?? [];
      list.push(point);
      byTag.set(point.tag_id, list);
    }
    const out: WmsSeries[] = [];
    for (const tag of catalogue) {
      const items = byTag.get(tag.id);
      if (!items || items.length === 0) continue;
      const { points, flaggedCount } = seriesFromReadings(items, "avg", readings.data?.tier ?? tier);
      if (!points.some((point) => point.value !== null) && flaggedCount === 0) continue;
      out.push({ tagCode: tag.code, label: tag.name, unit: tag.unit ?? IRRADIANCE_UNIT, points, flaggedCount });
    }
    return out;
  }, [readings.data, catalogue, tier]);

  return {
    series,
    catalogue,
    stationCount: stations.length,
    tier,
    isLoading: active && readings.isLoading,
    isError: readings.isError,
  };
}
