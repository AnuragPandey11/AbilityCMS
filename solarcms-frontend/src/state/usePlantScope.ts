/**
 * Resolve the selected Plant against what this token can actually see.
 *
 * A persisted Plant id can outlive the Client it belonged to. Requesting it
 * after a switch returns 404 at best — and the point of Guardrail 10 is that
 * nothing from the previous Client survives the switch, including a selection.
 * So the id is only honoured when it appears in `/auth/me` → `plants[]` (A-2).
 *
 * `useFilteredPlantScope` is the same, except that a platform administrator's Client filter and search
 * (`usePlantFilter`) narrow the Plants offered, and a selection outside the
 * narrowing moves to its first match — picking a Client must not leave another
 * Client's Plant on screen under it. When nothing matches, the selection stays
 * put and remains the one option offered: the picker must always be able to
 * name what the page is showing.
 */

import { useEffect } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { useSelection } from "./selection";
import { usePlantFilter } from "./usePlantFilter";
import type { MePlant } from "@/api/schemas";

export interface PlantScope {
  /** Visible Plants, straight from the token's `/auth/me` — narrowed when filtered. */
  plants: MePlant[];
  /** A Plant id that is certainly visible, or null when none is. */
  plantId: number | null;
  plant: MePlant | null;
  setPlantId: (plantId: number | null) => void;
  /** Zero assignments means zero Plants, never full access (I-5). */
  hasNoPlants: boolean;
}

export function usePlantScope(): PlantScope {
  return useScopeWithin(null);
}

export function useFilteredPlantScope(): PlantScope {
  const filter = usePlantFilter();
  return useScopeWithin(filter.active ? filter.matches : null);
}

/** `narrowed` is the filtered Plants, or null for every visible one. */
function useScopeWithin(narrowed: MePlant[] | null): PlantScope {
  const { me } = useAuth();
  const { plantId, setPlantId } = useSelection();
  const visible = me?.plants ?? [];
  const pool = narrowed ?? visible;

  const isVisible = plantId !== null && visible.some((plant) => plant.id === plantId);
  const inPool = plantId !== null && pool.some((plant) => plant.id === plantId);
  const resolved = inPool
    ? plantId
    : (pool[0]?.id ?? (isVisible ? plantId : (visible[0]?.id ?? null)));
  const current = visible.find((plant) => plant.id === resolved) ?? null;
  const plants =
    current && !pool.some((plant) => plant.id === current.id) ? [current, ...pool] : pool;

  useEffect(() => {
    // Write the correction back so the rest of the session agrees with what is
    // being displayed, rather than silently diverging from the store.
    if (resolved !== plantId) setPlantId(resolved);
  }, [resolved, plantId, setPlantId]);

  return {
    plants,
    plantId: resolved,
    plant: current,
    setPlantId,
    hasNoPlants: visible.length === 0,
  };
}
