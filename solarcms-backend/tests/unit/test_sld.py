"""The electrical tree, and the guard that keeps a hierarchy editor honest.

Pure `domain/` tests. The cycle cases matter more than they look: the hierarchy
editor lets an administrator drag any Device onto any other, so a ring is one
gesture away, and the two halves of the defence are tested separately —
`would_create_cycle` refuses to *create* one, `build_sld` survives one that
somehow exists anyway.
"""

from __future__ import annotations

from solarcms.domain.sld import SldDevice, build_sld, would_create_cycle


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
