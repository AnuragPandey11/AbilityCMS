/**
 * The little client state that is not server state (§1).
 *
 * Only the current selection lives here — which Plant is being viewed, which
 * period. Everything with a freshness requirement is server state and belongs to
 * React Query; duplicating it into a store adds a copy to keep in sync.
 *
 * ⚠ Persisted to sessionStorage, which is per-tab. It holds a Plant **id**, so
 * `useResolvedPlantId` validates it against the Plants the current token can see
 * before it is used — a stale id from before a Client switch must never be
 * requested.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { KpiPeriod } from "@/api/schemas";

interface SelectionState {
  plantId: number | null;
  period: KpiPeriod;
  setPlantId: (plantId: number | null) => void;
  setPeriod: (period: KpiPeriod) => void;
  reset: () => void;
}

export const useSelection = create<SelectionState>()(
  persist(
    (set) => ({
      plantId: null,
      period: "today",
      setPlantId: (plantId) => set({ plantId }),
      setPeriod: (period) => set({ period }),
      reset: () => set({ plantId: null, period: "today" }),
    }),
    {
      name: "solarcms.selection",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
