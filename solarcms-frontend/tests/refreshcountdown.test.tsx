/**
 * The header's refresh countdown follows the page's own dashboard query —
 * its interval, its last fetch — and shows nothing where no screen is showing
 * a Plant's live figures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { qk } from "@/api/queryKeys";
import { useSelection } from "@/state/selection";
import { RefreshCountdown } from "@/live/RefreshCountdown";

function Page({ plantId, interval }: { plantId: number; interval: number }): null {
  useQuery({
    queryKey: qk.plantDashboard(plantId),
    queryFn: async () => ({ computed_at: null }),
    refetchInterval: interval,
  });
  return null;
}

function setup(withPage: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      {withPage ? <Page plantId={7} interval={15_000} /> : null}
      <RefreshCountdown />
    </QueryClientProvider>,
  );
}

describe("RefreshCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useSelection.getState().setPlantId(7);
  });
  afterEach(() => {
    vi.useRealTimers();
    useSelection.getState().setPlantId(null);
  });

  it("counts down the interval the page's query is really on", async () => {
    setup(true);
    expect(await screen.findByText("15 s")).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.getByText("10 s")).toBeInTheDocument();
    // The socket is closed in a test, so it is a fixed poll, not a "by".
    expect(screen.getByText(/Refresh in/)).toBeInTheDocument();
  });

  it("shows nothing where no screen shows the Plant's live figures", () => {
    setup(false);
    expect(screen.queryByText(/Refresh/)).not.toBeInTheDocument();
  });
});
