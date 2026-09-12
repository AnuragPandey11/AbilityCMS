/**
 * The Single Line Diagram.
 *
 * `d3-hierarchy` computes positions; React renders the SVG. d3 never touches the
 * DOM (§1) — mixing two things that both want to own a subtree is how a chart
 * ends up with orphaned nodes after a re-render.
 *
 * Three rules, each protecting something confirmed (§6.4):
 *
 * 1. **Blocks never appear** (Guardrail 8, Guardrail 11). A Block says *where* a
 *    Device is; `parent_device_id` says *what it is wired into*. Putting a
 *    geographic grouping in an electrical diagram makes the diagram wrong.
 * 2. **`excluded_not_in_power_path` is not an error.** A Weather Station and a
 *    PPC are real, monitored Devices that carry no current — a side panel.
 * 3. **`orphaned` is a data problem worth surfacing.** Dropping them silently
 *    makes the diagram claim the Plant has less equipment than it does.
 */

import { useMemo } from "react";
import { hierarchy, tree, type HierarchyPointNode } from "d3-hierarchy";
import type { CommStatus, Sld, SldNodeData } from "@/api/schemas";
import { SldNode, NODE_HEIGHT, NODE_WIDTH } from "./SldNode";
import { token } from "@/theme/tokens";

const H_GAP = 42;
const V_GAP = 74;

export interface SldOverlay {
  /** comm_status per device_id, from GET /plants/{id}/devices. */
  commStatus: Record<number, CommStatus>;
  /** Live power per device_id, already formatted with its Tag's unit. */
  livePower: Record<number, string>;
  staleDevices: Set<number>;
}

export function SldTree({
  sld,
  overlay,
  onSelect,
  selectedDeviceId,
}: {
  sld: Sld;
  overlay: SldOverlay;
  onSelect?: (deviceId: number) => void;
  selectedDeviceId?: number | null;
}): JSX.Element {
  const layout = useMemo(() => {
    // A synthetic root holds the real roots side by side. A Plant can have more
    // than one incoming feeder, and forcing them under one node would invent an
    // electrical connection that does not exist.
    const virtualRoot: SldNodeData = {
      device_id: -1,
      code: "",
      name: "",
      type: "",
      variant: null,
      children: sld.roots,
    };

    const root = hierarchy<SldNodeData>(virtualRoot, (node) => node.children);
    const layoutFn = tree<SldNodeData>().nodeSize([NODE_WIDTH + H_GAP, NODE_HEIGHT + V_GAP]);
    const positioned = layoutFn(root);

    const nodes = positioned.descendants().filter((node) => node.data.device_id !== -1);
    const links = positioned
      .links()
      // Links from the synthetic root are not electrical connections.
      .filter((link) => link.source.data.device_id !== -1);

    const xs = nodes.map((node) => node.x);
    const ys = nodes.map((node) => node.y);
    const minX = Math.min(...xs, 0) - NODE_WIDTH;
    const maxX = Math.max(...xs, 0) + NODE_WIDTH;
    const minY = Math.min(...ys, 0) - NODE_HEIGHT;
    const maxY = Math.max(...ys, 0) + NODE_HEIGHT;

    return { nodes, links, minX, minY, width: maxX - minX, height: maxY - minY };
  }, [sld.roots]);

  if (sld.roots.length === 0) {
    return (
      <div className="rounded border border-dashed border-line p-6 text-center text-sm text-ink-muted">
        No Devices are in the power path for this Plant, so there is no electrical
        tree to draw. Devices that carry no current are listed beside this diagram.
      </div>
    );
  }

  const edgePath = (link: {
    source: HierarchyPointNode<SldNodeData>;
    target: HierarchyPointNode<SldNodeData>;
  }): string => {
    const x1 = link.source.x;
    const y1 = link.source.y + NODE_HEIGHT / 2;
    const x2 = link.target.x;
    const y2 = link.target.y - NODE_HEIGHT / 2;
    const mid = y1 + (y2 - y1) / 2;
    // Orthogonal, not curved: a single line diagram is a schematic, and a bezier
    // reads as a data-flow arrow rather than a conductor.
    return `M${x1},${y1} V${mid} H${x2} V${y2}`;
  };

  return (
    <div className="overflow-auto">
      <svg
        viewBox={`${layout.minX} ${layout.minY} ${layout.width} ${layout.height}`}
        width={Math.max(layout.width, 320)}
        height={Math.max(layout.height, 240)}
        role="img"
        aria-label="Single Line Diagram"
      >
        <g>
          {layout.links.map((link) => (
            <path
              key={`${link.source.data.device_id}-${link.target.data.device_id}`}
              d={edgePath(link)}
              fill="none"
              stroke={token("line")}
              strokeWidth={1.5}
            />
          ))}
        </g>
        <g>
          {layout.nodes.map((node) => (
            <SldNode
              key={node.data.device_id}
              node={node.data}
              x={node.x}
              y={node.y}
              commStatus={overlay.commStatus[node.data.device_id] ?? "unknown"}
              livePower={overlay.livePower[node.data.device_id] ?? null}
              stale={overlay.staleDevices.has(node.data.device_id)}
              selected={selectedDeviceId === node.data.device_id}
              onSelect={onSelect}
            />
          ))}
        </g>
      </svg>
    </div>
  );
}
