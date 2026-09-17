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
  const { plants, active, onboarding, entryFor } = fleet;

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
            {plants.length} visible Plant(s). Click a row to open it.
          </p>
        </div>
        <PeriodPicker value={period} onChange={setPeriod} />
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
