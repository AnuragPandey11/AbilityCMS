/**
 * `single_plant` (§6.3) — the Plant at a glance, on one screen.
 *
 * ── The constraint this screen is built around ──────────────────────────────
 * It used to be six and a half screens tall. Everything on it was correct and
 * nothing was reachable: the schematic, the live figures, the Inverters, the
 * health table and the time series were stacked in a column, so seeing the
 * second thing meant losing sight of the first. A dashboard whose parts cannot
 * be seen together is a report with a scrollbar — the entire value of the form
 * is that *how the Plant is doing* is one image, not a sequence.
 *
 * So the rule here is that the whole page fits a laptop viewport, and depth is
 * reached sideways or in a drawer rather than downwards:
 *
 *   headline strip    the figures that never change position, always visible
 *   schematic         generation → grid, with the equipment drawn
 *   power + weather   two charts, one axis each, over a chosen window
 *   Inverters         a carousel — seventeen peers go across, not down
 *   summary row       one card per section, each opening its full detail
 *
 * Nothing was deleted to achieve that. Every figure the long version showed is
 * still here; what changed is that the *second* copy of each is behind one
 * click instead of below one screen. `duplication.ts` handles the case where
 * the catalogue genuinely answers the same thing twice.
 *
 * ── Three rules the layout is not allowed to break ──────────────────────────
 * - **The panels and their positions are identical on every Plant.** Which
 *   Device answers each slot differs; the screen does not. That is the whole
 *   argument against a drag-and-drop canvas (MASTER §3.7) — a canvas makes
 *   every Plant a bespoke artefact nobody can compare with another.
 * - **Provenance travels with every value.** 6.32 MW measured at a settlement
 *   meter and 6.32 MW summed from twelve Inverters are different claims, and
 *   only the server knows which it just made.
 * - **A missing figure is "—" with its reason, never 0.** Zero is a claim about
 *   the equipment; silence is the absence of one.
 *
 * ⚠ **Blocks are optional.** A Plant with zero Blocks is valid and normal
 * (MASTER §2.2), so the Blocks card appears only when the Plant has some — no
 * "Unassigned" pseudo-Block, no empty grouping level.
 */

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  useAlarms,
  useDeviceHealth,
  useDeviceTableColumns,
  usePlant,
  usePlantBlocks,
  usePlantDashboard,
  usePlantDevices,
  usePlantKpis,
  useTagsById,
} from "@/api/hooks";
import { useSlotTrend, TREND_RANGES, type TrendRange } from "@/api/useSlotTrend";
import { useLatestValues } from "@/api/useLatestValues";
import { qk } from "@/api/queryKeys";
import * as plantsApi from "@/api/endpoints/plants";
import type {
  BlockKpis,
  DeviceListItem,
  ResolvedSlot,
  SldStage,
} from "@/api/schemas";
import { Panel, Badge, SegmentedControl, Drawer } from "@/components/ui";
import { Carousel, CarouselItem } from "@/components/ui/Carousel";
import { TrendChart, SmallMultiples } from "@/components/charts/TrendChart";
import { ReadingsPanel } from "@/components/charts/ReadingsPanel";
import { PlantSchematic } from "@/components/sld/PlantSchematic";
import { DeviceCard } from "@/components/devices/DeviceCard";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { SummaryCard, type SummaryFigure } from "@/components/dashboard/SummaryCard";
import { CoverageBadge } from "@/components/dashboard/CoverageBadge";
import { SlotRow, SlotStat, slotText } from "@/components/dashboard/SlotValue";
import { PerformancePanel } from "./single-plant/PerformancePanel";
import { fullyDuplicated } from "./single-plant/duplication";
import {
  EmptyState,
  ErrorState,
  SkeletonKpiRow,
  SkeletonPanel,
  SkeletonTable,
} from "@/components/state";
import { PlantStatusControl } from "@/admin/PlantStatusControl";
import { DataTable, type Column } from "@/components/tables/DataTable";
import {
  CommStatusBadge,
  DeviceHealthStrip,
  LastSeen,
  PeriodPicker,
  PlantPicker,
  SeverityBadge,
} from "@/components/domain";
import {
  IconAlarm,
  IconClock,
  IconEnergy,
  IconGauge,
  IconHealth,
  IconIrradiance,
  IconLocation,
  IconPower,
  IconSignal,
} from "@/components/icons";
import { formatCapacity, formatNumber, formatValue, UNDEFINED_DISPLAY, formatRatioAsPercent } from "@/format/value";
import { formatDateTime, timezoneLabel } from "@/format/datetime";
import { useSelection } from "@/state/selection";
import { usePlantScope } from "@/state/usePlantScope";
import { useLiveSocket } from "@/live/LiveSocket";
import { useLiveRefresh } from "@/live/useLiveRefresh";

/** Which icon labels a headline slot. Purely presentational. */
const SLOT_ICONS: Record<string, typeof IconPower> = {
  "kpi.plant_capacity": IconLocation,
  "kpi.current_power": IconPower,
  "kpi.energy_today": IconEnergy,
  "kpi.energy_month": IconEnergy,
  "kpi.energy_lifetime": IconEnergy,
};

/** Titles for the summary cards, by panel code. Presentation only. */
const PANEL_TITLES: Record<string, { title: string; subtitle: string; icon: typeof IconPower }> = {
  plant_status: {
    title: "Plant Status",
    subtitle: "Live figures at the Plant's electrical boundary.",
    icon: IconSignal,
  },
  power_summary: {
    title: "Power",
    subtitle: "DC in, AC out, and what crossed the meter. Each gap is a real loss.",
    icon: IconPower,
  },
  energy_summary: {
    title: "Energy",
    subtitle: "Generated, exported and imported are three different quantities.",
    icon: IconEnergy,
  },
  environment: {
    title: "Weather",
    subtitle: "The denominator of Performance Ratio.",
    icon: IconIrradiance,
  },
};

/** Which drawer is open. `null` is the normal state. */
type OpenPanel =
  | { kind: "panel"; code: string }
  | { kind: "performance" }
  | { kind: "health" }
  | { kind: "alarms" }
  | { kind: "blocks" }
  | { kind: "stage"; stage: SldStage }
  | { kind: "device"; device: DeviceListItem }
  | null;

function byPosition(slots: ResolvedSlot[]): ResolvedSlot[] {
  return [...slots].sort((a, b) => a.position - b.position);
}

/** The first `n` slots of a panel, as the figures a summary card shows. */
function toFigures(slots: ResolvedSlot[], n: number): SummaryFigure[] {
  return byPosition(slots)
    .slice(0, n)
    .map((slot) => ({
      label: slot.label,
      value: slot.value === null ? UNDEFINED_DISPLAY : slotText(slot),
      unit: slot.value === null ? null : slot.unit,
      tone: slot.value === null ? ("muted" as const) : ("default" as const),
      title: slot.source?.is_aggregated
        ? `${slot.source.aggregate} of ${slot.source.device_count} ${slot.source.device_type_code}`
        : (slot.source?.device_type_code ?? undefined),
    }));
}

export function SinglePlantDashboard(): JSX.Element {
  const { period, setPeriod } = useSelection();
  const { plants, plantId, setPlantId, hasNoPlants } = usePlantScope();
  const [range, setRange] = useState<TrendRange>("24h");
  const [open, setOpen] = useState<OpenPanel>(null);

  const plantQuery = usePlant(plantId);
  // The slots and KPI tiles refetch when this Plant's readings actually arrive,
  // rather than on a timer that fires whether or not anything happened. The
  // server still computes every figure, with its provenance — the socket only
  // says "there is something new to ask for".
  useLiveRefresh(plantId);

  const kpisQuery = usePlantKpis(plantId, period);
  const dashboardQuery = usePlantDashboard(plantId);
  const columnsQuery = useDeviceTableColumns();
  const blocksQuery = usePlantBlocks(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const healthQuery = useDeviceHealth(plantId);
  const alarmsQuery = useAlarms({ plantId: plantId ?? undefined, state: "active" });
  const tagsById = useTagsById();
  const { devices: liveDevices } = useLiveSocket();

  // The two charts. Both read the slot the server already resolved, so the
  // curve under a tile is the same claim as the tile — same Device Type, same
  // Tag, same aggregate (see `useSlotTrend`).
  const powerTrend = useSlotTrend(plantId, "kpi.current_power", range);
  const irradianceTrend = useSlotTrend(plantId, "env.irradiance", range);
  const moduleTempTrend = useSlotTrend(plantId, "env.module_temperature", range);

  const blocks = blocksQuery.data ?? [];
  const blockKpiQueries = useQueries({
    queries: blocks.map((block) => ({
      queryKey: qk.blockKpis(block.id, period),
      queryFn: () => plantsApi.blockKpis(block.id, period),
      staleTime: 30_000,
    })),
  });

  // Memoised because `?? []` produces a fresh array on every render, which
  // would make every downstream `useMemo` recompute on every paint.
  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);
  const dash = dashboardQuery.data;
  const panel = (code: string): ResolvedSlot[] => dash?.panels[code] ?? [];
  const headline = byPosition(panel("kpi_row"));

  /**
   * The Device Types present, each with its curated columns — the carousel is
   * built from this rather than from `type === "INVERTER"`. A Client whose
   * Plant is all string inverters and one meter gets a strip per type with no
   * release, and Guardrail 2 stays intact.
   */
  const deviceGroups = useMemo(() => {
    const columns = columnsQuery.data ?? {};
    const byType = new Map<string, DeviceListItem[]>();
    for (const device of devices) {
      const bucket = byType.get(device.type_code);
      if (bucket) bucket.push(device);
      else byType.set(device.type_code, [device]);
    }
    return [...byType]
      // Only types the catalogue has configured figures for. A type with no
      // columns would render a row of cards with nothing on them.
      .filter(([typeCode, group]) => (columns[typeCode]?.length ?? 0) > 0 && group.length > 0)
      // Most numerous first: the seventeen Inverters are what the carousel is
      // for, and a single meter above them wastes the row.
      .sort((a, b) => b[1].length - a[1].length)
      .map(([typeCode, group]) => ({
        typeCode,
        devices: [...group].sort((a, b) =>
          a.code.localeCompare(b.code, undefined, { numeric: true }),
        ),
        columns: columns[typeCode] ?? [],
      }));
  }, [devices, columnsQuery.data]);

  /**
   * The strip the carousel shows — the most numerous Device Type. Its cards are
   * seeded from stored readings so they are populated on arrival, and each is
   * overwritten by the live socket as that Device's next frame lands.
   */
  const strip = deviceGroups[0] ?? null;
  const latest = useLatestValues(
    strip?.devices.map((device) => device.id) ?? [],
    strip?.columns.map((column) => column.tag_id) ?? [],
    strip !== null,
  );

  /**
   * Live frame first, stored reading behind it.
   *
   * Merged per Tag rather than per Device: a frame carries only the Tags that
   * were not throttled in that message, so taking the frame wholesale would
   * blank the four figures that did not happen to be in it. The card would
   * then lose values as the Device reported, which is the opposite of what
   * arriving data should do.
   */
  const valuesFor = (deviceId: number): Record<string, number> | undefined => {
    const stored = latest.byDevice[deviceId];
    const live = liveDevices[deviceId]?.values;
    if (!stored && !live) return undefined;
    return { ...stored, ...live };
  };

  const healthCounts = useMemo(() => {
    const counts = { online: 0, degraded: 0, offline: 0, unknown: 0 };
    for (const record of healthQuery.data ?? []) counts[record.comm_status] += 1;
    return counts;
  }, [healthQuery.data]);

  const alarms = alarmsQuery.data ?? [];

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }
  // A skeleton in the shape of the page, not a centred spinner: the strip, the
  // schematic and the charts land in boxes that are already there, so nothing
  // reflows at the moment data arrives.
  if (plantQuery.isLoading) {
    return (
      <div className="space-y-2.5">
        <SkeletonPanel lines={1} />
        <SkeletonKpiRow tiles={5} />
        <div className="grid gap-2.5 xl:grid-cols-12">
          <div className="xl:col-span-7"><SkeletonPanel lines={4} /></div>
          <div className="xl:col-span-5"><SkeletonPanel lines={4} /></div>
        </div>
        <SkeletonTable rows={3} columns={6} />
      </div>
    );
  }
  if (plantQuery.isError) {
    return <ErrorState error={plantQuery.error} retry={() => void plantQuery.refetch()} />;
  }

  const plant = plantQuery.data!;
  const kpis = kpisQuery.data;
  // Every timestamp on this screen renders in the Plant's zone (Guardrail 11).
  const timezone = plant.timezone;

  /** The panel cards, minus any the headline strip already answered. */
  const panelCards = ["plant_status", "power_summary", "energy_summary", "environment"]
    .map((code) => ({ code, slots: panel(code) }))
    .filter(({ slots }) => slots.length > 0 && !fullyDuplicated(slots, headline));

  const drawerTitle = (() => {
    if (!open) return "";
    switch (open.kind) {
      case "panel":
        return PANEL_TITLES[open.code]?.title ?? open.code;
      case "performance":
        return `Performance — ${period}`;
      case "health":
        return "Device health";
      case "alarms":
        return "Open Alarms";
      case "blocks":
        return "Blocks";
      case "stage":
        return open.stage.label;
      case "device":
        return `${open.device.code} — ${open.device.name}`;
    }
  })();

  const deviceColumns: Column<DeviceListItem>[] = [
    {
      key: "code",
      header: "Device",
      render: (device) => (
        <span className="flex items-center gap-1.5">
          <DeviceArt typeCode={device.type_code} size={22} />
          <span className="font-medium">{device.code}</span>
        </span>
      ),
      sortValue: (device) => device.code,
      filterValue: (device) => `${device.code} ${device.name} ${device.type_code}`,
    },
    {
      key: "type",
      header: "Type",
      render: (device) => <span className="text-ink-muted">{device.type_code}</span>,
      sortValue: (device) => device.type_code,
      width: "120px",
    },
    {
      key: "comm",
      header: "Comms",
      render: (device) => <CommStatusBadge status={device.comm_status} />,
      sortValue: (device) => device.comm_status ?? "unknown",
      width: "100px",
    },
    {
      key: "seen",
      header: "Last seen",
      render: (device) => (
        <LastSeen
          at={device.last_seen_at}
          expectedIntervalS={device.expected_interval_s}
          timezone={timezone}
        />
      ),
      sortValue: (device) => (device.last_seen_at ? Date.parse(device.last_seen_at) : null),
      width: "110px",
    },
    {
      key: "collector",
      header: "Reports via",
      render: (device) =>
        device.reports_via_device_id ? (
          <span
            className="text-ink-muted"
            title="The Device that transmits this one. A failure here is communication loss, not equipment downtime."
          >
            #{device.reports_via_device_id}
          </span>
        ) : (
          <span className="text-ink-faint">direct</span>
        ),
      sortValue: (device) => device.reports_via_device_id,
      width: "100px",
    },
  ];

  return (
    <div className="flex flex-col gap-2.5">
      {/*
        One filter row, above everything it scopes. Two controls rather than
        one because they genuinely scope different things and merging them
        would be a lie: `Period` drives the derived figures, computed over a
        calendar period from aggregates; `Window` drives the charts, which are
        a rolling span of readings. "Today" and "the last 24 hours" are not the
        same range and must not share a control.
      */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="flex items-center gap-2 truncate text-base font-semibold text-ink">
            {plant.code}
            <span className="truncate font-normal text-ink-muted">{plant.name}</span>
          </h1>
          {/*
            The control, not the badge beside it: `PlantStatusControl` already
            renders the status as a Badge and adds the transition next to it, so
            showing `PlantStatusBadge` here too put the word "active" on the
            screen twice, 40px apart, which reads as two different facts.

            Status is edited where the Plant is looked at. It used to be
            reachable only from the onboarding wizard, so a Plant that finished
            commissioning a week later could be activated only by walking back
            through a form built for creating one.
          */}
          <PlantStatusControl plantId={plant.id} status={plant.status} />
        </div>

        <div className="flex items-center gap-2 text-[11px] text-ink-muted">
          <span title="Nameplate DC capacity from the Plant record.">
            DC {formatCapacity(plant.dc_capacity_kwp, "kWp")}
          </span>
          <span className="text-ink-faint">·</span>
          <span title="Nameplate AC capacity from the Plant record.">
            AC {formatCapacity(plant.ac_capacity_kw, "kW")}
          </span>
          <Badge
            tone="neutral"
            title="Every timestamp on this screen renders in the Plant's timezone, not the browser's."
          >
            {timezoneLabel(timezone)}
          </Badge>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" />
          <label className="flex items-center gap-1.5">
            <span
              className="text-[11px] text-ink-muted"
              title="Scopes the derived figures — PR, CUF, availability — which are computed over a calendar period."
            >
              Period
            </span>
            <PeriodPicker value={period} onChange={setPeriod} />
          </label>
          <label className="flex items-center gap-1.5">
            <span
              className="text-[11px] text-ink-muted"
              title="Scopes the charts, which show a rolling span of readings. Deliberately separate from Period: 'today' and 'the last 24 hours' are different ranges."
            >
              Window
            </span>
            <SegmentedControl
              label="Chart window"
              value={range}
              onChange={setRange}
              options={TREND_RANGES.map((option) => ({
                value: option.value,
                label: option.label,
                hint: option.hint,
              }))}
            />
          </label>
        </div>
      </header>

      {/*
        The headline strip. Every tile here is answerable by a bare rooftop
        Plant publishing four Inverters *and* by an 8 MW Plant with a settlement
        meter — that is the test a figure has to pass to be in this row — and
        each one names the Device that answered it.
      */}
      {dashboardQuery.isLoading ? (
        <SkeletonKpiRow tiles={5} />
      ) : dashboardQuery.isError ? (
        <ErrorState error={dashboardQuery.error} retry={() => void dashboardQuery.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {headline.map((slot) => (
            <SlotStat key={slot.slot_code} slot={slot} icon={SLOT_ICONS[slot.slot_code]} />
          ))}
        </div>
      )}

      <div className="grid gap-2.5 xl:grid-cols-12">
        {/*
          The four-stage schematic, fixed on every Plant. The detailed
          `parent_device_id` tree — which Inverter is the broken one — lives on
          the SLD dashboard; this answers the other question, whether the Plant
          is healthy at a glance and how it compares with the next one.
        */}
        <Panel
          fill
          className="xl:col-span-7"
          title="Plant Schematic"
          subtitle="PV Array → Inverters → Transformer → Grid. Every power-path Device folds into one of the four by its Device Type."
        >
          {dashboardQuery.isLoading ? (
            <SkeletonPanel lines={3} title={false} />
          ) : dash ? (
            <PlantSchematic
              sld={dash.sld}
              compact
              onSelectStage={(stage) => setOpen({ kind: "stage", stage })}
              selectedStage={open?.kind === "stage" ? open.stage.code : null}
            />
          ) : null}
        </Panel>

        <Panel
          fill
          className="xl:col-span-5"
          title={powerTrend.label}
          subtitle="One measure, one axis. Gaps are drawn as gaps — a Plant that reported nothing was not producing zero."
        >
          {powerTrend.unavailableReason ? (
            <p className="py-8 text-center text-xs text-ink-faint">
              {powerTrend.unavailableReason}
            </p>
          ) : (
            <TrendChart
              points={powerTrend.points}
              unit={powerTrend.unit}
              label={powerTrend.label}
              tier={powerTrend.tier}
              provenance={powerTrend.provenance}
              flaggedCount={powerTrend.flaggedCount}
              timezone={timezone}
              height={188}
            />
          )}
        </Panel>
      </div>

      <div className="grid gap-2.5 xl:grid-cols-12">
        {/*
          The Inverters, sideways. Seventeen peers stacked vertically is 2000px
          of page and everything below them falls off the screen; across, the
          first four are visible and the rest are one gesture away.
        */}
        <div className="min-w-0 xl:col-span-8">
          {deviceGroups.length === 0 && !devicesQuery.isLoading ? (
            <Panel title="Devices">
              <EmptyState
                title="No Devices registered"
                detail="This Plant has no Devices yet. Register them through Plants & Devices, giving each an expected interval taken from observation."
              />
            </Panel>
          ) : (
            <div className="space-y-2.5">
              {(strip ? [strip] : []).map((group) => (
                <Panel
                  fill
                  key={group.typeCode}
                  title={`${group.typeCode} — ${group.devices.length}`}
                  subtitle="Figures come from the catalogue's columns for this Device Type, not from this screen. Tap a card for everything the Device reports."
                >
                  <Carousel
                    ariaLabel={`${group.typeCode} Devices`}
                    className="flex h-full items-center"
                  >
                    {group.devices.map((device) => (
                      <CarouselItem key={device.id}>
                        <DeviceCard
                          device={device}
                          columns={group.columns}
                          maxFigures={6}
                          values={valuesFor(device.id)}
                          onSelect={(selected) => setOpen({ kind: "device", device: selected })}
                          selected={open?.kind === "device" && open.device.id === device.id}
                        />
                      </CarouselItem>
                    ))}
                  </Carousel>
                </Panel>
              ))}
            </div>
          )}
        </div>

        {/*
          Irradiance and module temperature, stacked on a shared time axis.
          ⚠ Deliberately **not** a dual-axis plot. Two y-scales on one frame
          make their alignment arbitrary, so the chart invents a correlation
          nobody measured — and irradiance against temperature is exactly the
          pair somebody would read a relationship into. Stacked, the reader can
          line up the times without the chart claiming a ratio.
        */}
        <Panel
          fill
          className="xl:col-span-4"
          title="Weather"
          subtitle="Two measures, two scales, one shared time axis — never one plot with two y-axes."
        >
          {irradianceTrend.unavailableReason && moduleTempTrend.unavailableReason ? (
            <p className="py-8 text-center text-xs text-ink-faint">
              {irradianceTrend.unavailableReason}
            </p>
          ) : (
            <SmallMultiples
              timezone={timezone}
              height={174}
              series={[
                {
                  key: "irradiance",
                  label: irradianceTrend.label,
                  unit: irradianceTrend.unit,
                  points: irradianceTrend.points,
                  tier: irradianceTrend.tier,
                  flaggedCount: irradianceTrend.flaggedCount,
                },
                {
                  key: "module_temp",
                  label: moduleTempTrend.label,
                  unit: moduleTempTrend.unit,
                  points: moduleTempTrend.points,
                  tier: moduleTempTrend.tier,
                  flaggedCount: moduleTempTrend.flaggedCount,
                },
              ]}
            />
          )}
        </Panel>
      </div>

      {/*
        The summary row. Each card carries the figures somebody scans for and
        opens its full detail in a drawer — so depth costs a click, never the
        glance. A card whose section cannot be answered here renders inert with
        the reason, rather than opening onto a list of dashes.
      */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryCard
          icon={IconGauge}
          title={`Performance · ${period}`}
          figures={[
            {
              label: "PR",
              value:
                kpis?.performance_ratio.value == null
                  ? UNDEFINED_DISPLAY
                  : formatRatioAsPercent(kpis.performance_ratio.value),
              tone: kpis?.performance_ratio.value == null ? "muted" : "default",
              title: kpis?.performance_ratio.undefined_reason ?? kpis?.performance_ratio.variant ?? undefined,
            },
            {
              label: "Availability",
              value:
                kpis?.availability.value == null
                  ? UNDEFINED_DISPLAY
                  : formatRatioAsPercent(kpis.availability.value),
              tone: kpis?.availability.value == null ? "muted" : "default",
            },
            {
              label: "Energy",
              value: kpis ? formatNumber(kpis.energy_kwh) : "…",
              unit: "kWh",
            },
          ]}
          count={<CoverageBadge coverage={kpis?.coverage} />}
          onOpen={() => setOpen({ kind: "performance" })}
        />

        {panelCards.map(({ code, slots }) => {
          const chrome = PANEL_TITLES[code] ?? {
            title: code,
            subtitle: "",
            icon: IconGauge,
          };
          return (
            <SummaryCard
              key={code}
              icon={chrome.icon}
              title={chrome.title}
              figures={toFigures(slots, 3)}
              count={`${slots.length} figure${slots.length === 1 ? "" : "s"}`}
              onOpen={() => setOpen({ kind: "panel", code })}
            />
          );
        })}

        <SummaryCard
          icon={IconHealth}
          title="Device Health"
          figures={[
            { label: "Online", value: String(healthCounts.online), tone: "ok" },
            {
              label: "Degraded",
              value: String(healthCounts.degraded),
              tone: healthCounts.degraded > 0 ? "warn" : "muted",
            },
            {
              label: "Offline",
              value: String(healthCounts.offline),
              tone: healthCounts.offline > 0 ? "bad" : "muted",
            },
          ]}
          count={`${devices.length} Device${devices.length === 1 ? "" : "s"} registered`}
          accent={healthCounts.offline > 0 ? "bad" : healthCounts.degraded > 0 ? "warn" : null}
          onOpen={() => setOpen({ kind: "health" })}
        />

        <SummaryCard
          icon={IconAlarm}
          title="Alarms"
          figures={[
            {
              label: "Open",
              value: String(alarms.length),
              tone: alarms.length > 0 ? "bad" : "ok",
            },
            {
              label: "Critical",
              value: String(alarms.filter((alarm) => alarm.severity === "critical").length),
              tone: alarms.some((alarm) => alarm.severity === "critical") ? "bad" : "muted",
            },
            {
              label: "Escalated",
              value: String(alarms.filter((alarm) => alarm.escalation_level > 0).length),
              tone: alarms.some((alarm) => alarm.escalation_level > 0) ? "warn" : "muted",
            },
          ]}
          count={alarms.length === 0 ? "Nothing open" : "Active, not yet acknowledged"}
          accent={alarms.length > 0 ? "bad" : null}
          onOpen={() => setOpen({ kind: "alarms" })}
        />

        {/* §6.3: only when the Plant actually has Blocks. Zero is normal. */}
        {blocks.length > 0 ? (
          <SummaryCard
            icon={IconLocation}
            title="Blocks"
            figures={[
              { label: "Blocks", value: String(blocks.length) },
              {
                label: "Capacity",
                value: formatNumber(blocks.reduce((total, block) => total + block.capacity_kwp, 0)),
                unit: "kWp",
              },
            ]}
            count="Geographic grouping — never in the Single Line Diagram"
            onOpen={() => setOpen({ kind: "blocks" })}
          />
        ) : null}
      </div>

      {/*
        The time-series explorer, collapsed. It is the one thing on this screen
        that is a *tool* rather than a reading — somebody using it has a
        specific question and is prepared to build a query — so it costs no
        vertical space until asked for.
      */}
      <details className="group rounded-card border border-line bg-surface-raised">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-semibold text-ink">
          <IconClock size={15} className="text-ink-faint" />
          Explore time series
          <span className="ml-auto text-[11px] font-normal text-ink-faint">
            Pick any Devices and Tags over any range
          </span>
        </summary>
        <div className="border-t border-line p-4">
          <ReadingsPanel devices={devices} timezone={timezone} title="" />
        </div>
      </details>

      {/* ── Detail drawers ──────────────────────────────────────────────── */}
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={drawerTitle}
        subtitle={
          open?.kind === "panel"
            ? PANEL_TITLES[open.code]?.subtitle
            : open?.kind === "stage"
              ? "Every Device whose Type folds into this stage."
              : undefined
        }
      >
        {open?.kind === "performance" ? (
          <PerformancePanel kpis={kpis} period={period} />
        ) : null}

        {open?.kind === "panel" ? (
          <div className="divide-y divide-line-soft">
            {byPosition(panel(open.code)).map((slot) => (
              <SlotRow key={slot.slot_code} slot={slot} />
            ))}
          </div>
        ) : null}

        {open?.kind === "stage" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-card border border-line bg-surface-sunken p-3">
              <DeviceArt
                typeCode={
                  open.stage.code === "INVERTERS" ? "INVERTER" : open.stage.code
                }
                size={64}
              />
              <div className="text-xs text-ink-muted">
                <div className="text-ink">
                  {open.stage.online_count} / {open.stage.device_count} reporting
                </div>
                <div className="mt-0.5 text-[11px]">
                  {open.stage.instrumented
                    ? "Devices registered at this stage."
                    : "No Device is registered at this stage. Normal on a Plant that has none — a commissioning gap on one that does."}
                </div>
              </div>
            </div>
            {open.stage.devices.length === 0 ? (
              <p className="text-xs text-ink-faint">Nothing folds into this stage.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {open.stage.devices.map((device) => (
                  <li key={device.device_id} className="flex items-center gap-2 py-1.5">
                    <DeviceArt typeCode={device.device_type_code} size={26} />
                    <span className="text-xs font-medium text-ink">{device.code}</span>
                    <span className="text-[11px] text-ink-faint">{device.device_type_code}</span>
                    <span
                      className={`ml-auto h-1.5 w-1.5 rounded-full ${device.online ? "bg-ok" : "bg-bad"}`}
                      title={device.online ? "Reporting" : "Not reporting"}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {open?.kind === "device" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-card border border-line bg-surface-sunken p-3">
              <DeviceArt typeCode={open.device.type_code} size={72} />
              <dl className="min-w-0 space-y-0.5 text-[11px]">
                <div className="flex gap-2">
                  <dt className="text-ink-faint">Type</dt>
                  <dd className="text-ink">{open.device.type_name ?? open.device.type_code}</dd>
                </div>
                {open.device.model_code ? (
                  <div className="flex gap-2">
                    <dt className="text-ink-faint">Model</dt>
                    <dd className="truncate text-ink">
                      {open.device.manufacturer ? `${open.device.manufacturer} ` : ""}
                      {open.device.model_code}
                    </dd>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <dt className="text-ink-faint">Comms</dt>
                  <dd><CommStatusBadge status={open.device.comm_status} /></dd>
                </div>
                <div className="flex gap-2">
                  <dt className="text-ink-faint">Interval</dt>
                  <dd
                    className="text-ink"
                    title="Registered from measurement, never from a default. The health sweep calls a Device degraded at twice this."
                  >
                    {open.device.expected_interval_s}s
                  </dd>
                </div>
                {open.device.collector_code ? (
                  <div className="flex gap-2">
                    <dt className="text-ink-faint">Collector</dt>
                    <dd
                      className="text-ink"
                      title="The enclosure this Device publishes from, named by its topic. A Collector is a room, not a component."
                    >
                      {open.device.collector_code}
                    </dd>
                  </div>
                ) : null}
                {open.device.source_address ? (
                  <div className="flex gap-2">
                    <dt className="shrink-0 text-ink-faint">Topic</dt>
                    <dd className="truncate font-mono text-[10px] text-ink-muted">
                      {open.device.source_address}
                    </dd>
                  </div>
                ) : null}
                <div className="flex gap-2">
                  <dt className="text-ink-faint">Last seen</dt>
                  <dd className="text-ink">
                    {open.device.last_seen_at
                      ? formatDateTime(open.device.last_seen_at, timezone)
                      : "never"}
                  </dd>
                </div>
              </dl>
            </div>

            <div>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                Live values
              </h3>
              {(() => {
                const entries = Object.entries(valuesFor(open.device.id) ?? {});
                if (entries.length === 0) {
                  return (
                    <p className="text-[11px] text-ink-faint">
                      No live frame has arrived for this Device. Silence is not zero — it may be
                      off, its Collector may be down, or its Tags may simply be throttled and not
                      due yet.
                    </p>
                  );
                }
                return (
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
                    {entries.map(([tagId, value]) => {
                      const tag = tagsById.get(Number(tagId));
                      return (
                        <div key={tagId} className="flex items-baseline justify-between gap-2">
                          <dt className="truncate text-[10px] text-ink-faint" title={tag?.name}>
                            {tag?.code ?? `#${tagId}`}
                          </dt>
                          <dd className="shrink-0 font-mono text-[11px] tabular-nums text-ink">
                            {/* The unit comes from the catalogue, never from
                                the Tag's name (§4.1). */}
                            {formatValue(value, tag?.unit)}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                );
              })()}
            </div>
          </div>
        ) : null}

        {open?.kind === "health" ? (
          <div className="space-y-3">
            <DeviceHealthStrip health={healthQuery.data} />
            {devicesQuery.isLoading ? (
              <SkeletonTable rows={5} columns={5} />
            ) : (
              <DataTable
                rows={devices}
                columns={deviceColumns}
                rowKey={(device) => device.id}
                filterPlaceholder="Filter Devices…"
              />
            )}
          </div>
        ) : null}

        {open?.kind === "alarms" ? (
          alarms.length === 0 ? (
            <p className="text-xs text-ink-faint">
              No Alarm is open on this Plant. Acknowledged Alarms are excluded — they have
              already reached somebody.
            </p>
          ) : (
            <ul className="divide-y divide-line-soft">
              {alarms.map((alarm) => (
                <li key={alarm.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={alarm.severity} />
                    <span className="truncate text-xs text-ink">{alarm.message}</span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-ink-faint">
                    <span>{alarm.device_code ?? "Plant-wide"}</span>
                    <span>{formatDateTime(alarm.opened_at, timezone)}</span>
                    <span
                      title="Tender §18 keeps communication loss and equipment downtime separate — absence alone never proves which."
                    >
                      {alarm.classification ?? "unclassified"}
                    </span>
                    {alarm.escalation_level > 0 ? (
                      <span className="text-warn">escalated L{alarm.escalation_level}</span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {open?.kind === "blocks" ? (
          <div className="space-y-2">
            {blocks.map((block, index) => {
              const blockKpi = blockKpiQueries[index]?.data as BlockKpis | undefined;
              return (
                <div key={block.id} className="rounded-card border border-line p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-ink">{block.code}</span>
                    <span className="text-[11px] text-ink-muted">
                      {formatCapacity(block.capacity_kwp, "kWp")}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-muted">{block.name}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[10px] text-ink-faint">Energy</div>
                      <div className="font-mono text-xs tabular-nums text-ink">
                        {blockKpi ? `${formatNumber(blockKpi.energy_kwh)} kWh` : "…"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-ink-faint">Specific yield</div>
                      <div
                        className={`font-mono text-xs tabular-nums ${
                          blockKpi?.specific_yield.value === null ? "text-ink-faint" : "text-ink"
                        }`}
                        title={
                          blockKpi?.specific_yield.undefined_reason ??
                          blockKpi?.specific_yield.variant ??
                          undefined
                        }
                      >
                        {blockKpi ? formatValue(blockKpi.specific_yield.value, "kWh/kWp") : "…"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-1.5 text-[10px] text-ink-faint">
                    {block.device_count} Device(s)
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
