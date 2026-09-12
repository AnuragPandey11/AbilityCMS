/**
 * `sld` — Single Line Diagram (§6.4).
 *
 * The backend returns a ready-built tree; this renders it and overlays live
 * state. The three rules it exists to honour are in `SldTree`, and they are all
 * about what must **not** appear or be dropped: no Blocks in the tree, non-power-path
 * Devices beside it rather than removed, and orphans surfaced as a warning.
 *
 * ⚠ Today the tree is usually two meters — there is no equipment hierarchy in
 * the live data yet (§0.4). That is a data state, not a fault, and it is said
 * plainly rather than left as a thin diagram someone reads as broken.
 */

import { useState } from "react";
import { usePlantDevices, usePlantSld, useTagsById } from "@/api/hooks";
import { SldTree, type SldOverlay } from "@/components/sld/SldTree";
import { Panel, Badge } from "@/components/ui";
import { EmptyState, ErrorState, LoadingState } from "@/components/state";
import { CommStatusBadge, PlantPicker } from "@/components/domain";
import { usePlantScope } from "@/state/usePlantScope";
import { useLiveSocket } from "@/live/LiveSocket";
import { STALE_INTERVAL_MULTIPLIER } from "@/live/useLiveDevice";
import { formatValue } from "@/format/value";
import { formatAge } from "@/format/datetime";
import type { CommStatus } from "@/api/schemas";

export function SldDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = usePlantScope();
  const sldQuery = usePlantSld(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const tagsById = useTagsById();
  const { devices: liveDevices } = useLiveSocket();
  const [selected, setSelected] = useState<number | null>(null);

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }
  if (sldQuery.isLoading) return <LoadingState label="Building diagram" />;
  if (sldQuery.isError) {
    return <ErrorState error={sldQuery.error} retry={() => void sldQuery.refetch()} />;
  }

  const sld = sldQuery.data!;
  const devices = devicesQuery.data ?? [];

  const commStatus: Record<number, CommStatus> = {};
  const staleDevices = new Set<number>();
  for (const device of devices) {
    commStatus[device.id] = device.comm_status ?? "unknown";
    const frame = liveDevices[device.id];
    if (frame) {
      const age = (Date.now() - Date.parse(frame.at)) / 1000;
      // The same threshold the health sweeper uses, so the diagram and the
      // Alarm agree rather than disagreeing by a few seconds.
      if (age > device.expected_interval_s * STALE_INTERVAL_MULTIPLIER) {
        staleDevices.add(device.id);
      }
    }
  }

  const livePower: Record<number, string> = {};
  for (const [deviceId, frame] of Object.entries(liveDevices)) {
    for (const [tagId, value] of Object.entries(frame.values)) {
      const tag = tagsById.get(Number(tagId));
      // Whichever electrical Tag this Device is bound to — not a named Tag
      // (§0.3). The unit is the catalogue's, rendered verbatim.
      if (tag && tag.category === "electrical") {
        livePower[Number(deviceId)] = formatValue(value, tag.unit);
        break;
      }
    }
  }

  const overlay: SldOverlay = { commStatus, livePower, staleDevices };
  const selectedDevice = devices.find((device) => device.id === selected) ?? null;

  const sparse = sld.device_count > 0 && sld.roots.length > 0 && sld.device_count <= 2;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Single Line Diagram</h1>
          <p className="text-xs text-ink-muted">
            The electrical path — what each Device is wired into. {sld.device_count}{" "}
            Device(s) in the power path.
          </p>
        </div>
        <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" />
      </div>

      {sparse ? (
        <div className="rounded border border-info/30 bg-info/10 px-4 py-3 text-xs text-ink-muted">
          This Plant currently reports through {sld.device_count} Device(s), so the
          diagram is correspondingly small. Per-Device publishing has not started;
          the tree will fill out on its own as equipment begins reporting.
        </div>
      ) : null}

      {sld.orphaned.length > 0 ? (
        // A data problem, surfaced. Dropping these would make the diagram claim
        // the Plant has less equipment than it does.
        <div className="rounded border border-warn/30 bg-warn/10 px-4 py-3">
          <p className="text-sm font-medium text-warn">
            {sld.orphaned.length} Device(s) are not connected to the power path
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            These name a parent Device that is missing, decommissioned, or in another
            Plant, so they cannot be placed in the tree. They are listed here rather
            than dropped:{" "}
            <span className="font-mono">
              {sld.orphaned.map((device) => device.code).join(", ")}
            </span>
          </p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
        <Panel
          title="Power path"
          subtitle="Blocks are deliberately absent — a Block says where a Device is, not what it feeds."
        >
          <SldTree
            sld={sld}
            overlay={overlay}
            onSelect={setSelected}
            selectedDeviceId={selected}
          />
        </Panel>

        <div className="space-y-4">
          <Panel
            title="Not in the power path"
            subtitle="Real, monitored Devices that carry no current."
          >
            {sld.excluded_not_in_power_path.length === 0 ? (
              <p className="text-xs text-ink-faint">None.</p>
            ) : (
              <ul className="space-y-1.5">
                {sld.excluded_not_in_power_path.map((device) => (
                  <li
                    key={device.device_id}
                    className="flex items-center justify-between rounded border border-line bg-surface px-2 py-1.5"
                  >
                    <span className="text-xs text-ink">{device.code}</span>
                    <Badge
                      tone="neutral"
                      title="Monitored, but outside the electrical diagram — a Weather Station or a plant controller carries no current."
                    >
                      {device.type}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {selectedDevice ? (
            <Panel title={selectedDevice.code} subtitle={selectedDevice.name}>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Type</dt>
                  <dd className="text-ink">
                    {selectedDevice.type_code}
                    {selectedDevice.variant ? ` · ${selectedDevice.variant}` : ""}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Comms</dt>
                  <dd>
                    <CommStatusBadge status={selectedDevice.comm_status} />
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Expected interval</dt>
                  <dd className="font-mono text-ink">
                    {selectedDevice.expected_interval_s}s
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Last seen</dt>
                  <dd className="text-ink">
                    {selectedDevice.last_seen_at
                      ? formatAge(
                          (Date.now() - Date.parse(selectedDevice.last_seen_at)) / 1000,
                        )
                      : "never"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-muted" title="The Device that transmits this one.">
                    Reports via
                  </dt>
                  <dd className="text-ink">
                    {selectedDevice.reports_via_device_id
                      ? `#${selectedDevice.reports_via_device_id}`
                      : "direct"}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-ink-muted" title="Geographic grouping — never drawn in this diagram.">
                    Block
                  </dt>
                  <dd className="text-ink">
                    {selectedDevice.block_id ? `#${selectedDevice.block_id}` : "none"}
                  </dd>
                </div>
              </dl>
            </Panel>
          ) : (
            <Panel title="Device detail">
              <p className="text-xs text-ink-faint">Select a node to inspect it.</p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
