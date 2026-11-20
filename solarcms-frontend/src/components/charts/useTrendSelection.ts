/**
 * Which readings are ticked on a `LanedTrendChart`, held by the screen rather
 * than the chart — the screen has to know, because it fetches **only the
 * ticked Tags**. `tierWithin` spends one point budget across every Tag asked
 * for, so requesting a whole station's or a Transformer's Tags to draw two of
 * them would quietly push Today from one-minute to fifteen-minute buckets.
 *
 * Until the reader touches the menu the screen's defaults apply (what each
 * screen drew before there was a menu); see `effectiveSelection`.
 */

import { useState } from "react";
import { effectiveSelection, type LaneInput } from "./trendLanes";

export function useTrendSelection(
  options: readonly Pick<LaneInput, "key" | "unavailableReason">[],
  defaults: readonly string[],
): { selected: Set<string>; setSelected: (next: Set<string>) => void } {
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  return { selected: effectiveSelection(options, chosen, defaults), setSelected: setChosen };
}
