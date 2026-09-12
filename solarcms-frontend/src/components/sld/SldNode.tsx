/**
 * One Device in the diagram.
 *
 * Colour is `comm_status`, not generation: the question a single line diagram
 * answers first is "is this thing reachable". Live power is overlaid as text
 * with its unit rendered verbatim (§4.1) — the caller formats it, because only
 * the caller knows which Tag it came from.
 *
 * No branch anywhere on a Device's code, name or id (Guardrail 1). The node's
 * appearance depends on its Device *Type* and status, both of which are data.
 */

import type { CommStatus, SldNodeData } from "@/api/schemas";
import { token } from "@/theme/tokens";

export const NODE_WIDTH = 132;
export const NODE_HEIGHT = 46;

// A function, not a constant: SVG attributes take a resolved colour, so these
// must be read per render rather than frozen at module load.
const statusStroke = (status: CommStatus): string =>
  ({
    online: token("ok"),
    degraded: token("warn"),
    offline: token("bad"),
    unknown: token("ink-faint"),
  })[status];

const STATUS_TITLE: Record<CommStatus, string> = {
  online: "Reporting within its expected interval.",
  degraded: "Late — past its expected interval but under the offline threshold.",
  offline: "Not reporting. This may be the Device or the Collector that carries it.",
  unknown: "No health record yet; the Device has not reported since registration.",
};

export function SldNode({
  node,
  x,
  y,
  commStatus,
  livePower,
  stale,
  selected,
  onSelect,
}: {
  node: SldNodeData;
  x: number;
  y: number;
  commStatus: CommStatus;
  livePower: string | null;
  stale: boolean;
  selected: boolean;
  onSelect?: (deviceId: number) => void;
}): JSX.Element {
  const left = x - NODE_WIDTH / 2;
  const top = y - NODE_HEIGHT / 2;
  const stroke = statusStroke(commStatus);

  return (
    <g
      transform={`translate(${left}, ${top})`}
      onClick={() => onSelect?.(node.device_id)}
      style={{ cursor: onSelect ? "pointer" : "default" }}
    >
      <title>
        {`${node.code} — ${node.name}\nType: ${node.type}${
          node.variant ? ` (${node.variant})` : ""
        }\n${STATUS_TITLE[commStatus]}`}
      </title>
      <rect
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={5}
        fill={selected ? token("accent-soft") : token("surface-raised")}
        stroke={selected ? token("accent") : stroke}
        strokeWidth={selected ? 2 : 1.4}
        opacity={stale ? 0.55 : 1}
      />
      <circle cx={10} cy={11} r={3.5} fill={stroke} />
      <text x={20} y={15} fill={token("ink")} fontSize={11} fontWeight={600}>
        {node.code.length > 15 ? `${node.code.slice(0, 14)}…` : node.code}
      </text>
      <text x={8} y={29} fill={token("ink-muted")} fontSize={9}>
        {node.type}
        {node.variant ? ` · ${node.variant}` : ""}
      </text>
      <text
        x={NODE_WIDTH - 8}
        y={40}
        fill={livePower ? token("info") : token("ink-faint")}
        fontSize={10}
        fontFamily="ui-monospace, monospace"
        textAnchor="end"
      >
        {/* An absent live value is a dash, never a zero (§4.3 applies here too). */}
        {livePower ?? "—"}
      </text>
    </g>
  );
}
