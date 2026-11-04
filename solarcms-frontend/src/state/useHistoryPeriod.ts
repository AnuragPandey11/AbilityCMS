/**
 * The history screens' shared period, kept in two places that agree.
 *
 * - **The link** (`?period=30d`, `?from=…&to=…`) wins when it names one, so a
 *   pasted URL opens on the stretch its sender was looking at.
 * - **The selection store** (sessionStorage, per tab) is what a screen opened
 *   from the menu — whose link names none — starts on, so moving from Energy
 *   Analytics to the Transformer keeps March on screen.
 *
 * Every change is written to both. The link is *replaced*, never pushed: Back
 * should leave the screen, not step through every period somebody tried.
 *
 * ⚠ A link that names a period badly (`?from=2026-02-30`) is ignored rather
 * than obeyed or "corrected": the screen shows the remembered period and the
 * link is rewritten to it, so what is on screen and what the URL says agree.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  DEFAULT_PERIOD,
  periodFromParams,
  periodToParams,
  samePeriod,
  type HistoryPeriod,
} from "@/api/historyPeriod";
import { useSelection } from "./selection";

const PERIOD_KEYS = ["period", "from", "to"] as const;

/** A stored value from an older build, or a hand-edited one, is not trusted blindly. */
function validStored(value: unknown): HistoryPeriod {
  if (value && typeof value === "object") {
    const candidate = value as Partial<HistoryPeriod> & Record<string, unknown>;
    if (candidate.kind === "preset" || candidate.kind === "custom") {
      const params = new URLSearchParams(
        candidate.kind === "preset"
          ? { period: String(candidate.preset ?? "") }
          : { from: String(candidate.from ?? ""), to: String(candidate.to ?? "") },
      );
      const parsed = periodFromParams(params);
      if (parsed) return parsed;
    }
  }
  return DEFAULT_PERIOD;
}

export function useHistoryPeriod(): {
  period: HistoryPeriod;
  setPeriod: (period: HistoryPeriod) => void;
} {
  const [params, setParams] = useSearchParams();
  const storedRaw = useSelection((state) => state.historyPeriod);
  const setStored = useSelection((state) => state.setHistoryPeriod);
  const stored = useMemo(() => validStored(storedRaw), [storedRaw]);

  const paramsKey = params.toString();
  const fromLink = useMemo(() => periodFromParams(new URLSearchParams(paramsKey)), [paramsKey]);
  const period = fromLink ?? stored;

  const writeLink = useCallback(
    (next: HistoryPeriod) => {
      setParams(
        (current) => {
          const merged = new URLSearchParams(current);
          for (const key of PERIOD_KEYS) merged.delete(key);
          for (const [key, value] of Object.entries(periodToParams(next))) merged.set(key, value);
          return merged;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // The link named a period: remember it, so the next screen opens on it too.
  useEffect(() => {
    if (fromLink && !samePeriod(fromLink, stored)) setStored(fromLink);
  }, [fromLink, stored, setStored]);

  // The link named none (opened from the menu), or named one badly: say in the
  // link what is on screen.
  useEffect(() => {
    if (fromLink) return;
    writeLink(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLink === null, stored]);

  const setPeriod = useCallback(
    (next: HistoryPeriod) => {
      setStored(next);
      writeLink(next);
    },
    [setStored, writeLink],
  );

  return { period, setPeriod };
}
