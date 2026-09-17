/**
 * Arrange a Plant's electrical hierarchy, and watch the diagram follow.
 *
 * The Single Line Diagram is not a drawing anyone saves. It is recomputed from
 * one field per Device — "what do I feed into?" — every time it is requested. So
 * this screen never asks anyone to position a box: drag a Device onto another to
 * say it feeds into it, and the diagram beside it redraws from the server's own
 * tree builder. There is no second layout implementation in the browser that
 * could disagree with the real one.
 *
 * That is also why any plant shape works without a template. A meter can sit
 * anywhere in the chain, a Plant can have several incoming feeders, and a
 * Transformer can feed another Transformer — none of that is special-cased here,
 * because none of it is special-cased in the data.
 *
 * ⚠ Only Devices **in the power path** appear in the tree. A Weather Station or
 * a PPC is real and monitored but carries no current, and putting it in an
 * electrical diagram would make the diagram wrong (Guardrail 11). They are
 * listed separately so their absence reads as deliberate rather than missing.
 */

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePlantDevices, usePlantSld } from "@/api/hooks";
import * as devicesApi from "@/api/endpoints/devices";
import { isApiError } from "@/api/problem";
import { usePlantScope } from "@/state/usePlantScope";
import { usePermission } from "@/auth/usePermission";
import { PlantPicker } from "@/components/domain";
import { SldTree } from "@/components/sld/SldTree";
import { Badge, Panel } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  SkeletonPanel,
} from "@/components/state";
import type { DeviceListItem } from "@/api/schemas";

/** A Device plus the Devices that feed into it, for rendering one branch. */
interface TreeRow {
  device: DeviceListItem;
  depth: number;
}

/**
 * Flatten the hierarchy into indented rows.
 *
 * Deliberately tolerant of broken data: a Device whose parent is missing, or
 * caught in a ring, still appears — at the top level, flagged — rather than
 * vanishing. A Device you cannot see is a Device you cannot fix.
 */
function flatten(devices: DeviceListItem[]): { rows: TreeRow[]; unreachable: DeviceListItem[] } {
  const inPath = devices.filter((d) => d.in_power_path);
  const byId = new Map(inPath.map((d) => [d.id, d]));
  const childrenOf = new Map<number | null, DeviceListItem[]>();

  for (const device of inPath) {
    // A parent outside the power path is treated as no parent: the Device is
    // still part of the electrical story and must not disappear.
    const key = device.parent_device_id !== null && byId.has(device.parent_device_id)
      ? device.parent_device_id
      : null;
    const list = childrenOf.get(key) ?? [];
    list.push(device);
    childrenOf.set(key, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.code.localeCompare(b.code));

  const rows: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (parentId: number | null, depth: number): void => {
    for (const device of childrenOf.get(parentId) ?? []) {
      if (seen.has(device.id)) continue;
      seen.add(device.id);
      rows.push({ device, depth });
      walk(device.id, depth + 1);
    }
  };
  walk(null, 0);

  return { rows, unreachable: inPath.filter((d) => !seen.has(d.id)) };
}

/** Every Device that feeds into this one, at any depth — an invalid drop target. */
function descendantsOf(devices: DeviceListItem[], rootId: number): Set<number> {
  const out = new Set<number>();
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const device of devices) {
      if (
        device.parent_device_id !== null &&
        frontier.includes(device.parent_device_id) &&
        !out.has(device.id)
      ) {
        out.add(device.id);
        next.push(device.id);
      }
    }
    frontier = next;
  }
  return out;
}

export function PlantHierarchyEditor(): JSX.Element {
  const canManage = usePermission("plant.manage");
  const queryClient = useQueryClient();
  const { plants, plantId, setPlantId } = usePlantScope();
  const devicesQuery = usePlantDevices(plantId);
  const sldQuery = usePlantSld(plantId);

  const [dragging, setDragging] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | "root" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);
  const { rows, unreachable } = useMemo(() => flatten(devices), [devices]);
  const outsidePowerPath = devices.filter((d) => !d.in_power_path);

  // Where the dragged Device may not be dropped: itself, its current parent
  // (a no-op), and anything that already feeds into it (which would close a
  // ring). The server refuses these too — this only avoids offering them.
  const forbidden = useMemo(() => {
    if (dragging === null) return new Set<number>();
    const blocked = descendantsOf(devices, dragging);
    blocked.add(dragging);
    return blocked;
  }, [dragging, devices]);

  const reparent = useMutation({
    mutationFn: ({ childId, parentId }: { childId: number; parentId: number | null }) =>
      devicesApi.updateDevice(
        childId,
        parentId === null
          ? { clear: ["parent_device_id"] }
          : { parent_device_id: parentId },
      ),
    onSuccess: (_result, variables) => {
      setError(null);
      const child = devices.find((d) => d.id === variables.childId);
      const parent = devices.find((d) => d.id === variables.parentId);
      setNote(
        parent
          ? `${child?.code} now feeds into ${parent.code}.`
          : `${child?.code} now feeds into nothing — it is where this Plant meets the grid.`,
      );
      // Both queries, because the two views are the same fact seen twice: the
      // tree comes from the Device list, the diagram from the server's own tree
      // builder. Refreshing one without the other is how they drift apart.
      void queryClient.invalidateQueries({ queryKey: ["plants", plantId, "devices"] });
      void queryClient.invalidateQueries({ queryKey: ["plants", plantId, "sld"] });
    },
    onError: (err) => {
      setNote(null);
      setError(
        isApiError(err)
          ? err.displayMessage
          : "Could not change the hierarchy.",
      );
    },
  });

  if (!canManage) {
    return (
      <ForbiddenState detail="Arranging a Plant's hierarchy requires the plant.manage permission." />
    );
  }

  const drop = (parentId: number | null): void => {
    const childId = dragging;
    setDragging(null);
    setHovered(null);
    if (childId === null) return;
    if (parentId !== null && forbidden.has(parentId)) return;
    const child = devices.find((d) => d.id === childId);
    if (child && (child.parent_device_id ?? null) === parentId) return;
    reparent.mutate({ childId, parentId });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-ink">Plant hierarchy</h1>
        <p className="max-w-3xl text-xs leading-relaxed text-ink-muted">
          Drag a Device onto the Device it feeds into. The diagram is not a saved
          drawing — it is rebuilt from these connections every time it is opened,
          so it can never disagree with what is recorded here. Nothing is
          positioned by hand; the layout follows the connections.
        </p>
      </div>

      <Panel title="Plant">
        <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" />
      </Panel>

      {plantId === null ? (
        <EmptyState
          title="Choose a Plant"
          detail="A hierarchy belongs to one Plant — a Device can only ever feed into another Device at the same Plant."
        />
      ) : devicesQuery.isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <SkeletonPanel lines={8} />
          <SkeletonPanel lines={8} />
        </div>
      ) : devicesQuery.isError ? (
        <ErrorState error={devicesQuery.error} retry={() => void devicesQuery.refetch()} />
      ) : (
        <>
          {note ? (
            <p className="rounded border border-ok/30 bg-ok/10 px-3 py-1.5 text-xs text-ok">
              {note}
            </p>
          ) : null}
          {error ? (
            <p className="rounded border border-bad/30 bg-bad/10 px-3 py-1.5 text-xs text-bad">
              {error}
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* ── The editable tree ─────────────────────────────────────── */}
            <Panel
              title="Connections"
              subtitle="Drag a Device onto what it feeds into."
            >
              {rows.length === 0 ? (
                <EmptyState
                  title="No Devices in the power path"
                  detail="Only Devices that carry current appear here. Register an Inverter, Transformer, breaker or meter, and it will show up."
                />
              ) : (
                <div className="space-y-1">
                  {/* Dropping here clears the parent — the Device becomes a
                      root, which is what "meets the grid" means. */}
                  <div
                    onDragOver={(event) => {
                      event.preventDefault();
                      setHovered("root");
                    }}
                    onDragLeave={() => setHovered(null)}
                    onDrop={() => drop(null)}
                    className={`rounded border border-dashed px-3 py-2 text-[11px] transition ${
                      hovered === "root"
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-line text-ink-faint"
                    }`}
                  >
                    ⏚ Drop here to feed into nothing — the grid connection point
                  </div>

                  {rows.map(({ device, depth }) => {
                    const isForbidden = dragging !== null && forbidden.has(device.id);
                    const isHovered = hovered === device.id && !isForbidden;
                    return (
                      <div
                        key={device.id}
                        draggable
                        onDragStart={() => {
                          setDragging(device.id);
                          setNote(null);
                          setError(null);
                        }}
                        onDragEnd={() => {
                          setDragging(null);
                          setHovered(null);
                        }}
                        onDragOver={(event) => {
                          if (isForbidden) return;
                          event.preventDefault();
                          setHovered(device.id);
                        }}
                        onDragLeave={() => setHovered(null)}
                        onDrop={() => drop(device.id)}
                        style={{ marginLeft: `${depth * 22}px` }}
                        className={`flex cursor-grab items-center gap-2 rounded border px-3 py-2 text-sm transition ${
                          isHovered
                            ? "border-accent bg-accent/10"
                            : isForbidden
                              ? "border-line bg-surface-sunken opacity-40"
                              : "border-line bg-surface hover:border-line-strong"
                        } ${dragging === device.id ? "opacity-50" : ""}`}
                        title={
                          isForbidden
                            ? "Cannot drop here — this Device already feeds into the one being moved, and electricity cannot flow in a ring."
                            : `${device.code} — ${device.name}`
                        }
                      >
                        <span className="font-medium text-ink">{device.code}</span>
                        <span className="truncate text-xs text-ink-muted">
                          {device.type_code}
                        </span>
                        {device.parent_device_id === null ? (
                          <Badge tone="info" title="Feeds into nothing — the grid connection point.">
                            grid
                          </Badge>
                        ) : null}
                      </div>
                    );
                  })}

                  {unreachable.length > 0 ? (
                    <div className="mt-3 rounded border border-bad/30 bg-bad/10 px-3 py-2">
                      <p className="text-xs font-medium text-bad">
                        {unreachable.length} Device(s) in a loop
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                        These feed into each other in a ring, so no path reaches
                        the grid. Drag one onto the grid marker above to break it.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {unreachable.map((device) => (
                          <span
                            key={device.id}
                            draggable
                            onDragStart={() => setDragging(device.id)}
                            onDragEnd={() => setDragging(null)}
                            className="cursor-grab rounded border border-bad/40 bg-surface px-2 py-0.5 text-[11px] text-ink"
                          >
                            {device.code}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {outsidePowerPath.length > 0 ? (
                <div className="mt-4 border-t border-line pt-3">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                    Not in the diagram
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                    Real and monitored, but no current flows through them, so they
                    have no place in an electrical diagram.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {outsidePowerPath.map((device) => (
                      <Badge key={device.id} tone="neutral">
                        {device.code} · {device.type_code}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}
            </Panel>

            {/* ── The live diagram ──────────────────────────────────────── */}
            <Panel
              title="Diagram"
              subtitle="Redrawn by the server after every change."
            >
              {sldQuery.isLoading ? (
                <SkeletonPanel lines={8} title={false} />
              ) : sldQuery.isError ? (
                <ErrorState error={sldQuery.error} retry={() => void sldQuery.refetch()} />
              ) : sldQuery.data ? (
                <SldTree
                  sld={sldQuery.data}
                  overlay={{ commStatus: {}, livePower: {}, staleDevices: new Set() }}
                />
              ) : null}
              {reparent.isPending ? (
                <p className="mt-2 text-[11px] text-ink-faint">Saving…</p>
              ) : null}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}
