"""Builds the Single Line Diagram tree from a Device list. Pure — no I/O.

The SLD is the **electrical** topology and is built from `parent_device_id`
alone. Two things are deliberately excluded:

* **Blocks never appear** (Guardrail 11). A Block says *where* a Device is;
  `parent_device_id` says *what it is wired into*. Inserting a geographic grouping
  into an electrical diagram makes the diagram wrong.
* **Devices outside the power path never appear** (MASTER §2.3). A Weather Station
  and a Power Plant Controller are real, monitored Devices, but electricity does
  not flow through them, and placing them in the electrical tree would corrupt it.
* **A Collector is never a node** (migration 0022). An MCR or an ICR is an
  enclosure that *holds* Devices; no current flows through the room. It travels
  with each Device as `collector_code` so the caller can draw a box around the
  Devices inside it, which is a different shape from a box in the chain — a node
  would claim the diagram passes through it, and it does not.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class SldDevice:
    """One Device as the diagram needs it."""

    device_id: int
    code: str
    name: str
    device_type_code: str
    in_power_path: bool
    parent_device_id: int | None
    variant: str | None = None
    rated_capacity_kw: float | None = None
    # The enclosure this Device sits in, or None when it sits in none. Carried
    # through untouched: `build_sld` never groups, sorts or nests by it, because
    # the electrical tree is `parent_device_id` and nothing else. Two Devices in
    # one MCR may sit at opposite ends of the chain, and the diagram must keep
    # saying so.
    collector_code: str | None = None


@dataclass(slots=True)
class SldNode:
    device: SldDevice
    children: list[SldNode] = field(default_factory=list)

    def walk(self) -> list[SldDevice]:
        """Depth-first, this node first."""
        out = [self.device]
        for child in self.children:
            out.extend(child.walk())
        return out


@dataclass(slots=True)
class SldTree:
    roots: list[SldNode] = field(default_factory=list)
    # Devices excluded because they carry no current. Returned rather than
    # dropped: the caller still has to display them somewhere, just not here.
    excluded_not_in_power_path: list[SldDevice] = field(default_factory=list)
    # parent_device_id pointed outside the supplied set, or formed a cycle.
    orphaned: list[SldDevice] = field(default_factory=list)

    @property
    def device_count(self) -> int:
        return sum(len(root.walk()) for root in self.roots)


def would_create_cycle(
    parents: dict[int, int | None], child_id: int, new_parent_id: int | None
) -> bool:
    """Would pointing `child_id` at `new_parent_id` close a loop?

    `build_sld` already survives a cycle — it detaches the loop and reports it
    rather than recursing — but surviving one is not the same as allowing one to
    be created. A hierarchy editor lets an administrator drag any Device onto any
    other, so the mistake is one gesture away, and catching it at the moment of
    the drag says *"that would make A feed into itself"* where catching it later
    only produces a diagram with pieces mysteriously missing.

    Walks up from the proposed parent: if the chain reaches the child, the edge
    closes a loop. Iteration is bounded by the number of Devices, so a cycle
    already present in the data cannot hang this.
    """
    if new_parent_id is None:
        return False
    if new_parent_id == child_id:
        return True

    seen: set[int] = set()
    cursor: int | None = new_parent_id
    while cursor is not None and cursor not in seen:
        if cursor == child_id:
            return True
        seen.add(cursor)
        cursor = parents.get(cursor)
    return False


def crosses_collector_boundary(
    child_collector: str | None, parent_collector: str | None
) -> bool:
    """Would this edge cross the wall of an enclosure?

    A Collector's outward connection belongs to the *box*
    (`plant_collectors.parent_device_id`), not to each occupant. Seventeen
    Inverters in the MCR do not each run a cable to the transformer; the room
    has one outgoing connection. So an edge is legal only between two Devices
    on the same side of the wall:

        both inside the same Collector  → legal (hierarchy within a room)
        both outside every Collector    → legal
        one inside, one outside         → crosses; the box's edge says this
        inside different Collectors     → crosses; neither box owns it

    ⚠ Compared exactly, never case-folded. `MCR` and `mcr` are two enclosures
    for the same reason they are two origins (Guardrail 5).

    Enforced in the API rather than by a constraint: a CHECK cannot see the
    parent row, and a composite foreign key on `(parent_device_id,
    collector_code)` is satisfied vacuously whenever either side is NULL
    (MATCH SIMPLE) — which is precisely the case it would most need to catch.
    Same reasoning as `would_create_cycle`.
    """
    return child_collector != parent_collector


def build_sld(devices: list[SldDevice]) -> SldTree:
    """Assemble the electrical tree.

    A Device whose parent is absent from the power path becomes a root rather than
    being discarded: an Inverter wired through a non-power-path Device is still
    part of the electrical story, and silently dropping it would make the diagram
    claim the Plant has less equipment than it does.

    Cycles cannot occur through valid data — `parent_device_id` is constrained to
    the same Plant and a Device cannot be its own parent (I-3) — but a cycle is
    detected and reported rather than recursed into, because a diagram request
    must not be able to hang the API.
    """
    in_path = [d for d in devices if d.in_power_path]
    tree = SldTree(excluded_not_in_power_path=[d for d in devices if not d.in_power_path])

    nodes = {d.device_id: SldNode(d) for d in in_path}
    present = set(nodes)

    for device in in_path:
        parent_id = device.parent_device_id
        if parent_id is None or parent_id not in present:
            tree.roots.append(nodes[device.device_id])
        else:
            nodes[parent_id].children.append(nodes[device.device_id])

    # Any node not reachable from a root sits in a cycle. Detected by counting
    # rather than by recursion, so a malformed graph costs one pass, not a stack.
    reachable: set[int] = set()
    stack = [node for node in tree.roots]
    while stack:
        node = stack.pop()
        if node.device.device_id in reachable:
            continue
        reachable.add(node.device.device_id)
        stack.extend(node.children)

    if len(reachable) != len(present):
        for device_id in sorted(present - reachable):
            tree.orphaned.append(nodes[device_id].device)
        # Detach them so the returned tree is traversable without looping.
        cyclic = present - reachable
        for node in nodes.values():
            node.children = [c for c in node.children if c.device.device_id not in cyclic]

    # Stable output: a diagram that reorders between requests is unreadable.
    #
    # Siblings sharing a Collector are kept adjacent, and only then ordered by
    # code. This changes no relationship — the tree is still `parent_device_id`
    # alone — but it is what lets the renderer draw one unbroken box per
    # enclosure instead of a box with somebody else's Inverter sitting inside
    # it. Devices in no Collector sort first, ahead of every named one, so the
    # unenclosed equipment does not end up wedged between two boxes.
    def order(device: SldDevice) -> tuple[int, str, str]:
        return (0 if device.collector_code is None else 1,
                device.collector_code or "", device.code)

    def sort_node(node: SldNode) -> None:
        node.children.sort(key=lambda c: order(c.device))
        for child in node.children:
            sort_node(child)

    tree.roots.sort(key=lambda n: order(n.device))
    for root in tree.roots:
        sort_node(root)
    return tree
