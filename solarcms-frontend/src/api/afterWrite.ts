/**
 * What is re-read after a write, wherever in the application it was made.
 *
 * Every write used to refresh only what its own button's author thought of —
 * the list the button sat in — and much of the application is cached for a
 * minute (`/plants`, Devices, the diagram) or for the whole session (the Tag
 * catalogue, and `/auth/me`, which is where the Plant picker, the menu and the
 * Client's name come from). So a renamed Device kept its old name on the
 * diagram, a Plant brought into service still read "commissioning" in the
 * picker, and a Plant made in the onboarding wizard could not be chosen — each
 * until the page was reloaded, which is the only thing that empties the cache.
 *
 * Rather than a list of keys per write, which every new button must remember
 * and none did, a write refreshes **everything**, with two exceptions:
 *
 * - **What was recorded** — `readings`, and the report tables computed from
 *   them. No setting changes a measurement already stored, these are the
 *   heaviest requests the application makes, and they are re-asked when their
 *   own inputs change.
 * - **The catalogue**, unless the write was to `/catalog`. It is cached for the
 *   session because it changes monthly, and only a catalogue write changes it.
 *
 * Invalidation re-fetches only what is on screen; everything else is marked
 * stale and re-fetched when next shown. Nothing is cleared, so no figure goes
 * blank while its replacement loads.
 */

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useEffect } from "react";
import { setWriteHandler } from "./client";

/**
 * How long after the last write the refresh waits. Several flows write in
 * sequence — every Inverter's size and then the tariff, a Device and then its
 * topics and bindings — and one refresh after the last is the one that shows
 * the result; one per write would ask for the same screen a dozen times.
 */
export const WRITE_SETTLE_MS = 200;

/**
 * How far behind somebody else's edit a screen may be. Nothing tells this tab
 * about a change made in another, so configuration (`hooks.CONFIGURATION`) and
 * the identity are re-asked this often while shown, and on coming back to it.
 */
export const CONFIGURATION_REFRESH_MS = 60_000;

function isRecorded(key: QueryKey): boolean {
  const [family, kind, sub] = key;
  if (family === "readings") return true;
  if (family !== "reports") return false;
  return kind === "tables" || (kind === "custom" && sub === "table");
}

/** Whether a write to these paths makes this query out of date. */
export function staleAfterWrite(key: QueryKey, paths: readonly string[]): boolean {
  if (isRecorded(key)) return false;
  if (key[0] === "catalog") return paths.some((path) => path.startsWith("/catalog"));
  return true;
}

export function invalidateAfterWrite(
  queryClient: QueryClient,
  paths: readonly string[],
): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => staleAfterWrite(query.queryKey, paths),
  });
}

/**
 * Refresh the cache and the identity after writes. Mounted once, by
 * `AuthProvider`, which holds the identity.
 */
export function useRefreshAfterWrites(
  queryClient: QueryClient,
  rereadIdentity: () => Promise<void>,
): void {
  useEffect(() => {
    const paths = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setWriteHandler((path) => {
      paths.add(path);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const written = [...paths];
        paths.clear();
        void invalidateAfterWrite(queryClient, written);
        void rereadIdentity();
      }, WRITE_SETTLE_MS);
    });
    return () => {
      clearTimeout(timer);
      setWriteHandler(() => {});
    };
  }, [queryClient, rereadIdentity]);
}
