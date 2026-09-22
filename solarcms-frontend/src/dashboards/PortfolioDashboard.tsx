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
import {
  IconAlarm,
  IconAvailability,
  IconCapacity,
  IconEnergy,
  IconGauge,
  IconHealth,
  IconLeaf,
} from "@/components/icons";
import {
  fleetTotal,
  instrumentedSplit,
  weightedRatio,
} from "./fleet/aggregate";
import { FleetComparison, buildFleetRows } from "./fleet/FleetComparison";

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
  const totalEnergy = fleetTotal(kpis.map((kpi) => kpi?.energy_kwh));
  const totalCo2 = fleetTotal(kpis.map((kpi) => kpi?.co2_avoided_kg.value));

  /*
    ⚠ Every ratio carries each Plant's coverage, and that is load-bearing.
    A Plant with no Devices answers `availability: 0.0` — a real number, not a
    null — so without this one healthy Plant beside two uncommissioned ones
    reported **52.6% fleet availability**. Nothing was down; nothing was even
    connected. `couldAnswer` drops a Plant that was never due to report and
    keeps one that was due and silent, which is the case the figure exists for.
  */
  const weights = counted.map((plant) => plant.dc_capacity_kwp ?? 0);
  const ratioEntries = (pick: (kpi: (typeof kpis)[number]) => KpiFigure | undefined) =>
    kpis.map((kpi, index) => ({
      figure: pick(kpi),
      weight: weights[index],
      coverage: kpi?.coverage,
    }));

  const fleetPr = weightedRatio(ratioEntries((kpi) => kpi?.performance_ratio));
  const fleetAvailability = weightedRatio(ratioEntries((kpi) => kpi?.availability));
  const fleetCuf = weightedRatio(ratioEntries((kpi) => kpi?.cuf));
  const split = instrumentedSplit(kpis);
  const fleetRows = buildFleetRows(counted, kpis);

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
          {/*
            Which Plants actually contributed to the averages. A fleet ratio
            computed over two of five Plants is not wrong, but it is a narrower
            claim than the headline implies, and the difference is invisible
            unless it is said.
          */}
          {split.notInstrumented > 0 ? (
            <p className="mt-0.5 text-[11px] text-warn">
              {split.notInstrumented} of {counted.length} active Plant(s) have no Devices
              bound, so nothing was expected of them. They are excluded from the averages
              below — counting their zeros would report a fleet that is not under-performing
              as though it were.
            </p>
          ) : null}
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <StatTile
          label="Total DC capacity"
          icon={IconCapacity}
          numeric={totalDcCapacity}
          unit="kWp"
          footnote={`AC ${formatCapacity(totalAcCapacity, "kW")}`}
          hint="Sums active Plants only. Draft and commissioning Plants are excluded."
        />
        <StatTile
          label={`Energy (${period})`}
          icon={IconEnergy}
          {...(kpisLoading ? { value: "…" } : { numeric: totalEnergy, unit: "kWh" })}
          hint="Summed from each Plant's export counter endpoints, read from hourly aggregates rather than raw Readings."
        />
        <KpiTile
          label="Fleet performance ratio"
          icon={IconGauge}
          figure={fleetPr}
          kind="ratio"
          hint="Capacity-weighted across active Plants. Plants with an undefined PR are excluded from the weighting, never counted as zero."
        />
        <KpiTile
          label="Fleet availability"
          icon={IconAvailability}
          figure={fleetAvailability}
          kind="ratio"
          hint="Capacity-weighted. Communication loss and equipment downtime are distinguished at the Device level."
        />
        <KpiTile
          label="Fleet CUF"
          icon={IconGauge}
          figure={fleetCuf}
          kind="ratio"
          hint="Capacity utilisation factor, capacity-weighted."
        />
        <StatTile
          label="CO₂ avoided"
          icon={IconLeaf}
          {...(kpisLoading ? { value: "…" } : { numeric: totalCo2, unit: "kg" })}
          hint="Uses each region's grid emission factor. Provisional pending OPEN-16."
        />
        <StatTile
          label="Active alarms"
          icon={IconAlarm}
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
          icon={IconHealth}
          value={
            <span className="text-base">
              <DeviceHealthStrip health={healthQuery.data} />
            </span>
          }
          hint="Across every visible Plant."
        />
      </div>

      {/*
        The fleet, compared. This is the question a multi-Plant owner has that a
        single-Plant one does not — *which of these needs me* — and it is a
        ranking question, so the Plants have to be on one axis together. A
        Client with one Plant sees a one-bar chart and a table of one, which is
        honest and costs nothing.
      */}
      <FleetComparison
        rows={fleetRows}
        period={period}
        onOpenPlant={openPlant}
        isLoading={kpisLoading}
      />

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
