/**
 * Resolve the selected Plant against what this token can actually see.
 *
 * A persisted Plant id can outlive the Client it belonged to. Requesting it
 * after a switch returns 404 at best — and the point of Guardrail 10 is that
 * nothing from the previous Client survives the switch, including a selection.
 * So the id is only honoured when it appears in `/auth/me` → `plants[]` (A-2).
 */

import { useEffect } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { useSelection } from "./selection";
import type { MePlant } from "@/api/schemas";

export interface PlantScope {
  /** Visible Plants, straight from the token's `/auth/me`. */
  plants: MePlant[];
  /** A Plant id that is certainly visible, or null when none is. */
  plantId: number | null;
  plant: MePlant | null;
  setPlantId: (plantId: number | null) => void;
  /** Zero assignments means zero Plants, never full access (I-5). */
  hasNoPlants: boolean;
}

export function usePlantScope(): PlantScope {
  const { me } = useAuth();
  const { plantId, setPlantId } = useSelection();
  const plants = me?.plants ?? [];

  const isVisible = plantId !== null && plants.some((plant) => plant.id === plantId);
  const resolved = isVisible ? plantId : (plants[0]?.id ?? null);

  useEffect(() => {
    // Write the correction back so the rest of the session agrees with what is
    // being displayed, rather than silently diverging from the store.
    if (resolved !== plantId) setPlantId(resolved);
  }, [resolved, plantId, setPlantId]);

  return {
    plants,
    plantId: resolved,
    plant: plants.find((plant) => plant.id === resolved) ?? null,
    setPlantId,
    hasNoPlants: plants.length === 0,
  };
}
