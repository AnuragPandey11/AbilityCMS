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

export interface FlowStage {
  key: string;
  typeCode: string;
  /** Distance from the grid; larger is further upstream, drawn further left. */
  depth: number;
  devices: DeviceListItem[];
  online: number;
}

/**
 * Collapse the wiring into stages.
 *
 * Depth is measured from the grid end (a Device feeding into nothing is depth
 * 0), then Devices sharing a depth *and* a type become one stage. Two
 * transformers side by side collapse together; a transformer and a meter at the
 * same depth stay apart, because they are not the same thing.
 */
export function buildStages(devices: DeviceListItem[]): FlowStage[] {
  const inPath = devices.filter((d) => d.in_power_path);
  const byId = new Map(inPath.map((d) => [d.id, d]));

  const depthOf = (device: DeviceListItem): number => {
    let depth = 0;
    let cursor: DeviceListItem | undefined = device;
    const seen = new Set<number>();
    // Bounded by the number of Devices: a ring in the data must not hang a
    // render, the same reason the server's tree builder counts rather than
    // recurses.
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parentId: number | null = cursor.parent_device_id;
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
      });
    }
  }

  const stages = [...groups.values()];
  for (const stage of stages) {
    stage.devices.sort((a, b) => a.code.localeCompare(b.code));
    stage.online = stage.devices.filter((d) => d.comm_status === "online").length;
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
      a.typeCode.localeCompare(b.typeCode)
    );
  });
  return stages;
}

/** A small glyph per Device Type. Presentation only — an unknown type still renders. */
function TypeIcon({ typeCode }: { typeCode: string }): JSX.Element {
  const common = {
    width: 22, height: 22, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.7,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  switch (typeCode) {
    case "INVERTER":
      return (
        <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M7 14c1.5-4 3.5-4 5 0s3.5 4 5 0" /></svg>
      );
    case "TRANSFORMER":
      return (
        <svg {...common}><circle cx="9" cy="12" r="5" /><circle cx="15" cy="12" r="5" /></svg>
      );
    case "MFM": case "ABT_METER": case "NET_METER":
      return (
        <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 12l4-3" />
          <path d="M12 7v1" /></svg>
      );
    case "VCB": case "ISOLATOR":
      return (
        <svg {...common}><path d="M6 18V9" /><path d="M18 18V6" />
          <path d="M6 9l12-3" /><circle cx="6" cy="18" r="1.6" />
          <circle cx="18" cy="18" r="1.6" /></svg>
      );
    case "PV_ARRAY": case "SMB":
      return (
        <svg {...common}><rect x="3" y="7" width="18" height="11" rx="1" />
          <path d="M3 12h18M9 7v11M15 7v11" /></svg>
      );
    case "DCDB": case "ACDB":
      return (
        <svg {...common}><rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M8 8h8M8 12h8M8 16h4" /></svg>
      );
    case "WMS":
      return (
        <svg {...common}><circle cx="12" cy="9" r="3.5" />
          <path d="M12 2v1.5M12 14.5V16M5 9H3.5M20.5 9H19M7 4l-1-1M18 4l1-1" />
          <path d="M5 20h14" /></svg>
      );
    default:
      return (
        <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M9 12h6" /></svg>
      );
  }
}

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

const STATUS_TONE = (online: number, total: number): "ok" | "warn" | "bad" =>
  online === total ? "ok" : online === 0 ? "bad" : "warn";

export function PlantFlow({
  devices,
  dcCapacityKwp,
}: {
  devices: DeviceListItem[];
  /** Shown on the leftmost stage when the Plant records one. */
  dcCapacityKwp?: number | null;
}): JSX.Element {
  const tagsById = useTagsById();
  const { devices: live } = useLiveSocket();
  const [openStage, setOpenStage] = useState<string | null>(null);

  const stages = useMemo(() => buildStages(devices), [devices]);
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

  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <div className="flex min-w-max items-start gap-1">
          {stages.map((stage, index) => (
            <div key={stage.key} className="flex items-start gap-1">
              <button
                type="button"
                onClick={() =>
                  setOpenStage((current) => (current === stage.key ? null : stage.key))
                }
                className={`flex w-[104px] flex-col items-center gap-1.5 rounded-lg border p-2 text-center transition ${
                  openStage === stage.key
                    ? "border-accent bg-accent/10"
                    : "border-line bg-surface hover:border-line-strong"
                }`}
                title={`${stage.devices.length} ${stage.typeCode} — click for detail`}
              >
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-lg ${
                    stage.online === stage.devices.length
                      ? "bg-ok/10 text-ok"
                      : stage.online === 0
                        ? "bg-bad/10 text-bad"
                        : "bg-warn/10 text-warn"
                  }`}
                >
                  <TypeIcon typeCode={stage.typeCode} />
                </span>
                <span className="text-[11px] font-semibold leading-tight text-ink">
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
                <span className="font-mono text-[10px] leading-tight text-ink-muted">
                  {stageReading(stage, live, tagsById) ??
                    (index === 0 && dcCapacityKwp
                      ? `${dcCapacityKwp} kWp`
                      : "—")}
                </span>
              </button>
              <ArrowRight />
            </div>
          ))}

          {/* The grid is not a Device — it is what "feeds into nothing" means. */}
          <div className="flex w-[104px] flex-col items-center gap-1.5 rounded-lg border border-dashed border-line p-2 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-sunken text-ink-muted">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth={1.7} strokeLinecap="round">
                <path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" />
              </svg>
            </span>
            <span className="text-[11px] font-semibold leading-tight text-ink">Grid</span>
            <span className="text-[10px] leading-tight text-ink-faint">
              beyond the plant
            </span>
          </div>
        </div>
      </div>

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
      width="30" height="72" viewBox="0 0 30 72" aria-hidden="true"
      className="shrink-0 text-line-strong"
    >
      <path
        d="M2 30 H22" stroke="currentColor" strokeWidth={2}
        strokeDasharray="4 3" strokeLinecap="round"
      />
      <path d="M22 25 L28 30 L22 35 Z" fill="currentColor" />
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
