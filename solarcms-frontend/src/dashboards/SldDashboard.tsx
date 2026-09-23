/**
 * `sld` — Single Line Diagram (§6.4).
 *
 * The backend returns a ready-built tree; this renders it and overlays live
 * state. The four rules it exists to honour are in `SldTree`, and they are all
 * about what must **not** appear or be dropped: no Blocks in the tree, no
 * Collector drawn as a Device, non-power-path Devices beside it rather than
 * removed, and orphans surfaced as a warning.
 *
 * Clicking a node opens everything recorded about that Device — its three
 * groupings, its enclosure, its topic, its health, its model. A diagram whose
 * boxes are inert makes you leave it to find out anything, and the question
 * that brought you here ("which Inverter, and what is wrong with it") is
 * answered in two places or not at all.
 *
 * ⚠ Today the tree is often thin — there is no equipment hierarchy in the live
 * data until someone sets it in the hierarchy editor (§0.4). That is a data
 * state, not a fault, and it is said plainly rather than left as a small
 * diagram someone reads as broken.
 */

import { useState } from "react";
import { usePlant, usePlantDevices, usePlantSld, useTagsById } from "@/api/hooks";
import { SldTree, type SldOverlay } from "@/components/sld/SldTree";
import { PlantFlow } from "@/components/sld/PlantFlow";
import { Panel, Badge } from "@/components/ui";
import { EmptyState, ErrorState, SkeletonPanel } from "@/components/state";
import { CommStatusBadge, PlantPicker } from "@/components/domain";
import { DeviceInspector } from "@/components/devices/DeviceInspector";
import { Drawer } from "@/components/ui";
import { IconChevronRight } from "@/components/icons";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { DEFAULT_TIMEZONE } from "@/format/datetime";
import { useLiveSocket } from "@/live/LiveSocket";
import { STALE_INTERVAL_MULTIPLIER } from "@/live/useLiveDevice";
import { formatValue } from "@/format/value";
import type { CommStatus } from "@/api/schemas";

export function SldDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  // Every timestamp in the inspector renders in the Plant's zone, never the
  // browser's (Guardrail 11).
  const plantQuery = usePlant(plantId);
  const timezone = plantQuery.data?.timezone ?? DEFAULT_TIMEZONE;
  const sldQuery = usePlantSld(plantId);
  const devicesQuery = usePlantDevices(plantId);
  const tagsById = useTagsById();
  const { devices: liveDevices } = useLiveSocket();
  const [selected, setSelected] = useState<number | null>(null);
  /**
   * The stage whose Devices are being listed.
   *
   * Held here rather than inside `PlantFlow` so the list opens in a drawer
   * beside the page instead of expanding between the schematic and the power
   * path, which pushed everything below it down by the height of the list.
   */
  const [openStage, setOpenStage] = useState<{ typeCode: string; deviceIds: number[] } | null>(
    null,
  );

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }
  if (sldQuery.isLoading) {
    return (
      <div className="space-y-4">
        <SkeletonPanel lines={1} />
        <SkeletonPanel lines={8} title={false} />
      </div>
    );
  }
  if (sldQuery.isError) {
    return <ErrorState error={sldQuery.error} retry={() => void sldQuery.refetch()} />;
  }

  const sld = sldQuery.data!;
  /**
   * What each enclosure feeds into, keyed by code.
   *
   * The schematic derives depth from what a Device is wired into, and a Device
   * inside a collector has no parent of its own — the server refuses that edge,
   * because the room owns it. Without this a correctly wired Plant reads as
   * unwired. The Collector is still never a node: this only tells the row where
   * its occupants sit in the chain.
   */
  const collectorEdges = Object.fromEntries(
    sld.collectors.map((c) => [c.code, c.parent_device_id]),
  );
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
  const devicesById = new Map(devices.map((device) => [device.id, device]));

  const sparse = sld.device_count > 0 && sld.roots.length > 0 && sld.device_count <= 2;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="page-title">Single Line Diagram</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            The electrical path — what each Device is wired into. {sld.device_count}{" "}
            Device(s) in the power path
            {sld.collectors.length > 0
              ? `, in ${sld.collectors.length} collector(s)`
              : ""}
            .
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

      {/*
        The Plant's *actual* chain of equipment, rolled up by type and distance
        from the grid. Distinct from the four-stage spine on the Single Plant
        dashboard, which folds every Plant into the same four boxes so two Plants
        can be compared: this one shows what is really wired, in the order it is
        really wired, which is what you want once you are already on the SLD page.
      */}
      <Panel
        title="Plant schematic"
        subtitle="Derived from the wiring, not from a fixed sequence — a Plant with a meter mid-chain or two transformers draws itself."
      >
        <PlantFlow
          devices={devices}
          collectorEdges={collectorEdges}
          onSelectStage={(stage) => setOpenStage(stage)}
        />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_20rem]">
        <Panel
          title="Power path"
          subtitle="Blocks are deliberately absent — a Block says where a Device is, not what it feeds. A dashed outline is a collector: a room, not a component."
          className="min-w-0"
        >
          <SldTree
            sld={sld}
            overlay={overlay}
            onSelect={setSelected}
            selectedDeviceId={selected}
            height={460}
            label={
              selectedDevice
                ? `Selected: ${selectedDevice.code}`
                : "Tap a Device for its detail"
            }
          />
        </Panel>

        <div className="space-y-4">
          {sld.collectors.length > 0 ? (
            <Panel
              title="Collectors"
              subtitle="Enclosures, not equipment. Nothing is wired through one."
            >
              <ul className="space-y-1.5">
                {sld.collectors.map((collector) => (
                  <li
                    key={collector.code}
                    className="rounded border border-dashed border-line-strong bg-surface-sunken px-2 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs font-medium text-ink">
                        {collector.code}
                      </span>
                      <Badge tone="neutral">{collector.device_count} Device(s)</Badge>
                    </div>
                    {collector.in_power_path_count < collector.device_count ? (
                      <p className="mt-0.5 text-[11px] text-ink-faint">
                        {collector.in_power_path_count} in the power path; the rest
                        carry no current and are not drawn in the tree.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <Panel
            title="Not in the power path"
            subtitle="Real, monitored Devices that carry no current."
          >
            {sld.excluded_not_in_power_path.length === 0 ? (
              <p className="text-xs text-ink-faint">None.</p>
            ) : (
              <ul className="space-y-1.5">
                {sld.excluded_not_in_power_path.map((device) => (
                  <li key={device.device_id}>
                    <button
                      type="button"
                      onClick={() => setSelected(device.device_id)}
                      className="flex w-full items-center justify-between gap-2 rounded border border-line bg-surface px-2 py-1.5 text-left hover:border-line-strong"
                    >
                      <span className="truncate text-xs text-ink">{device.code}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <CommStatusBadge
                          status={commStatus[device.device_id] ?? "unknown"}
                        />
                        <Badge
                          tone="neutral"
                          title="Monitored, but outside the electrical diagram — a Weather Station or a plant controller carries no current."
                        >
                          {device.type}
                        </Badge>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      {/*
        ── One flow for "what is this thing" ──────────────────────────────────
        A Device opens the same inspector, in the same drawer, whether it was
        found on the schematic, in the power path, in the not-in-power-path
        list, or on the Plant dashboard. The page behind it does not move, and
        the panel is a fixed column at every width rather than whatever a grid
        cell happened to leave over — which is what made the old right-hand
        version a long ribbon on a wide screen and a full-width wall on a narrow
        one.
      */}
      <Drawer
        open={selectedDevice !== null}
        onClose={() => setSelected(null)}
        title={selectedDevice ? `${selectedDevice.code} — ${selectedDevice.name}` : ""}
      >
        {selectedDevice ? (
          <DeviceInspector
            device={selectedDevice}
            values={liveDevices[selectedDevice.id]?.values}
            timezone={timezone}
            deviceLookup={devicesById}
          />
        ) : null}
      </Drawer>

      {/* A stage lists its Devices, each of which opens the inspector above. */}
      <Drawer
        open={openStage !== null && selectedDevice === null}
        onClose={() => setOpenStage(null)}
        title={openStage ? openStage.typeCode.replace(/_/g, " ") : ""}
        subtitle="Every Device folded into this stage of the schematic."
      >
        {openStage ? (
          <ul className="divide-y divide-line-soft">
            {openStage.deviceIds.map((deviceId) => {
              const device = devicesById.get(deviceId);
              if (!device) return null;
              return (
                <li key={deviceId}>
                  <button
                    type="button"
                    onClick={() => setSelected(deviceId)}
                    className="flex w-full items-center gap-2 py-2 text-left transition hover:text-accent"
                  >
                    <DeviceArt typeCode={device.type_code} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-ink">
                        {device.code}
                      </span>
                      <span className="block truncate text-[10px] text-ink-faint">
                        {device.type_code}
                        {device.collector_code ? ` · in ${device.collector_code}` : ""}
                      </span>
                    </span>
                    <CommStatusBadge status={device.comm_status} />
                    <IconChevronRight size={13} className="shrink-0 text-ink-faint" />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Drawer>
    </div>
  );
}
