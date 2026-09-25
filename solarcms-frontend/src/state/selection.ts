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
 *
 * `clientId` and `plantSearch` narrow which Plants the pickers offer, for a
 * platform administrator only (see `usePlantFilter`). They live here rather than
 * in the filter bar so the page's own Plant picker, mounted separately, reads the
 * same narrowing — and so moving between the Plant screens keeps it, as it keeps
 * the Plant. `plantSearch` is written already debounced.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { KpiPeriod } from "@/api/schemas";
import type { TrendRange } from "@/api/useSlotTrend";

interface SelectionState {
  plantId: number | null;
  period: KpiPeriod;
  clientId: number | null;
  plantSearch: string;
  /**
   * The Power trend panel's window. Kept here beside `period` so the time
   * controls survive leaving the screen alike — `period` was remembered and
   * this was not, so returning to a Plant restored one and silently reset the
   * other.
   */
  trendRange: TrendRange;
  /**
   * The Weather panel's window, independent of the Power trend's: each chart
   * panel carries its own control, and a control that also moved another
   * panel's chart would be the ambiguity that moving it into the panel removed.
   */
  weatherRange: TrendRange;
  setPlantId: (plantId: number | null) => void;
  setPeriod: (period: KpiPeriod) => void;
  setClientId: (clientId: number | null) => void;
  setPlantSearch: (plantSearch: string) => void;
  setTrendRange: (trendRange: TrendRange) => void;
  setWeatherRange: (weatherRange: TrendRange) => void;
  reset: () => void;
}

export const useSelection = create<SelectionState>()(
  persist(
    (set) => ({
      plantId: null,
      period: "today",
      clientId: null,
      plantSearch: "",
      trendRange: "today",
      weatherRange: "today",
      setPlantId: (plantId) => set({ plantId }),
      setPeriod: (period) => set({ period }),
      setClientId: (clientId) => set({ clientId }),
      setPlantSearch: (plantSearch) => set({ plantSearch }),
      setTrendRange: (trendRange) => set({ trendRange }),
      setWeatherRange: (weatherRange) => set({ weatherRange }),
      reset: () =>
        set({
          plantId: null,
          period: "today",
          clientId: null,
          plantSearch: "",
          trendRange: "today",
          weatherRange: "today",
        }),
    }),
    {
      name: "solarcms.selection",
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);
