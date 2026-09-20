/**
 * Where a Collector's outline is drawn.
 *
 * The rule the whole thing rests on: **an outline may never enclose a Device
 * that is not in that Collector.** A diagram saying a machine is in a room it
 * is not in is worse than a diagram that marks no rooms at all — it is the one
 * failure mode that makes the feature actively misleading rather than merely
 * absent, and it is easy to hit, because nodes are positioned by the
 * electrical tree and nothing forces a Collector's members to be neighbours.
 */

import { describe, expect, it } from "vitest";
import { collectorBoxes, type PlacedNode } from "@/components/sld/SldTree";
import { NODE_HEIGHT, NODE_WIDTH } from "@/components/sld/SldNode";

/** One positioned node. `x` is the centre, `y` is the row. */
function node(
  device_id: number,
  x: number,
  y: number,
  collector_code: string | null,
): PlacedNode {
  return {
    x,
    y,
    data: {
      device_id,
      code: `DEV-${device_id}`,
      name: `Device ${device_id}`,
      type: "INVERTER",
      variant: null,
      collector_code,
      children: [],
    },
  };
}

/** Does this box's rectangle overlap that node's rectangle? */
function encloses(
  box: { x: number; y: number; width: number; height: number },
  n: PlacedNode,
): boolean {
  return (
    n.x + NODE_WIDTH / 2 > box.x &&
    n.x - NODE_WIDTH / 2 < box.x + box.width &&
    n.y + NODE_HEIGHT / 2 > box.y &&
    n.y - NODE_HEIGHT / 2 < box.y + box.height
  );
}

const STEP = NODE_WIDTH + 42;

describe("collector outlines", () => {
  it("draws nothing when no Device names a collector", () => {
    const nodes = [node(1, 0, 0, null), node(2, STEP, 0, null)];
    expect(collectorBoxes(nodes)).toEqual([]);
  });

  it("draws one outline around a contiguous group", () => {
    const nodes = [
      node(1, 0, 0, "MCR"),
      node(2, STEP, 0, "MCR"),
      node(3, STEP * 2, 0, null),
    ];
    const boxes = collectorBoxes(nodes);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].code).toBe("MCR");
    expect(boxes[0].deviceCount).toBe(2);
    expect(encloses(boxes[0], nodes[0])).toBe(true);
    expect(encloses(boxes[0], nodes[1])).toBe(true);
    // The stranger beside them stays outside.
    expect(encloses(boxes[0], nodes[2])).toBe(false);
  });

  it("spans rows when the group runs down the chain", () => {
    // A meter feeding two Inverters, all three in the same room. One outline,
    // two rows tall — that is a room, and it is what the diagram should say.
    const nodes = [
      node(1, STEP / 2, 0, "MCR"),
      node(2, 0, 120, "MCR"),
      node(3, STEP, 120, "MCR"),
    ];
    const boxes = collectorBoxes(nodes);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].deviceCount).toBe(3);
  });

  it("never encloses a Device belonging to another collector", () => {
    // Interleaved: MCR, ICR, MCR across one row. A single bounding box would
    // swallow the ICR machine, so the MCR is drawn as two outlines instead.
    const nodes = [
      node(1, 0, 0, "MCR"),
      node(2, STEP, 0, "ICR"),
      node(3, STEP * 2, 0, "MCR"),
    ];
    const boxes = collectorBoxes(nodes);
    const mcr = boxes.filter((box) => box.code === "MCR");
    expect(mcr).toHaveLength(2);
    for (const box of boxes) {
      for (const other of nodes) {
        const inside = encloses(box, other);
        const member = other.data.collector_code === box.code;
        // The invariant, stated directly: anything inside an outline is in
        // that collector.
        if (inside) expect(member).toBe(true);
      }
    }
  });

  it("keeps each collector's outlines labelled with the same name", () => {
    const nodes = [
      node(1, 0, 0, "MCR"),
      node(2, STEP, 0, "ICR"),
      node(3, STEP * 2, 0, "MCR"),
    ];
    const boxes = collectorBoxes(nodes);
    // Distinct keys so React can render them, one shared label so the operator
    // reads two outlines as one room.
    expect(new Set(boxes.map((b) => b.key)).size).toBe(boxes.length);
    expect(boxes.filter((b) => b.code === "MCR").map((b) => b.code)).toEqual([
      "MCR",
      "MCR",
    ]);
  });

  it("leaves room above the outline for its label", () => {
    // Without it the collector's name is printed over the top edge of the
    // first node in it.
    const nodes = [node(1, 0, 0, "MCR")];
    const [box] = collectorBoxes(nodes);
    expect(box.y).toBeLessThan(-NODE_HEIGHT / 2 - 16);
  });
});
