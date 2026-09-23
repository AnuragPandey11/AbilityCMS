/**
 * `plant_overview` + `plant_list`, merged (§6.2).
 *
 * ── Why they are one screen ─────────────────────────────────────────────────
 * The tender names Overview and List separately and never says how they differ,
 * so this platform proposed a split: Overview as cards ordered by need for
 * attention, List as a sortable table. Both drew the *same Plants from the same
 * hook* and differed only in shape, and in the navigation they read as two
 * destinations for one job — the obvious question in front of them was "which
 * of these is the real one", which is the question a menu should never provoke.
 *
 * They are now one screen with a **view toggle**. Nothing was removed: the
 * urgency ordering is the Cards view, the sortable, filterable, exportable
 * table is the Table view, and the filters and period apply to both. Both
 * dashboard codes route here, so a granted code and a pasted URL still work
 * (A-3), while the menu shows one entry.
 *
 * ── Cards are ordered by attention, and never by a KPI ──────────────────────
 * Ranking is driven by open Alarms and communication health — both *states the
 * platform is sure of*. An undefined PR is the normal night-time condition on
 * every Plant in the fleet; ranking on it would put the whole estate at the top
 * of the screen at dusk and teach operators that the ordering means nothing.
 *
 * ⚠ Plants in `draft` or `commissioning` are shown in their own group and
 * excluded from the summary totals (MASTER §6.5) — a half-mapped Plant would
 * otherwise drag fleet figures down.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Panel, SegmentedControl } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonKpiRow, SkeletonTable } from "@/components/state";
import {
  DeviceHealthStrip,
  PeriodPicker,
  PlantStatusBadge,
  SeverityBadge,
  isOnboarding,
} from "@/components/domain";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { CoverageBadge } from "@/components/dashboard/CoverageBadge";
import {
  UNDEFINED_DISPLAY,
  formatCapacity,
  formatNumber,
  formatRatioAsPercent,
  variantNote,
} from "@/format/value";
import {
  IconAlarm,
  IconChevronRight,
  IconEnergy,
  IconHealth,
  IconCapacity,
  IconOverview,
  IconList as IconTable,
  IconPower,
} from "@/components/icons";
import { usePermission } from "@/auth/usePermission";
import { useSelection } from "@/state/selection";
import { usePlantFleet, type PlantFleetEntry } from "./usePlantFleet";
import { fleetTotal } from "./fleet/aggregate";
import { RailFigure, RailTile } from "@/components/charts/RailTile";
import { PlantCard, RailLegend } from "./plants/PlantsParts";

/**
 * How loudly a Plant asks to be looked at. Lower sorts first.
 *
 * See the note at the top: Alarms and communication health only, never a KPI.
 */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function attentionRank(entry: PlantFleetEntry): number {
  if (entry.worstSeverity) return SEVERITY_RANK[entry.worstSeverity] ?? 4;
  const offline = entry.health.filter((row) => row.comm_status === "offline").length;
  if (offline > 0) return 5;
  const degraded = entry.health.filter((row) => row.comm_status === "degraded").length;
  if (degraded > 0) return 6;
  return 7;
}

export function PlantsDashboard(): JSX.Element {
  const navigate = useNavigate();
  const { period, setPeriod, setPlantId } = useSelection();
  const canExport = usePermission("data.export");
  const fleet = usePlantFleet(period);
  const { plants, entryFor } = fleet;

  /** Cards to scan, or a table to work through. The data is identical. */
  const [view, setView] = useState<"cards" | "table">("cards");

  /**
   * Which Client's Plants to show. `"all"` until someone narrows it.
   *
   * Derived from the rows rather than from `GET /clients`, which is Super
   * Admin only: a Client Admin would get a 403 and lose the control. It also
   * means the list can never offer a Client whose Plants are all invisible.
   */
  const [clientFilter, setClientFilter] = useState<number | "all">("all");
  const clients = useMemo(() => {
    const byId = new Map<number, string>();
    for (const plant of plants) {
      if (!byId.has(plant.client_id)) {
        byId.set(
          plant.client_id,
          plant.client_name ?? plant.client_code ?? `Client #${plant.client_id}`,
        );
      }
    }
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [plants]);

  const visible = useMemo(
    () => (clientFilter === "all" ? plants : plants.filter((p) => p.client_id === clientFilter)),
    [plants, clientFilter],
  );

  const live = useMemo(() => visible.filter((p) => !isOnboarding(p.status)), [visible]);
  const onboarding = useMemo(() => visible.filter((p) => isOnboarding(p.status)), [visible]);

  /** Live Plants, worst first. */
  const ranked = useMemo(
    () =>
      live
        // `entryFor` is undefined only for a Plant that vanished between
        // renders; dropping it beats rendering a card with no data behind it.
        .map((plant) => entryFor(plant.id))
        .filter((entry): entry is PlantFleetEntry => entry !== undefined)
        .sort((a, b) => {
          const byAttention = attentionRank(a) - attentionRank(b);
          return byAttention !== 0 ? byAttention : a.plant.name.localeCompare(b.plant.name);
        }),
    [live, entryFor],
  );

  const openPlant = (plantId: number) => {
    setPlantId(plantId);
    navigate("/d/single_plant");
  };

  /** Summary of the set on screen. Counts are states, never inferred from a KPI. */
  const summary = useMemo(() => {
    let needsAttention = 0;
    let offline = 0;
    let openAlarms = 0;
    for (const entry of ranked) {
      if (entry.alarms.length > 0) needsAttention += 1;
      if (entry.health.some((row) => row.comm_status === "offline")) offline += 1;
      openAlarms += entry.alarms.length;
    }
    return {
      needsAttention,
      offline,
      openAlarms,
      capacity: fleetTotal(live.map((p) => p.dc_capacity_kwp)),
      energy: fleetTotal(ranked.map((e) => e.kpis?.energy_kwh)),
    };
  }, [ranked, live]);

  const columns: Column<PlantFleetEntry>[] = [
    ...(clients.length > 1
      ? [
          {
            key: "client",
            header: "Client",
            render: (e: PlantFleetEntry) =>
              e.plant.client_name ?? e.plant.client_code ?? `#${e.plant.client_id}`,
            sortValue: (e: PlantFleetEntry) => e.plant.client_name ?? "",
            filterValue: (e: PlantFleetEntry) =>
              `${e.plant.client_name ?? ""} ${e.plant.client_code ?? ""}`,
            width: "140px",
          } satisfies Column<PlantFleetEntry>,
        ]
      : []),
    {
      key: "plant",
      header: "Plant",
      render: (e) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-ink">{e.plant.code}</span>
          <span className="truncate text-ink-muted">{e.plant.name}</span>
        </span>
      ),
      sortValue: (e) => e.plant.code,
      filterValue: (e) => `${e.plant.code} ${e.plant.name} ${e.plant.region_code ?? ""}`,
    },
    {
      key: "status",
      header: "Status",
      width: "110px",
      render: (e) => <PlantStatusBadge status={e.plant.status} />,
      sortValue: (e) => e.plant.status,
    },
    {
      key: "capacity",
      header: "DC capacity",
      align: "right",
      width: "115px",
      render: (e) => formatCapacity(e.plant.dc_capacity_kwp, "kWp"),
      sortValue: (e) => e.plant.dc_capacity_kwp,
    },
    {
      key: "devices",
      header: "Devices",
      align: "right",
      width: "85px",
      render: (e) =>
        e.plant.device_count === 0 ? (
          <span className="text-warn" title="No Devices registered, so this Plant reports nothing.">
            0
          </span>
        ) : (
          e.plant.device_count
        ),
      sortValue: (e) => e.plant.device_count,
    },
    {
      key: "energy",
      header: `Energy (${period})`,
      align: "right",
      width: "125px",
      render: (e) =>
        e.kpis ? (
          <span className="font-mono tabular-nums">{formatNumber(e.kpis.energy_kwh)}</span>
        ) : (
          <span className="text-ink-faint">…</span>
        ),
      sortValue: (e) => e.kpis?.energy_kwh ?? null,
    },
    {
      key: "pr",
      header: "PR",
      align: "right",
      width: "95px",
      render: (e) => {
        const figure = e.kpis?.performance_ratio;
        if (!figure) return <span className="text-ink-faint">…</span>;
        // §4.3: null is "—" with its reason, never 0.
        return figure.value === null ? (
          <span className="text-ink-faint" title={figure.undefined_reason ?? undefined}>
            {UNDEFINED_DISPLAY}
          </span>
        ) : (
          <span className="font-mono tabular-nums" title={variantNote(figure.variant)}>
            {formatRatioAsPercent(figure.value)}
          </span>
        );
      },
      sortValue: (e) => e.kpis?.performance_ratio.value ?? null,
    },
    {
      key: "coverage",
      header: "Coverage",
      width: "125px",
      render: (e) => <CoverageBadge coverage={e.kpis?.coverage} />,
      sortValue: (e) => e.kpis?.coverage?.ratio ?? null,
    },
    {
      key: "health",
      header: "Device health",
      render: (e) => <DeviceHealthStrip health={e.health} />,
      filterValue: (e) => e.health.map((row) => row.comm_status).join(" "),
    },
    {
      key: "alarms",
      header: "Open alarms",
      align: "right",
      width: "110px",
      render: (e) =>
        e.alarms.length === 0 ? (
          <span className="text-ink-faint">none</span>
        ) : (
          <span className="flex items-center justify-end gap-1">
            {e.worstSeverity ? <SeverityBadge severity={e.worstSeverity} /> : null}
            <span className="font-mono tabular-nums">{e.alarms.length}</span>
          </span>
        ),
      sortValue: (e) => e.alarms.length,
    },
  ];

  if (fleet.isError) {
    return <ErrorState error={fleet.error} retry={fleet.refetch} />;
  }
  if (!fleet.isLoading && plants.length === 0) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Plants</h1>
          <p className="mt-1.5 text-sm leading-snug text-ink-muted">
            {live.length} live
            {onboarding.length > 0 ? `, ${onboarding.length} onboarding` : ""}. Cards are
            ordered by need for attention; the table sorts on any column.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
          {clients.length > 1 ? (
            <label className="flex items-center gap-2.5">
              <span className="whitespace-nowrap text-sm font-medium text-ink-muted">Client</span>
              <select
                value={clientFilter === "all" ? "" : String(clientFilter)}
                onChange={(event) =>
                  setClientFilter(event.target.value === "" ? "all" : Number(event.target.value))
                }
                className="surface-tile min-w-[12rem] rounded-control border border-line px-3 py-2 text-sm font-semibold text-ink"
              >
                <option value="">All Clients</option>
                {clients.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <PeriodPicker value={period} onChange={setPeriod} size="lg" />
          <SegmentedControl
            label="View"
            size="lg"
            value={view}
            onChange={setView}
            options={[
              { value: "cards", label: "Cards", hint: "Ordered by need for attention." },
              { value: "table", label: "Table", hint: "Sortable, filterable, exportable." },
            ]}
          />
        </div>
      </header>

      {/* The set on screen, summarised. Every figure is a state or a sum — no
          ratio is averaged here, because that is the Portfolio's job and doing
          it twice invites the two screens to disagree. */}
      {fleet.isLoading ? (
        <SkeletonKpiRow tiles={5} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <RailTile tone="ok" icon={IconPower} label="Live Plants">
            <RailFigure value={live.length} digits={0} />
          </RailTile>
          <RailTile
            tone="warn"
            icon={IconAlarm}
            label="Need attention"
            figureTone={summary.needsAttention > 0 ? "warn" : "ok"}
            footnote={summary.openAlarms > 0 ? `${summary.openAlarms} open Alarm(s)` : "Nothing open"}
          >
            <RailFigure value={summary.needsAttention} digits={0} />
          </RailTile>
          <RailTile
            tone="violet"
            icon={IconHealth}
            label="With a Device offline"
            figureTone={summary.offline > 0 ? "bad" : "ok"}
            footnote="Communication, never equipment condition."
          >
            <RailFigure value={summary.offline} digits={0} />
          </RailTile>
          <RailTile
            tone="info"
            icon={IconCapacity}
            label="DC capacity"
            footnote="Live Plants only; onboarding is excluded."
          >
            <RailFigure value={summary.capacity} unit="kWp" />
          </RailTile>
          <RailTile tone="blue" icon={IconEnergy} label={`Energy · ${period}`}>
            <RailFigure value={summary.energy} unit="kWh" />
          </RailTile>
        </div>
      )}

      {fleet.isLoading ? (
        <SkeletonTable rows={6} columns={6} />
      ) : view === "cards" ? (
        <Panel
          padding="p-5"
          tray
          title={<span className="text-lg">Live Plants</span>}
          subtitle={
            <span className="text-sm">
              Worst first. Ordering follows open Alarms and communication health — never a
              KPI, which is undefined on every Plant at night.
            </span>
          }
          actions={<RailLegend />}
        >
          {ranked.length === 0 ? (
            <p className="text-xs text-ink-faint">
              No live Plants{clientFilter === "all" ? "" : " for this Client"}.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-5">
              {ranked.map((entry) => (
                <PlantCard
                  key={entry.plant.id}
                  entry={entry}
                  period={period}
                  capacityShare={
                    entry.plant.dc_capacity_kwp === null || summary.capacity <= 0
                      ? null
                      : entry.plant.dc_capacity_kwp / summary.capacity
                  }
                  onOpen={() => openPlant(entry.plant.id)}
                />
              ))}
            </div>
          )}
        </Panel>
      ) : (
        <Panel
          title="Live Plants"
          subtitle="Sort any column; click a row to open that Plant."
        >
          <DataTable
            rows={ranked}
            columns={columns}
            rowKey={(e) => e.plant.id}
            onRowClick={(e) => openPlant(e.plant.id)}
            filterPlaceholder="Filter Plants…"
            exportFilename={canExport ? "plants" : undefined}
          />
        </Panel>
      )}

      {/* ⚠ Onboarding Plants are shown but never counted (MASTER §6.5). */}
      {onboarding.length > 0 ? (
        <Panel
          title={`Onboarding — ${onboarding.length}`}
          subtitle="Excluded from every total above. A half-mapped Plant would otherwise drag fleet figures down."
        >
          <ul className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
            {onboarding.map((plant) => (
              <li key={plant.id}>
                <button
                  type="button"
                  onClick={() => openPlant(plant.id)}
                  className="flex w-full items-center gap-2 rounded-control border border-line px-2.5 py-1.5 text-left transition hover:border-accent/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-ink">
                      {plant.code}
                    </span>
                    <span className="block truncate text-[10px] text-ink-faint">{plant.name}</span>
                  </span>
                  <PlantStatusBadge status={plant.status} />
                  <IconChevronRight size={13} className="shrink-0 text-ink-faint" />
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}

/** Icons used only to label the summary tiles above. */
export const PLANTS_VIEW_ICONS = { cards: IconOverview, table: IconTable };
