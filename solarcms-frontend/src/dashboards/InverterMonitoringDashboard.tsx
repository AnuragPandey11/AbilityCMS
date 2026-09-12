/**
 * `inverter_monitoring` — per-Inverter comparison and ranking (tender §8, §6.5).
 *
 * ⚠ **Rank only within an Inverter variant** (OPEN-13, Guardrail 9).
 * `device_models.variant` is `central` or `string`; the two have different Tag
 * sets and different expected outputs, and ranking across them is meaningless.
 * Devices are grouped by variant, ranked inside each group, and the grouping is
 * labelled so the ranking cannot be misread as fleet-wide.
 *
 * ⚠ **There are no Inverters in the live data yet** (§0.4). This screen is
 * contracted and built; its empty state explains that rather than spinning.
 *
 * On Guardrail 1: this filters on a Device *Type* code, which is a catalogue row
 * — not on any Client, Plant or Device identity. A new Device Type still needs
 * no change here; this dashboard is simply the one that is about Inverters.
 */

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { usePlantDevices, useTagsById } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as devicesApi from "@/api/endpoints/devices";
import type { DeviceDetail, DeviceListItem } from "@/api/schemas";
import { Panel, Badge, InfoHint } from "@/components/ui";
import { AwaitingDeviceDataState, EmptyState, ErrorState, LoadingState } from "@/components/state";
import { CommStatusBadge, LastSeen, PlantPicker } from "@/components/domain";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { UNDEFINED_DISPLAY, formatNumber, formatValue } from "@/format/value";
import { usePlantScope } from "@/state/usePlantScope";
import { useLiveSocket } from "@/live/LiveSocket";
import { STALE_INTERVAL_MULTIPLIER } from "@/live/useLiveDevice";

const INVERTER_TYPE_CODE = "INVERTER";

interface RankedInverter {
  device: DeviceListItem;
  /** The live electrical value this Device is bound to, with its own unit. */
  liveValue: number | null;
  liveUnit: string | null;
  ratedCapacityKw: number | null;
  /**
   * Live output ÷ rated capacity. The only figure comparable *within* a variant
   * when the Inverters differ in size. Null whenever either input is missing —
   * never zero (§4.3).
   */
  specificOutput: number | null;
  stale: boolean;
  rank: number | null;
}

const VARIANT_LABEL: Record<string, string> = {
  central: "Central Inverters",
  string: "String Inverters",
  unspecified: "Inverters with no variant recorded",
};

const VARIANT_NOTE: Record<string, string> = {
  central:
    "Ranked among central Inverters only. A central and a string Inverter have different Tag sets and different expected outputs.",
  string:
    "Ranked among string Inverters only. A central and a string Inverter have different Tag sets and different expected outputs.",
  unspecified:
    "These Devices have no variant on their Device Model, so they cannot be ranked against either group. Set the variant to include them.",
};

export function InverterMonitoringDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = usePlantScope();
  const devicesQuery = usePlantDevices(plantId);
  const tagsById = useTagsById();
  const { devices: liveDevices } = useLiveSocket();

  const inverters = useMemo(
    () =>
      (devicesQuery.data ?? []).filter(
        (device) => device.type_code === INVERTER_TYPE_CODE,
      ),
    [devicesQuery.data],
  );

  // Rated capacity is not on the list endpoint, so it is fetched per Device.
  // Without it the comparison is raw output, which is only meaningful between
  // identically sized Inverters — so it is fetched rather than assumed.
  const detailQueries = useQueries({
    queries: inverters.map((device) => ({
      queryKey: qk.device(device.id),
      queryFn: () => devicesApi.getDevice(device.id),
      staleTime: 300_000,
    })),
  });

  const grouped = useMemo(() => {
    const rows: RankedInverter[] = inverters.map((device, index) => {
      const detail = detailQueries[index]?.data as DeviceDetail | undefined;
      const frame = liveDevices[device.id];

      let liveValue: number | null = null;
      let liveUnit: string | null = null;
      if (frame) {
        for (const [tagId, value] of Object.entries(frame.values)) {
          const tag = tagsById.get(Number(tagId));
          // Whichever electrical Tag this Device is bound to — not a Tag chosen
          // by name (§0.3, Guardrail 2). Its unit comes from the catalogue.
          if (tag && tag.category === "electrical") {
            liveValue = value;
            liveUnit = tag.unit;
            break;
          }
        }
      }

      const ratedCapacityKw = detail?.rated_capacity_kw ?? null;
      const stale = frame
        ? (Date.now() - Date.parse(frame.at)) / 1000 >
          device.expected_interval_s * STALE_INTERVAL_MULTIPLIER
        : false;

      return {
        device,
        liveValue,
        liveUnit,
        ratedCapacityKw,
        specificOutput:
          liveValue !== null && ratedCapacityKw !== null && ratedCapacityKw > 0
            ? liveValue / ratedCapacityKw
            : null,
        stale,
        rank: null,
      };
    });

    const groups = new Map<string, RankedInverter[]>();
    for (const row of rows) {
      const variant = row.device.variant ?? "unspecified";
      const bucket = groups.get(variant);
      if (bucket) bucket.push(row);
      else groups.set(variant, [row]);
    }

    // Rank inside each group and nowhere else (Guardrail 9).
    for (const [variant, members] of groups) {
      if (variant === "unspecified") continue;
      const rankable = members
        .filter((row) => row.specificOutput !== null)
        .sort((a, b) => (b.specificOutput ?? 0) - (a.specificOutput ?? 0));
      rankable.forEach((row, index) => {
        row.rank = index + 1;
      });
    }

    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [inverters, detailQueries, liveDevices, tagsById]);

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }
  if (devicesQuery.isLoading) return <LoadingState label="Loading Devices" />;
  if (devicesQuery.isError) {
    return <ErrorState error={devicesQuery.error} retry={() => void devicesQuery.refetch()} />;
  }

  const columns = (variant: string): Column<RankedInverter>[] => [
    {
      key: "rank",
      header: "Rank",
      align: "right",
      width: "70px",
      render: (row) =>
        row.rank === null ? (
          <span
            className="text-ink-faint"
            title={
              variant === "unspecified"
                ? "Not ranked: no Inverter variant is recorded on this Device Model."
                : "Not ranked: no live output, or no rated capacity to normalise it by."
            }
          >
            —
          </span>
        ) : (
          <span className={row.rank === 1 ? "text-ok" : "text-ink"}>#{row.rank}</span>
        ),
      sortValue: (row) => row.rank,
    },
    {
      key: "code",
      header: "Inverter",
      render: (row) => (
        <span className={row.stale ? "opacity-60" : undefined}>
          <span className="font-medium">{row.device.code}</span>
          <span className="ml-2 text-ink-muted">{row.device.name}</span>
        </span>
      ),
      sortValue: (row) => row.device.code,
      filterValue: (row) => `${row.device.code} ${row.device.name}`,
    },
    {
      key: "comm",
      header: "Comms",
      width: "110px",
      render: (row) => <CommStatusBadge status={row.device.comm_status} />,
      sortValue: (row) => row.device.comm_status ?? "unknown",
    },
    {
      key: "output",
      header: "Live output",
      align: "right",
      width: "140px",
      render: (row) =>
        row.liveValue === null ? (
          <span className="text-ink-faint" title="No live frame for this Device.">
            {UNDEFINED_DISPLAY}
          </span>
        ) : (
          <span className={row.stale ? "text-warn" : "text-info"}>
            {formatValue(row.liveValue, row.liveUnit)}
          </span>
        ),
      sortValue: (row) => row.liveValue,
    },
    {
      key: "rated",
      header: "Rated",
      align: "right",
      width: "110px",
      render: (row) => formatValue(row.ratedCapacityKw, "kW", { digits: 1 }),
      sortValue: (row) => row.ratedCapacityKw,
    },
    {
      key: "specific",
      header: "Output / rated",
      align: "right",
      width: "130px",
      render: (row) =>
        row.specificOutput === null ? (
          <span
            className="text-ink-faint"
            title="Needs both a live output and a rated capacity. Undefined, not zero."
          >
            {UNDEFINED_DISPLAY}
          </span>
        ) : (
          formatNumber(row.specificOutput, { digits: 3 })
        ),
      sortValue: (row) => row.specificOutput,
    },
    {
      key: "seen",
      header: "Last seen",
      width: "110px",
      render: (row) => (
        <LastSeen
          at={row.device.last_seen_at}
          expectedIntervalS={row.device.expected_interval_s}
        />
      ),
      sortValue: (row) =>
        row.device.last_seen_at ? Date.parse(row.device.last_seen_at) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Inverter Monitoring</h1>
          <p className="text-xs text-ink-muted">
            Comparison and ranking, within each Inverter variant.
          </p>
        </div>
        <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" />
      </div>

      {inverters.length === 0 ? (
        <AwaitingDeviceDataState
          screen="Inverter Monitoring"
          detail="No Inverters are registered in this Plant. The broker currently publishes Plant-level totals only — one meter and one weather station per Plant, and no Inverters."
        />
      ) : (
        grouped.map(([variant, rows]) => (
          <Panel
            key={variant}
            title={
              <span className="flex items-center gap-2">
                {VARIANT_LABEL[variant] ?? `Inverters — ${variant}`}
                <Badge tone={variant === "unspecified" ? "warn" : "accent"}>
                  {variant}
                </Badge>
                <InfoHint text={VARIANT_NOTE[variant] ?? VARIANT_NOTE.central} />
              </span>
            }
            subtitle={`${rows.length} Device(s). ${VARIANT_NOTE[variant] ?? VARIANT_NOTE.central}`}
          >
            <DataTable
              rows={rows}
              columns={columns(variant)}
              rowKey={(row) => row.device.id}
              filterPlaceholder="Filter Inverters…"
            />
          </Panel>
        ))
      )}
    </div>
  );
}
