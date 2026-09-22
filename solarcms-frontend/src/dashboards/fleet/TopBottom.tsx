/**
 * The best and worst Plants on one measure, side by side.
 *
 * ── Why this earns its place beside the comparison chart ────────────────────
 * The bar chart answers "how do they compare"; this answers "who do I call".
 * They look like the same information and are not: a ranked bar chart of forty
 * Plants is a wall, and the two ends of it are the only rows anybody acts on.
 * At three Plants the two panels are nearly the same thing, which is honest —
 * this is a screen that gets more useful as an estate grows.
 *
 * ── What it refuses to rank ─────────────────────────────────────────────────
 * A Plant that was never due to report has no figure, only a zero the backend
 * emitted because nothing was asked of it. Ranked, it lands at the bottom of
 * the "worst" column and reads as the Plant most in trouble, when nothing about
 * it has been measured at all. Those are counted and named beneath the lists
 * rather than ranked — that count is itself the actionable item (somebody has
 * a Plant with no Devices bound).
 *
 * ⚠ Ties are left in the order the fleet arrived rather than broken by name.
 * Alphabetical order has no meaning here, and a tie-break that looks like a
 * ranking is the same defect as ordering a diagram by type code.
 */

import { useMemo } from "react";
import type { PlantKpis } from "@/api/schemas";
import type { FleetRow } from "./FleetComparison";
import { formatRatioAsPercent } from "@/format/value";
import { IconChevronRight } from "@/components/icons";

export interface RankMetric {
  key: string;
  label: string;
  /** null where the Plant reported nothing — never a zero stand-in. */
  of: (kpi: PlantKpis) => number | null;
  /** How the value reads. Ratios render as percentages. */
  format: (value: number) => string;
}

export const PR_METRIC: RankMetric = {
  key: "pr",
  label: "Performance Ratio",
  of: (kpi) => kpi.performance_ratio.value,
  format: (value) => formatRatioAsPercent(value),
};

function RankList({
  title,
  tone,
  rows,
  metric,
  onOpenPlant,
}: {
  title: string;
  tone: "ok" | "bad";
  rows: { code: string; name: string; id: number; value: number }[];
  metric: RankMetric;
  onOpenPlant: (plantId: number) => void;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div
        className={`mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${
          tone === "ok" ? "text-ok" : "text-bad"
        }`}
      >
        <span aria-hidden>{tone === "ok" ? "▲" : "▼"}</span>
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-ink-faint">
          No Plant reported {metric.label} for this period.
        </p>
      ) : (
        <ol className="space-y-0.5">
          {rows.map((row, index) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => onOpenPlant(row.id)}
                className="flex w-full items-center gap-2 rounded px-1 py-1 text-left text-[11px] transition hover:bg-surface-sunken"
                title={row.name}
              >
                <span className="w-3 shrink-0 text-right tabular-nums text-ink-faint">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-ink">{row.code}</span>
                <span className="shrink-0 font-mono tabular-nums text-ink-muted">
                  {metric.format(row.value)}
                </span>
                <IconChevronRight size={12} className="shrink-0 text-ink-faint" />
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function TopBottomPerformers({
  rows,
  metric = PR_METRIC,
  count = 5,
  onOpenPlant,
}: {
  rows: FleetRow[];
  metric?: RankMetric;
  count?: number;
  onOpenPlant: (plantId: number) => void;
}): JSX.Element {
  const { top, bottom, unranked } = useMemo(() => {
    const ranked: { code: string; name: string; id: number; value: number }[] = [];
    let skipped = 0;
    for (const row of rows) {
      const value = row.instrumented && row.kpi ? metric.of(row.kpi) : null;
      if (value === null) {
        skipped += 1;
        continue;
      }
      ranked.push({ id: row.plant.id, code: row.plant.code, name: row.plant.name, value });
    }
    // `sort` is stable in every engine this runs on, so equal values keep the
    // order the fleet arrived in rather than acquiring a meaningless one.
    const ascending = [...ranked].sort((a, b) => a.value - b.value);
    return {
      top: [...ascending].reverse().slice(0, count),
      bottom: ascending.slice(0, count),
      unranked: skipped,
    };
  }, [rows, metric, count]);

  // With fewer Plants than both lists hold, the same rows appear twice in
  // reverse — which reads as a bug. One list, ranked best first, is the honest
  // rendering of a small estate.
  const overlapping = top.length + bottom.length > new Set([...top, ...bottom].map((r) => r.id)).size;

  return (
    <div>
      {overlapping ? (
        <RankList
          title={`Ranked by ${metric.label}`}
          tone="ok"
          rows={top}
          metric={metric}
          onOpenPlant={onOpenPlant}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <RankList title="Top performing" tone="ok" rows={top} metric={metric} onOpenPlant={onOpenPlant} />
          <RankList title="Lowest performing" tone="bad" rows={bottom} metric={metric} onOpenPlant={onOpenPlant} />
        </div>
      )}

      {unranked > 0 ? (
        <p className="mt-2 border-t border-line-soft pt-1.5 text-[10px] leading-snug text-ink-faint">
          {unranked} Plant{unranked === 1 ? "" : "s"} could not be ranked — no{" "}
          {metric.label} was reported, either because nothing is bound or because the figure
          is undefined for this period. {unranked === 1 ? "It is" : "They are"} left out
          rather than placed last: a Plant nobody measured is not a Plant performing badly.
        </p>
      ) : null}
    </div>
  );
}
