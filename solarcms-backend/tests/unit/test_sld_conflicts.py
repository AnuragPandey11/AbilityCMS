"""Where wiring and the four-stage fold disagree, and what satisfies both."""

from __future__ import annotations

from solarcms.domain.sld_conflicts import (
    WiredDevice,
    detect_stage_conflicts,
    stale_overrides,
)


def device(
    device_id: int, code: str, type_code: str, type_stage: str | None,
    parent: int | None = None, override: str | None = None,
    in_power_path: bool = True,
) -> WiredDevice:
    return WiredDevice(
        device_id=device_id, code=code, device_type_code=type_code,
        parent_device_id=parent, in_power_path=in_power_path,
        type_stage=type_stage, stage_override=override,
    )


def sunfield(override: str | None = None) -> list[WiredDevice]:
    """The worked example: an LT feeder meter wired upstream of the transformer.

        INVERTER_1..2 -> MFM_LT -> TRANSFORMER -> VCB -> MFM_HV -> grid

    Both meters are Type MFM, so both default to the Grid stage. One of them
    belongs there; the other is third from the left.
    """
    return [
        device(1, "INVERTER_1", "INVERTER", "INVERTERS", parent=10),
        device(2, "INVERTER_2", "INVERTER", "INVERTERS", parent=10),
        device(10, "MFM_LT", "MFM", "GRID", parent=20, override=override),
        device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER", parent=30),
        device(30, "VCB", "VCB", "TRANSFORMER", parent=40),
        device(40, "MFM_HV", "MFM", "GRID", parent=None),
    ]


class TestDetection:
    def test_the_worked_example_flags_exactly_one_of_two_identical_meters(self) -> None:
        conflicts = detect_stage_conflicts(sunfield())
        assert [c.code for c in conflicts] == ["MFM_LT"]

        conflict = conflicts[0]
        assert conflict.stage == "GRID"
        # It is flagged against what it feeds into.
        assert conflict.feeds_into_code == "TRANSFORMER"
        assert conflict.feeds_into_stage == "TRANSFORMER"
        # Bounded below by the Inverters feeding it, above by the Transformer.
        assert conflict.candidate_stages == ("INVERTERS", "TRANSFORMER")
        # Nearest its Type default (GRID), not the leftmost allowed.
        assert conflict.suggested_stage == "TRANSFORMER"

    def test_the_settlement_meter_is_not_flagged(self) -> None:
        # Same Type, same stage, correct position. Whole point of edge-based
        # detection: it judges position, not Type.
        assert all(c.code != "MFM_HV" for c in detect_stage_conflicts(sunfield()))

    def test_accepting_the_suggestion_resolves_it(self) -> None:
        assert detect_stage_conflicts(sunfield(override="INVERTERS")) == []

    def test_the_other_candidate_also_resolves_it(self) -> None:
        assert detect_stage_conflicts(sunfield(override="TRANSFORMER")) == []

    def test_an_ordinary_plant_has_no_conflicts(self) -> None:
        devices = [
            device(1, "INVERTER_1", "INVERTER", "INVERTERS", parent=20),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER", parent=40),
            device(40, "MFM", "MFM", "GRID", parent=None),
        ]
        assert detect_stage_conflicts(devices) == []


class TestGating:
    def test_an_unwired_plant_yields_nothing(self) -> None:
        # Every Device a root. Nothing is compared with anything, so a Plant
        # nobody has wired produces no conflicts rather than a page of them.
        devices = [
            device(1, "INVERTER_1", "INVERTER", "INVERTERS"),
            device(10, "MFM_LT", "MFM", "GRID"),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER"),
        ]
        assert detect_stage_conflicts(devices) == []

    def test_partial_wiring_only_judges_the_wired_part(self) -> None:
        # The unwired Devices sit at no depth and must not be dragged in.
        devices = [
            device(1, "INVERTER_1", "INVERTER", "INVERTERS", parent=10),
            device(10, "MFM_LT", "MFM", "GRID", parent=20),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER"),
            device(99, "VCB_SPARE", "VCB", "TRANSFORMER"),
        ]
        assert [c.code for c in detect_stage_conflicts(devices)] == ["MFM_LT"]

    def test_devices_outside_the_power_path_are_never_compared(self) -> None:
        devices = [
            device(1, "INVERTER_1", "INVERTER", "INVERTERS", parent=20),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER"),
            device(50, "WMS", "WMS", None, parent=20, in_power_path=False),
        ]
        assert detect_stage_conflicts(devices) == []

    def test_a_parent_outside_the_set_is_not_an_edge(self) -> None:
        # Points at a Device that is not power-path, decommissioned, or on
        # another Plant. No edge, so nothing to contradict.
        devices = [device(10, "MFM_LT", "MFM", "GRID", parent=777)]
        assert detect_stage_conflicts(devices) == []

    def test_a_type_with_no_stage_is_skipped_not_crashed(self) -> None:
        devices = [
            device(1, "MYSTERY", "NEW_TYPE", None, parent=20),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER"),
        ]
        assert detect_stage_conflicts(devices) == []


class TestConstraints:
    def test_a_device_with_no_neighbours_left_is_unconstrained(self) -> None:
        # Only a downstream neighbour: everything at or left of it is allowed.
        devices = [
            device(10, "MFM_LT", "MFM", "GRID", parent=20),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER"),
        ]
        conflict = detect_stage_conflicts(devices)[0]
        assert conflict.candidate_stages == ("PV_ARRAY", "INVERTERS", "TRANSFORMER")
        # With no lower bound, "leftmost allowed" would propose PV Array for a
        # meter. The smallest move from its Type default is the sane answer.
        assert conflict.suggested_stage == "TRANSFORMER"

    def test_impossible_wiring_offers_no_candidate(self) -> None:
        # Fed by something in Grid and feeding something in PV_ARRAY: no stage
        # satisfies both, so restaging cannot help and the wiring is wrong.
        devices = [
            device(1, "METER_A", "MFM", "GRID", parent=2),
            device(2, "MIDDLE", "MFM", "GRID", parent=3),
            device(3, "ARRAY", "PV_ARRAY", "PV_ARRAY"),
        ]
        middle = next(c for c in detect_stage_conflicts(devices) if c.code == "MIDDLE")
        assert middle.candidate_stages == ()
        assert middle.suggested_stage is None
        assert middle.resolvable_by_restaging is False

    def test_the_suggestion_is_never_the_stage_it_already_has(self) -> None:
        conflict = detect_stage_conflicts(sunfield())[0]
        assert conflict.suggested_stage != conflict.stage
        assert conflict.stage not in conflict.candidate_stages

    def test_one_entry_per_device_however_many_neighbours_disagree(self) -> None:
        devices = [
            device(1, "INVERTER_1", "INVERTER", "INVERTERS", parent=10),
            device(2, "INVERTER_2", "INVERTER", "INVERTERS", parent=10),
            device(10, "MFM_LT", "MFM", "GRID", parent=20),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER"),
        ]
        conflicts = detect_stage_conflicts(devices)
        assert len({c.device_id for c in conflicts}) == len(conflicts)

    def test_a_cycle_does_not_hang(self) -> None:
        # build_sld detaches rings and reports them; this must simply not spin.
        devices = [
            device(1, "A", "MFM", "GRID", parent=2),
            device(2, "B", "INVERTER", "INVERTERS", parent=1),
        ]
        assert isinstance(detect_stage_conflicts(devices), list)


class TestStaleOverrides:
    def test_an_override_still_doing_work_is_not_stale(self) -> None:
        assert stale_overrides(sunfield(override="INVERTERS")) == []

    def test_an_override_the_wiring_no_longer_needs_is_reported(self) -> None:
        # The meter has since been re-wired to the grid side, where its Type
        # default was right all along. The override now explains nothing.
        devices = [
            device(1, "INVERTER_1", "INVERTER", "INVERTERS", parent=20),
            device(20, "TRANSFORMER", "TRANSFORMER", "TRANSFORMER", parent=10),
            device(10, "MFM_LT", "MFM", "GRID", parent=None, override="INVERTERS"),
        ]
        stale = stale_overrides(devices)
        assert [s.code for s in stale] == ["MFM_LT"]
        assert stale[0].override_stage == "INVERTERS"
        assert stale[0].type_stage == "GRID"

    def test_an_override_equal_to_the_default_is_not_reported_twice(self) -> None:
        devices = [device(10, "MFM", "MFM", "GRID", override="GRID")]
        assert stale_overrides(devices) == []

    def test_no_overrides_means_nothing_to_report(self) -> None:
        assert stale_overrides(sunfield()) == []
