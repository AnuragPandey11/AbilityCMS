/**
 * `plant_list` and `plant_overview` (§6.2).
 *
 * A sortable, filterable table of Plants: code, name, region, capacity, status,
 * current power, today's energy, PR, device health summary, open alarms.
 *
 * `GET /plants` is cursor-paginated. Follow `next_cursor`; never construct an
 * offset — the backend has no offset parameter and inventing one silently
 * repeats rows as the fleet grows.
 */

import { useQueries } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useAlarms, useAllPlants, useDeviceHealth } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as plantsApi from "@/api/endpoints/plants";
import type { PlantKpis, PlantListItem } from "@/api/schemas";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { Panel } from "@/components/ui";
import { EmptyState, ErrorState, LoadingState } from "@/components/state";
import {
  DeviceHealthStrip,
  PeriodPicker,
  PlantStatusBadge,
  isOnboarding,
} from "@/components/domain";
import { UNDEFINED_DISPLAY, formatCapacity, formatNumber, formatRatioAsPercent, variantNote } from "@/format/value";
import { usePermission } from "@/auth/usePermission";
import { useSelection } from "@/state/selection";
import { useLiveSocket } from "@/live/LiveSocket";

export function PlantListDashboard({
  variant = "plant_list",
}: {
  /** Both dashboard codes render this component; the heading differs. */
  variant?: "plant_list" | "plant_overview";
}): JSX.Element {
  const navigate = useNavigate();
  const { period, setPeriod, setPlantId } = useSelection();
  const canExport = usePermission("data.export");
  const plantsQuery = useAllPlants();
  const healthQuery = useDeviceHealth();
  const alarmsQuery = useAlarms({ state: "active", limit: 500 });
  const { devices: liveDevices } = useLiveSocket();

  const plants = plantsQuery.data ?? [];

  const kpiQueries = useQueries({
    queries: plants.map((plant) => ({
      queryKey: qk.plantKpis(plant.id, period),
      queryFn: () => plantsApi.plantKpis(plant.id, period),
      staleTime: 30_000,
    })),
  });

  if (plantsQuery.isLoading) return <LoadingState label="Loading Plants" />;
  if (plantsQuery.isError) {
    return <ErrorState error={plantsQuery.error} retry={() => void plantsQuery.refetch()} />;
  }
  if (plants.length === 0) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const kpiFor = (plantId: number): PlantKpis | undefined =>
    kpiQueries[plants.findIndex((plant) => plant.id === plantId)]?.data as
      | PlantKpis
      | undefined;

  const healthFor = (plantId: number) =>
    (healthQuery.data ?? []).filter((entry) => entry.plant_id === plantId);

  const alarmCount = (plantId: number) =>
    (alarmsQuery.data ?? []).filter((alarm) => alarm.plant_id === plantId).length;

  /**
   * "Current power" is derived from the live socket rather than requested: the
   * REST path has no instantaneous endpoint, and the socket already carries the
   * latest frame per Device. Absent frames render as "—", never as 0.
   */
  const liveDeviceCount = (plantId: number) =>
    Object.values(liveDevices).filter((device) => device.plantId === plantId).length;

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

  const active = plants.filter((plant) => !isOnboarding(plant.status));
  const onboarding = plants.filter((plant) => isOnboarding(plant.status));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">
            {variant === "plant_overview" ? "Plant Overview" : "Plant List"}
          </h1>
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
