/**
 * Summary columns for a Device Type, including the types the catalogue has not
 * curated.
 *
 * ── Why a fallback exists at all ────────────────────────────────────────────
 * `device_table_columns` is the right source for which figures represent a
 * Device Type at a glance — it is configuration, so a Client who wants winding
 * temperature on their Transformer cards changes a row rather than a release.
 * But it is only populated for the types somebody has curated. On this Plant
 * that is six of nine, and the three without rows — the breaker, the plant
 * controller, the synthetic KPI panel — were silently dropped from every
 * summary view. Not shown with no figures: **absent**, with no way to reach
 * them from the Plant screen at all.
 *
 * Dropping them is the wrong failure. A curated list is an improvement over
 * "whatever this Device publishes", not a precondition for showing it, so an
 * uncurated type falls back to its own bindings.
 *
 * ── Why the fallback is derived from one Device, not the Type ───────────────
 * There is no "what does this Type publish" endpoint, and there should not be:
 * a Model's signal schedule is a *starting point* for a Device's bindings, not
 * their authority — string counts, disabled rows and hand corrections all move
 * a unit away from its Model. One Device's real bindings are a true statement
 * about at least that Device, where the Model's schedule might be true of none
 * of them.
 *
 * ⚠ The consequence to know: on a Plant whose Devices of one Type are bound
 * differently, the cards show the first Device's signals and the others may
 * have gaps. That is visible ("—", never zero) and is the honest rendering —
 * the alternative is a union across every Device, which would show every card
 * mostly empty.
 */

import { useMemo } from "react";
import { useBindings, useDeviceTableColumns, useTags } from "./hooks";
import type { DeviceListItem, DeviceTableColumn, TagCategory } from "./schemas";

/** Which categories matter most on a card, most first. */
const CATEGORY_RANK: Record<string, number> = {
  performance: 0,
  electrical: 1,
  environmental: 2,
  status: 3,
  diagnostic: 4,
};

export interface TypeColumns {
  columns: DeviceTableColumn[];
  /** True when these came from a Device's bindings rather than the catalogue. */
  isFallback: boolean;
  isLoading: boolean;
}

export function useTypeColumns(
  typeCode: string | null,
  /** Any Device of that Type — its bindings stand in for the Type's. */
  sampleDevice: DeviceListItem | null,
): TypeColumns {
  const curatedQuery = useDeviceTableColumns();
  const tagsQuery = useTags();

  const curated = typeCode ? (curatedQuery.data?.[typeCode] ?? []) : [];
  const needsFallback = typeCode !== null && curated.length === 0;

  // Only fetched when the catalogue has nothing — a curated type costs no
  // extra request.
  const bindingsQuery = useBindings(
    needsFallback ? (sampleDevice?.id ?? null) : null,
    needsFallback && sampleDevice !== null,
  );

  const fallback = useMemo<DeviceTableColumn[]>(() => {
    if (!needsFallback) return [];
    const bindings = bindingsQuery.data ?? [];
    const tags = tagsQuery.data ?? [];
    const byId = new Map(tags.map((tag) => [tag.id, tag]));
    return bindings
      .filter((binding) => binding.enabled)
      .map((binding) => {
        const tag = byId.get(binding.tag_id);
        return {
          tag_id: binding.tag_id,
          tag_code: binding.tag_code,
          name: tag?.name ?? binding.tag_code,
          unit: binding.unit,
          category: (tag?.category ?? "diagnostic") as TagCategory,
          position: 0,
        };
      })
      .sort((a, b) => {
        const rank = (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9);
        return rank !== 0 ? rank : a.tag_code.localeCompare(b.tag_code);
      })
      // A card shows a handful; the inspector shows all of them. Cutting here
      // rather than in the card keeps "how many figures exist" honest for any
      // caller that counts them.
      .slice(0, 8);
  }, [needsFallback, bindingsQuery.data, tagsQuery.data]);

  return {
    columns: needsFallback ? fallback : curated,
    isFallback: needsFallback,
    isLoading: curatedQuery.isLoading || (needsFallback && bindingsQuery.isLoading),
  };
}
