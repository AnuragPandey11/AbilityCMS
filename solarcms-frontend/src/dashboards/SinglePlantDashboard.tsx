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
 * So depth is reached sideways or in a drawer rather than downwards, and the
 * first screen answers "is the Plant working, and how well":
 *
 *   headline strip    Current Power, then PR, CUF and availability as gauges
 *                     over the Period, with the coverage that qualifies them
 *   status rail       Plant Status and Energy Summary, the client's two list
 *                     cards, down the left — beside the schematic and the
 *                     power trend, which need the width
 *   Inverters         a carousel — seventeen peers go across, not down —
 *                     beside the weather charts
 *   summary row       one card per section, each opening its full detail
 *   energy cards      today, month and lifetime energy, drawn
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

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
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
  usePlantOperatingStatus,
} from "@/api/hooks";
import { useSlotTrend, TREND_RANGES, type TrendPoint, type TrendRange } from "@/api/useSlotTrend";
import { useSlotSteps } from "@/api/useSlotSteps";
import { useLatestValues } from "@/api/useLatestValues";
import { useTypeColumns } from "@/api/useTypeColumns";
import { qk } from "@/api/queryKeys";
import * as plantsApi from "@/api/endpoints/plants";
import type {
  BlockKpis,
  DeviceListItem,
  ResolvedSlot,
  SldStage,
} from "@/api/schemas";
import { Panel, SegmentedControl, Drawer } from "@/components/ui";
import { useScrollPager } from "@/components/ui/Carousel";
import { TrendChart, SmallMultiples } from "@/components/charts/TrendChart";
import { CheckboxMenu } from "@/components/ui/CheckboxMenu";
import {
  PowerComparisonChart,
  SeriesSwatch,
  slotColor,
} from "./single-plant/PowerComparisonChart";
import {
  COMPARE_DEFAULT,
  COMPARE_SLOT,
  usePowerComparison,
  type CompareKey,
} from "./single-plant/usePowerComparison";
import { ReadingsPanel } from "@/components/charts/ReadingsPanel";
import { PlantSchematic } from "@/components/sld/PlantSchematic";
import { DeviceFigureCard } from "@/components/devices/DeviceFigureCard";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DeviceInspector } from "@/components/devices/DeviceInspector";
import { SummaryCard, type SummaryFigure } from "@/components/dashboard/SummaryCard";
import { SlotRow, slotText } from "@/components/dashboard/SlotValue";
import {
  PerformanceDetailsButton,
  PerformancePanel,
  PerformanceTiles,
} from "./single-plant/PerformancePanel";
import { RailTile } from "@/components/charts/RailTile";
import { OperatingDetail, PlantStatusCard } from "./single-plant/PlantStatusCard";
import { EnergySummaryCard } from "./single-plant/EnergySummaryCard";
import { PowerSummary } from "./single-plant/PowerSummary";
import { fullyDuplicated } from "./single-plant/duplication";
import {
  EmptyState,
  ErrorState,
  Skeleton,
  SkeletonKpiRow,
  SkeletonPanel,
  SkeletonTable,
} from "@/components/state";
import { PlantStatusControl } from "@/admin/PlantStatusControl";
import { HeaderContent } from "@/components/layout/HeaderSlot";
import { HeadlineCard } from "@/dashboards/single-plant/HeadlineCards";
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
  IconChevronLeft,
  IconChevronRight,
  IconClock,
  IconEnergy,
  IconGauge,
  IconHealth,
  IconIrradiance,
  IconLocation,
  IconPower,
  IconSignal,
} from "@/components/icons";
import {
  formatCapacity,
  formatNumber,
  formatValue,
  UNDEFINED_DISPLAY,
} from "@/format/value";
import { formatDateTime, timezoneLabel } from "@/format/datetime";
import { useSelection } from "@/state/selection";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { usePermission } from "@/auth/usePermission";
import { useLiveSocket } from "@/live/LiveSocket";
import { useLiveRefresh } from "@/live/useLiveRefresh";

/**
 * Which icon labels a headline slot — per *quantity*: a bolt for a rate,
 * accumulating bars for an energy total. Presentation only.
 */
const SLOT_ICONS: Record<string, typeof IconPower> = {
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
    title: "Power Summary",
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

/**
 * The energy cards at the foot of the page. Each is a drawing of a register —
 * a month of columns, an odometer — read for its shape once the state of the
 * Plant has been read above. Today's sun clock is not here: it closes the
 * headline strip, where it carries the way into the performance detail.
 */
const ENERGY_CARDS = ["kpi.energy_month", "kpi.energy_lifetime"];

/** Literal class names, so Tailwind's scanner emits every one. */
const ENERGY_COLUMNS: Record<number, string> = {
  1: "",
  2: "md:grid-cols-2",
};

/**
 * The panels whose figures the status rail already carries: Plant Status holds
 * the weather and opens onto the electrical boundary, Energy Summary opens
 * onto the energy panel. A summary card for any of them would be a second
 * copy of a card that is on the first screen.
 */
const ON_THE_RAIL = new Set(["plant_status", "energy_summary", "environment"]);

/**
 * The energy panel's rows for the Energy Summary drawer, less start and stop:
 * those are on Plant Status, derived from history by one rule, and the Plant
 * KPI Device's copies here would be a second answer to the same question.
 */
const RAIL_OWNS = new Set(["energy.plant_start", "energy.plant_stop"]);

/**
 * Summary-row columns, by how many cards there are.
 *
 * The count varies by Plant — Power Summary drops out when the headline slots
 * already answer it, and Blocks appears only where there are some — so a fixed
 * column count left a row ending in a hole. With the status rail holding the
 * other panels it is two to four: three go across from `md`, four go two by
 * two until there is room for all four. Literal class names, so Tailwind's
 * scanner emits every one.
 */
const SUMMARY_COLUMNS: Record<number, string> = {
  2: "",
  3: "md:grid-cols-3",
  4: "xl:grid-cols-4",
};

/** Which drawer is open. `null` is the normal state. */
type OpenPanel =
  | { kind: "panel"; code: string }
  | { kind: "performance" }
  | { kind: "status" }
  | { kind: "energy" }
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

/** A panel title at the size every panel on this screen uses. */
const heading = (text: string) => <span className="text-lg">{text}</span>;
const lede = (text: string) => <span className="text-sm">{text}</span>;

/**
 * The Plant's Devices, one Device Type at a time, sideways.
 *
 * Seventeen peers stacked vertically is 2000px of page and everything below
 * them falls off the screen; across, the first three are visible and the rest
 * are one press away. The type chips come first because the question is
 * usually "show me the meter", and the paging buttons sit under them rather
 * than over the cards, where they would cover a figure.
 */
function DeviceStrip({
  groups,
  current,
  onPick,
  isFallback,
  children,
  count,
}: {
  groups: { typeCode: string; devices: DeviceListItem[] }[];
  current: string;
  onPick: (typeCode: string) => void;
  /** True when the Type has no curated columns and a Device's bindings stand in. */
  isFallback: boolean;
  children: ReactNode;
  count: number;
}): JSX.Element {
  const pager = useScrollPager<HTMLDivElement>(undefined, `${current}:${count}`);
  const pageBy = (direction: -1 | 1) => {
    const track = pager.ref.current;
    if (!track) return;
    track.scrollBy({ left: direction * (track.clientWidth + 16), behavior: "smooth" });
  };
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Device Type">
        {groups.map((option) => {
          const active = option.typeCode === current;
          return (
            <button
              key={option.typeCode}
              type="button"
              onClick={() => onPick(option.typeCode)}
              aria-pressed={active}
              title={`${option.devices.length} ${option.typeCode}`}
              className={`rounded-full border px-4 py-1.5 text-sm font-semibold transition ${
                active
                  ? "border-accent/60 bg-accent/10 text-accent"
                  : "border-line text-ink hover:border-line-strong"
              }`}
            >
              {option.typeCode}
              <span className={`ml-1.5 ${active ? "" : "text-ink-muted"}`}>
                {option.devices.length}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex min-h-9 items-center gap-3">
        {pager.overflows ? (
          <>
            <button
              type="button"
              onClick={() => pageBy(-1)}
              disabled={pager.atStart}
              aria-label={`Previous ${current}`}
              className="surface-tile flex h-9 w-9 items-center justify-center rounded-control border border-line text-ink-muted transition hover:text-ink disabled:opacity-40"
            >
              <IconChevronLeft size={15} />
            </button>
            <button
              type="button"
              onClick={() => pageBy(1)}
              disabled={pager.atEnd}
              aria-label={`Next ${current}`}
              className="surface-tile flex h-9 w-9 items-center justify-center rounded-control border border-line text-ink-muted transition hover:text-ink disabled:opacity-40"
            >
              <IconChevronRight size={15} />
            </button>
          </>
        ) : null}
        {/* Two different silences, and which one it is decides where to go
            (Guardrail 26): an uncurated Type is fine, and says so. */}
        {isFallback ? (
          <span className="text-xs text-ink-faint">
            No summary columns are curated for {current}, so these are its own bound
            signals. Tap a card for everything it reports.
          </span>
        ) : null}
      </div>

      <div
        ref={pager.ref}
        role="group"
        aria-label={`${current} Devices`}
        className="mt-4 flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none]"
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Whether the viewport is at least `px` wide, following it as it changes.
 * False where there is no `matchMedia` (jsdom), which is the narrow layout.
 */
function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const read = () => typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [matches, setMatches] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * The trend chart's height. Beside the status rail it is the one flexible
 * thing in the right-hand column, so it is sized to end where the rail ends —
 * the rail is ten rows over six on every Plant, so that is a constant, not a
 * measurement. Below `xl` the rail sits above it and the chart keeps the height
 * it always had. Measured rather than flexed: a chart that grew to fill its
 * cell would also grow the row it sits in.
 */
const TREND_HEIGHT = { beside_rail: 370, stacked: 230 };

/**
 * How many of the Plant's days the Energy view shows for each chart window.
 * A per-day chart cannot show "the last 24 hours", so each window becomes the
 * calendar days it touches: 24h is yesterday and today.
 */
const ENERGY_DAYS: Record<TrendRange, number> = { today: 1, "24h": 2, "7d": 7, "30d": 30 };

/**
 * A chart panel's own window, inside the panel it scopes.
 *
 * It used to be one control in the page's filter row, beside `Period`, driving
 * every chart at once — which read as though it scoped the gauges too, and
 * gave no way to tell which charts followed it. Each chart panel now carries
 * its own, so what a control changes is the panel it sits in and nothing else.
 */
function ChartWindow({
  label,
  value,
  onChange,
}: {
  /** Names the group for a screen reader: which chart this window is for. */
  label: string;
  value: TrendRange;
  onChange: (value: TrendRange) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span
        className="text-xs font-medium text-ink-muted"
        title="The span of readings this chart shows. Separate from Period: 'today' and 'the last 24 hours' are different ranges."
      >
        Window
      </span>
      <SegmentedControl
        label={label}
        value={value}
        onChange={onChange}
        options={TREND_RANGES.map((option) => ({
          value: option.value,
          label: option.label,
          hint: option.hint,
        }))}
      />
    </div>
  );
}

/**
 * DC and AC nameplate, then the timezone every timestamp on the page is in.
 * Rendered in the header from `xl` and at the head of the filter row below it.
 */
function PlantNameplate({
  plant,
  timezone,
}: {
  plant: { dc_capacity_kwp: number | null; ac_capacity_kw: number | null };
  timezone: string;
}): JSX.Element {
  return (
    <>
      <span className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-muted">
        <span title="Nameplate DC capacity from the Plant record.">
          DC{" "}
          <span className="figure font-semibold text-ink">
            {formatCapacity(plant.dc_capacity_kwp, "kWp")}
          </span>
        </span>
        <span className="text-ink-faint">·</span>
        <span title="Nameplate AC capacity from the Plant record.">
          AC{" "}
          <span className="figure font-semibold text-ink">
            {formatCapacity(plant.ac_capacity_kw, "kW")}
          </span>
        </span>
      </span>
      <span
        className="surface-tile whitespace-nowrap rounded-control border border-line px-2.5 py-1 text-xs text-ink-muted"
        title="Every timestamp on this screen renders in the Plant's timezone, not the browser's."
      >
        {timezoneLabel(timezone)}
      </span>
    </>
  );
}

export function SinglePlantDashboard(): JSX.Element {
  const navigate = useNavigate();
  const canManage = usePermission("plant.manage");
  // `range` is the Power trend panel's window, `weatherRange` the Weather
  // panel's — each set by the control inside its own panel. Both are the
  // Plant's day by default, framed 00:00–24:00: a generation curve is read for
  // the shape of a day, and a rolling 24 hours splits that shape in two.
  const {
    period,
    setPeriod,
    trendRange: range,
    setTrendRange: setRange,
    weatherRange,
    setWeatherRange,
  } = useSelection();
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const [chartView, setChartView] = useState<"power" | "energy">("power");
  const [open, setOpen] = useState<OpenPanel>(null);
  // Tailwind's `xl`, where the status rail moves beside the charts.
  const besideRail = useMinWidth(1280);
  const trendHeight = besideRail ? TREND_HEIGHT.beside_rail : TREND_HEIGHT.stacked;

  const plantQuery = usePlant(plantId);
  // The slots and KPI tiles refetch when this Plant's readings actually arrive,
  // rather than on a timer that fires whether or not anything happened. The
  // server still computes every figure, with its provenance — the socket only
  // says "there is something new to ask for".
  useLiveRefresh(plantId);

  const kpisQuery = usePlantKpis(plantId, period);
  // Energy Summary is about today whatever the Period says. When the Period is
  // today this is the same cache entry as the gauges', so the two PRs are one.
  const kpisTodayQuery = usePlantKpis(plantId, "today");
  const operatingQuery = usePlantOperatingStatus(plantId);
  const dashboardQuery = usePlantDashboard(plantId);
  const columnsQuery = useDeviceTableColumns();
  const blocksQuery = usePlantBlocks(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const healthQuery = useDeviceHealth(plantId);
  const alarmsQuery = useAlarms({ plantId: plantId ?? undefined, state: "active" });
  const { devices: liveDevices } = useLiveSocket();

  // The two charts. Both read the slot the server already resolved, so the
  // curve under a tile is the same claim as the tile — same Device Type, same
  // Tag, same aggregate (see `useSlotTrend`).
  const powerTrend = useSlotTrend(plantId, "kpi.current_power", range);
  /*
    Energy per day, from the same slot the "Today's Energy" tile uses — built
    from hourly readings and grouped by the Plant's own midnights.

    ⚠ Not from the daily tier. `agg_1d` buckets are cut at UTC midnight, and
    `ENERGY_TODAY` resets at the Plant's — for Kolkata 18:30 UTC, inside the
    bucket — so the bucket's `last` was a reading taken after the reset, and
    every finished day read as roughly nothing wherever equipment reports
    overnight. The Month Energy card's columns come from the same code, so the
    two cannot disagree about a day.
  */
  const energyDays = useSlotSteps(
    plantId,
    "kpi.energy_today",
    { days: ENERGY_DAYS[range] },
    // Fetched only while the Energy view is showing: a month of hourly buckets
    // is not a cost to pay for a chart behind a toggle.
    { enabled: chartView === "energy", resetsExpected: true },
  );
  const energyPoints = useMemo<TrendPoint[]>(
    () =>
      energyDays.periods.map((day) => ({
        at: new Date(day.start).toISOString(),
        value: day.energy,
        contributors: day.contributors,
      })),
    [energyDays.periods],
  );
  const irradianceTrend = useSlotTrend(plantId, "env.irradiance", range);
  // What the power trend is compared with: direct radiation by default, as the
  // client's reference chart draws it, and the two nameplate references on
  // request. See `single-plant/powerComparison` for what each curve is.
  const radiationTrend = useSlotTrend(plantId, "env.direct_radiation", range);
  // The Inverters' own efficiency, for the AC reference's conversion loss.
  const efficiencyTrend = useSlotTrend(plantId, "sld.inv.efficiency", range);
  const [compareWith, setCompareWith] = useState<Set<CompareKey>>(() => new Set(COMPARE_DEFAULT));
  const comparison = usePowerComparison({
    power: powerTrend,
    radiation: radiationTrend,
    irradiance: irradianceTrend,
    efficiency: efficiencyTrend,
    environment: dashboardQuery.data?.panels.environment,
    dcCapacityKwp: plantQuery.data?.dc_capacity_kwp,
    acCapacityKw: plantQuery.data?.ac_capacity_kw,
    chosen: compareWith,
  });
  // The Weather panel's own series, on its own window. Irradiance is asked for
  // twice — the Power trend's Exp Power (DC) needs it on that panel's window —
  // but with the two windows equal the query keys match and it is fetched once.
  const weatherIrradianceTrend = useSlotTrend(plantId, "env.irradiance", weatherRange);
  const moduleTempTrend = useSlotTrend(plantId, "env.module_temperature", weatherRange);

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
    return (
      [...byType]
        .filter(([, group]) => group.length > 0)
        // Most numerous first: the seventeen Inverters are what the carousel is
        // for, and a single meter above them wastes the row.
        .sort((a, b) => b[1].length - a[1].length)
        .map(([typeCode, group]) => ({
          typeCode,
          devices: [...group].sort((a, b) =>
            a.code.localeCompare(b.code, undefined, { numeric: true }),
          ),
          /** Empty for an uncurated Type; `useTypeColumns` fills it in. */
          columns: columns[typeCode] ?? [],
        }))
    );
  }, [devices, columnsQuery.data]);

  /**
   * Which Device Type the carousel is showing.
   *
   * It used to show only the most numerous group, which on this Plant meant the
   * seventeen Inverters and *nothing else* — the meter, the transformer, the
   * weather station and the plant controller were reachable only by opening a
   * schematic stage or the health table. Six registered Devices with no route
   * to them from the screen that is meant to show the Plant.
   *
   * A type switcher costs one row of chips and makes every Device on the Plant
   * two clicks away, without the page growing by a panel per type.
   */
  const [stripType, setStripType] = useState<string | null>(null);
  const strip =
    deviceGroups.find((group) => group.typeCode === stripType) ?? deviceGroups[0] ?? null;
  /**
   * The selected strip's columns — from the catalogue where it has been
   * curated, from a Device's own bindings where it has not. Without the
   * fallback, a Type nobody curated was dropped from the screen entirely.
   */
  const stripColumns = useTypeColumns(strip?.typeCode ?? null, strip?.devices[0] ?? null);

  const latest = useLatestValues(
    strip?.devices.map((device) => device.id) ?? [],
    stripColumns.columns.map((column) => column.tag_id),
    strip !== null && stripColumns.columns.length > 0,
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

  /** id → Device, so the inspector can name a parent rather than print `#38`. */
  const deviceById = useMemo(
    () => new Map(devices.map((device) => [device.id, device])),
    [devices],
  );

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
        <div className="grid gap-5 xl:grid-cols-12">
          <div className="xl:col-span-3"><SkeletonPanel lines={10} /></div>
          <div className="space-y-5 xl:col-span-9">
            <SkeletonPanel lines={4} />
            <SkeletonPanel lines={4} />
          </div>
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

  /** The panel cards, minus the rail's and any the headline slots already answered. */
  const panelCards = ["plant_status", "power_summary", "energy_summary", "environment"]
    .filter((code) => !ON_THE_RAIL.has(code))
    .map((code) => ({ code, slots: panel(code) }))
    .filter(({ slots }) => slots.length > 0 && !fullyDuplicated(slots, headline));
  const slotByCode = new Map(headline.map((slot) => [slot.slot_code, slot]));
  const currentPower = slotByCode.get("kpi.current_power");
  const energyToday = slotByCode.get("kpi.energy_today");
  const energyCards = ENERGY_CARDS.flatMap((code) => {
    const slot = slotByCode.get(code);
    return slot ? [slot] : [];
  });
  // Panel cards, Device Health, Alarms, and Blocks where the Plant has any.
  const summaryCount = panelCards.length + 2 + (blocks.length > 0 ? 1 : 0);

  /** Into the performance drawer, with the gauges' coverage on it. */
  const performanceButton = (
    <PerformanceDetailsButton
      kpis={kpis}
      period={period}
      timeZone={timezone}
      onOpen={() => setOpen({ kind: "performance" })}
    />
  );

  const drawerTitle = (() => {
    if (!open) return "";
    switch (open.kind) {
      case "panel":
        return PANEL_TITLES[open.code]?.title ?? open.code;
      case "performance":
        return `Performance — ${period}`;
      case "status":
        return "Plant Status";
      case "energy":
        return "Energy Summary — today";
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

  /**
   * Where a drawer leads.
   *
   * A summary that opens a panel and stops there is a dead end: the operator
   * came to the card because something looked wrong, and the detail behind it
   * is usually one step short of the screen that lets them act. Every drawer
   * that has a fuller home names it, and the ones whose fuller home is another
   * Device open that Device instead.
   */
  const drawerFooter = (() => {
    if (!open) return null;
    const link = (to: string, label: string) => (
      <button
        type="button"
        onClick={() => {
          setOpen(null);
          navigate(to);
        }}
        className="flex w-full items-center justify-between gap-2 rounded-control border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
      >
        {label}
        <IconChevronRight size={13} />
      </button>
    );
    switch (open.kind) {
      case "alarms":
        return link("/d/alarms", "Open the Alarms dashboard");
      case "performance":
      case "energy":
        return link("/d/reports", "Generate a performance report");
      case "device":
        return canManage
          ? link("/admin/plant-setup", `Configure ${open.device.code} in Plants & Devices`)
          : null;
      case "health":
        return link("/d/sld", "See how these Devices are connected");
      case "stage":
        return link("/d/sld", "Open the full Single Line Diagram");
      case "status":
      case "panel":
        // These panels are answered by Devices; the useful next step is the
        // list of what answered them, which is one drawer away rather than
        // one navigation.
        return (
          <button
            type="button"
            onClick={() => setOpen({ kind: "health" })}
            className="flex w-full items-center justify-between gap-2 rounded-control border border-line px-2.5 py-1.5 text-[11px] font-medium text-ink-muted transition hover:border-accent/50 hover:text-accent"
          >
            See the Devices behind these figures
            <IconChevronRight size={13} />
          </button>
        );
      default:
        return null;
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
    <div className="flex flex-col gap-5">
      {/*
        The Plant's identity rides in the application header, beside the live
        state, so it stays in view as the page scrolls and the filters get the
        top of the page to themselves. It is one line there, so the nameplate
        and timezone step out of it below `xl`, and the status control below
        `sm`, rather than wrap the bar or overlap the code — and reappear at the
        end of the filter row, because the timezone says how to read every
        timestamp on the page and cannot simply go missing.
      */}
      <HeaderContent>
        <div className="flex min-w-0 items-center gap-x-3">
          <h1 className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 font-mono text-xl font-bold tracking-tight text-ink">{plant.code}</span>
            <span className="hidden truncate text-base font-medium text-ink-muted sm:inline">{plant.name}</span>
          </h1>
          {/*
            The control, not the badge beside it: `PlantStatusControl` already
            renders the status and adds the transition next to it, so showing a
            status badge here too put the word "active" on the screen twice,
            40px apart, which reads as two different facts.

            Status is edited where the Plant is looked at. It used to be
            reachable only from the onboarding wizard, so a Plant that finished
            commissioning a week later could be activated only by walking back
            through a form built for creating one.
          */}
          <div className="hidden sm:flex">
            <PlantStatusControl plantId={plant.id} status={plant.status} />
          </div>
          <div className="hidden shrink-0 items-center gap-3 xl:flex">
            <PlantNameplate plant={plant} timezone={timezone} />
          </div>
        </div>
      </HeaderContent>

      {/*
        One filter row, above everything it scopes. `Period` drives the
        derived figures, computed over a calendar period from aggregates. The
        charts' `Window` is not here: each chart panel carries its own, inside
        the panel it scopes (see `ChartWindow`). "Today" and "the last 24
        hours" are not the same range and must not share a control.
      */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" size="lg" />
        <div className="flex items-center gap-2.5">
          <span
            className="text-sm font-medium text-ink-muted"
            title="Scopes the derived figures — PR, CUF, availability — which are computed over a calendar period."
          >
            Period
          </span>
          <PeriodPicker value={period} onChange={setPeriod} size="lg" />
        </div>
        {/* What the header had no room for at this width. */}
        <div className="flex flex-wrap items-center gap-3 xl:hidden">
          <div className="sm:hidden">
            <PlantStatusControl plantId={plant.id} status={plant.status} />
          </div>
          <PlantNameplate plant={plant} timezone={timezone} />
        </div>
      </header>

      {/*
        The headline strip: what the Plant is doing now, how well it did over
        the Period, and what it has made today. Current Power and today's energy
        are live; the three gauges between them are derived and provisional,
        which is why each says its period — and why the button into their
        detail carries their coverage, so it stays in the same row as the
        figures it qualifies (Guardrail 18).
      */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {dashboardQuery.isLoading ? (
          <Skeleton className="rounded-card" style={{ minHeight: 270 }} />
        ) : dashboardQuery.isError ? (
          <ErrorState error={dashboardQuery.error} retry={() => void dashboardQuery.refetch()} />
        ) : currentPower ? (
          <HeadlineCard
            slot={currentPower}
            icon={SLOT_ICONS[currentPower.slot_code] ?? IconGauge}
            plantId={plant.id}
            acCapacityKw={plant.ac_capacity_kw}
          />
        ) : null}
        <PerformanceTiles
          kpis={kpis}
          period={period}
          isLoading={kpisQuery.isLoading}
          error={kpisQuery.error}
          retry={() => void kpisQuery.refetch()}
        />
        {/* Spans the row at `sm`, where the strip is two columns and it is the
            fifth tile — alone it would leave a hole beside it. */}
        <div className="flex sm:col-span-2 xl:col-span-1 [&>*]:flex-1">
          {dashboardQuery.isLoading ? (
            <Skeleton className="rounded-card" style={{ minHeight: 270 }} />
          ) : energyToday ? (
            <HeadlineCard
              slot={energyToday}
              icon={SLOT_ICONS[energyToday.slot_code] ?? IconGauge}
              plantId={plant.id}
              acCapacityKw={plant.ac_capacity_kw}
              action={performanceButton}
              compact
            />
          ) : (
            // The slot never hides (it is a headline position), so this is the
            // dashboard request failing — the first tile says so. The way into
            // the performance detail must not go with it.
            <RailTile
              icon={IconEnergy}
              label="Today's Energy"
              footnote="The dashboard could not be loaded."
              action={performanceButton}
            />
          )}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[20rem_minmax(0,1fr)]">
        {/*
          The status rail. The client's two list cards, one above the other,
          down the left: what state the Plant is in and what it has made today,
          read at the first glance without scrolling. Down the side rather than
          across a row because they are tall and narrow by nature — ten short
          rows — and the schematic beside them needs the width: its four stages
          scroll sideways below about 650px, and squeezed between two cards
          they would. A fixed width rather than a share of twelve: the rows'
          labels are the client's own wording and must not be cut short.
        */}
        <div className="grid gap-5 md:grid-cols-2 xl:flex xl:flex-col">
          <PlantStatusCard
            status={operatingQuery.data}
            isLoading={operatingQuery.isLoading}
            environment={panel("environment")}
            devices={devices}
            health={healthCounts}
            timeZone={timezone}
            onOpen={() => setOpen({ kind: "status" })}
          />
          <EnergySummaryCard
            headline={headline}
            today={kpisTodayQuery.data}
            onOpen={() => setOpen({ kind: "energy" })}
            className="xl:flex-1"
          />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/*
            The four-stage schematic, fixed on every Plant. The detailed
            `parent_device_id` tree — which Inverter is the broken one — lives on
            the SLD dashboard; this answers the other question, whether the Plant
            is healthy at a glance and how it compares with the next one.
          */}
          {/* Default padding, unchanged: the schematic keeps exactly the room it
              had, and at mid widths every pixel is a stage that does not scroll. */}
          <Panel
            fill
            className="min-w-0"
            title={heading("Plant Schematic")}
            subtitle={lede(
              "PV Array → Inverters → Transformer → Grid. Every power-path Device folds into one of the four by its Device Type.",
            )}
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


          {/*
            Two charts, one panel. Power over time and energy per day are the two
            questions asked of a Plant's output and they are asked at different
            altitudes — "what is it doing" and "how much did it make" — so they
            are genuinely different views rather than two series to overlay.
            Stacking them as separate panels would have cost a third of the
            screen for a chart most visits do not look at.
          */}
          <Panel
            fill
            padding="p-5"
            className="min-w-0 flex-1"
            title={heading(
              chartView === "power"
                ? `Power trend${powerTrend.unit ? ` (${powerTrend.unit})` : ""}`
                : "Energy per day",
            )}
            subtitle={lede(
              chartView === "power"
                ? `Actual output ${range === "today" ? "across the Plant's day" : "over the window"}, against what it is compared with. Gaps are drawn as gaps — a Plant that reported nothing was not producing zero.`
                : "One bar per Plant day, midnight to midnight: what each Device's counter added that day. A day nothing measured is left empty, not drawn as zero.",
            )}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              {/* The window scopes both views of this chart, so it sits beside
                  the switch between them rather than inside either. */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <SegmentedControl
                  label="Chart view"
                  size="lg"
                  value={chartView}
                  onChange={setChartView}
                  options={[
                    { value: "power", label: "Power", hint: "Output over the selected window." },
                    { value: "energy", label: "Energy", hint: "Generation per day over the selected window." },
                  ]}
                />
                <ChartWindow label="Power trend window" value={range} onChange={setRange} />
              </div>
              {chartView === "power" && !powerTrend.unavailableReason ? (
                <CheckboxMenu
                  label="Select options"
                  ariaLabel="Compare the power trend with"
                  selected={compareWith}
                  onChange={setCompareWith}
                  options={comparison.options.map((option) => ({
                    ...option,
                    swatch: <SeriesSwatch line={option.line} color={slotColor(COMPARE_SLOT[option.value])} />,
                  }))}
                />
              ) : null}
            </div>
            {chartView === "power" ? (
              powerTrend.unavailableReason ? (
                <p className="py-8 text-center text-xs text-ink-faint">
                  {powerTrend.unavailableReason}
                </p>
              ) : (
                <PowerComparisonChart
                  series={comparison.series}
                  perWm2={comparison.perWm2}
                  dcCapacityKwp={plant.dc_capacity_kwp}
                  tier={powerTrend.tier}
                  provenance={powerTrend.provenance}
                  flaggedCount={comparison.flaggedCount}
                  isLoading={comparison.isLoading}
                  timezone={timezone}
                  height={trendHeight}
                  day={powerTrend.day}
                />
              )
            ) : energyDays.unavailableReason || energyDays.isError ? (
              <p className="py-8 text-center text-xs text-ink-faint">
                {energyDays.unavailableReason ?? "The daily energy could not be loaded."}
              </p>
            ) : (
              <TrendChart
                points={energyPoints}
                unit={energyDays.unit}
                label="Energy"
                // One point per Plant day, so dates format as days; the badge
                // says where the days came from rather than naming this tier.
                tier="agg_1d"
                resolution={{
                  label: "Plant days, from hourly readings",
                  title:
                    "Each bar is the energy every Device's counter added between two of the Plant's midnights, " +
                    "summed. Built from hourly buckets because the daily tier is cut at UTC midnight, not the Plant's.",
                }}
                provenance={energyDays.provenance}
                flaggedCount={energyDays.flaggedCount}
                isLoading={energyDays.isLoading}
                timezone={timezone}
                height={trendHeight}
                shape="bar"
                // The largest day in a month is not a fact anybody acts on, and
                // the label would sit over a neighbouring bar.
                markPeak={false}
              />
            )}
          </Panel>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-12">
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
            strip ? (
              <Panel fill tray padding="p-5" className="h-full">
                <DeviceStrip
                  groups={deviceGroups}
                  current={strip.typeCode}
                  onPick={setStripType}
                  isFallback={stripColumns.isFallback}
                  count={strip.devices.length}
                >
                  {strip.devices.map((device) => (
                    <div key={device.id} className="w-[17.5rem] shrink-0 snap-start">
                      <DeviceFigureCard
                        device={device}
                        columns={stripColumns.columns}
                        maxFigures={6}
                        values={valuesFor(device.id)}
                        onSelect={(selected) => setOpen({ kind: "device", device: selected })}
                        selected={open?.kind === "device" && open.device.id === device.id}
                      />
                    </div>
                  ))}
                </DeviceStrip>
              </Panel>
            ) : null
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
          padding="p-5"
          className="xl:col-span-4"
          title={heading("Weather")}
          subtitle={lede(
            "Two measures, two scales, one shared time axis — never one plot with two y-axes.",
          )}
        >
          {weatherIrradianceTrend.unavailableReason && moduleTempTrend.unavailableReason ? (
            <p className="py-8 text-center text-xs text-ink-faint">
              {weatherIrradianceTrend.unavailableReason}
            </p>
          ) : (
            <>
              <div className="mb-3">
                <ChartWindow label="Weather window" value={weatherRange} onChange={setWeatherRange} />
              </div>
              <SmallMultiples
                timezone={timezone}
                height={210}
                day={weatherIrradianceTrend.day}
                series={[
                  {
                    key: "irradiance",
                    label: weatherIrradianceTrend.label,
                    unit: weatherIrradianceTrend.unit,
                    points: weatherIrradianceTrend.points,
                    tier: weatherIrradianceTrend.tier,
                    flaggedCount: weatherIrradianceTrend.flaggedCount,
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
            </>
          )}
        </Panel>
      </div>

      {/*
        The summary row. Each card carries the figures somebody scans for and
        opens its full detail in a drawer — so depth costs a click, never the
        glance. A card whose section cannot be answered here renders inert with
        the reason, rather than opening onto a list of dashes. Performance,
        Plant Status, Energy and Weather are not here: their gauges are in the
        headline strip and their figures on the status rail, and a card
        repeating them below would be a second copy.
      */}
      <div
        className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${SUMMARY_COLUMNS[summaryCount] ?? ""}`}
      >
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
        The energy registers, drawn: a month of daily columns and the lifetime
        odometer. At the foot of the page because they answer "how much, and
        when", which is read after "is it working".
      */}
      {energyCards.length > 0 ? (
        <div className={`grid grid-cols-1 gap-4 ${ENERGY_COLUMNS[energyCards.length] ?? ""}`}>
          {energyCards.map((slot) => (
            <HeadlineCard
              key={slot.slot_code}
              slot={slot}
              icon={SLOT_ICONS[slot.slot_code] ?? IconGauge}
              plantId={plant.id}
              acCapacityKw={plant.ac_capacity_kw}
            />
          ))}
        </div>
      ) : null}

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
        footer={drawerFooter}
      >
        {open?.kind === "performance" ? (
          <PerformancePanel kpis={kpis} period={period} />
        ) : null}

        {/* Everything behind Plant Status: how its derived rows were decided,
            then the electrical boundary and the weather in full. */}
        {open?.kind === "status" ? (
          <div className="space-y-5">
            <OperatingDetail status={operatingQuery.data} timeZone={timezone} />
            {(
              [
                ["plant_status", "At the grid boundary"],
                ["environment", "Weather"],
              ] as const
            ).map(([code, title]) =>
              panel(code).length > 0 ? (
                <section key={code}>
                  <h3 className="field-label mb-1">{title}</h3>
                  <div className="divide-y divide-line-soft">
                    {byPosition(panel(code)).map((slot) => (
                      <SlotRow key={slot.slot_code} slot={slot} />
                    ))}
                  </div>
                </section>
              ) : null,
            )}
          </div>
        ) : null}

        {/* Everything behind Energy Summary: the energy panel in full, then
            what today's derived figures were computed from. */}
        {open?.kind === "energy" ? (
          <div className="space-y-5">
            {panel("energy_summary").some((slot) => !RAIL_OWNS.has(slot.slot_code)) ? (
              <div className="divide-y divide-line-soft">
                {byPosition(panel("energy_summary"))
                  .filter((slot) => !RAIL_OWNS.has(slot.slot_code))
                  .map((slot) => (
                    <SlotRow key={slot.slot_code} slot={slot} />
                  ))}
              </div>
            ) : null}
            <PerformancePanel kpis={kpisTodayQuery.data} period="today" />
          </div>
        ) : null}

        {open?.kind === "panel" && open.code === "power_summary" ? (
          <PowerSummary
            slots={panel("power_summary")}
            currentPower={headline.find((slot) => slot.slot_code === "kpi.current_power")}
            acCapacityKw={plant.ac_capacity_kw}
          />
        ) : open?.kind === "panel" ? (
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
              /* Each row opens that Device's full inspector. A stage listing
                 its Devices and stopping there is a dead end — the reason
                 somebody opened the stage is almost always one machine in it. */
              <ul className="divide-y divide-line-soft">
                {open.stage.devices.map((entry) => {
                  const full = deviceById.get(entry.device_id);
                  return (
                    <li key={entry.device_id}>
                      <button
                        type="button"
                        disabled={!full}
                        onClick={() => full && setOpen({ kind: "device", device: full })}
                        className="flex w-full items-center gap-2 py-1.5 text-left transition hover:text-accent disabled:cursor-default"
                      >
                        <DeviceArt typeCode={entry.device_type_code} size={26} />
                        <span className="text-xs font-medium text-ink">{entry.code}</span>
                        <span className="text-[11px] text-ink-faint">
                          {entry.device_type_code}
                        </span>
                        <span
                          className={`ml-auto h-1.5 w-1.5 rounded-full ${entry.online ? "bg-ok" : "bg-bad"}`}
                          title={entry.online ? "Reporting" : "Not reporting"}
                        />
                        {full ? <IconChevronRight size={13} className="text-ink-faint" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}

        {open?.kind === "device" ? (
          <DeviceInspector
            device={open.device}
            values={valuesFor(open.device.id)}
            timezone={timezone}
            deviceLookup={deviceById}
          />
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
                onRowClick={(device) => setOpen({ kind: "device", device })}
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
