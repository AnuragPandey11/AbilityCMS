/**
 * "Next refresh in 12 s" — when the Plant's figures on screen will next be
 * asked for, as a ring that empties (the user's request, 1 Nov 2026).
 *
 * It follows the query that actually carries the live figures — the Plant's
 * dashboard (`usePlantDashboard`) — read from the cache, never by observing it:
 * an observer of its own would run a second refresh timer beside the page's.
 * So it shows only while a screen is showing that Plant's figures, and the
 * interval it counts is the one that query is really on:
 *
 * - **Socket open:** a backstop of 30 s, and sooner whenever the Plant's
 *   equipment sends readings (`useLiveRefresh`, at most every 15 s). The count
 *   is then a "by", never a promise of nothing sooner — and it restarts each
 *   time a reading brings the refresh forward.
 * - **Socket closed:** every 15 s, and that is the only thing keeping it current.
 *
 * ⚠ It cannot make a figure fresher than the equipment: the server works the
 * dashboard out every 15 s from what the Devices last sent, and PR/CUF once a
 * minute. The tooltip says so, with when the copy on screen was worked out.
 */

import { useEffect, useState } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import { useSelection } from "@/state/selection";
import { useLiveSocket } from "./LiveSocket";
import { formatTime } from "@/format/datetime";

const R = 6.5;
const CIRCUMFERENCE = 2 * Math.PI * R;

interface Snapshot {
  updatedAt: number;
  intervalMs: number | null;
  fetching: boolean;
  computedAt: string | null;
}

function read(query: Query | undefined): Snapshot | null {
  if (!query || query.getObserversCount() === 0) return null;
  const interval = query.observers
    .map((observer) => observer.options.refetchInterval)
    .find((value): value is number => typeof value === "number" && value > 0);
  const data = query.state.data as { computed_at?: string | null } | undefined;
  return {
    updatedAt: query.state.dataUpdatedAt,
    intervalMs: interval ?? null,
    fetching: query.state.fetchStatus === "fetching",
    computedAt: data?.computed_at ?? null,
  };
}

export function RefreshCountdown(): JSX.Element | null {
  const plantId = useSelection((state) => state.plantId);
  const queryClient = useQueryClient();
  const { status } = useLiveSocket();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (plantId === null) {
      setSnapshot(null);
      return;
    }
    const cache = queryClient.getQueryCache();
    const key = qk.plantDashboard(plantId);
    const update = () => setSnapshot(read(cache.find({ queryKey: key, exact: true })));
    update();
    return cache.subscribe((event) => {
      if (event.query.queryHash === cache.find({ queryKey: key, exact: true })?.queryHash) update();
    });
  }, [plantId, queryClient]);

  // One tick a second, and only while there is something to count.
  useEffect(() => {
    if (!snapshot?.intervalMs || !snapshot.updatedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [snapshot?.intervalMs, snapshot?.updatedAt]);

  if (!snapshot?.intervalMs || !snapshot.updatedAt) return null;

  const remainingMs = Math.max(0, snapshot.updatedAt + snapshot.intervalMs - now);
  const seconds = Math.ceil(remainingMs / 1000);
  const busy = snapshot.fetching || seconds === 0;
  const fraction = busy ? 0 : remainingMs / snapshot.intervalMs;
  const live = status === "open";
  const age = Math.max(0, Math.round((now - snapshot.updatedAt) / 1000));

  const title = [
    `Fetched ${age} s ago${snapshot.computedAt ? `; worked out by the server at ${formatTime(snapshot.computedAt)}` : ""}.`,
    live
      ? `Refreshed again within ${snapshot.intervalMs / 1000} s — sooner, as soon as this Plant's equipment sends new readings.`
      : `The live connection is down, so the figures are asked for every ${snapshot.intervalMs / 1000} s.`,
    "The server works the figures out every 15 s from what the equipment last sent (PR and CUF once a minute), so a figure is never fresher than the equipment's own reporting.",
  ].join(" ");

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-1 text-xs text-ink-muted"
      title={title}
      aria-live="off"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className={busy ? "animate-spin" : undefined}>
        <circle cx="8" cy="8" r={R} fill="none" className="stroke-line" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={R}
          fill="none"
          className="stroke-accent"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={busy ? `${CIRCUMFERENCE * 0.3} ${CIRCUMFERENCE}` : `${CIRCUMFERENCE}`}
          strokeDashoffset={busy ? 0 : CIRCUMFERENCE * (1 - fraction)}
          transform="rotate(-90 8 8)"
          style={{ transition: busy ? undefined : "stroke-dashoffset 1s linear" }}
        />
      </svg>
      {busy ? (
        <span>Refreshing…</span>
      ) : (
        <span>
          {live ? "Refresh by " : "Refresh in "}
          <span className="figure inline-block min-w-[2.2em] text-right font-semibold tabular-nums text-ink">
            {seconds} s
          </span>
        </span>
      )}
    </span>
  );
}
