/**
 * `single_plant` (§6.3).
 *
 * Header, KPI row, a device-health strip, a time-series panel, and Blocks **if
 * the Plant has any**.
 *
 * ⚠ **Blocks are optional.** A Plant with zero Blocks is valid and normal
 * (MASTER §2.2). The Block section renders only when `GET /plants/{id}/blocks`
 * returns rows — no "Unassigned" pseudo-Block, no empty grouping level.
 */

import { useQueries } from "@tanstack/react-query";
import {
  usePlant,
  usePlantBlocks,
  usePlantDevices,
  usePlantKpis,
  useDeviceHealth,
  useTagsById,
} from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as plantsApi from "@/api/endpoints/plants";
import type { BlockKpis } from "@/api/schemas";
import { KpiTile, StatTile } from "@/components/charts/KpiTile";
import { Gauge } from "@/components/charts/Gauge";
import { ReadingsPanel } from "@/components/charts/ReadingsPanel";
import { Panel, Badge } from "@/components/ui";
import { EmptyState, ErrorState, LoadingState } from "@/components/state";
import {
  CommStatusBadge,
  DeviceHealthStrip,
  LastSeen,
  PeriodPicker,
  PlantPicker,
  PlantStatusBadge,
} from "@/components/domain";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { formatCapacity, formatNumber, formatValue } from "@/format/value";
import { timezoneLabel } from "@/format/datetime";
import { useSelection } from "@/state/selection";
import { usePlantScope } from "@/state/usePlantScope";
import { useLiveSocket } from "@/live/LiveSocket";
import { STALE_INTERVAL_MULTIPLIER } from "@/live/useLiveDevice";
import type { DeviceListItem } from "@/api/schemas";

export function SinglePlantDashboard(): JSX.Element {
  const { period, setPeriod } = useSelection();
  const { plants, plantId, setPlantId, hasNoPlants } = usePlantScope();

  const plantQuery = usePlant(plantId);
  const kpisQuery = usePlantKpis(plantId, period);
  const blocksQuery = usePlantBlocks(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const healthQuery = useDeviceHealth(plantId);
  const tagsById = useTagsById();
  const { devices: liveDevices } = useLiveSocket();

  const blocks = blocksQuery.data ?? [];
  const blockKpiQueries = useQueries({
    queries: blocks.map((block) => ({
      queryKey: qk.blockKpis(block.id, period),
      queryFn: () => plantsApi.blockKpis(block.id, period),
      staleTime: 30_000,
    })),
  });

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }
  if (plantQuery.isLoading) return <LoadingState label="Loading Plant" />;
  if (plantQuery.isError) {
    return <ErrorState error={plantQuery.error} retry={() => void plantQuery.refetch()} />;
  }

  const plant = plantQuery.data!;
  const kpis = kpisQuery.data;
  // Every timestamp on this screen renders in the Plant's zone (Guardrail 11).
  const timezone = plant.timezone;
  const devices = devicesQuery.data ?? [];

  const liveValueFor = (device: DeviceListItem): string | null => {
    const frame = liveDevices[device.id];
    if (!frame) return null;
    // Show the first live Tag in the `electrical` category, with its own unit
    // read from the catalogue — never a unit assumed from the Tag's name.
    for (const [tagId, value] of Object.entries(frame.values)) {
      const tag = tagsById.get(Number(tagId));
      if (tag && tag.category === "electrical") {
        return formatValue(value, tag.unit);
      }
    }
    return null;
  };

  const deviceColumns: Column<DeviceListItem>[] = [
    {
      key: "code",
      header: "Device",
      render: (device) => (
        <span>
          <span className="font-medium">{device.code}</span>
          <span className="ml-2 text-ink-muted">{device.name}</span>
        </span>
      ),
      sortValue: (device) => device.code,
      filterValue: (device) => `${device.code} ${device.name}`,
    },
    {
      key: "type",
      header: "Type",
      render: (device) => (
        <span>
          {device.type_code}
          {device.variant ? (
            <span className="ml-1 text-ink-faint">{device.variant}</span>
          ) : null}
        </span>
      ),
      sortValue: (device) => device.type_code,
      filterValue: (device) => `${device.type_code} ${device.variant ?? ""}`,
      width: "150px",
    },
    {
      key: "comm",
      header: "Comms",
      render: (device) => <CommStatusBadge status={device.comm_status} />,
      sortValue: (device) => device.comm_status ?? "unknown",
      width: "110px",
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
      key: "live",
      header: "Live",
      align: "right",
      render: (device) => {
        const value = liveValueFor(device);
        return value ? (
          <span className="text-info">{value}</span>
        ) : (
          <span
            className="text-ink-faint"
            title={`No live frame received. Staleness is judged at ${device.expected_interval_s * STALE_INTERVAL_MULTIPLIER}s for this Device.`}
          >
            —
          </span>
        );
      },
      width: "130px",
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
      width: "110px",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold text-ink">
            {plant.code}
            <span className="text-ink-muted">{plant.name}</span>
            <PlantStatusBadge status={plant.status} />
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-muted">
            <span>DC {formatCapacity(plant.dc_capacity_kwp, "kWp")}</span>
            <span>AC {formatCapacity(plant.ac_capacity_kw, "kW")}</span>
            <span>Region {plant.region_code ?? "—"}</span>
            <Badge
              tone="info"
              title="All timestamps on this screen are rendered in the Plant's timezone, not the browser's."
            >
              {timezoneLabel(timezone)}
            </Badge>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" />
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      </div>

      {kpisQuery.isError ? (
        <ErrorState error={kpisQuery.error} retry={() => void kpisQuery.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label={`Energy (${period})`}
              value={kpis ? `${formatNumber(kpis.energy_kwh)} kWh` : "…"}
              hint="Read from hourly aggregates — Reports and KPIs never query raw Readings."
            />
            <KpiTile
              label="Performance ratio"
              figure={kpis?.performance_ratio}
              kind="ratio"
              hint={kpis?.assumptions_note}
            />
            <KpiTile
              label="CUF"
              figure={kpis?.cuf}
              kind="ratio"
              hint={kpis?.assumptions_note}
            />
            <KpiTile
              label="Availability"
              figure={kpis?.availability}
              kind="ratio"
              hint="Derived from Device communication status. A Collector failure is communication loss, not generation downtime."
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Gauge figure={kpis?.performance_ratio} label="Performance ratio" />
            <Gauge figure={kpis?.cuf} label="CUF" />
            <Gauge figure={kpis?.availability} label="Availability" />
          </div>
        </>
      )}

      <Panel
        title="Device health"
        subtitle="Communication status is distinct from equipment condition."
      >
        <div className="mb-3">
          <DeviceHealthStrip health={healthQuery.data} />
        </div>
        {devicesQuery.isLoading ? (
          <LoadingState label="Loading Devices" />
        ) : devices.length === 0 ? (
          <EmptyState
            title="No Devices registered"
            detail="This Plant has no Devices yet. Register them through the onboarding wizard, giving each an expected interval taken from observation."
          />
        ) : (
          <DataTable
            rows={devices}
            columns={deviceColumns}
            rowKey={(device) => device.id}
            filterPlaceholder="Filter Devices…"
          />
        )}
      </Panel>

      {/* §6.3: only when the Plant actually has Blocks. Zero is normal. */}
      {blocks.length > 0 ? (
        <Panel
          title="Blocks"
          subtitle="Geographic grouping within the Plant. Blocks never appear in the Single Line Diagram."
        >
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {blocks.map((block, index) => {
              const blockKpi = blockKpiQueries[index]?.data as BlockKpis | undefined;
              return (
                <div
                  key={block.id}
                  className="rounded-lg border border-line bg-surface p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-ink">{block.code}</span>
                    <span className="text-xs text-ink-muted">
                      {formatCapacity(block.capacity_kwp, "kWp")}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-muted">{block.name}</div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-[11px] text-ink-faint">Energy</div>
                      <div className="font-mono text-sm text-ink">
                        {blockKpi ? `${formatNumber(blockKpi.energy_kwh)} kWh` : "…"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[11px] text-ink-faint">Specific yield</div>
                      <div
                        className={`font-mono text-sm ${
                          blockKpi?.specific_yield.value === null
                            ? "text-ink-faint"
                            : "text-ink"
                        }`}
                        title={
                          blockKpi?.specific_yield.undefined_reason ??
                          blockKpi?.specific_yield.variant ??
                          undefined
                        }
                      >
                        {blockKpi
                          ? formatValue(blockKpi.specific_yield.value, "kWh/kWp")
                          : "…"}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-ink-faint">
                    {block.device_count} Device(s)
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      ) : null}

      <ReadingsPanel devices={devices} timezone={timezone} title="Time series" />
    </div>
  );
}
