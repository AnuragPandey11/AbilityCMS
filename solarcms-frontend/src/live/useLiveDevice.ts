/**
 * Subscribe a component to one Device's live values.
 *
 * Staleness is the part worth reading. Each frame carries `at`; a tile is stale
 * once its age exceeds the Device's `expected_interval_s × 2` — the same
 * threshold the health sweeper uses, so the UI and the Alarm agree rather than
 * disagreeing by a few seconds and looking broken (§5.2).
 */

import { useEffect, useState } from "react";
import { ageSeconds } from "@/format/datetime";
import { useLiveSocket, type DeviceLiveState } from "./LiveSocket";

/** HEALTH_DEGRADED_MULTIPLIER in `domain/assumptions.py`. Kept in step by hand. */
export const STALE_INTERVAL_MULTIPLIER = 2;

export interface LiveDeviceReading {
  state: DeviceLiveState | null;
  /** Seconds since the last frame for this Device, or null if none has arrived. */
  ageSeconds: number | null;
  isStale: boolean;
  /** No frame has arrived at all — distinct from a frame that has gone stale. */
  isSilent: boolean;
  valueFor: (tagId: number) => number | null;
}

/** Re-renders once a second so ages and staleness advance without a new frame. */
function useTick(intervalMs = 1000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return tick;
}

export function useLiveDevice(
  deviceId: number | null | undefined,
  expectedIntervalS: number | null | undefined,
): LiveDeviceReading {
  const { devices } = useLiveSocket();
  useTick();

  const state = deviceId ? (devices[deviceId] ?? null) : null;
  const age = state ? ageSeconds(state.at) : null;
  const threshold = (expectedIntervalS ?? 60) * STALE_INTERVAL_MULTIPLIER;

  return {
    state,
    ageSeconds: age,
    isStale: age !== null && age > threshold,
    isSilent: state === null,
    valueFor: (tagId: number) => state?.values[tagId] ?? null,
  };
}

/** Every live Device belonging to one Plant — for a Plant-level rollup. */
export function useLivePlant(plantId: number | null | undefined): DeviceLiveState[] {
  const { devices } = useLiveSocket();
  useTick(2000);
  if (!plantId) return [];
  return Object.values(devices).filter((device) => device.plantId === plantId);
}
