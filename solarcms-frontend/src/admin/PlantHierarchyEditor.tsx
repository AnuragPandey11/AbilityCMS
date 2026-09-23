/**
 * Arrange a Plant's electrical hierarchy, and watch the diagram follow.
 *
 * The Single Line Diagram is not a drawing anyone saves. It is recomputed from
 * one field per Device — "what do I feed into?" — every time it is requested. So
 * this screen never asks anyone to position a box: say a Device feeds into
 * another, and the diagram beside it redraws from the server's own tree builder.
 * There is no second layout implementation in the browser that could disagree
 * with the real one.
 *
 * That is also why any plant shape works without a template. A meter can sit
 * anywhere in the chain, a Plant can have several incoming feeders, and a
 * Transformer can feed another Transformer — none of that is special-cased here,
 * because none of it is special-cased in the data.
 *
 * Two ways to say it, because a Plant with forty Inverters makes dragging across
 * a scrolling list miserable and a pointer is not available to everyone: drag a
 * Device onto its parent, or pick the parent from the row's own list. Both issue
 * the same PATCH.
 *
 * ⚠ Only Devices **in the power path** appear in the tree. A Weather Station or
 * a PPC is real and monitored but carries no current, and putting it in an
 * electrical diagram would make the diagram wrong (Guardrail 11). They are
 * listed separately so their absence reads as deliberate rather than missing.
 *
 * ── Collectors ──────────────────────────────────────────────────────────────
 * A Collector — an MCR, an ICR, a panel — is an *enclosure*, and the second
 * thing this screen edits. It is **never a Device**: nothing is wired through
 * a room, so it has no place in the hierarchy and no row of its own. It is set
 * per Device, as a name, and the diagram draws a dashed outline around
 * everything sharing that name.
 *
 * Which means the two things this screen says about a Device are deliberately
 * independent: *what it feeds into* (the chain, which the diagram is built
 * from) and *where it sits* (the enclosure, which is drawn around the chain).
 * An Inverter in the MCR can perfectly well feed a transformer outside it, and
 * the diagram has to be able to say so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlantDevices, usePlantSld } from "@/api/hooks";
import * as devicesApi from "@/api/endpoints/devices";
import * as plantsApi from "@/api/endpoints/plants";
import { isApiError } from "@/api/problem";
import { usePlantScope } from "@/state/usePlantScope";
import { usePermission } from "@/auth/usePermission";
import { PlantPicker } from "@/components/domain";
import { SldTree } from "@/components/sld/SldTree";
import { DeviceInspector } from "@/components/devices/DeviceInspector";
import { DeviceIcon } from "@/components/devices/DeviceIcon";
import { usePlant } from "@/api/hooks";
import { DEFAULT_TIMEZONE } from "@/format/datetime";
import { Badge, Button, Panel, inputClass } from "@/components/ui";
import {
  EmptyState,
  ErrorState,
  ForbiddenState,
  SkeletonPanel,
} from "@/components/state";
import type { DeviceListItem } from "@/api/schemas";

/** How often the screen re-reads the hierarchy while it is being watched. */
const REFRESH_MS = 10_000;

/**
 * Device codes are numbered, and a plain string sort files INVERTER_10 between
 * INVERTER_1 and INVERTER_2 — which reads as data corruption to the operator who
 * numbered them. Collate numerically so runs stay in their own order.
 */
function byCode(a: DeviceListItem, b: DeviceListItem): number {
  return a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Whether a human may say which enclosure this Device sits in.
 *
 * Almost always: no. A Collector is the enclosure a Device *publishes from*,
 * so the topic decides it — six segments name the room, five say there is no
 * room, and either way a typed-in value is a contradiction rather than an
 * override (Guardrail 5). The server refuses both, so offering an editable box
 * would only invite a rejection.
 *
 * The exception is a Device with no topic yet — registered ahead of
 * commissioning — where nobody has stated anything and somebody has to. The
 * Plant KPI panel is excluded even then: it is synthetic, publishes nothing,
 * and will never have a topic, so the question has no answer for it at all.
 */
function collectorIsEditable(device: DeviceListItem): boolean {
  return !device.source_address && device.type_code !== "PLANT_KPI";
}

/** A Device plus where it sits in the tree, for rendering one branch. */
interface TreeRow {
  device: DeviceListItem;
  depth: number;
  childCount: number;
}

/**
 * Every Device that feeds into each Device, at any depth.
 *
 * Walked upwards from each Device rather than downwards from each root, so the
 * whole map costs one pass over the ancestors instead of a descendant search per
 * Device. The guard set stops a ring in the data from hanging the render, the
 * same reason the server's tree builder counts rather than recurses.
 */
function descendantMap(devices: DeviceListItem[]): Map<number, Set<number>> {
  const byId = new Map(devices.map((d) => [d.id, d]));
  const out = new Map<number, Set<number>>();
  for (const device of devices) {
    const guard = new Set<number>([device.id]);
    let cursor = device.parent_device_id;
    while (cursor !== null && byId.has(cursor) && !guard.has(cursor)) {
      guard.add(cursor);
      const set = out.get(cursor) ?? new Set<number>();
      set.add(device.id);
      out.set(cursor, set);
      cursor = byId.get(cursor)?.parent_device_id ?? null;
    }
  }
  return out;
}

/**
 * Flatten the hierarchy into indented rows.
 *
 * Deliberately tolerant of broken data: a Device whose parent is missing, or
 * caught in a ring, still appears — at the top level, flagged — rather than
 * vanishing. A Device you cannot see is a Device you cannot fix.
 */
function flatten(
  devices: DeviceListItem[],
  collapsed: Set<number>,
): { rows: TreeRow[]; unreachable: DeviceListItem[] } {
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
  for (const list of childrenOf.values()) list.sort(byCode);

  const rows: TreeRow[] = [];
  const seen = new Set<number>();
  const walk = (parentId: number | null, depth: number): void => {
    for (const device of childrenOf.get(parentId) ?? []) {
      if (seen.has(device.id)) continue;
      seen.add(device.id);
      rows.push({
        device,
        depth,
        childCount: childrenOf.get(device.id)?.length ?? 0,
      });
      if (!collapsed.has(device.id)) walk(device.id, depth + 1);
    }
  };
  walk(null, 0);

  return { rows, unreachable: inPath.filter((d) => !seen.has(d.id)) };
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
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [watching, setWatching] = useState(true);
  /** What the last change moved, so it can be put back in one click. */
  const [undo, setUndo] = useState<{ childId: number; parentId: number | null } | null>(null);
  /** Which Device's full record is open beside the diagram. */
  const [inspecting, setInspecting] = useState<number | null>(null);

  /**
   * Which collector boxes the operator has actually typed in.
   *
   * ⚠ Load-bearing, not an optimisation. The collector inputs are uncontrolled
   * (`defaultValue` + a `key` carrying the stored value), so when that value
   * changes underneath them — a refresh, or an edit made elsewhere — React
   * unmounts the old node and mounts a new one. If the old node happened to
   * hold focus, the browser fires `blur` on it **as it is removed**, carrying
   * the value it had before the change. A handler that commits on every blur
   * then writes that stale value straight back.
   *
   * That is not hypothetical: it silently re-applied `collector_code = 'MCR'`
   * to two Devices that had just been moved out of the MCR, from a page nobody
   * was touching, and the audit log recorded it as a deliberate edit.
   *
   * So a blur commits only if a keystroke preceded it. A field nobody typed in
   * cannot write.
   */
  const editedCollectors = useRef<Set<number>>(new Set());

  // Timestamps in the inspector render in the Plant's zone (Guardrail 11).
  const plantQuery = usePlant(plantId);
  const timezone = plantQuery.data?.timezone ?? DEFAULT_TIMEZONE;
  const devices = useMemo(() => devicesQuery.data ?? [], [devicesQuery.data]);
  const descendants = useMemo(() => descendantMap(devices), [devices]);
  const query = filter.trim().toLowerCase();

  // A collapsed branch would hide a match, so searching expands everything. A
  // search that silently skips the Device you typed is worse than no search.
  const { rows, unreachable } = useMemo(
    () => flatten(devices, query === "" ? collapsed : new Set<number>()),
    [devices, collapsed, query],
  );

  const devicesById = useMemo(
    () => new Map(devices.map((d) => [d.id, d])),
    [devices],
  );
  const inspectedDevice =
    inspecting === null ? null : (devicesById.get(inspecting) ?? null);

  const inPath = useMemo(() => devices.filter((d) => d.in_power_path).sort(byCode), [devices]);
  const outsidePowerPath = useMemo(() => devices.filter((d) => !d.in_power_path), [devices]);

  /**
   * Rows surviving the search — matches, plus the ancestors that carry them.
   *
   * Without the ancestors a match would appear at the wrong indent, which is a
   * claim about the wiring rather than about the filter.
   */
  const visibleRows = useMemo(() => {
    if (query === "") return rows;
    const byId = new Map(devices.map((d) => [d.id, d]));
    const keep = new Set<number>();
    for (const { device } of rows) {
      const haystack = `${device.code} ${device.name} ${device.type_code}`.toLowerCase();
      if (!haystack.includes(query)) continue;
      keep.add(device.id);
      const guard = new Set<number>([device.id]);
      let cursor = device.parent_device_id;
      while (cursor !== null && byId.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        keep.add(cursor);
        cursor = byId.get(cursor)?.parent_device_id ?? null;
      }
    }
    return rows.filter((row) => keep.has(row.device.id));
  }, [rows, devices, query]);

  // Where the dragged Device may not be dropped: itself, and anything that
  // already feeds into it (which would close a ring). The server refuses these
  // too — this only avoids offering them.
  const forbidden = useMemo(() => {
    if (dragging === null) return new Set<number>();
    const blocked = new Set(descendants.get(dragging) ?? []);
    blocked.add(dragging);
    return blocked;
  }, [dragging, descendants]);

  const refresh = useCallback((): void => {
    if (plantId === null) return;
    // Both queries, because the two views are the same fact seen twice: the tree
    // comes from the Device list, the diagram from the server's own tree
    // builder. Refreshing one without the other is how they drift apart.
    void queryClient.invalidateQueries({ queryKey: ["plants", plantId, "devices"] });
    void queryClient.invalidateQueries({ queryKey: ["plants", plantId, "sld"] });
  }, [queryClient, plantId]);

  /**
   * Keep the screen current without a browser reload.
   *
   * Someone else re-wiring the same Plant, a bulk import, or a device registered
   * from the broker all change this tree underneath whoever is looking at it,
   * and a stale hierarchy is the one thing this screen must never show. Paused
   * mid-drag and while the tab is hidden: re-ordering the list under a pointer
   * that is already holding a row drops it on the wrong parent.
   */
  useEffect(() => {
    if (!watching || plantId === null) return;
    const tick = (): void => {
      if (document.hidden || dragging !== null) return;
      refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, [watching, plantId, dragging, refresh]);

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
      refresh();
    },
    onError: (err) => {
      setNote(null);
      setUndo(null);
      setError(
        isApiError(err)
          ? err.displayMessage
          : "Could not change the hierarchy.",
      );
    },
  });

  const move = useCallback(
    (childId: number, parentId: number | null): void => {
      const child = devices.find((d) => d.id === childId);
      if (!child) return;
      if ((child.parent_device_id ?? null) === parentId) return;
      if (parentId !== null && (descendants.get(childId)?.has(parentId) || childId === parentId)) {
        return;
      }
      setUndo({ childId, parentId: child.parent_device_id ?? null });
      reparent.mutate({ childId, parentId });
    },
    [devices, descendants, reparent],
  );

  /**
   * Every enclosure named at this Plant, so the same one is picked rather than
   * retyped. Free text stays possible — the first Device in a new room has
   * nothing to pick from — but a datalist means "MCR" is offered instead of
   * someone inventing "MCR " and getting two boxes that look identical.
   */
  /**
   * Every enclosure at this Plant and the single outward edge each owns.
   *
   * ⚠ A Collector is **not a Device** (Guardrail 12) — no Model, no Tags, no
   * topic, never in a Device list, and drawn as a box *around* its occupants
   * rather than as a node. Nothing here changes that. It is editable only
   * because the box owns exactly one fact beyond its name: what it feeds into.
   */
  const collectorsQuery = useQuery({
    queryKey: ["plants", plantId, "collectors"],
    queryFn: () => plantsApi.listPlantCollectors(Number(plantId)),
    enabled: plantId !== null,
  });
  const collectors = useMemo(
    () => collectorsQuery.data ?? [],
    [collectorsQuery.data],
  );

  const setCollectorEdge = useMutation({
    mutationFn: ({ code, parentId }: { code: string; parentId: number | null }) =>
      plantsApi.setCollectorParent(Number(plantId), code, parentId),
    onSuccess: (_result, variables) => {
      setError(null);
      const target = devices.find((d) => d.id === variables.parentId);
      setNote(
        variables.parentId === null
          ? `${variables.code} no longer records what it feeds into.`
          : `${variables.code} feeds into ${target?.code ?? "that Device"}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["plants", plantId] });
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not set what that collector feeds into.",
      ),
  });

  const collectorCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const device of devices) {
      if (device.collector_code) codes.add(device.collector_code);
    }
    return [...codes].sort((a, b) => a.localeCompare(b));
  }, [devices]);

  const setCollector = useMutation({
    mutationFn: ({ deviceId, code }: { deviceId: number; code: string | null }) =>
      devicesApi.updateDevice(
        deviceId,
        // An empty box means "in no enclosure", which a PATCH cannot express by
        // omitting the field — `null` and "unchanged" are the same JSON.
        code === null ? { clear: ["collector_code"] } : { collector_code: code },
      ),
    onSuccess: (_result, variables) => {
      setError(null);
      const device = devices.find((d) => d.id === variables.deviceId);
      setNote(
        variables.code === null
          ? `${device?.code} is no longer in a collector.`
          : `${device?.code} is in collector ${variables.code}.`,
      );
      // No undo offered here: unlike a re-parent, this changes nothing about
      // the electrical chain, and the previous value is one keystroke away.
      setUndo(null);
      refresh();
    },
    onError: (err) => {
      setNote(null);
      setError(
        isApiError(err) ? err.displayMessage : "Could not change the collector.",
      );
    },
  });

  const commitCollector = useCallback(
    (device: DeviceListItem, raw: string): void => {
      const value = raw.trim();
      const current = device.collector_code ?? "";
      if (value === current) return;
      setCollector.mutate({ deviceId: device.id, code: value === "" ? null : value });
    },
    [setCollector],
  );

  const toggleCollapse = (id: number): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
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
    move(childId, parentId);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="page-title">Plant hierarchy</h1>
          <p className="max-w-3xl mt-1.5 text-sm leading-relaxed text-ink-muted">
            Say what each Device feeds into — drag it onto its parent, or pick the
            parent from the row. The diagram is not a saved drawing; it is rebuilt
            from these connections every time it is opened, so it can never
            disagree with what is recorded here.
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <div className="w-56">
            <PlantPicker
              plants={plants}
              value={plantId}
              onChange={setPlantId}
              label="Plant"
            />
          </div>
          <button
            type="button"
            onClick={() => setWatching((on) => !on)}
            aria-pressed={watching}
            title={
              watching
                ? "Re-reading the hierarchy every few seconds. Turn off to hold the current view still."
                : "Not re-reading. The tree may be out of date."
            }
            className={`flex items-center gap-1.5 rounded-control border px-2.5 py-1.5 text-xs font-medium transition ${
              watching
                ? "border-ok/40 bg-ok/10 text-ok"
                : "border-line bg-surface-raised text-ink-muted hover:text-ink"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                watching ? "animate-pulse bg-ok" : "bg-ink-faint"
              }`}
            />
            {watching ? "Live" : "Paused"}
          </button>
          <Button
            onClick={refresh}
            disabled={plantId === null || devicesQuery.isFetching}
            title="Re-read the hierarchy from the server now."
          >
            {devicesQuery.isFetching ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

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
            <div className="flex flex-wrap items-center gap-3 rounded border border-ok/30 bg-ok/10 px-3 py-1.5 text-xs text-ok">
              <span>{note}</span>
              {undo ? (
                <button
                  type="button"
                  onClick={() => {
                    const step = undo;
                    setUndo(null);
                    move(step.childId, step.parentId);
                  }}
                  className="font-medium underline underline-offset-2 hover:opacity-80"
                >
                  Undo
                </button>
              ) : null}
            </div>
          ) : null}
          {error ? (
            <p className="rounded border border-bad/30 bg-bad/10 px-3 py-1.5 text-xs text-bad">
              {error}
            </p>
          ) : null}

          {/* ⚠ Order matters here, and getting it wrong is invisible in the
              source. The Collectors panel is `lg:col-span-2`, and CSS grid
              auto-placement cannot fit a two-column item into the one free
              cell beside Connections — so it dropped to its own row and pushed
              the Diagram down to a *third* row, at half width, leaving the cell
              next to the tree permanently empty. The tree and the diagram it
              produces now sit side by side, which is the whole point of the
              screen; the enclosure edges span the full width beneath them. */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            {/* ── The editable tree ─────────────────────────────────────── */}
            <Panel
              title="Connections"
              subtitle="Drag a Device onto what it feeds into, or use its “feeds into” list."
              actions={
                <span className="text-[11px] text-ink-faint">
                  {inPath.length} in the power path
                </span>
              }
            >
              {rows.length === 0 ? (
                <EmptyState
                  title="No Devices in the power path"
                  detail="Only Devices that carry current appear here. Register an Inverter, Transformer, breaker or meter, and it will show up."
                />
              ) : (
                <div className="space-y-1">
                  <input
                    type="search"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Find a Device by code, name or type…"
                    aria-label="Filter Devices"
                    className={inputClass}
                  />
                  {query !== "" ? (
                    <p className="px-0.5 pb-1 text-[11px] text-ink-faint">
                      {visibleRows.length} of {rows.length} shown — parents are kept
                      so the indentation still tells the truth.
                    </p>
                  ) : null}

                  {/* The rows scroll inside the panel rather than lengthening
                      the page. A forty-Inverter Plant otherwise pushed the
                      diagram — the thing the edits are being judged against —
                      several screens below the list making them. The filter
                      above and the loop warning below stay out of this box, so
                      neither can be scrolled out of reach. */}
                  <div className="space-y-1 lg:max-h-[27rem] lg:overflow-y-auto lg:pr-1">
                  {/* Dropping here clears the parent — the Device becomes a
                      root, which is what "meets the grid" means. Sticky, so it
                      stays reachable without scrolling to the top mid-drag. */}
                  <div
                    onDragOver={(event) => {
                      event.preventDefault();
                      setHovered("root");
                    }}
                    onDragLeave={() => setHovered(null)}
                    onDrop={() => drop(null)}
                    className={`sticky top-0 z-10 rounded border border-dashed px-3 py-2 text-[11px] backdrop-blur transition ${
                      hovered === "root"
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-line bg-surface-raised/90 text-ink-faint"
                    }`}
                  >
                    ⏚ Drop here to feed into nothing — the grid connection point
                  </div>

                  {visibleRows.map(({ device, depth, childCount }) => {
                    const isForbidden = dragging !== null && forbidden.has(device.id);
                    const isHovered = hovered === device.id && !isForbidden;
                    const blocked = descendants.get(device.id) ?? new Set<number>();
                    return (
                      <div
                        key={device.id}
                        className="flex items-center"
                        style={{ paddingLeft: `${depth * 18}px` }}
                      >
                        {/* A tick joining the row to its indent, so a child
                            reads as wired to the row above rather than merely
                            printed further right. */}
                        {depth > 0 ? (
                          <span className="mr-1 h-px w-3 shrink-0 bg-line-strong" aria-hidden />
                        ) : null}
                        <div
                          onDragOver={(event) => {
                            if (isForbidden) return;
                            event.preventDefault();
                            setHovered(device.id);
                          }}
                          onDragLeave={() => setHovered(null)}
                          onDrop={() => drop(device.id)}
                          className={`flex min-w-0 flex-1 items-center gap-2 rounded border px-2 py-1.5 text-sm transition ${
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
                          {/* Only the grip is draggable: a draggable row swallows
                              clicks meant for the select inside it. */}
                          <span
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
                            title={`Drag ${device.code} onto what it feeds into`}
                            aria-label={`Drag ${device.code}`}
                            className="cursor-grab select-none px-0.5 text-ink-faint hover:text-ink active:cursor-grabbing"
                          >
                            ⠿
                          </span>

                          {childCount > 0 ? (
                            <button
                              type="button"
                              onClick={() => toggleCollapse(device.id)}
                              aria-expanded={!collapsed.has(device.id)}
                              title={`${childCount} Device(s) feed into ${device.code}`}
                              className="shrink-0 rounded px-1 text-[10px] text-ink-muted hover:text-ink"
                            >
                              {collapsed.has(device.id) ? `▸ ${childCount}` : "▾"}
                            </button>
                          ) : (
                            <span className="w-4 shrink-0" aria-hidden />
                          )}

                          {/* Shape before text: an operator scanning forty rows
                              for the transformer is matching a silhouette, not
                              reading type codes down the right-hand side. */}
                          <DeviceIcon
                            typeCode={device.type_code}
                            size={15}
                            className="text-ink-faint"
                          />

                          <button
                            type="button"
                            onClick={() => setInspecting(device.id)}
                            title={`Show everything recorded about ${device.code}`}
                            className="truncate font-medium text-ink hover:underline"
                          >
                            {device.code}
                          </button>
                          <span className="truncate text-xs text-ink-muted">
                            {device.type_code}
                          </span>
                          {device.parent_device_id === null ? (
                            <Badge tone="info" title="Feeds into nothing — the grid connection point.">
                              grid
                            </Badge>
                          ) : null}

                          {/* The enclosure. Read-only wherever the topic
                              answers the question, which is almost always: a
                              Collector is the room a Device publishes from,
                              and the topic is the sole authority for origin.
                              The server refuses a contradiction, so an
                              editable box here would only invite a 422. */}
                          {collectorIsEditable(device) ? (
                            <input
                              list="collector-codes"
                              defaultValue={device.collector_code ?? ""}
                              key={`collector-${device.id}-${device.collector_code ?? ""}`}
                              placeholder="collector"
                              aria-label={`Collector holding ${device.code}`}
                              title={`${device.code} has no topic yet, so nothing has stated which enclosure it is in. Once it publishes, its topic decides and this becomes read-only.`}
                              onChange={() => editedCollectors.current.add(device.id)}
                              onBlur={(event) => {
                                // `delete` both tests and clears: a blur with no
                                // preceding keystroke is React unmounting the
                                // node, not the operator leaving the field.
                                if (!editedCollectors.current.delete(device.id)) return;
                                commitCollector(device, event.target.value);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") event.currentTarget.blur();
                                if (event.key === "Escape") {
                                  editedCollectors.current.delete(device.id);
                                  event.currentTarget.value = device.collector_code ?? "";
                                  event.currentTarget.blur();
                                }
                              }}
                              className="ml-auto w-[6.5rem] shrink-0 rounded border border-line bg-surface-raised px-1.5 py-0.5 text-[11px] text-ink-faint focus:border-accent focus:outline-none"
                            />
                          ) : (
                            <span
                              title={
                                device.collector_code
                                  ? `In collector ${device.collector_code}, because its topic says so: ${device.source_address}. A Device cannot be moved between collectors here — change what it publishes on.`
                                  : device.type_code === "PLANT_KPI"
                                    ? "A Plant KPI panel is synthetic — its figures are computed, not published — so it sits in no enclosure."
                                    : `In no collector: ${device.source_address} has no collector segment.`
                              }
                              className={`ml-auto w-[6.5rem] shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] ${
                                device.collector_code
                                  ? "border border-dashed border-line-strong bg-surface-sunken text-ink"
                                  : "text-ink-faint"
                              }`}
                            >
                              {device.collector_code ?? "—"}
                            </span>
                          )}

                          {/* The keyboard path, and the fast one on a long list. */}
                          <select
                            value={device.parent_device_id ?? ""}
                            onChange={(event) =>
                              move(
                                device.id,
                                event.target.value === "" ? null : Number(event.target.value),
                              )
                            }
                            aria-label={`What ${device.code} feeds into`}
                            title={`What ${device.code} feeds into`}
                            className="max-w-[9rem] shrink-0 truncate rounded border border-line bg-surface-raised px-1.5 py-0.5 text-[11px] text-ink-muted focus:border-accent focus:text-ink focus:outline-none"
                          >
                            <option value="">⏚ grid</option>
                            {inPath
                              .filter(
                                (d) =>
                                  d.id !== device.id &&
                                  !blocked.has(d.id) &&
                                  // Only Devices on the same side of the
                                  // enclosure wall. A collector's outward
                                  // connection belongs to the collector, so the
                                  // server refuses a crossing edge — and a list
                                  // that offers one is a list of things that
                                  // will fail.
                                  (d.collector_code ?? null) ===
                                    (device.collector_code ?? null),
                              )
                              .map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.code}
                                </option>
                              ))}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                  </div>

                  {unreachable.length > 0 ? (
                    <div className="mt-3 rounded border border-bad/30 bg-bad/10 px-3 py-2">
                      <p className="text-xs font-medium text-bad">
                        {unreachable.length} Device(s) in a loop
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                        These feed into each other in a ring, so no path reaches
                        the grid. Send one to the grid to break it.
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {unreachable.map((device) => (
                          <button
                            key={device.id}
                            type="button"
                            onClick={() => move(device.id, null)}
                            title={`Make ${device.code} feed into nothing, breaking the ring`}
                            className="rounded border border-bad/40 bg-surface px-2 py-0.5 text-[11px] text-ink hover:border-bad"
                          >
                            {device.code} → ⏚ grid
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Shared by every row's collector box. One list, so the same
                  enclosure is offered everywhere and nobody invents a second
                  spelling of a room that already exists. */}
              <datalist id="collector-codes">
                {collectorCodes.map((code) => (
                  <option key={code} value={code} />
                ))}
              </datalist>

              {outsidePowerPath.length > 0 ? (
                <div className="mt-4 border-t border-line pt-3">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                    Not in the diagram
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                    Real and monitored, but no current flows through them, so they
                    have no place in an electrical diagram. They can still sit in a
                    collector — a Weather Station in the MCR is in the MCR.
                  </p>
                  <div className="mt-2 space-y-1">
                    {outsidePowerPath.map((device) => (
                      <div
                        key={device.id}
                        className="flex items-center gap-2 rounded border border-line bg-surface px-2 py-1"
                      >
                        <button
                          type="button"
                          onClick={() => setInspecting(device.id)}
                          className="truncate text-xs font-medium text-ink hover:underline"
                        >
                          {device.code}
                        </button>
                        <span className="truncate text-[11px] text-ink-muted">
                          {device.type_code}
                        </span>
                        {collectorIsEditable(device) ? (
                          <input
                            list="collector-codes"
                            defaultValue={device.collector_code ?? ""}
                            key={`collector-${device.id}-${device.collector_code ?? ""}`}
                            placeholder="collector"
                            aria-label={`Collector holding ${device.code}`}
                            onChange={() => editedCollectors.current.add(device.id)}
                            onBlur={(event) => {
                              if (!editedCollectors.current.delete(device.id)) return;
                              commitCollector(device, event.target.value);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                            className="ml-auto w-[6.5rem] shrink-0 rounded border border-line bg-surface-raised px-1.5 py-0.5 text-[11px] text-ink-faint focus:border-accent focus:outline-none"
                          />
                        ) : (
                          <span
                            title={
                              device.collector_code
                                ? `In collector ${device.collector_code}, because its topic says so: ${device.source_address}`
                                : device.type_code === "PLANT_KPI"
                                  ? "A Plant KPI panel is synthetic — its figures are computed, not published — so it sits in no enclosure."
                                  : `In no collector: ${device.source_address} has no collector segment.`
                            }
                            className={`ml-auto w-[6.5rem] shrink-0 truncate rounded px-1.5 py-0.5 text-center text-[11px] ${
                              device.collector_code
                                ? "border border-dashed border-line-strong bg-surface-sunken text-ink"
                                : "text-ink-faint"
                            }`}
                          >
                            {device.collector_code ?? "—"}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </Panel>

            {/* ── The live diagram ──────────────────────────────────────── */}
            <div className="min-w-0 space-y-4 lg:sticky lg:top-4">
              <Panel
                title="Diagram"
                subtitle="Redrawn by the server after every change. A dashed outline is a collector — a room, not a component."
                className="min-w-0"
              >
                {sldQuery.isLoading ? (
                  <SkeletonPanel lines={8} title={false} />
                ) : sldQuery.isError ? (
                  <ErrorState error={sldQuery.error} retry={() => void sldQuery.refetch()} />
                ) : sldQuery.data ? (
                  <SldTree
                    sld={sldQuery.data}
                    overlay={{
                      commStatus: Object.fromEntries(
                        devices.map((d) => [d.id, d.comm_status ?? "unknown"]),
                      ),
                      livePower: {},
                      staleDevices: new Set(),
                    }}
                    onSelect={setInspecting}
                    selectedDeviceId={inspecting}
                    height={420}
                    label={
                      sldQuery.data.collectors.length > 0
                        ? `${sldQuery.data.collectors.length} collector(s): ${sldQuery.data.collectors
                            .map((c) => c.code)
                            .join(", ")}`
                        : "No collectors — every Device publishes directly"
                    }
                  />
                ) : null}
                {reparent.isPending || setCollector.isPending ? (
                  <p className="mt-2 text-[11px] text-ink-faint">Saving…</p>
                ) : null}
              </Panel>

              {inspectedDevice ? (
                /* The same inspector the dashboards open. A Device must not
                   look like a different thing depending on which screen found
                   it — and on this screen in particular, the wiring being
                   edited is right there in its Placement section. */
                <Panel
                  title={`${inspectedDevice.code} — ${inspectedDevice.name}`}
                  actions={
                    <button
                      type="button"
                      onClick={() => setInspecting(null)}
                      className="rounded-control border border-line px-2 py-1 text-[11px] text-ink-muted transition hover:text-ink"
                    >
                      Close
                    </button>
                  }
                >
                  <DeviceInspector
                    device={inspectedDevice}
                    values={undefined}
                    timezone={timezone}
                    deviceLookup={devicesById}
                  />
                </Panel>
              ) : null}
            </div>

            {/* ── What each enclosure feeds into ────────────────────────── */}
            {collectors.length > 0 ? (
              <Panel
                title="Collectors"
                subtitle="A room, not a component. Nothing is wired through one — but the room itself has a single outgoing connection, and this is where it is recorded."
                className="lg:col-span-2"
              >
                <p className="mb-2 text-[11px] leading-relaxed text-ink-faint">
                  Seventeen Inverters in an MCR do not each run a cable to the
                  transformer; the room has <em>one</em> outgoing feeder. Said
                  once here, it covers every Device inside — which is also why a
                  Device inside a collector cannot be pointed at one outside it.
                </p>
                <div className="space-y-1.5">
                  {collectors.map((collector) => {
                    // Only Devices outside this enclosure may be chosen: a box
                    // feeding one of its own occupants would be a ring drawn
                    // through a wall, and the server refuses it anyway.
                    const targets = inPath.filter(
                      (d) => d.collector_code !== collector.code,
                    );
                    return (
                      <div
                        key={collector.code}
                        className="flex flex-wrap items-center gap-2 rounded border border-dashed border-line-strong bg-surface-sunken px-2 py-1.5"
                      >
                        <span className="text-xs font-medium text-ink">
                          {collector.code}
                        </span>
                        <span className="text-[11px] text-ink-faint">
                          {collector.in_power_path_count} in the power path
                        </span>
                        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-ink-muted">
                          feeds into
                          <select
                            value={collector.parent_device_id ?? ""}
                            disabled={!canManage || setCollectorEdge.isPending}
                            onChange={(event) =>
                              setCollectorEdge.mutate({
                                code: collector.code,
                                parentId:
                                  event.target.value === ""
                                    ? null
                                    : Number(event.target.value),
                              })
                            }
                            aria-label={`What collector ${collector.code} feeds into`}
                            className="w-44 rounded border border-line bg-surface-raised px-1.5 py-0.5 text-[11px] text-ink focus:border-accent focus:outline-none disabled:opacity-50"
                          >
                            <option value="">— not recorded —</option>
                            {targets.map((device) => (
                              <option key={device.id} value={device.id}>
                                {device.code} · {device.type_code}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </Panel>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
