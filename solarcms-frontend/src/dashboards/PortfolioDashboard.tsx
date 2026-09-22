/**
 * `portfolio` — the fleet (§6.1).
 *
 * **Portfolio is computed, never stored** (MASTER §1.1). There is no
 * `/portfolio` endpoint and there should not be: this sums what `/plants`
 * returns and asks each active Plant for its KPIs.
 *
 * ⚠ Plants in `draft` or `commissioning` are **excluded from every total**
 * (MASTER §6.5). A half-mapped Plant would otherwise drag fleet PR down. They
 * are shown in a separate "Onboarding" group so they remain visible without
 * polluting the numbers.
 */

import {
  useAllPlants,
  useAlarms,
  useDeviceHealth,
  usePlantKpiFanout,
} from "@/api/hooks";
import type { KpiFigure, PlantListItem } from "@/api/schemas";
import { KpiTile, StatTile } from "@/components/charts/KpiTile";
import { Panel, SectionHeading, Badge } from "@/components/ui";
import {EmptyState, ErrorState, SkeletonChart, SkeletonKpiRow, SkeletonTable} from "@/components/state";
import {
  DeviceHealthStrip,
  PeriodPicker,
  PlantStatusBadge,
  SeverityBadge,
  isOnboarding,
} from "@/components/domain";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { formatCapacity, formatNumber } from "@/format/value";
import { useSelection } from "@/state/selection";
import { useNavigate } from "react-router-dom";

/**
 * A capacity-weighted mean of a fleet-wide ratio.
 *
 * Weighted, not arithmetic: a 2 MW Plant and a 200 MW Plant do not contribute
 * equally to fleet performance, and an unweighted mean lets a small outlier
 * dominate. Plants whose figure is undefined are excluded from both sides of
 * the fraction rather than counted as zero (§4.3).
 */
function weightedRatio(
  entries: { figure: KpiFigure | undefined; weight: number }[],
): KpiFigure {
  let numerator = 0;
  let denominator = 0;
  let variant: string | null = null;
  let contributing = 0;

  for (const entry of entries) {
    const value = entry.figure?.value;
    if (value === null || value === undefined || entry.weight <= 0) continue;
    numerator += value * entry.weight;
    denominator += entry.weight;
    variant = entry.figure?.variant ?? variant;
    contributing += 1;
  }

  if (denominator === 0) {
    return {
      value: null,
      variant,
      undefined_reason:
        contributing === 0
          ? "No active Plant reported a defined figure for this period."
          : "No Plant with a defined figure has a capacity to weight it by.",
    };
  }
  return { value: numerator / denominator, variant, undefined_reason: null };
}

export function PortfolioDashboard(): JSX.Element {
  const navigate = useNavigate();
  const { period, setPeriod, setPlantId } = useSelection();
  const plantsQuery = useAllPlants();
  const alarmsQuery = useAlarms({ state: "active", limit: 500 });
  const healthQuery = useDeviceHealth();

  const all = plantsQuery.data ?? [];
  const counted = all.filter((plant) => !isOnboarding(plant.status));
  const onboarding = all.filter((plant) => isOnboarding(plant.status));

  // One KPI request per counted Plant. There is no fleet endpoint, by design.
  //
  // ⚠ This used to be its own `useQueries` block with `staleTime: 30_000` and
  // no `refetchInterval`, which is not a slow refresh — it is *no* refresh.
  // `staleTime` only says when a value may be re-asked for; something still
  // has to ask, and with the global `refetchOnWindowFocus: false` nothing did.
  // Every figure on this screen was therefore fixed at page load: on a wall
  // display it never moved again, which reads as a plant that has stopped.
  const { kpis, isLoading: kpisLoading } = usePlantKpiFanout(counted, period);

  if (plantsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonKpiRow tiles={6} />
        <SkeletonChart />
        <SkeletonTable rows={6} columns={5} />
      </div>
    );
  }
  if (plantsQuery.isError) {
    return <ErrorState error={plantsQuery.error} retry={() => void plantsQuery.refetch()} />;
  }

  if (all.length === 0) {
    return (
      <EmptyState
        title="No Plants are visible to this account"
        detail={
          <>
            Plant Assignments are granted explicitly — zero assignments means zero
            Plants, never all of them. Ask an administrator to assign the Plants you
            need.
          </>
        }
      />
    );
  }

  const totalDcCapacity = counted.reduce(
    (sum, plant) => sum + (plant.dc_capacity_kwp ?? 0),
    0,
  );
  const totalAcCapacity = counted.reduce(
    (sum, plant) => sum + (plant.ac_capacity_kw ?? 0),
    0,
  );
  const totalEnergy = kpis.reduce((sum, kpi) => sum + (kpi?.energy_kwh ?? 0), 0);
  const totalCo2 = kpis.reduce(
    (sum, kpi) => sum + (kpi?.co2_avoided_kg.value ?? 0),
    0,
  );

  const weights = counted.map((plant) => plant.dc_capacity_kwp ?? 0);
  const fleetPr = weightedRatio(
    kpis.map((kpi, index) => ({ figure: kpi?.performance_ratio, weight: weights[index] })),
  );
  const fleetAvailability = weightedRatio(
    kpis.map((kpi, index) => ({ figure: kpi?.availability, weight: weights[index] })),
  );
  const fleetCuf = weightedRatio(
    kpis.map((kpi, index) => ({ figure: kpi?.cuf, weight: weights[index] })),
  );

  const alarms = alarmsQuery.data ?? [];
  const bySeverity = (["critical", "high", "medium", "low"] as const).map((severity) => ({
    severity,
    count: alarms.filter((alarm) => alarm.severity === severity).length,
  }));

  const openPlant = (plantId: number) => {
    setPlantId(plantId);
    navigate("/d/single_plant");
  };

  const columns: Column<PlantListItem>[] = [
    {
      key: "code",
      header: "Plant",
      render: (plant) => (
        <span>
          <span className="font-medium">{plant.code}</span>
          <span className="ml-2 text-ink-muted">{plant.name}</span>
        </span>
      ),
      sortValue: (plant) => plant.code,
      filterValue: (plant) => `${plant.code} ${plant.name}`,
    },
    {
      key: "status",
      header: "Status",
      render: (plant) => <PlantStatusBadge status={plant.status} />,
      sortValue: (plant) => plant.status,
    },
    {
      key: "capacity",
      header: "DC capacity",
      align: "right",
      render: (plant) => formatCapacity(plant.dc_capacity_kwp, "kWp"),
      sortValue: (plant) => plant.dc_capacity_kwp,
    },
    {
      key: "devices",
      header: "Devices",
      align: "right",
      render: (plant) => formatNumber(plant.device_count, { digits: 0 }),
      sortValue: (plant) => plant.device_count,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Portfolio</h1>
          <p className="text-xs text-ink-muted">
            Computed across {counted.length} active Plant(s). Portfolio is never
            stored — these figures are summed from each Plant.
          </p>
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <StatTile
          label="Total DC capacity"
          numeric={totalDcCapacity}
          unit="kWp"
          footnote={`AC ${formatCapacity(totalAcCapacity, "kW")}`}
          hint="Sums active Plants only. Draft and commissioning Plants are excluded."
        />
        <StatTile
          label={`Energy (${period})`}
          {...(kpisLoading ? { value: "…" } : { numeric: totalEnergy, unit: "kWh" })}
          hint="Summed from each Plant's export counter endpoints, read from hourly aggregates rather than raw Readings."
        />
        <KpiTile
          label="Fleet performance ratio"
          figure={fleetPr}
          kind="ratio"
          hint="Capacity-weighted across active Plants. Plants with an undefined PR are excluded from the weighting, never counted as zero."
        />
        <KpiTile
          label="Fleet availability"
          figure={fleetAvailability}
          kind="ratio"
          hint="Capacity-weighted. Communication loss and equipment downtime are distinguished at the Device level."
        />
        <KpiTile
          label="Fleet CUF"
          figure={fleetCuf}
          kind="ratio"
          hint="Capacity utilisation factor, capacity-weighted."
        />
        <StatTile
          label="CO₂ avoided"
          {...(kpisLoading ? { value: "…" } : { numeric: totalCo2, unit: "kg" })}
          hint="Uses each region's grid emission factor. Provisional pending OPEN-16."
        />
        <StatTile
          label="Active alarms"
          numeric={alarms.length}
          digits={0}
          tone={alarms.length > 0 ? "warn" : "default"}
          footnote={
            <span className="flex flex-wrap gap-1">
              {bySeverity
                .filter((entry) => entry.count > 0)
                .map((entry) => (
                  <span key={entry.severity} className="inline-flex items-center gap-1">
                    <SeverityBadge severity={entry.severity} />
                    {entry.count}
                  </span>
                ))}
              {alarms.length === 0 ? "None open" : null}
            </span>
          }
        />
        <StatTile
          label="Device health"
          value={
            <span className="text-base">
              <DeviceHealthStrip health={healthQuery.data} />
            </span>
          }
          hint="Across every visible Plant."
        />
      </div>

      <Panel
        title="Active Plants"
        subtitle="Counted in the totals above."
      >
        <DataTable
          rows={counted}
          columns={columns}
          rowKey={(plant) => plant.id}
          onRowClick={(plant) => openPlant(plant.id)}
          filterPlaceholder="Filter Plants…"
          emptyMessage="No active Plants. Plants still onboarding are listed below."
        />
      </Panel>

      {onboarding.length > 0 ? (
        <Panel
          title="Onboarding"
          subtitle="Draft and commissioning Plants — visible, but excluded from every total above."
        >
          <SectionHeading note="A partly mapped Plant would distort fleet performance, so these are kept out of the figures until they are active.">
            <Badge tone="warn">Not counted</Badge>
          </SectionHeading>
          <DataTable
            rows={onboarding}
            columns={columns}
            rowKey={(plant) => plant.id}
            onRowClick={(plant) => openPlant(plant.id)}
            filterPlaceholder="Filter onboarding Plants…"
          />
        </Panel>
      ) : null}
    </div>
  );
}
