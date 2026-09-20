/**
 * The Single Line Diagram.
 *
 * `d3-hierarchy` computes positions; React renders the SVG. d3 never touches the
 * DOM (§1) — mixing two things that both want to own a subtree is how a chart
 * ends up with orphaned nodes after a re-render.
 *
 * Four rules, each protecting something confirmed (§6.4):
 *
 * 1. **Blocks never appear** (Guardrail 8, Guardrail 11). A Block says *where* a
 *    Device is; `parent_device_id` says *what it is wired into*. Putting a
 *    geographic grouping in an electrical diagram makes the diagram wrong.
 * 2. **`excluded_not_in_power_path` is not an error.** A Weather Station and a
 *    PPC are real, monitored Devices that carry no current — a side panel.
 * 3. **`orphaned` is a data problem worth surfacing.** Dropping them silently
 *    makes the diagram claim the Plant has less equipment than it does.
 * 4. **A Collector is a box around Devices, never a box in the chain.** An MCR
 *    or an ICR is an enclosure: equipment sits inside it, no current flows
 *    through it, and nothing connects to it. It is drawn as a dashed outline
 *    behind the nodes that share its name — so the diagram still reads as the
 *    electrical path, with the rooms marked on it.
 */

import { useMemo } from "react";
import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import type { CommStatus, Sld, SldNodeData } from "@/api/schemas";
import { SldNode, NODE_HEIGHT, NODE_WIDTH } from "./SldNode";
import { DiagramCanvas } from "./DiagramCanvas";
import { token } from "@/theme/tokens";

const H_GAP = 42;
const V_GAP = 74;

/** Space between a Collector's outline and the Devices inside it. */
const BOX_PADDING = 16;
/** Room above the outline for its label, so the name never sits on a node. */
const BOX_LABEL_SPACE = 20;

export interface SldOverlay {
  /** comm_status per device_id, from GET /plants/{id}/devices. */
  commStatus: Record<number, CommStatus>;
  /** Live power per device_id, already formatted with its Tag's unit. */
  livePower: Record<number, string>;
  staleDevices: Set<number>;
}

/**
 * One entry in the *layout* hierarchy.
 *
 * ⚠ A `collector` entry exists so d3 can position a box and the line leaving
 * it. It is **not** a Device and must never be rendered as one (Guardrail 12):
 * it has no id, no type, no status, no reading, and clicking it selects
 * nothing. It is drawn as the dashed outline its members sit inside, and the
 * single edge it owns is the one the client asked for — "the MCR feeds the
 * transformer", said once, instead of seventeen identical claims.
 */
export type LayoutNode =
  | { kind: "device"; device: SldNodeData; wired: boolean; children: LayoutNode[] }
  | { kind: "collector"; code: string; children: LayoutNode[] }
  | { kind: "virtual"; children: LayoutNode[] };

/**
 * Fold the server's electrical tree plus its collectors into one layout tree.
 *
 * The server sends two things that have to be reconciled here because only the
 * renderer needs them joined: the `parent_device_id` tree (Devices only, power
 * path only) and the list of enclosures with the one edge each of them owns.
 *
 * The result nests a Collector's members *inside* the collector node, and hangs
 * the collector node under whatever Device it feeds. So the seventeen Inverters
 * that are now parentless in the data do not fan out across the diagram as
 * seventeen roots — they sit in the MCR, and the MCR has one line to the meter.
 *
 * Devices that carry no current are added as leaves, marked `wired: false`.
 * They keep their place *in* a Collector when they have one, which is the whole
 * point: a Weather Station in the MCR should look like it is in the MCR.
 */
export function buildLayout(sld: Sld): LayoutNode {
  const byId = new Map<number, SldNodeData>();
  const collect = (node: SldNodeData): void => {
    byId.set(node.device_id, node);
    node.children.forEach(collect);
  };
  sld.roots.forEach(collect);

  // Devices that carry no current never appear in the server's tree, so they
  // are turned into leaves here rather than being left out of the picture.
  const unwired: SldNodeData[] = sld.excluded_not_in_power_path.map((d) => ({
    device_id: d.device_id,
    code: d.code,
    name: d.name ?? d.code,
    type: d.type,
    variant: d.variant ?? null,
    collector_code: d.collector_code ?? null,
    children: [],
  }));

  const memberOf = new Map<number, string>();
  for (const collector of sld.collectors) {
    for (const id of collector.device_ids) memberOf.set(id, collector.code);
  }
  const collectorOf = (id: number): string | null => memberOf.get(id) ?? null;

  // Parent of every Device in the server's tree, so "is my parent in the same
  // enclosure as me?" is answerable without re-walking.
  const parentOf = new Map<number, number>();
  const link = (node: SldNodeData): void => {
    for (const child of node.children) {
      parentOf.set(child.device_id, node.device_id);
      link(child);
    }
  };
  sld.roots.forEach(link);

  /**
   * Where a Device starts its own subtree in the layout.
   *
   * True when it has no parent, or when its parent sits in a different
   * enclosure. The second case should not exist — the boundary rule forbids
   * that edge — but data predating the rule does contain it, and the honest
   * response is to place the Device in the box it belongs to rather than
   * silently drop it from the diagram. The box's own edge then carries the
   * connection, which is exactly what the migration to a collector edge does.
   */
  const startsSubtree = (id: number): boolean => {
    const parent = parentOf.get(id);
    return parent === undefined || collectorOf(parent) !== collectorOf(id);
  };

  const toLayout = (node: SldNodeData, wired: boolean): LayoutNode => ({
    kind: "device",
    device: node,
    wired,
    // Only children in the same enclosure descend here; one in a different
    // enclosure is drawn inside that enclosure's box instead.
    children: node.children
      .filter((c) => collectorOf(c.device_id) === collectorOf(node.device_id))
      .map((c) => toLayout(c, true)),
  });

  const everyDevice: SldNodeData[] = [...byId.values()];

  const collectorNodes = new Map<string, LayoutNode>();
  for (const collector of sld.collectors) {
    const inside = everyDevice
      .filter((d) => collectorOf(d.device_id) === collector.code && startsSubtree(d.device_id))
      .map((d) => toLayout(d, true));
    const leaves = unwired
      .filter((d) => d.collector_code === collector.code)
      .map((d) => toLayout(d, false));
    if (inside.length + leaves.length === 0) continue;
    collectorNodes.set(collector.code, {
      kind: "collector", code: collector.code, children: [...inside, ...leaves],
    });
  }

  // Hang each collector under the Device it feeds; the rest stay top-level.
  const attached = new Set<string>();
  const attachTo = (node: LayoutNode): LayoutNode => {
    if (node.kind !== "device") return node;
    const hung = sld.collectors.filter(
      (c) => c.parent_device_id === node.device.device_id && collectorNodes.has(c.code),
    );
    for (const c of hung) attached.add(c.code);
    return {
      ...node,
      children: [
        ...node.children.map(attachTo),
        ...hung.map((c) => collectorNodes.get(c.code)!),
      ],
    };
  };

  const topLevel: LayoutNode[] = [];
  for (const device of everyDevice) {
    if (collectorOf(device.device_id) !== null) continue; // drawn inside its box
    if (!startsSubtree(device.device_id)) continue;       // drawn under its parent
    topLevel.push(attachTo(toLayout(device, true)));
  }
  // A collector nobody has wired yet is still a real enclosure and must draw.
  for (const [code, node] of collectorNodes) {
    if (!attached.has(code)) topLevel.push(node);
  }
  // Devices that carry no current and sit in no enclosure: drawn, unconnected.
  // This is the WMS case — visible in the diagram, wired to nothing.
  for (const d of unwired) {
    if (!d.collector_code) topLevel.push(toLayout(d, false));
  }

  return { kind: "virtual", children: topLevel };
}

export interface PlacedNode {
  data: SldNodeData;
  x: number;
  y: number;
}

export interface CollectorBox {
  key: string;
  code: string;
  x: number;
  y: number;
  width: number;
  height: number;
  deviceCount: number;
}

/**
 * Work out where to draw each Collector's outline.
 *
 * The honest version of this is harder than it looks. A Collector's Devices are
 * positioned by the *electrical* tree, and nothing guarantees they end up next
 * to each other — an MCR can hold an Inverter at one end of the chain and the
 * meter at the other. One rectangle around the extremes would then also
 * enclose equipment that is not in that room, and a diagram that says a Device
 * is somewhere it is not is worse than one that says nothing.
 *
 * So: try one box, and check it. If nothing foreign falls inside, that is the
 * answer and it is the common case — the server already orders siblings so
 * that Devices sharing a Collector stay adjacent. If something foreign *is*
 * inside, the group is split into one box per contiguous run on each row, and
 * the Collector is simply drawn as several outlines with the same name. Two
 * boxes labelled MCR is a true statement about a plant wired that way; one big
 * box swallowing a stranger is not.
 */
export function collectorBoxes(nodes: PlacedNode[]): CollectorBox[] {
  const groups = new Map<string, PlacedNode[]>();
  for (const node of nodes) {
    const code = node.data.collector_code;
    if (!code) continue;
    const list = groups.get(code) ?? [];
    list.push(node);
    groups.set(code, list);
  }

  const bounds = (members: PlacedNode[]) => {
    const left = Math.min(...members.map((n) => n.x - NODE_WIDTH / 2)) - BOX_PADDING;
    const right = Math.max(...members.map((n) => n.x + NODE_WIDTH / 2)) + BOX_PADDING;
    const top =
      Math.min(...members.map((n) => n.y - NODE_HEIGHT / 2)) -
      BOX_PADDING -
      BOX_LABEL_SPACE;
    const bottom = Math.max(...members.map((n) => n.y + NODE_HEIGHT / 2)) + BOX_PADDING;
    return { x: left, y: top, width: right - left, height: bottom - top };
  };

  const encloses = (
    box: { x: number; y: number; width: number; height: number },
    node: PlacedNode,
  ): boolean =>
    node.x + NODE_WIDTH / 2 > box.x &&
    node.x - NODE_WIDTH / 2 < box.x + box.width &&
    node.y + NODE_HEIGHT / 2 > box.y &&
    node.y - NODE_HEIGHT / 2 < box.y + box.height;

  const boxes: CollectorBox[] = [];
  for (const [code, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const ids = new Set(members.map((n) => n.data.device_id));
    const whole = bounds(members);
    const intruders = nodes.filter(
      (n) => !ids.has(n.data.device_id) && encloses(whole, n),
    );
    if (intruders.length === 0) {
      boxes.push({ key: code, code, ...whole, deviceCount: members.length });
      continue;
    }

    // Split: one run per row, broken wherever a foreign node sits between two
    // members. `y` is the layout's depth, so grouping on it groups by row.
    const rows = new Map<number, PlacedNode[]>();
    for (const member of members) {
      const list = rows.get(member.y) ?? [];
      list.push(member);
      rows.set(member.y, list);
    }
    let part = 0;
    for (const [y, rowMembers] of [...rows].sort(([a], [b]) => a - b)) {
      const foreign = nodes
        .filter((n) => n.y === y && !ids.has(n.data.device_id))
        .map((n) => n.x)
        .sort((a, b) => a - b);
      let run: PlacedNode[] = [];
      const flush = (): void => {
        if (run.length === 0) return;
        part += 1;
        boxes.push({
          key: `${code}#${part}`,
          code,
          ...bounds(run),
          deviceCount: run.length,
        });
        run = [];
      };
      for (const member of [...rowMembers].sort((a, b) => a.x - b.x)) {
        const previous = run[run.length - 1];
        if (previous && foreign.some((fx) => fx > previous.x && fx < member.x)) {
          flush();
        }
        run.push(member);
      }
      flush();
    }
  }
  return boxes;
}

export function SldTree({
  sld,
  overlay,
  onSelect,
  selectedDeviceId,
  height,
  label,
  actions,
}: {
  sld: Sld;
  overlay: SldOverlay;
  onSelect?: (deviceId: number) => void;
  selectedDeviceId?: number | null;
  /** Viewport height. The diagram inside keeps its natural size. */
  height?: number;
  label?: string;
  actions?: JSX.Element | null;
}): JSX.Element {
  const layout = useMemo(() => {
    const root = hierarchy<LayoutNode>(buildLayout(sld), (node) => node.children);
    const layoutFn = tree<LayoutNode>().nodeSize([NODE_WIDTH + H_GAP, NODE_HEIGHT + V_GAP]);
    const positioned = layoutFn(root);

    const devices = positioned
      .descendants()
      .filter((n) => n.data.kind === "device");
    // Two kinds of link are deliberately *not* drawn:
    //
    //   virtual   → the synthetic root; those are not electrical connections.
    //   collector → its own members; containment is what the box says, and a
    //               wire from the box to each occupant would claim seventeen
    //               cables where the whole point is that there is one.
    //
    // What remains is Device → Device (hierarchy, including inside a box) and
    // Device → collector, which is the single edge the enclosure owns.
    const links = positioned
      .links()
      .filter((l) => l.source.data.kind === "device");

    /**
     * A Collector's outline, measured from its own subtree.
     *
     * Because the collector is a node in the *layout*, d3 places everything it
     * contains contiguously beneath it — so the box is simply the extent of its
     * descendants. The old approach measured scattered positions and had to
     * split a group whenever a stranger fell inside; that case is now
     * unreachable by construction, which is a better guarantee than a check.
     */
    const boxes = positioned
      .descendants()
      .filter((n) => n.data.kind === "collector")
      .map((n) => {
        const inside = n.descendants().filter((d) => d.data.kind === "device");
        if (inside.length === 0) return null;
        const left = Math.min(...inside.map((d) => d.x - NODE_WIDTH / 2)) - BOX_PADDING;
        const right = Math.max(...inside.map((d) => d.x + NODE_WIDTH / 2)) + BOX_PADDING;
        const top =
          Math.min(...inside.map((d) => d.y - NODE_HEIGHT / 2)) - BOX_PADDING - BOX_LABEL_SPACE;
        const bottom = Math.max(...inside.map((d) => d.y + NODE_HEIGHT / 2)) + BOX_PADDING;
        return {
          key: n.data.kind === "collector" ? n.data.code : "",
          code: n.data.kind === "collector" ? n.data.code : "",
          x: left, y: top, width: right - left, height: bottom - top,
          deviceCount: inside.length,
          anchorX: (left + right) / 2,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);

    const xs = devices.map((n) => n.x);
    const ys = devices.map((n) => n.y);
    const minX = Math.min(...xs, 0, ...boxes.map((b) => b.x)) - NODE_WIDTH;
    const maxX = Math.max(...xs, 0, ...boxes.map((b) => b.x + b.width)) + NODE_WIDTH;
    const minY = Math.min(...ys, 0, ...boxes.map((b) => b.y)) - NODE_HEIGHT;
    const maxY = Math.max(...ys, 0, ...boxes.map((b) => b.y + b.height)) + NODE_HEIGHT;

    return { devices, links, boxes, minX, minY, width: maxX - minX, height: maxY - minY };
  }, [sld]);

  if (sld.roots.length === 0) {
    return (
      <div className="rounded border border-dashed border-line p-6 text-center text-sm text-ink-muted">
        No Devices are in the power path for this Plant, so there is no electrical
        tree to draw. Devices that carry no current are listed beside this diagram.
      </div>
    );
  }

  /** A stable key and a label for either kind of layout node. */
  const nodeKey = (n: { data: LayoutNode }): string =>
    n.data.kind === "device"
      ? `d${n.data.device.device_id}`
      : n.data.kind === "collector"
        ? `c${n.data.code}`
        : "root";

  const edgePath = (link: {
    source: HierarchyPointNode<LayoutNode>;
    target: HierarchyPointNode<LayoutNode>;
  }): string => {
    const x1 = link.source.x;
    const y1 = link.source.y + NODE_HEIGHT / 2;
    const x2 = link.target.x;
    // A line into a Collector stops at the box's border, not at a node inside
    // it — the connection belongs to the enclosure, and running it to one of
    // the Devices would say the cable lands on that Device.
    const box = link.target.data.kind === "collector"
      ? layout.boxes.find((b) => b.code === (link.target.data as { code: string }).code)
      : undefined;
    const y2 = box ? box.y : link.target.y - NODE_HEIGHT / 2;
    const mid = y1 + (y2 - y1) / 2;
    // Orthogonal, not curved: a single line diagram is a schematic, and a bezier
    // reads as a data-flow arrow rather than a conductor.
    return `M${x1},${y1} V${mid} H${box ? box.anchorX : x2} V${y2}`;
  };

  return (
    <DiagramCanvas
      height={height}
      label={label}
      actions={actions ?? undefined}
      fitKey={`${sld.plant_id}:${sld.device_count}:${layout.boxes.length}`}
    >
      <svg
        viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`}
        width={layout.width}
        height={layout.height}
        role="img"
        aria-label="Single Line Diagram"
      >
        {/* Behind everything: an enclosure contains the equipment, it does not
            overlay it. Dashed, because a solid outline at this weight reads as
            a component and a Collector is not one. */}
        <g>
          {layout.boxes.map((box) => (
            <g key={box.key}>
              <rect
                x={box.x}
                y={box.y}
                width={box.width}
                height={box.height}
                rx={10}
                fill={token("surface-sunken")}
                fillOpacity={0.55}
                stroke={token("ink-faint")}
                strokeWidth={1.3}
                strokeDasharray="7 5"
              />
              <text
                x={box.x + 12}
                y={box.y + 15}
                fill={token("ink-muted")}
                fontSize={11}
                fontWeight={600}
              >
                {box.code}
              </text>
              <text
                x={box.x + box.width - 12}
                y={box.y + 15}
                fill={token("ink-faint")}
                fontSize={10}
                textAnchor="end"
              >
                {/* "collector", spelled out: an unlabelled dashed box is read as
                    a selection, a group, or a fault region by different people. */}
                collector · {box.deviceCount}
              </text>
            </g>
          ))}
        </g>
        <g>
          {layout.links.map((link) => (
            <path
              key={`${nodeKey(link.source)}->${nodeKey(link.target)}`}
              d={edgePath(link)}
              fill="none"
              stroke={token("line")}
              strokeWidth={1.5}
            />
          ))}
        </g>
        <g>
          {layout.devices.map((node) => {
            const entry = node.data as Extract<LayoutNode, { kind: "device" }>;
            const device = entry.device;
            return (
              <SldNode
                key={device.device_id}
                node={device}
                x={node.x}
                y={node.y}
                commStatus={overlay.commStatus[device.device_id] ?? "unknown"}
                livePower={overlay.livePower[device.device_id] ?? null}
                stale={overlay.staleDevices.has(device.device_id)}
                selected={selectedDeviceId === device.device_id}
                onSelect={onSelect}
                // Carries no current: drawn so it is visible where it sits,
                // styled so it is never mistaken for part of the power path.
                unwired={!entry.wired}
              />
            );
          })}
        </g>
      </svg>
    </DiagramCanvas>
  );
}
