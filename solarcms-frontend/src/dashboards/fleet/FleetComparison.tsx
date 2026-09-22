/**
 * Comparing Plants against each other — the question a multi-Plant owner has
 * that a single-Plant one does not.
 *
 * A Client Admin with one Plant wants to know how that Plant is doing. With
 * five, the first question is *which of the five needs me*, and no amount of
 * per-Plant detail answers it: it is a ranking question, and it needs the
 * Plants on one axis together.
 *
 * ── Every figure here is one a Plant already reported ───────────────────────
 * Nothing on this screen is computed from a formula that does not already
 * exist server-side. The metrics are exactly the ones `/plants/{id}/kpis`
 * returns — energy, PR, CUF, availability — plus nameplate capacity from the
 * Plant record. There is no "expected energy", no benchmark, no loss
 * breakdown: those need inputs this platform does not have, and inventing them
 * would put a number on screen that no one could defend.
 *
 * ── Plants that were never due to report are shown, and never ranked ────────
 * A Plant with no Devices answers `availability: 0.0` — a real number. Ranked,
 * it sits at the bottom looking like the worst performer in the fleet, when in
 * fact nothing about it has been measured. It stays visible (hiding a Plant
 * from its owner's fleet view is worse) and is drawn as "not instrumented"
 * rather than as a zero.
 */

import { useMemo, useState } from "react";
import type { KpiPeriod, PlantKpis, PlantListItem } from "@/api/schemas";
import { ComparisonBars, type ComparisonRow } from "@/components/charts/ComparisonBars";
import { SharePie } from "@/components/charts/SharePie";
import { Panel, SegmentedControl } from "@/components/ui";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { CoverageBadge } from "@/components/dashboard/CoverageBadge";
import { PlantStatusBadge } from "@/components/domain";
import {
  UNDEFINED_DISPLAY,
  formatCapacity,
  formatNumber,
  formatRatioAsPercent,
} from "@/format/value";
import { couldAnswer } from "./aggregate";

/**
 * What the Plants can be compared on.
 *
 * `ratio` figures render as percentages and share a 0..100 axis; `quantity`
 * ones carry their own unit. Kept as data so the chart, the table and the
 * picker cannot disagree about what a column means.
 */
const METRICS = [
  {
    key: "energy",
    label: "Energy",
    unit: "kWh",
    kind: "quantity" as const,
    of: (kpi: PlantKpis) => kpi.energy_kwh,
    hint: "Generation over the selected period, from hourly aggregates.",
  },
  {
    key: "pr",
    label: "PR",
    unit: "%",
    kind: "ratio" as const,
    of: (kpi: PlantKpis) => kpi.performance_ratio.value,
    hint: "Performance Ratio. Provisional pending the client's own definition (OPEN-16).",
  },
  {
    key: "cuf",
    label: "CUF",
    unit: "%",
    kind: "ratio" as const,
    of: (kpi: PlantKpis) => kpi.cuf.value,
    hint: "Capacity Utilisation Factor. Undefined where AC capacity is not recorded.",
  },
  {
    key: "availability",
    label: "Availability",
    unit: "%",
    kind: "ratio" as const,
    of: (kpi: PlantKpis) => kpi.availability.value,
    hint: "Derived from Device communication status, not from generation.",
  },
] as const;

type MetricKey = (typeof METRICS)[number]["key"];

export interface FleetRow {
  plant: PlantListItem;
  kpi: PlantKpis | undefined;
  /** False where nothing was expected — no Devices bound, or not yet live. */
  instrumented: boolean;
}

export function buildFleetRows(
  plants: PlantListItem[],
  kpis: (PlantKpis | undefined)[],
): FleetRow[] {
  return plants.map((plant, index) => ({
    plant,
    kpi: kpis[index],
    instrumented: couldAnswer(kpis[index]?.coverage),
  }));
}

export function FleetComparison({
  rows,
  period,
  onOpenPlant,
  isLoading,
}: {
  rows: FleetRow[];
  period: KpiPeriod;
  onOpenPlant: (plantId: number) => void;
  isLoading?: boolean;
}): JSX.Element {
  const [metricKey, setMetricKey] = useState<MetricKey>("energy");
  const metric = METRICS.find((entry) => entry.key === metricKey) ?? METRICS[0];

  /** One bar per Plant on the chosen measure. */
  const bars = useMemo<ComparisonRow[]>(
    () =>
      rows.map(({ plant, kpi, instrumented }) => {
        const raw = kpi ? metric.of(kpi) : null;
        // A Plant that was never due to report has no value — not a zero.
        const value = !instrumented || raw === null ? null : metric.kind === "ratio" ? raw * 100 : raw;
        return {
          id: plant.id,
          label: plant.code,
          value,
          attention: !instrumented,
          attentionReason: !instrumented
            ? "No Devices are bound, so nothing was expected of this Plant. It is shown but not ranked."
            : undefined,
        };
      }),
    [rows, metric],
  );

  /** Energy share is always energy — a share of a *ratio* is meaningless. */
  const shareSlices = useMemo(
    () =>
      rows
        .filter((row) => row.instrumented)
        .map((row) => ({
          id: row.plant.id,
          label: row.plant.code,
          value: row.kpi?.energy_kwh ?? 0,
        })),
    [rows],
  );

  const columns: Column<FleetRow>[] = [
    {
      key: "plant",
      header: "Plant",
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-ink">{row.plant.code}</span>
          <span className="truncate text-ink-muted">{row.plant.name}</span>
        </span>
      ),
      sortValue: (row) => row.plant.code,
      filterValue: (row) => `${row.plant.code} ${row.plant.name}`,
    },
    {
      key: "status",
      header: "Status",
      width: "110px",
      render: (row) => <PlantStatusBadge status={row.plant.status} />,
      sortValue: (row) => row.plant.status,
    },
    {
      key: "capacity",
      header: "DC capacity",
      align: "right",
      width: "120px",
      render: (row) => formatCapacity(row.plant.dc_capacity_kwp, "kWp"),
      sortValue: (row) => row.plant.dc_capacity_kwp,
    },
    {
      key: "devices",
      header: "Devices",
      align: "right",
      width: "90px",
      render: (row) =>
        row.plant.device_count === 0 ? (
          <span className="text-warn" title="No Devices are registered, so this Plant reports nothing.">
            0
          </span>
        ) : (
          row.plant.device_count
        ),
      sortValue: (row) => row.plant.device_count,
    },
    {
      key: "energy",
      header: `Energy (${period})`,
      align: "right",
      width: "130px",
      render: (row) =>
        row.kpi ? (
          <span className="font-mono tabular-nums">{formatNumber(row.kpi.energy_kwh)}</span>
        ) : (
          <span className="text-ink-faint">…</span>
        ),
      sortValue: (row) => row.kpi?.energy_kwh ?? null,
    },
    ...(["pr", "cuf", "availability"] as const).map((key): Column<FleetRow> => {
      const entry = METRICS.find((candidate) => candidate.key === key)!;
      return {
        key,
        header: entry.label,
        align: "right" as const,
        width: "110px",
        render: (row: FleetRow) => {
          if (!row.instrumented) {
            return (
              <span
                className="text-ink-faint"
                title="No Devices are bound, so nothing was expected of this Plant. Its zero is not a measurement."
              >
                not instrumented
              </span>
            );
          }
          const value = row.kpi ? entry.of(row.kpi) : null;
          if (value === null) {
            return (
              <span
                className="text-ink-faint"
                title={
                  (key === "pr"
                    ? row.kpi?.performance_ratio.undefined_reason
                    : key === "cuf"
                      ? row.kpi?.cuf.undefined_reason
                      : row.kpi?.availability.undefined_reason) ?? "Not defined for this period."
                }
              >
                {UNDEFINED_DISPLAY}
              </span>
            );
          }
          return <span className="font-mono tabular-nums">{formatRatioAsPercent(value)}</span>;
        },
        sortValue: (row: FleetRow) =>
          row.instrumented && row.kpi ? entry.of(row.kpi) : null,
      };
    }),
    {
      key: "coverage",
      header: "Coverage",
      width: "130px",
      render: (row) => <CoverageBadge coverage={row.kpi?.coverage} />,
      sortValue: (row) => row.kpi?.coverage?.ratio ?? null,
    },
  ];

  const rankable = bars.filter((bar) => bar.value !== null);

  return (
    <div className="space-y-2.5">
      <div className="grid gap-2.5 xl:grid-cols-12">
        <Panel
          fill
          className="xl:col-span-7"
          title="Plants compared"
          subtitle={`${rankable.length} of ${rows.length} Plant(s) can be ranked on this measure. A Plant with nothing bound is shown, never ranked.`}
          actions={
            <SegmentedControl
              label="Comparison measure"
              value={metricKey}
              onChange={setMetricKey}
              options={METRICS.map((entry) => ({
                value: entry.key,
                label: entry.label,
                hint: entry.hint,
              }))}
            />
          }
        >
          {isLoading ? (
            <p className="py-10 text-center text-xs text-ink-faint">Loading each Plant&rsquo;s figures…</p>
          ) : (
            <ComparisonBars
              rows={bars}
              unit={metric.unit}
              metricLabel={metric.label}
              noun="Plant"
              height={Math.max(150, Math.min(rows.length * 26 + 30, 340))}
            />
          )}
        </Panel>

        <Panel
          fill
          className="xl:col-span-5"
          title={`Energy share — ${period}`}
          subtitle="Which Plants produced the fleet's generation. Always energy: a share of a ratio has no meaning."
        >
          {isLoading ? (
            <p className="py-10 text-center text-xs text-ink-faint">Loading…</p>
          ) : (
            <SharePie
              slices={shareSlices}
              unit="kWh"
              height={196}
              onSelect={onOpenPlant}
            />
          )}
        </Panel>
      </div>

      <Panel
        title="Plant performance"
        subtitle="Every figure here is one the Plant itself reported. Sort any column; click a row to open that Plant."
      >
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(row) => row.plant.id}
          filterPlaceholder="Filter Plants…"
          onRowClick={(row) => onOpenPlant(row.plant.id)}
        />
      </Panel>
    </div>
  );
}
