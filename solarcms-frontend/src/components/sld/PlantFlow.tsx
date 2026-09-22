/**
 * The plant schematic — a rolled-up, left-to-right view of the power path.
 *
 * The detailed tree (`SldTree`) draws one box per Device, which is what you want
 * when something is wrong and you need to know *which* Inverter. This view
 * answers the other question — *is the plant healthy at a glance* — by
 * collapsing every Device of the same type at the same distance from the grid
 * into one stage: twelve Inverters become one box reading "12 / 12 online".
 *
 * **Nothing about the stages is hardcoded.** There is no fixed
 * PV-Array-then-Inverter-then-Transformer sequence anywhere below. The stages
 * are derived from the same `parent_device_id` chain the diagram and the editor
 * use, so a Plant with two transformers, a meter in the middle, or an MCR
 * section between the transformer and the grid produces a different row of boxes
 * without a line of code changing. A Plant nobody has wired yet produces one
 * stage per type, which is honest rather than wrong.
 *
 * Flow reads left to right, generation to grid, because that is how every
 * single line diagram an engineer has ever seen is drawn — even though the
 * underlying pointer runs the other way ("what do I feed into").
 */

import { useMemo, useState } from "react";
import type { CommStatus, DeviceListItem, Tag } from "@/api/schemas";
import { useTagsById } from "@/api/hooks";
import { useLiveSocket } from "@/live/LiveSocket";
import { formatValue } from "@/format/value";
import { Badge } from "@/components/ui";
import { DeviceArt } from "@/components/devices/DeviceArt";
import { DiagramCanvas } from "./DiagramCanvas";

/**
 * Units whose values *add up* across several Devices. Everything else is
 * averaged.
 *
 * Driven by the Tag's own unit rather than by its Device Type: twelve Inverters
 * produce twelve lots of power, which sum, but they each sit at roughly the same
 * voltage, which does not. Reading it off the unit keeps the rule in the
 * catalogue instead of in a list of type codes (Guardrail 2).
 */
const SUMMABLE_UNITS = new Set([
  "kW", "MW", "kWh", "MWh", "kVAr", "kVA", "A", "count",
]);

/** Which kind of reading best represents a stage, most significant first. */
const CATEGORY_PRIORITY = ["performance", "electrical", "environmental"] as const;

/**
 * Types that are where generation *starts* — nothing upstream of them.
 *
 * Ordering is otherwise by distance from the grid, which is correct the moment a
 * Plant is wired. But before anyone sets the hierarchy every Device is its own
 * root at distance zero, and a PV Array would then be ordered alphabetically
 * among the rest — landing on the right, beside the Grid, which is the exact
 * opposite of where generation begins. Pinning it survives that, and survives
 * someone mis-wiring the array downstream of an inverter.
 *
 * Referenced by Type, never by Device or Plant (Guardrail 2). If more source
 * types appear, this is the one place they go — and a per-Type ordering field in
 * the catalogue is the natural home if it ever needs to be configurable.
 */
const GENERATION_SOURCE_TYPES = new Set(["PV_ARRAY"]);

/**
 * Left to right, generation to grid — the same four the spine draws.
 *
 * Used to break ties between stages at the same depth. It replaced ordering by
 * type code, which is alphabetical and electrically meaningless: on a Plant
 * nobody has wired yet every Device sits at depth 0, the tie-break decides the
 * whole row, and `INVERTER < MFM < TRANSFORMER < VCB` drew the settlement meter
 * upstream of the transformer. Reading the order off each Device's own
 * `sld_stage` keeps it in the catalogue rather than in a list here.
 */
const STAGE_ORDER = ["PV_ARRAY", "INVERTERS", "TRANSFORMER", "GRID"];

function stagePosition(device: DeviceListItem): number {
  const stage = device.sld_stage_override ?? device.sld_stage ?? "";
  const index = STAGE_ORDER.indexOf(stage);
  // A Type with no stage sorts last rather than first: an unknown box belongs
  // beside the grid, not in front of the generation.
  return index === -1 ? STAGE_ORDER.length : index;
}

/**
 * Collector code → the Device that enclosure feeds into.
 *
 * A Collector is **not a Device** (Guardrail 12): it has no Model, no Tags and
 * no topic, it never appears in a Device list, and it is drawn as a box around
 * its occupants rather than as a node in the chain. This carries the one thing
 * that can be said about it beyond its name.
 */
export type CollectorEdges = Record<string, number | null | undefined>;

export interface FlowStage {
  key: string;
  typeCode: string;
  /** Distance from the grid; larger is further upstream, drawn further left. */
  depth: number;
  /** Index into the four stages, used only to break ties at equal depth. */
  stagePosition: number;
  devices: DeviceListItem[];
  online: number;
  /**
   * The enclosure every Device in this stage sits in, or null when they do not
   * agree on one.
   *
   * Null covers two different situations on purpose — a stage whose Devices
   * are in no Collector, and a stage split across two — because the view does
   * the same thing in both: it draws no box. Claiming a stage is "in the MCR"
   * when half of it is in the ICR would be worse than saying nothing, and the
   * detailed tree is where a split like that is visible anyway.
   */
  collector: string | null;
}

/**
 * Collapse the wiring into stages.
 *
 * Depth is measured from the grid end (a Device feeding into nothing is depth
 * 0), then Devices sharing a depth *and* a type become one stage. Two
 * transformers side by side collapse together; a transformer and a meter at the
 * same depth stay apart, because they are not the same thing.
 */
export function buildStages(
  devices: DeviceListItem[],
  collectorEdges: CollectorEdges = {},
): FlowStage[] {
  const inPath = devices.filter((d) => d.in_power_path);
  const byId = new Map(inPath.map((d) => [d.id, d]));

  /**
   * What this Device is wired into — its own parent, or its enclosure's.
   *
   * ⚠ Seventeen Inverters in an MCR do not each run a cable to the transformer;
   * the room has one outgoing connection, recorded once on the box. The server
   * refuses the per-Device version outright — a Device inside a Collector may
   * not point at one outside it — so for those Devices the room's edge is the
   * *only* statement of what they feed, and reading only `parent_device_id`
   * would leave a correctly wired Plant looking entirely unwired.
   *
   * A Device with its own parent keeps it: hierarchy *within* an enclosure is
   * normal and more specific than the box's edge.
   */
  const feedsInto = (device: DeviceListItem): number | null => {
    if (device.parent_device_id !== null) return device.parent_device_id;
    const code = device.collector_code;
    return code ? collectorEdges[code] ?? null : null;
  };

  const depthOf = (device: DeviceListItem): number => {
    let depth = 0;
    let cursor: DeviceListItem | undefined = device;
    const seen = new Set<number>();
    // Bounded by the number of Devices: a ring in the data must not hang a
    // render, the same reason the server's tree builder counts rather than
    // recurses.
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parentId: number | null = feedsInto(cursor);
      if (parentId === null) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      cursor = parent;
      depth += 1;
    }
    return depth;
  };

  const groups = new Map<string, FlowStage>();
  for (const device of inPath) {
    const depth = depthOf(device);
    const key = `${depth}:${device.type_code}`;
    const existing = groups.get(key);
    if (existing) {
      existing.devices.push(device);
    } else {
      groups.set(key, {
        key, typeCode: device.type_code, depth, devices: [device], online: 0,
        collector: null, stagePosition: stagePosition(device),
      });
    }
  }

  const stages = [...groups.values()];
  for (const stage of stages) {
    stage.devices.sort((a, b) => a.code.localeCompare(b.code));
    stage.online = stage.devices.filter((d) => d.comm_status === "online").length;
    const collectors = new Set(stage.devices.map((d) => d.collector_code ?? ""));
    const only = [...collectors][0];
    stage.collector = collectors.size === 1 && only ? only : null;
  }
  // Generation sources first, then furthest-from-the-grid first, so the row
  // always reads generation → grid. The Grid itself is not a stage at all: it is
  // what "feeds into nothing" means, and the view appends it after everything.
  stages.sort((a, b) => {
    const aSource = GENERATION_SOURCE_TYPES.has(a.typeCode) ? 0 : 1;
    const bSource = GENERATION_SOURCE_TYPES.has(b.typeCode) ? 0 : 1;
    return (
      aSource - bSource ||
      b.depth - a.depth ||
      // Ties broken by electrical position, never alphabetically. Two stages at
      // the same depth are the same distance from the grid, and the only
      // meaningful thing left to order them by is the stage each folds into.
      a.stagePosition - b.stagePosition ||
      a.typeCode.localeCompare(b.typeCode)
    );
  });
  return stages;
}

/**
 * True when no Device in the power path is wired to anything.
 *
 * Depth is the only electrical signal the row has, and depth comes entirely
 * from `parent_device_id`. With none set, every stage ties and the order is a
 * default rather than something derived — which the view must say, because a
 * confidently-drawn wrong diagram is worse than an absent one.
 */
export function isUnwired(
  devices: DeviceListItem[],
  collectorEdges: CollectorEdges = {},
): boolean {
  const inPath = devices.filter((d) => d.in_power_path);
  if (inPath.length === 0) return false;
  // A Plant whose rooms are wired is wired. Counting only `parent_device_id`
  // would tell an operator who had correctly set "the MCR feeds the
  // transformer" that they had done nothing — the worst possible answer, since
  // the per-Device edit they would reach for next is the one the server
  // refuses.
  return inPath.every(
    (d) =>
      d.parent_device_id === null &&
      !(d.collector_code && collectorEdges[d.collector_code]),
  );
}

/** A small glyph per Device Type. Presentation only — an unknown type still renders. */
/** The stage's headline reading, summed or averaged per its unit. */
function stageReading(
  stage: FlowStage,
  live: Record<number, { values: Record<number, number> }>,
  tagsById: Map<number, Tag>,
): string | null {
  const samples = new Map<number, number[]>();
  for (const device of stage.devices) {
    const frame = live[device.id];
    if (!frame) continue;
    for (const [tagId, value] of Object.entries(frame.values)) {
      const id = Number(tagId);
      const list = samples.get(id) ?? [];
      list.push(value);
      samples.set(id, list);
    }
  }
  if (samples.size === 0) return null;

  // The most significant reading this stage actually publishes, by the Tag's
  // own category — never a Tag named in this file.
  let best: { tag: Tag; values: number[] } | null = null;
  for (const [tagId, values] of samples) {
    const tag = tagsById.get(tagId);
    if (!tag) continue;
    const rank = CATEGORY_PRIORITY.indexOf(
      tag.category as (typeof CATEGORY_PRIORITY)[number],
    );
    if (rank === -1) continue;
    const bestRank = best
      ? CATEGORY_PRIORITY.indexOf(best.tag.category as (typeof CATEGORY_PRIORITY)[number])
      : Number.MAX_SAFE_INTEGER;
    if (rank < bestRank) best = { tag, values };
  }
  if (!best) return null;

  const total = best.values.reduce((sum, v) => sum + v, 0);
  const value = SUMMABLE_UNITS.has(best.tag.unit)
    ? total
    : total / best.values.length;
  return formatValue(value, best.tag.unit);
}

/** Stable identity, so an omitted prop does not rebuild the stages every render. */
const EMPTY_EDGES: CollectorEdges = {};

const STATUS_TONE = (online: number, total: number): "ok" | "warn" | "bad" =>
  online === total ? "ok" : online === 0 ? "bad" : "warn";

export function PlantFlow({
  devices,
  dcCapacityKwp,
  collectorEdges,
}: {
  devices: DeviceListItem[];
  /** Shown on the leftmost stage when the Plant records one. */
  dcCapacityKwp?: number | null;
  /**
   * What each enclosure feeds into. Without it a Plant wired only at the room
   * level reads as unwired, because its occupants carry no parent of their own
   * — the server refuses that edge, so the room's is the only one there is.
   */
  collectorEdges?: CollectorEdges;
}): JSX.Element {
  const tagsById = useTagsById();
  const { devices: live } = useLiveSocket();
  const [openStage, setOpenStage] = useState<string | null>(null);

  const edges = collectorEdges ?? EMPTY_EDGES;
  const stages = useMemo(() => buildStages(devices, edges), [devices, edges]);
  const selected = stages.find((s) => s.key === openStage) ?? null;

  if (stages.length === 0) {
    return (
      <p className="rounded border border-dashed border-line p-5 text-center text-sm text-ink-muted">
        No Devices carry current at this Plant yet, so there is no power path to
        draw. Devices that carry no current are shown elsewhere — this is not an
        error.
      </p>
    );
  }

  // Runs of neighbouring stages that sit in the same enclosure. Consecutive
  // only: a Collector holding the first and third stage but not the second is
  // two boxes, because one box would enclose the stage in between and say
  // something untrue about where it is.
  const segments: { collector: string | null; stages: FlowStage[] }[] = [];
  for (const stage of stages) {
    const last = segments[segments.length - 1];
    if (last && last.collector === stage.collector) last.stages.push(stage);
    else segments.push({ collector: stage.collector, stages: [stage] });
  }

  const renderStage = (stage: FlowStage, index: number): JSX.Element => (
            <div key={stage.key} className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() =>
                  setOpenStage((current) => (current === stage.key ? null : stage.key))
                }
                className={`flex w-[136px] flex-col items-center gap-1.5 rounded-xl border p-3 text-center shadow-sm transition ${
                  openStage === stage.key
                    ? "border-accent bg-accent/10 shadow-soft ring-1 ring-accent/25"
                    : "border-line bg-surface hover:border-line-strong hover:shadow-soft"
                }`}
                title={`${stage.devices.length} ${stage.typeCode} — click for detail`}
              >
                {/*
                  The equipment, drawn. The status stays on the *plinth* under
                  it rather than tinting the drawing: `DeviceIcon` renders a
                  glyph in `currentColor`, which is right for a list row whose
                  colour already means something, and wrong here — a monochrome
                  silhouette of a transformer and a monochrome silhouette of a
                  switchgear cubicle are the same shape at 44px, and in a
                  schematic the picture *is* the label.
                */}
                <span
                  className={`flex h-14 w-[72px] items-end justify-center rounded-lg border-b-2 ${
                    stage.online === stage.devices.length
                      ? "border-ok/70 bg-ok/[0.07]"
                      : stage.online === 0
                        ? "border-bad/70 bg-bad/[0.07]"
                        : "border-warn/70 bg-warn/[0.07]"
                  }`}
                >
                  <DeviceArt typeCode={stage.typeCode} size={64} />
                </span>
                <span className="text-xs font-semibold leading-tight text-ink">
                  {/* A Plant can have the same type at two points in the chain —
                      a meter at the transformer and another at the grid tie. The
                      type name alone would label both identically, so a stage
                      holding exactly one Device names it. */}
                  {stage.devices.length === 1
                    ? stage.devices[0].code
                    : stage.typeCode.replace(/_/g, " ")}
                </span>
                {/* The count is the headline the operator scans for. */}
                <Badge tone={STATUS_TONE(stage.online, stage.devices.length)}>
                  {stage.online} / {stage.devices.length} online
                </Badge>
                <span className="font-mono text-xs font-semibold leading-tight text-ink">
                  {stageReading(stage, live, tagsById) ??
                    (index === 0 && dcCapacityKwp
                      ? `${dcCapacityKwp} kWp`
                      : "—")}
                </span>
              </button>
              <ArrowRight />
            </div>
  );

  const unwired = isUnwired(devices, edges);

  return (
    <div>
      {/*
        ⚠ Said plainly rather than drawn over. With nothing wired, depth is
        constant and the row below is a default order, not one derived from this
        Plant — and a diagram that looks authoritative while being a guess is
        worse than one that admits it.
      */}
      {unwired ? (
        <p className="mb-2 rounded-control border border-warn/30 bg-warn/10 px-3 py-2 text-[11px] leading-relaxed text-warn">
          <span className="font-medium">Hierarchy not set.</span> No Device in
          the power path is wired to anything, so this order is a default by
          equipment type — not derived from this Plant. Set “feeds into” in
          Wiring &amp; Diagram and the chain below becomes the real one.
        </p>
      ) : null}
      <DiagramCanvas
        height={210}
        label={
          unwired
            ? `${stages.length} stage(s), default order`
            : `${stages.length} stage(s), generation → grid`
        }
        fitKey={`${devices.length}:${stages.length}:${segments.length}`}
      >
        <div className="flex min-w-max items-center gap-1.5 p-2">
          {segments.map((segment, segmentIndex) => {
            const offset = segments
              .slice(0, segmentIndex)
              .reduce((sum, s) => sum + s.stages.length, 0);
            const inside = segment.stages.map((stage, i) =>
              renderStage(stage, offset + i),
            );
            if (!segment.collector) {
              return (
                <div key={`open-${segmentIndex}`} className="flex items-center gap-1.5">
                  {inside}
                </div>
              );
            }
            return (
              // Dashed, and labelled "collector", because this is an enclosure
              // and not a component: nothing is wired through it, and it must
              // not be mistaken for a stage of its own.
              <div
                key={`collector-${segment.collector}-${segmentIndex}`}
                className="relative flex items-center gap-1.5 rounded-xl border border-dashed border-line-strong bg-surface-sunken/60 px-2 pb-2 pt-5"
              >
                <span className="absolute left-2.5 top-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                  {segment.collector}
                </span>
                <span className="absolute right-2.5 top-1 text-[10px] text-ink-faint">
                  collector
                </span>
                {inside}
              </div>
            );
          })}

          {/* The grid is not a Device — it is what "feeds into nothing" means. */}
          <div className="flex w-[136px] flex-col items-center gap-1.5 rounded-xl border border-dashed border-line p-3 text-center">
            {/* The pylon: the one drawing in the set depicting something
                outside the fence, which is exactly what the Grid is. */}
            <span className="flex h-14 w-[72px] items-end justify-center rounded-lg border-b-2 border-dashed border-line bg-surface-sunken">
              <DeviceArt typeCode="GRID" size={64} />
            </span>
            <span className="text-xs font-semibold leading-tight text-ink">Grid</span>
            <span className="text-[11px] leading-tight text-ink-faint">
              beyond the plant
            </span>
          </div>
        </div>
      </DiagramCanvas>

      {/* ── Drill-down ─────────────────────────────────────────────────── */}
      {selected ? (
        <div className="mt-3 rounded-lg border border-accent/30 bg-surface-raised p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">
              {selected.typeCode.replace(/_/g, " ")} — {selected.devices.length} Device(s)
            </p>
            <button
              type="button"
              onClick={() => setOpenStage(null)}
              className="text-[11px] text-ink-muted hover:text-ink hover:underline"
            >
              Close
            </button>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {selected.devices.map((device) => (
              <DeviceRow key={device.id} device={device} live={live} tagsById={tagsById} />
            ))}
          </div>
        </div>
      ) : (
        <p className="mt-2 text-[11px] text-ink-faint">
          Click any stage to see the individual Devices behind it.
        </p>
      )}
    </div>
  );
}

function ArrowRight(): JSX.Element {
  return (
    <svg
      width="28" height="16" viewBox="0 0 28 16" aria-hidden="true"
      className="shrink-0 text-line-strong"
    >
      <path
        d="M1 8 H21" stroke="currentColor" strokeWidth={2}
        strokeDasharray="4 3" strokeLinecap="round"
      />
      <path d="M21 3 L27 8 L21 13 Z" fill="currentColor" />
    </svg>
  );
}

function DeviceRow({
  device,
  live,
  tagsById,
}: {
  device: DeviceListItem;
  live: Record<number, { values: Record<number, number> }>;
  tagsById: Map<number, Tag>;
}): JSX.Element {
  const frame = live[device.id];
  const reading = frame
    ? Object.entries(frame.values)
        .map(([tagId, value]) => ({ tag: tagsById.get(Number(tagId)), value }))
        .find((row) => row.tag?.category === "performance" || row.tag?.category === "electrical")
    : undefined;

  const tone: Record<CommStatus, string> = {
    online: "bg-ok", degraded: "bg-warn", offline: "bg-bad", unknown: "bg-ink-faint",
  };

  return (
    <div className="flex items-center gap-2 rounded border border-line bg-surface px-2 py-1.5">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${tone[device.comm_status ?? "unknown"]}`}
        title={device.comm_status ?? "unknown"}
      />
      <span className="truncate text-xs font-medium text-ink">{device.code}</span>
      <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-muted">
        {reading?.tag ? formatValue(reading.value, reading.tag.unit) : "—"}
      </span>
    </div>
  );
}
