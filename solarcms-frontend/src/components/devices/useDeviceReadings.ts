/**
 * One Device's current figures, ready to place on a screen about it.
 *
 * The stored latest value of every Tag the Device reported in the last thirty
 * minutes (`useDeviceLatest`, no Tag filter), the live frame over it per Tag,
 * and `fill` — the Inverter view's rule for a position: the first of its Tag
 * codes the Device reports, else a dash with the most specific reason this
 * session can know (Guardrail 26). The screens about one Device — the Weather
 * Station, the meters — read it through here so they cannot drift apart.
 */

import { useMemo } from "react";
import { useBindings, useTags } from "@/api/hooks";
import type { DeviceListItem, Tag } from "@/api/schemas";
import { useDeviceLatest } from "@/api/useLatestValues";
import { usePermission } from "@/auth/usePermission";
import { useLiveSocket } from "@/live/LiveSocket";
import { latestOf } from "@/format/datetime";
import { fillPosition, type Filled, type Position } from "./InverterView";

export interface DeviceReadings {
  /** Tag id → value: stored latest, then the live frame over it. */
  values: Map<number, number>;
  fill: (position: Position) => Filled;
  /** The later of the health sweep's last contact and the last live frame. */
  heard: string | null;
  tagsById: Map<number, Tag>;
  isLoading: boolean;
}

export function useDeviceReadings(
  device: DeviceListItem | null,
  /** Names the Device in a reason — "this station", "this meter". */
  subject: string,
): DeviceReadings {
  const tagsQuery = useTags();
  const latest = useDeviceLatest(device?.id ?? null);
  const { devices: liveDevices } = useLiveSocket();
  const live = device ? liveDevices[device.id] : undefined;

  // Bindings say "not bound" where this session may read them; everybody else
  // gets the weaker, still true, "nothing received".
  const canReadBindings = usePermission("config.modify");
  const bindingsQuery = useBindings(device?.id ?? null, canReadBindings);
  const bound = useMemo(
    () =>
      bindingsQuery.data
        ? new Set(bindingsQuery.data.filter((binding) => binding.enabled).map((binding) => binding.tag_code))
        : null,
    [bindingsQuery.data],
  );

  const tagsByCode = useMemo(
    () => new Map((tagsQuery.data ?? []).map((tag) => [tag.code, tag])),
    [tagsQuery.data],
  );
  const tagsById = useMemo(
    () => new Map((tagsQuery.data ?? []).map((tag) => [tag.id, tag])),
    [tagsQuery.data],
  );

  const values = useMemo(() => {
    const out = new Map(latest.values);
    for (const [key, value] of Object.entries(live?.values ?? {})) out.set(Number(key), value);
    return out;
  }, [latest.values, live]);

  const fill = (position: Position): Filled =>
    fillPosition(position, { tagsByCode, values, bound, isLoading: latest.isLoading, subject });

  return {
    values,
    fill,
    heard: device ? latestOf(device.last_seen_at, live?.at) : null,
    tagsById,
    isLoading: latest.isLoading,
  };
}
