/**
 * Running a fix from the Data Issues screen.
 *
 * Every fix goes through the route that already owns the change, so this only
 * adds what a list of fixes needs on top: which rows are busy, the error that
 * belongs to each row (in the server's own sentence), and one refresh of
 * everything a fix can change once it has landed.
 */

import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isApiError } from "@/api/problem";
import { qk } from "@/api/queryKeys";

export interface IssueActions {
  busy: Record<string, boolean>;
  errors: Record<string, string>;
  /** The last thing that succeeded, said in a sentence. */
  done: string | null;
  /**
   * Run `work` for the rows named by `keys`. Runs one at a time when given
   * several, so a bulk fix stops at nothing and reports per row.
   */
  run: (keys: string[], work: (key: string) => Promise<void>, doneMessage: string) => Promise<void>;
  clearDone: () => void;
}

export function useIssueActions(plantId: number | null): IssueActions {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const tasks = [
      queryClient.invalidateQueries({ queryKey: ["devices"] }),
      queryClient.invalidateQueries({ queryKey: ["discovery"] }),
      queryClient.invalidateQueries({ queryKey: qk.tags() }),
    ];
    // Everything under the Plant: its Devices, its dashboard and its issues.
    if (plantId !== null) {
      tasks.push(queryClient.invalidateQueries({ queryKey: qk.plant(plantId) }));
    }
    await Promise.all(tasks);
    // The badge last: the server caches each Plant's counts, and re-reading
    // the Plant's issues above is what refreshes that cache — read before it,
    // the badge would show the count from before the fix.
    await queryClient.invalidateQueries({ queryKey: qk.dataIssuesSummary() });
  }, [queryClient, plantId]);

  const run = useCallback<IssueActions["run"]>(
    async (keys, work, doneMessage) => {
      setDone(null);
      setBusy((current) => ({ ...current, ...Object.fromEntries(keys.map((k) => [k, true])) }));
      setErrors((current) => {
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      });
      let failed = 0;
      for (const key of keys) {
        try {
          await work(key);
        } catch (error) {
          failed += 1;
          const message = isApiError(error)
            ? error.displayMessage
            : error instanceof Error
              ? error.message
              : "That did not work.";
          setErrors((current) => ({ ...current, [key]: message }));
        }
      }
      setBusy((current) => {
        const next = { ...current };
        for (const key of keys) delete next[key];
        return next;
      });
      if (failed < keys.length) {
        setDone(
          failed === 0
            ? doneMessage
            : `${doneMessage} ${failed} of ${keys.length} could not be done — see the rows marked in red.`,
        );
      }
      await refresh();
    },
    [refresh],
  );

  return { busy, errors, done, run, clearDone: () => setDone(null) };
}
