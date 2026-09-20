"""The electrical tree, and the guard that keeps a hierarchy editor honest.

Pure `domain/` tests. The cycle cases matter more than they look: the hierarchy
editor lets an administrator drag any Device onto any other, so a ring is one
gesture away, and the two halves of the defence are tested separately —
`would_create_cycle` refuses to *create* one, `build_sld` survives one that
somehow exists anyway.
"""

from __future__ import annotations

from solarcms.domain.sld import (
    SldDevice,
    build_sld,
    crosses_collector_boundary,
    would_create_cycle,
)


def device(
    device_id: int, code: str, parent: int | None = None, *, in_power_path: bool = True
) -> SldDevice:
    return SldDevice(
        device_id=device_id, code=code, name=f"{code} name",
        device_type_code="MFM", in_power_path=in_power_path, parent_device_id=parent,
    )


# ── build_sld ───────────────────────────────────────────────────────────────

def test_a_chain_builds_one_root_with_descendants() -> None:
    # INV-01 -> TXF-01 -> MFM-01 -> (grid). The root is the Device that feeds
    # into nothing, which is the point where the Plant meets the grid.
    tree = build_sld([
        device(1, "INV-01", parent=2),
        device(2, "TXF-01", parent=3),
        device(3, "MFM-01"),
    ])
    assert [root.device.code for root in tree.roots] == ["MFM-01"]
    assert tree.device_count == 3
    assert [d.code for d in tree.roots[0].walk()] == ["MFM-01", "TXF-01", "INV-01"]


def test_two_feeders_stay_separate_roots() -> None:
    # A Plant may genuinely have more than one incoming feeder. Forcing them
    # under one node would invent an electrical connection that does not exist.
    tree = build_sld([device(1, "MFM-A"), device(2, "MFM-B")])
    assert [root.device.code for root in tree.roots] == ["MFM-A", "MFM-B"]


def test_devices_outside_the_power_path_are_excluded_not_dropped() -> None:
    # A Weather Station is real and monitored; electricity does not flow through
    # it. It belongs beside the diagram, not in it — and not nowhere.
    tree = build_sld([
        device(1, "MFM-01"),
        device(2, "WMS-01", in_power_path=False),
    ])
    assert [d.code for d in tree.excluded_not_in_power_path] == ["WMS-01"]
    assert tree.device_count == 1


def test_a_parent_outside_the_power_path_leaves_the_child_as_a_root() -> None:
    # Silently dropping it would make the diagram claim the Plant has less
    # equipment than it does.
    tree = build_sld([
        device(1, "INV-01", parent=9),
        device(9, "PPC-01", in_power_path=False),
    ])
    assert [root.device.code for root in tree.roots] == ["INV-01"]


def test_a_ring_is_reported_rather_than_recursed_into() -> None:
    # Should be unreachable through the API now, but a diagram request must not
    # be able to hang regardless of how the data got that way.
    tree = build_sld([
        device(1, "A", parent=2),
        device(2, "B", parent=3),
        device(3, "C", parent=1),
    ])
    assert tree.roots == []
    assert sorted(d.code for d in tree.orphaned) == ["A", "B", "C"]


def test_output_order_is_stable() -> None:
    # A diagram that reorders between requests is unreadable.
    devices = [device(3, "C", parent=1), device(2, "B", parent=1), device(1, "A")]
    first = build_sld(devices)
    second = build_sld(list(reversed(devices)))
    assert [c.device.code for c in first.roots[0].children] == ["B", "C"]
    assert [c.device.code for c in second.roots[0].children] == ["B", "C"]


# ── would_create_cycle ──────────────────────────────────────────────────────

def test_clearing_a_parent_is_always_allowed() -> None:
    assert not would_create_cycle({1: 2, 2: None}, 1, None)


def test_a_device_cannot_feed_into_itself() -> None:
    assert would_create_cycle({1: None}, 1, 1)


def test_a_device_cannot_feed_into_its_own_child() -> None:
    # B already feeds into A. Pointing A at B closes a two-Device ring.
    assert would_create_cycle({1: None, 2: 1}, 1, 2)


def test_a_device_cannot_feed_into_a_distant_descendant() -> None:
    # C -> B -> A. Pointing A at C closes a three-Device ring, which no
    # constraint in the schema can see.
    parents = {1: None, 2: 1, 3: 2}
    assert would_create_cycle(parents, 1, 3)


def test_an_ordinary_reparent_is_permitted() -> None:
    # Moving a leaf under a sibling is the common case and must stay cheap.
    parents = {1: None, 2: 1, 3: 1}
    assert not would_create_cycle(parents, 3, 2)


def test_a_ring_already_in_the_data_does_not_hang_the_check() -> None:
    # Bounded by the number of Devices, not by the shape of the graph.
    parents = {1: 2, 2: 3, 3: 1, 4: None}
    assert not would_create_cycle(parents, 4, None)
    assert would_create_cycle(parents, 1, 3)


# ── Collectors ──────────────────────────────────────────────────────────────
#
# A Collector is an enclosure, not a Device (migration 0022). These assert the
# two halves of that: it never becomes a node, and it never changes what the
# tree says — it only decides which siblings stand next to each other, so the
# renderer can draw one unbroken outline per room.

def in_collector(
    device_id: int, code: str, collector: str | None, parent: int | None = None
) -> SldDevice:
    return SldDevice(
        device_id=device_id, code=code, name=f"{code} name",
        device_type_code="INVERTER", in_power_path=True, parent_device_id=parent,
        collector_code=collector,
    )


def test_a_collector_never_becomes_a_node() -> None:
    # Twenty Devices in the MCR are twenty nodes. The room is not a twenty-first,
    # and nothing is wired through it.
    tree = build_sld([
        in_collector(1, "MFM-01", "MCR"),
        in_collector(2, "INV-01", "MCR", parent=1),
        in_collector(3, "INV-02", "MCR", parent=1),
    ])
    assert tree.device_count == 3
    assert [d.code for d in tree.roots[0].walk()] == ["MFM-01", "INV-01", "INV-02"]


def test_siblings_sharing_a_collector_are_kept_adjacent() -> None:
    # Ordered by code alone this reads INV-A, INV-B, INV-C, INV-D and the two
    # MCR machines are separated by the two ICR ones. The renderer would then
    # have to draw the MCR as two outlines with strangers between them.
    tree = build_sld([
        in_collector(1, "MFM-01", None),
        in_collector(2, "INV-A", "MCR", parent=1),
        in_collector(3, "INV-B", "ICR", parent=1),
        in_collector(4, "INV-C", "MCR", parent=1),
        in_collector(5, "INV-D", "ICR", parent=1),
    ])
    children = [child.device.code for child in tree.roots[0].children]
    assert children == ["INV-B", "INV-D", "INV-A", "INV-C"]


def test_devices_in_no_collector_sort_ahead_of_every_named_one() -> None:
    # Otherwise unenclosed equipment ends up wedged between two outlines, which
    # reads as being inside one of them.
    tree = build_sld([
        in_collector(1, "MFM-01", None),
        in_collector(2, "INV-A", "MCR", parent=1),
        in_collector(3, "INV-Z", None, parent=1),
    ])
    assert [c.device.code for c in tree.roots[0].children] == ["INV-Z", "INV-A"]


def test_the_collector_does_not_change_what_feeds_into_what() -> None:
    # The whole point of keeping it beside `parent_device_id` rather than in it:
    # an Inverter in the MCR can feed a transformer outside the MCR, and the
    # diagram has to keep saying so.
    tree = build_sld([
        in_collector(1, "TXF-01", None),
        in_collector(2, "INV-01", "MCR", parent=1),
    ])
    assert tree.roots[0].device.code == "TXF-01"
    assert tree.roots[0].children[0].device.code == "INV-01"
    assert tree.roots[0].children[0].device.collector_code == "MCR"


# ── The collector boundary ──────────────────────────────────────────────────
#
# A Collector's outward connection belongs to the box (migration 0024), so an
# edge between two Devices is legal only when both sit on the same side of the
# wall. Enforced in the API rather than by a constraint, for the reason
# `would_create_cycle` is: a CHECK cannot see the parent row, and a composite
# foreign key is satisfied vacuously whenever either collector_code is NULL.

def test_two_devices_in_the_same_collector_may_be_wired() -> None:
    # Hierarchy *within* a room is exactly what the rule is meant to allow.
    assert not crosses_collector_boundary("MCR", "MCR")


def test_two_devices_in_no_collector_may_be_wired() -> None:
    # The ordinary case for a plant that publishes on the five-segment shape.
    assert not crosses_collector_boundary(None, None)


def test_a_device_inside_may_not_feed_one_outside() -> None:
    # The MCR's connection to the meter belongs to the MCR, not to each of the
    # seventeen Inverters in it.
    assert crosses_collector_boundary("MCR", None)


def test_a_device_outside_may_not_feed_one_inside() -> None:
    # The same wall, approached from the other side.
    assert crosses_collector_boundary(None, "MCR")


def test_two_different_collectors_may_not_be_wired_directly() -> None:
    # Neither box owns this edge, so neither can be the one that states it.
    assert crosses_collector_boundary("MCR", "ICR")


def test_the_comparison_is_never_case_folded() -> None:
    # `MCR` and `mcr` are two enclosures for the same reason they are two
    # origins: the topic is case-sensitive and Guardrail 5 makes it the
    # authority. Folding here would silently merge two rooms.
    assert crosses_collector_boundary("MCR", "mcr")
