/**
 * Refetch a Plant's server-computed figures the moment its data actually lands.
 *
 * The dashboard slots and the KPI tiles are *not* drawn from the live socket
 * directly, and deliberately so. A slot value is resolved on the server against
 * what this Plant is really bound to, and **provenance travels with it** — 6.32
 * MW read from a settlement meter and 6.32 MW summed from twelve Inverters are
 * different claims, and only the server knows which one it just made. Summing
 * device frames in the browser would produce a number with no provenance at
 * all, and a second implementation of an aggregation rule that already exists.
 *
 * So the socket is used as a **trigger, never as a source**. When a reading for
 * this Plant arrives, the queries are marked stale and React Query refetches;
 * the figure on screen still comes from the server, with its provenance intact.
 *
 * What this removes is the *waiting*. Before, a tile sat on a 5–10 second timer
 * that fired whether or not anything had happened — so a reading that landed
 * just after a tick waited most of an interval to be seen, and a Plant sending
 * nothing at all was polled anyway. Now the refetch follows the data.
 *
 * ⚠ It does not make a tile fresher than the equipment. If the client publishes
 * once a minute, the number is still up to a minute old; this only removes the
 * delay *we* were adding on top.
 */

import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveSocket } from "@/live/LiveSocket";

/**
 * How long to gather frames before refetching once.
 *
 * Frames arrive per Device, so a Plant with twenty Devices produces twenty of
 * them per publishing round — refetching on each would turn one round of data
 * into twenty identical requests. Coalescing them into a single refetch keeps
 * the request count near one per round however many Devices report.
 *
 * One second, not zero: readings from one round do not arrive together (ingest
 * accepts each message as it comes), and a refetch fired on the first would
 * read a half-updated Plant and then need another.
 */
const COALESCE_MS = 1_000;

export function useLiveRefresh(plantId: number | null): void {
  const { devices } = useLiveSocket();
  const queryClient = useQueryClient();
  const pending = useRef<number | null>(null);

  /**
   * The newest frame seen for this Plant, as a number.
   *
   * Derived rather than counted: `devices` is replaced on every frame, so
   * depending on the object itself would fire the effect for another Plant's
   * data too. A timestamp changes only when *this* Plant has actually spoken.
   */
  const latestFrameAt = useMemo(() => {
    if (plantId === null) return 0;
    let newest = 0;
    for (const device of Object.values(devices)) {
      if (device.plantId !== plantId) continue;
      const at = Date.parse(device.at);
      if (Number.isFinite(at) && at > newest) newest = at;
    }
    return newest;
  }, [devices, plantId]);

  useEffect(() => {
    if (plantId === null || latestFrameAt === 0) return;
    // A refetch is already scheduled; this frame joins it rather than adding
    // another. This is the coalescing — without it, twenty Devices reporting
    // in one round would queue twenty refetches.
    if (pending.current !== null) return;

    pending.current = window.setTimeout(() => {
      pending.current = null;
      // `invalidateQueries`, not `refetchQueries`: a screen that is not
      // currently mounted should be marked stale and refetched when it opens,
      // not fetched in the background for nobody.
      void queryClient.invalidateQueries({
        queryKey: ["plants", plantId, "dashboard"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["plants", plantId, "kpis"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["plants", plantId, "operating-status"],
      });
    }, COALESCE_MS);
  }, [latestFrameAt, plantId, queryClient]);

  // Clearing on unmount only, not on every frame: the timer is the coalescing
  // window, and tearing it down whenever a frame arrives would reset it
  // forever under a steady stream and the refetch would never fire.
  useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );
}
