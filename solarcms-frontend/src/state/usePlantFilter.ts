/**
 * A platform administrator's narrowing of the Plant pickers: by Client, and by
 * a search over Plant and Client names and codes.
 *
 * Only a platform administrator sees several Clients' Plants at once, so only
 * they get it — a Client Admin's Client filter would have one entry.
 *
 * The Plants are still `/auth/me` → `plants[]` (A-2); `GET /plants` is read
 * only for which Client each belongs to, because the token's list does not
 * carry it. Until that has loaded the filter is inactive rather than guessing,
 * so a persisted Client narrows nothing instead of narrowing to nothing.
 */

import { useMemo } from "react";
import { useAuth } from "@/auth/AuthProvider";
import { useAllPlants } from "@/api/hooks";
import type { MePlant } from "@/api/schemas";
import { rankMatches } from "./searchMatch";
import { useSelection } from "./selection";

export interface ClientOption {
  id: number;
  code: string | null;
  name: string | null;
  /** Name, else code, else the id — a Client row can be unreadable (see `PlantListItem`). */
  label: string;
  plantCount: number;
}

export interface PlantFilter {
  /** A platform administrator, with every Plant's Client known. */
  enabled: boolean;
  clients: ClientOption[];
  /** Validated against `clients`: a persisted id for a Client no longer visible is null. */
  clientId: number | null;
  /** Already debounced — the bar writes it only once typing pauses. */
  search: string;
  /** Anything narrowing at all. When false, `matches` is every Plant. */
  active: boolean;
  matches: MePlant[];
  clientOf: (plantId: number | null | undefined) => ClientOption | undefined;
}

/**
 * Plants passing both the Client filter and the search, best match first.
 *
 * Every whitespace-separated word must match the Plant's code or name or its
 * Client's code or name — so "roofco wh" finds WH1 and WH2 of ROOFCO and
 * nothing of SUNFIELD. Matching forgives separators and, when nothing matches
 * as typed, a slip (`searchMatch`). With no search, order is preserved.
 */
export function matchPlants(
  plants: MePlant[],
  clientOf: (plantId: number) => ClientOption | undefined,
  clientId: number | null,
  search: string,
): MePlant[] {
  const inClient =
    clientId === null ? plants : plants.filter((plant) => clientOf(plant.id)?.id === clientId);
  return rankMatches(
    inClient,
    (plant) => {
      const client = clientOf(plant.id);
      return [
        { text: plant.code },
        { text: plant.name },
        { text: client?.code, secondary: true },
        { text: client?.name, secondary: true },
      ];
    },
    search,
  );
}

export function usePlantFilter(): PlantFilter {
  const { me } = useAuth();
  const isPlatformAdmin = me?.platform_admin ?? false;
  const { clientId: storedClientId, plantSearch } = useSelection();
  const plantsQuery = useAllPlants(isPlatformAdmin);

  return useMemo(() => {
    const plants = me?.plants ?? [];
    const byPlant = new Map<number, ClientOption>();
    const clients = new Map<number, ClientOption>();
    for (const item of plantsQuery.data ?? []) {
      let client = clients.get(item.client_id);
      if (!client) {
        client = {
          id: item.client_id,
          code: item.client_code,
          name: item.client_name,
          label: item.client_name ?? item.client_code ?? `Client #${item.client_id}`,
          plantCount: 0,
        };
        clients.set(item.client_id, client);
      }
      client.plantCount += 1;
      byPlant.set(item.id, client);
    }
    const clientOf = (plantId: number | null | undefined) =>
      plantId == null ? undefined : byPlant.get(plantId);

    const enabled = isPlatformAdmin && plantsQuery.isSuccess;
    const clientId = enabled && storedClientId !== null && clients.has(storedClientId)
      ? storedClientId
      : null;
    const search = enabled ? plantSearch.trim() : "";
    const active = clientId !== null || search !== "";

    return {
      enabled,
      clients: [...clients.values()].sort((a, b) => a.label.localeCompare(b.label)),
      clientId,
      search,
      active,
      matches: active ? matchPlants(plants, clientOf, clientId, search) : plants,
      clientOf,
    };
  }, [me?.plants, isPlatformAdmin, plantsQuery.data, plantsQuery.isSuccess, storedClientId, plantSearch]);
}
