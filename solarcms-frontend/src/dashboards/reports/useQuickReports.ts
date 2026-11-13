/**
 * The saved custom reports and the reader's quick reports among them — one
 * query shared by the quick-report row and the builder, and one write for any
 * change to the row (`PUT /reports/custom/pins`).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import * as reportsApi from "@/api/endpoints/reports";
import type { SavedReport } from "@/api/endpoints/reports";
import { QUICK_REPORT_LIMIT, pinnedReports, withPin, withoutPin } from "./quickReportRules";

export interface QuickReports {
  saved: SavedReport[];
  /** The reader's quick reports, in their order. */
  pinned: SavedReport[];
  loaded: boolean;
  failed: boolean;
  full: boolean;
  busy: boolean;
  /** Add `id` to the row, or put it in `replacing`'s place when the row is full. */
  pin: (id: number, replacing?: number) => Promise<void>;
  unpin: (id: number) => Promise<void>;
}

export function useQuickReports(): QuickReports {
  const queryClient = useQueryClient();
  const savedQuery = useQuery({
    queryKey: qk.savedReports(),
    queryFn: reportsApi.listSavedReports,
    staleTime: 60_000,
    retry: false,
  });
  const saved = savedQuery.data ?? [];
  const pinned = pinnedReports(saved);
  const row = pinned.map((report) => report.id);
  const mutation = useMutation({
    mutationFn: reportsApi.setPinnedReports,
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.savedReports() }),
  });

  return {
    saved,
    pinned,
    loaded: savedQuery.isSuccess,
    failed: savedQuery.isError,
    full: row.length >= QUICK_REPORT_LIMIT,
    busy: mutation.isPending,
    pin: async (id, replacing) => {
      await mutation.mutateAsync(withPin(row, id, replacing));
    },
    unpin: async (id) => {
      await mutation.mutateAsync(withoutPin(row, id));
    },
  };
}
