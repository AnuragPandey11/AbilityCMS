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
  usePlantDashboardFanout,
  usePlantKpiFanout,
} from "@/api/hooks";
import type {
  Alarm,
  DeviceHealth,
  KpiFigure,
  PlantDashboard,
  PlantListItem,
  ResolvedSlot,
} from "@/api/schemas";
import { Panel, SectionHeading, Badge } from "@/components/ui";
import {EmptyState, ErrorState, SkeletonChart, SkeletonKpiRow, SkeletonTable} from "@/components/state";
import {
  DeviceHealthStrip,
  PeriodPicker,
  PlantStatusBadge,
  SeverityBadge,
  isOnboarding,
} from "@/components/domain";
import { sourceLabel } from "@/components/dashboard/SlotValue";
import { DataTable, type Column } from "@/components/tables/DataTable";
import {
  UNDEFINED_DISPLAY,
  formatCapacity,
  formatHeadline,
  formatNumber,
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
} from "@/format/value";
import { useSelection } from "@/state/selection";
import { useNavigate } from "react-router-dom";
import {
  IconAlarm,
  IconAvailability,
  IconCalendar,
  IconCapacity,
  IconClock,
  IconGauge,
  IconHealth,
  IconLeaf,
  IconPower,
} from "@/components/icons";
import type { IconProps } from "@/components/icons";
import type { ComponentType } from "react";
import {
  fleetTotal,
  instrumentedSplit,
  weightedRatio,
} from "./fleet/aggregate";
import {
  conditionCounts,
  fleetStatusWord,
  plantCondition,
  sumLivePower,
} from "./fleet/condition";
import { FleetComparison, buildFleetRows } from "./fleet/FleetComparison";
import {
  FleetCard,
  FleetTile,
  GenerationBars,
  HeaderCell,
  PlantStatusRing,
  StatusWord,
  SummaryRow,
  TileFigure,
  type GenerationRow,
  type TileTone,
} from "./fleet/PortfolioParts";

/** A slot by code, wherever the catalogue placed it. `null` once resolved and absent. */
function slotFor(
  dashboard: PlantDashboard | undefined,
  code: string,
): ResolvedSlot | null | undefined {
  if (dashboard === undefined) return undefined;
  for (const slots of Object.values(dashboard.panels)) {
    const slot = slots.find((candidate) => candidate.slot_code === code);
    if (slot) return slot;
  }
  return null;
}

function groupByPlant<T extends { plant_id: number | null }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    if (row.plant_id === null) continue;
    const bucket = grouped.get(row.plant_id);
    if (bucket) bucket.push(row);
    else grouped.set(row.plant_id, [row]);
  }
  return grouped;
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
  // Live generation is each Plant's own resolved Current Power, summed — so
  // every contribution keeps the provenance its Plant screen shows.
  const { dashboards } = usePlantDashboardFanout(counted);

  if (plantsQuery.isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonKpiRow tiles={8} />
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
  const severeAlarms = alarms.filter((a) => a.severity === "critical" || a.severity === "high").length;
  const alarmTone: TileTone = alarms.length === 0 ? "ok" : severeAlarms > 0 ? "bad" : "warn";

  // Condition reads open Alarms and Device communication — never a KPI.
  const healthByPlant = groupByPlant<DeviceHealth>(healthQuery.data ?? []);
  const alarmsByPlant = groupByPlant<Alarm>(alarms);
  const counts = conditionCounts(
    counted.map((plant) =>
      plantCondition({
        health: healthByPlant.get(plant.id) ?? [],
        alarms: alarmsByPlant.get(plant.id) ?? [],
      }),
    ),
  );
  const fleetStatus = fleetStatusWord(counts, counted.length);
  const countedDevices = counted.flatMap((plant) => healthByPlant.get(plant.id) ?? []);
  const devicesOnline = countedDevices.filter((d) => d.comm_status === "online").length;

  const powerSlots = counted.map((_, index) => slotFor(dashboards[index], "kpi.current_power"));
  const live = sumLivePower(powerSlots);
  const liveLoading = powerSlots.some((slot) => slot === undefined);
  const liveFooter = liveLoading
    ? "Resolving each Plant…"
    : live.mixedUnits
      ? "Plants report power in different units; not summed."
      : live.value === null
        ? "No Plant has a current-power figure."
        : `Σ ${live.contributing} of ${live.total} Plant${live.total === 1 ? "" : "s"}${
            live.contributing < live.total ? " · partial" : ""
          }`;

  // Largest first. A Plant with no Current Power position draws a dash, never
  // a zero bar. The track is the Plant's DC capacity only where the power is
  // in kW — a unit is never converted to make a bar fit.
  const generationRows: GenerationRow[] = counted
    .map((plant, index) => {
      const slot = powerSlots[index];
      return {
        key: plant.id,
        label: plant.name,
        value: slot?.value ?? null,
        max: slot?.unit === "kW" ? plant.dc_capacity_kwp : null,
        hint:
          slot === undefined
            ? "Resolving…"
            : slot === null
              ? "No Current Power position on this Plant's dashboard."
              : slot.value === null
                ? "The source is registered and reporting nothing."
                : `${formatNumber(slot.value)} ${slot.unit ?? ""} · ${sourceLabel(slot.source)}${
                    slot.source?.tag_code ? ` · ${slot.source.tag_code}` : ""
                  }`,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const generationUnit = live.unit ?? "kW";

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

  const ratioTile = (
    label: string,
    icon: ComponentType<IconProps>,
    iconTone: TileTone,
    figure: KpiFigure,
    footer: string,
    hint?: string,
    showHint = false,
  ) => {
    // A ratio outside its physical range is a fault in the inputs, not a
    // result: shown unaltered, flagged, and pointed at the coverage.
    const implausible = ratioIsImplausible(figure.value);
    return (
      <FleetTile
        className="xl:col-span-4"
        icon={icon}
        iconTone={iconTone}
        frame={implausible ? "warn" : "neutral"}
        label={label}
        hint={hint}
        showHint={showHint}
        footer={
          figure.value === null
            ? figure.undefined_reason
            : implausible
              ? "Outside its physical range — check each Plant's coverage"
              : footer
        }
        footerTone={implausible ? "warn" : "faint"}
      >
        <TileFigure
          value={figure.value === null ? null : formatRatioAsPercent(figure.value)}
          tone={implausible ? "warn" : "ink"}
          loading={kpisLoading}
          title={
            figure.value === null
              ? (figure.undefined_reason ?? undefined)
              : implausible
                ? implausibleRatioReason(figure.value, label)
                : undefined
          }
        />
      </FleetTile>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-[34rem]">
          <h1 className="page-title">Portfolio</h1>
          <p className="mt-1.5 text-sm leading-snug text-ink-muted">
            All Plants overview · computed across {counted.length} active Plant
            {counted.length === 1 ? "" : "s"}. Never stored — every figure is summed from
            each Plant&apos;s own.
          </p>
          {/*
            Which Plants actually contributed to the averages. A fleet ratio
            computed over two of five Plants is not wrong, but it is a narrower
            claim than the headline implies, and the difference is invisible
            unless it is said.
          */}
          {split.notInstrumented > 0 ? (
            <p className="mt-1 text-xs text-warn">
              {split.notInstrumented} of {counted.length} active Plant(s) have no Devices
              bound, so nothing was expected of them. They are excluded from the averages
              below — counting their zeros would report a fleet that is not under-performing
              as though it were.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-stretch gap-3 lg:shrink-0 lg:justify-end">
          <HeaderCell
            label="Plants online"
            title="Active Plants whose every Device is reporting with no Alarm open."
          >
            <span className={counts.online === counted.length ? "text-ok" : "text-ink"}>
              {counts.online} / {counted.length}
            </span>
          </HeaderCell>
          <HeaderCell label="Fleet status" title={fleetStatus.detail}>
            <StatusWord word={fleetStatus.word} tone={fleetStatus.tone} />
          </HeaderCell>
          <div className="flex items-center">
            <PeriodPicker value={period} onChange={setPeriod} size="lg" />
          </div>
        </div>
      </div>

      {/*
        Two rows that each mean one thing: what the fleet *produces* (capacity,
        power, energy, CO₂) and how it is *performing* (PR, CUF, availability,
        Alarms, Devices). On a wide screen that is 4 over 5, on a 20-column grid
        so both rows fill edge to edge. Narrower, it is 3 × 3 — CO₂ drops to
        the last row beside the two status tiles, so each row still reads as
        one group — and 2 across below that.
      */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[repeat(20,minmax(0,1fr))]">
        <FleetTile
          className="xl:col-span-5"
          icon={IconCapacity}
          iconTone="accent"
          label="Total capacity"
          footer={`AC ${formatCapacity(totalAcCapacity, "kW")} · active Plants only`}
          hint="Sums active Plants only. Draft and commissioning Plants are excluded."
        >
          <TileFigure value={totalDcCapacity} unit="kWp" />
        </FleetTile>
        <FleetTile
          className="xl:col-span-5"
          icon={IconPower}
          iconTone="accent"
          label="Live generation"
          footer={liveFooter}
          showHint
          hint="The sum of each Plant's resolved Current Power. Provenance per Plant is on Generation by Plant — hover a bar."
        >
          <TileFigure value={live.value} unit={live.unit} loading={liveLoading} />
        </FleetTile>
        <FleetTile
          className="xl:col-span-5"
          icon={IconCalendar}
          iconTone="accent"
          label={`Energy · ${period}`}
          footer="From hourly aggregates, never raw Readings"
          showHint
          hint="Summed from each Plant's export counter endpoints, read from hourly aggregates rather than raw Readings."
        >
          <TileFigure value={totalEnergy} unit="kWh" loading={kpisLoading} />
        </FleetTile>
        <FleetTile
          className="lg:order-1 xl:order-none xl:col-span-5"
          icon={IconLeaf}
          iconTone="accent"
          label={`CO₂ avoided · ${period}`}
          footer="Each Region's grid factor · provisional (OPEN-16)"
          hint="Uses each region's grid emission factor. Provisional pending OPEN-16."
        >
          <TileFigure value={totalCo2} unit="kg" loading={kpisLoading} />
        </FleetTile>
        {ratioTile(
          "Fleet performance ratio",
          IconGauge,
          "accent",
          fleetPr,
          `Capacity-weighted · ${variantNote(fleetPr.variant)}`,
          "Capacity-weighted across active Plants. Plants with an undefined PR are excluded from the weighting, never counted as zero.",
          true,
        )}
        {ratioTile(
          "Fleet CUF",
          IconClock,
          "accent",
          fleetCuf,
          "Capacity-weighted",
          "Capacity utilisation factor, capacity-weighted.",
        )}
        {ratioTile(
          "Fleet availability",
          IconAvailability,
          "accent",
          fleetAvailability,
          "Communication status, capacity-weighted",
          "Capacity-weighted. Communication loss and equipment downtime are distinguished at the Device level.",
        )}
        <FleetTile
          className="lg:order-1 xl:order-none xl:col-span-4"
          icon={IconAlarm}
          iconTone={alarmTone}
          frame={alarmTone}
          label="Active alarms"
          footer={
            alarms.length === 0 ? (
              "None open across the fleet"
            ) : (
              <span className="flex flex-wrap gap-1">
                {bySeverity
                  .filter((entry) => entry.count > 0)
                  .map((entry) => (
                    <span key={entry.severity} className="inline-flex items-center gap-1">
                      <SeverityBadge severity={entry.severity} />
                      {entry.count}
                    </span>
                  ))}
              </span>
            )
          }
        >
          <TileFigure value={alarms.length} digits={0} tone={alarmTone} />
        </FleetTile>
        <FleetTile
          className="sm:col-span-2 lg:order-1 lg:col-span-1 xl:order-none xl:col-span-4"
          icon={IconHealth}
          iconTone="accent"
          frame={
            countedDevices.length > 0 && devicesOnline < countedDevices.length ? "warn" : "neutral"
          }
          label="Devices reporting"
          hint="Registered Devices within their expected interval, across active Plants."
          footer={
            countedDevices.length === 0 ? (
              "No Devices registered"
            ) : devicesOnline === countedDevices.length ? (
              "All within their expected interval"
            ) : (
              <DeviceHealthStrip health={countedDevices} />
            )
          }
        >
          <TileFigure
            value={
              countedDevices.length === 0 ? null : `${devicesOnline} / ${countedDevices.length}`
            }
            tone={devicesOnline < countedDevices.length ? "warn" : "ink"}
          />
        </FleetTile>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        <FleetCard
          className="xl:col-span-5"
          title="Generation by Plant"
          subtitle={`Current power against registered capacity (${generationUnit} on kWp). Each Plant's own source; hover for provenance.`}
        >
          {generationRows.length === 0 ? (
            <EmptyState title="No active Plants" detail="Nothing to rank yet." />
          ) : (
            <GenerationBars rows={generationRows} onSelect={openPlant} />
          )}
        </FleetCard>

        <FleetCard
          className="xl:col-span-3"
          title="Plant Status"
          subtitle="From open Alarms and Device communication — never from a KPI."
        >
          <PlantStatusRing counts={counts} total={counted.length} />
        </FleetCard>

        <FleetCard
          className="xl:col-span-4"
          title="Fleet Summary"
          subtitle="What the whole estate is doing right now."
        >
          <div className="-mt-3 divide-y divide-line">
            <SummaryRow
              label="Plants online"
              value={`${counts.online} / ${counted.length}`}
              tone={counts.online === counted.length ? "ok" : "ink"}
            />
            <SummaryRow
              label="Devices reporting"
              value={
                countedDevices.length === 0
                  ? UNDEFINED_DISPLAY
                  : `${devicesOnline} / ${countedDevices.length}`
              }
              tone={
                countedDevices.length > 0 && devicesOnline < countedDevices.length ? "warn" : "ink"
              }
              hint="Registered Devices within their expected interval, across active Plants."
            />
            <SummaryRow
              label="Live generation"
              value={
                liveLoading
                  ? "…"
                  : live.value === null
                    ? UNDEFINED_DISPLAY
                    : `${formatHeadline(live.value).text} ${live.unit ?? ""}`
              }
              hint={live.contributing < live.total ? liveFooter : undefined}
            />
            <SummaryRow
              label={`Energy · ${period}`}
              value={kpisLoading ? "…" : `${formatHeadline(totalEnergy).text} kWh`}
            />
            <SummaryRow
              label={`CO₂ avoided · ${period}`}
              value={kpisLoading ? "…" : `${formatHeadline(totalCo2).text} kg`}
            />
            <SummaryRow
              label="Open alarms"
              value={String(alarms.length)}
              tone={alarmTone === "ok" ? "ok" : alarmTone === "bad" ? "bad" : "warn"}
            />
            {onboarding.length > 0 ? (
              <SummaryRow
                label="Onboarding"
                value={`${onboarding.length} not counted`}
                tone="faint"
                hint="Draft and commissioning Plants are excluded from every total."
              />
            ) : null}
          </div>
        </FleetCard>
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
