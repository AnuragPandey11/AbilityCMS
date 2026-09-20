/**
 * `plant_list` — the table (§6.2).
 *
 * A sortable, filterable, exportable table of Plants: code, name, region,
 * capacity, status, live Devices, energy, PR, device health summary, open
 * alarms. The screen for working through Plants systematically; the one for
 * spotting which Plant needs attention is `PlantOverviewDashboard`, which draws
 * the same data (`usePlantFleet`) as cards ordered by urgency.
 *
 * `GET /plants` is cursor-paginated and followed inside `usePlantFleet`; never
 * construct an offset — the backend has no offset parameter and inventing one
 * silently repeats rows as the fleet grows.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PlantListItem } from "@/api/schemas";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Panel } from "@/components/ui";
import {EmptyState, ErrorState, SkeletonKpiRow, SkeletonTable} from "@/components/state";
import { DeviceHealthStrip, PeriodPicker, PlantStatusBadge } from "@/components/domain";
import { UNDEFINED_DISPLAY, formatCapacity, formatNumber, formatRatioAsPercent, variantNote } from "@/format/value";
import { usePermission } from "@/auth/usePermission";
import { useSelection } from "@/state/selection";
import { usePlantFleet } from "./usePlantFleet";

export function PlantListDashboard(): JSX.Element {
  const navigate = useNavigate();
  const { period, setPeriod, setPlantId } = useSelection();
  const canExport = usePermission("data.export");
  const fleet = usePlantFleet(period);
  const { plants, entryFor } = fleet;

  /**
   * Which Client's Plants to show. `"all"` until someone narrows it.
   *
   * Client-side, over the fleet already loaded, because the fleet is loaded
   * whole for the portfolio totals anyway and a server round trip per filter
   * change would be slower for no gain. The server-side `client_id` parameter
   * exists for callers that do not need the whole fleet.
   */
  const [clientFilter, setClientFilter] = useState<number | "all">("all");

  /**
   * The Clients actually present in what this session can see.
   *
   * Derived from the rows rather than from `GET /clients`, which is Super
   * Admin only: a Client Admin would get a 403 and lose the column. It also
   * means the list can never offer a Client whose Plants are all invisible.
   */
  const clients = useMemo(() => {
    const byId = new Map<number, string>();
    for (const plant of plants) {
      if (!byId.has(plant.client_id)) {
        byId.set(plant.client_id, plant.client_name ?? plant.client_code ?? `Client #${plant.client_id}`);
      }
    }
    return [...byId].sort((a, b) => a[1].localeCompare(b[1]));
  }, [plants]);

  // One Client means there is nothing to choose between, and a filter with a
  // single option is furniture. A Client Admin sees exactly one, always.
  const showClientFilter = clients.length > 1;

  const matchesClient = (plant: PlantListItem): boolean =>
    clientFilter === "all" || plant.client_id === clientFilter;
  const active = fleet.active.filter(matchesClient);
  const onboarding = fleet.onboarding.filter(matchesClient);

  // A skeleton in the shape of the list, so rows land in place rather than
  // pushing the summary tiles down the page as they arrive.
  if (fleet.isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonKpiRow tiles={6} />
        <SkeletonTable rows={8} columns={7} />
      </div>
    );
  }
  if (fleet.isError) {
    return <ErrorState error={fleet.error} retry={fleet.refetch} />;
  }
  if (plants.length === 0) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const kpiFor = (plantId: number) => entryFor(plantId)?.kpis;
  const healthFor = (plantId: number) => entryFor(plantId)?.health ?? [];
  const alarmCount = (plantId: number) => entryFor(plantId)?.alarms.length ?? 0;
  // From the live socket rather than requested: the REST path has no
  // instantaneous endpoint. Absent frames render as "—", never as 0.
  const liveDeviceCount = (plantId: number) => entryFor(plantId)?.liveDeviceCount ?? 0;

  const columns: Column<PlantListItem>[] = [
    // Only where it distinguishes anything. A Client Admin sees one Client by
    // construction, and a column repeating their own name in every row is
    // noise in a table that is already wide.
    ...(showClientFilter
      ? [
          {
            key: "client",
            header: "Client",
            render: (plant: PlantListItem) =>
              plant.client_name ?? plant.client_code ?? `#${plant.client_id}`,
            sortValue: (plant: PlantListItem) => plant.client_name ?? "",
            filterValue: (plant: PlantListItem) =>
              `${plant.client_name ?? ""} ${plant.client_code ?? ""}`,
            width: "150px",
          } satisfies Column<PlantListItem>,
        ]
      : []),
    {
      key: "code",
      header: "Code",
      render: (plant) => <span className="font-medium">{plant.code}</span>,
      sortValue: (plant) => plant.code,
      filterValue: (plant) => plant.code,
      width: "110px",
    },
    {
      key: "name",
      header: "Name",
      render: (plant) => plant.name,
      sortValue: (plant) => plant.name,
      filterValue: (plant) => plant.name,
    },
    {
      key: "region",
      header: "Region",
      render: (plant) => plant.region_code ?? UNDEFINED_DISPLAY,
      sortValue: (plant) => plant.region_code,
      filterValue: (plant) => plant.region_code ?? "",
      width: "90px",
    },
    {
      key: "status",
      header: "Status",
      render: (plant) => <PlantStatusBadge status={plant.status} />,
      sortValue: (plant) => plant.status,
      filterValue: (plant) => plant.status,
      width: "120px",
    },
    {
      key: "capacity",
      header: "DC capacity",
      align: "right",
      render: (plant) => formatCapacity(plant.dc_capacity_kwp, "kWp"),
      sortValue: (plant) => plant.dc_capacity_kwp,
      width: "120px",
    },
    {
      key: "live",
      header: "Live Devices",
      align: "right",
      render: (plant) => {
        const count = liveDeviceCount(plant.id);
        return count === 0 ? (
          <span
            className="text-ink-faint"
            title="No live frames received for this Plant in this session. Values may still exist over REST."
          >
            —
          </span>
        ) : (
          formatNumber(count, { digits: 0 })
        );
      },
      sortValue: (plant) => liveDeviceCount(plant.id),
      width: "110px",
    },
    {
      key: "energy",
      header: `Energy (${period})`,
      align: "right",
      render: (plant) => {
        const kpi = kpiFor(plant.id);
        // The API returns kWh for this figure; the unit is stated, not inferred.
        return kpi ? `${formatNumber(kpi.energy_kwh)} kWh` : "…";
      },
      sortValue: (plant) => kpiFor(plant.id)?.energy_kwh ?? null,
      width: "140px",
    },
    {
      key: "pr",
      header: "PR",
      align: "right",
      render: (plant) => {
        const figure = kpiFor(plant.id)?.performance_ratio;
        if (!figure) return "…";
        // §4.3: null is "—" with its reason, never 0.
        return (
          <span
            title={
              figure.value === null
                ? (figure.undefined_reason ?? "Undefined for this period.")
                : variantNote(figure.variant)
            }
            className={figure.value === null ? "text-ink-faint" : undefined}
          >
            {formatRatioAsPercent(figure.value)}
          </span>
        );
      },
      sortValue: (plant) => kpiFor(plant.id)?.performance_ratio.value ?? null,
      width: "90px",
    },
    {
      key: "health",
      header: "Device health",
      render: (plant) => <DeviceHealthStrip health={healthFor(plant.id)} />,
      filterValue: (plant) =>
        healthFor(plant.id)
          .map((entry) => entry.comm_status)
          .join(" "),
    },
    {
      key: "alarms",
      header: "Open alarms",
      align: "right",
      render: (plant) => {
        const count = alarmCount(plant.id);
        return count === 0 ? (
          <span className="text-ink-faint">0</span>
        ) : (
          <span className="text-warn">{count}</span>
        );
      },
      sortValue: (plant) => alarmCount(plant.id),
      width: "110px",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Plant List</h1>
          <p className="text-xs text-ink-muted">
            {clientFilter === "all"
              ? `${plants.length} visible Plant(s)`
              : `${active.length + onboarding.length} of ${plants.length} Plant(s)`}
            {showClientFilter ? ` across ${clients.length} Client(s)` : ""}. Click
            a row to open it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showClientFilter ? (
            <label className="flex items-center gap-1.5 text-xs text-ink-muted">
              Client
              <select
                value={clientFilter}
                onChange={(event) =>
                  setClientFilter(
                    event.target.value === "all" ? "all" : Number(event.target.value),
                  )
                }
                className="rounded-control border border-line bg-surface-raised px-2 py-1.5 text-xs text-ink focus:border-accent focus:outline-none"
              >
                <option value="all">All Clients</option>
                {clients.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      </div>

      <Panel title="Plants">
        <DataTable
          rows={active}
          columns={columns}
          rowKey={(plant) => plant.id}
          onRowClick={(plant) => {
            setPlantId(plant.id);
            navigate("/d/single_plant");
          }}
          filterPlaceholder="Filter by code, name, region, status…"
          // Export is a separate permission from viewing (MASTER §4.3).
          exportFilename={canExport ? "plants.csv" : undefined}
          emptyMessage="No active Plants."
        />
      </Panel>

      {onboarding.length > 0 ? (
        <Panel
          title="Onboarding"
          subtitle="Draft and commissioning Plants. Excluded from portfolio totals."
        >
          <DataTable
            rows={onboarding}
            columns={columns}
            rowKey={(plant) => plant.id}
            onRowClick={(plant) => {
              setPlantId(plant.id);
              navigate("/d/single_plant");
            }}
            exportFilename={canExport ? "plants-onboarding.csv" : undefined}
          />
        </Panel>
      ) : null}
    </div>
  );
}
