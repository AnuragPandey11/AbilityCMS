"""What commissioning reads out of a Device code, and the PV-string keys. Plain values only."""

from __future__ import annotations

import pytest

from solarcms.domain.assumptions import MAX_PV_STRINGS, TAG_SPECS, alias_for
from solarcms.domain.commissioning import match_device_type, string_topic_owner

# The seeded catalogue's codes (services/seed.DEVICE_TYPES), as a literal so the
# test reads the same whatever the seed later grows.
TYPES = (
    "VCB", "ISOLATOR", "INVERTER", "SMB", "TRANSFORMER", "MFM", "ABT_METER", "WMS",
    "PPC", "MODULE_TRACKER", "UPS", "DC_POWER_BANK", "FIRE_SYSTEM", "ANNUNCIATOR",
    "SLDC_TELEMETRY", "MCR_SECTION", "ICR_SECTION", "PV_ARRAY", "DCDB", "ACDB",
    "PLANT_KPI",
)


class TestStringTopicOwner:
    @pytest.mark.parametrize(("code", "owner"), [
        # Observed on the client's broker, 6 Oct 2026.
        ("INVERTER_1_STRING16", "INVERTER_1"),
        ("INVERTER_10_STRING28", "INVERTER_10"),
        ("INVERTER_1_STRING", "INVERTER_1"),
        ("SMB1_STRING16", "SMB1"),
        ("SMB1_STRING24", "SMB1"),
    ])
    def test_a_string_topic_names_its_owner(self, code: str, owner: str) -> None:
        assert string_topic_owner(code) == owner

    @pytest.mark.parametrize("code", [
        "INVERTER_1", "INVERTER1", "MFM", "WMS_WEST", "MAIN_MFM",
        # A suffix with nothing before it names no Device.
        "_STRING16",
        # Only a suffix counts: STRING in the middle is part of a name.
        "STRING_BOX_1", "INVERTER_STRINGS",
    ])
    def test_anything_else_is_its_own_device(self, code: str) -> None:
        assert string_topic_owner(code) is None


class TestMatchDeviceType:
    @pytest.mark.parametrize(("code", "expected"), [
        ("MFM", "MFM"),
        ("INVERTER_7", "INVERTER"),
        ("INVERTER1", "INVERTER"),
        ("WMS_WEST", "WMS"),
        ("SMB1", "SMB"),
        # A qualifier before the Type — both observed on 6 Oct 2026, and both
        # BLOCKED by the prefix-only rule before.
        ("MAIN_MFM", "MFM"),
        ("ICOG_MFM", "MFM"),
        ("MAIN_ABT_METER", "ABT_METER"),
        ("FEEDER_2_VCB", "VCB"),
        # The client abbreviates; exactly one Type is meant.
        ("MCR", "MCR_SECTION"),
    ])
    def test_matches(self, code: str, expected: str) -> None:
        assert match_device_type(code, TYPES) == expected

    @pytest.mark.parametrize("code", [
        # Two Types in one code is a question for a person. (`VCB_MFM` is not:
        # the prefix rule, unchanged since before tokens, answers VCB first.)
        "FEEDER_VCB_MFM",
        # `M` could be MFM, MCR_SECTION or MODULE_TRACKER.
        "M",
        "WEATHER",
    ])
    def test_ambiguity_is_a_question_not_a_default(self, code: str) -> None:
        assert match_device_type(code, TYPES) is None

    def test_a_type_inside_a_word_does_not_match(self) -> None:
        # `UPS` inside `GROUPS` is not an Uninterruptible Power Supply.
        assert match_device_type("GROUPS_PANEL", TYPES) is None


class TestPvStringAliases:
    def test_every_string_key_maps_to_its_pv_tag(self) -> None:
        for n in range(1, MAX_PV_STRINGS + 1):
            for device_type in ("INVERTER", "SMB"):
                assert alias_for(f"I{n}", device_type) == f"PV{n}_CURRENT"
                assert alias_for(f"P{n}", device_type) == f"PV{n}_ACTIVE_POWER"
                assert f"PV{n}_CURRENT" in TAG_SPECS
                assert f"PV{n}_ACTIVE_POWER" in TAG_SPECS

    @pytest.mark.parametrize("device_type", [None, "MFM", "VCB", "WMS"])
    def test_the_string_keys_are_scoped_to_the_types_that_have_strings(
        self, device_type: str | None
    ) -> None:
        # `I1` is a generic word; on a meter it must stay unmapped rather than
        # silently become a PV-string current.
        assert alias_for("I1", device_type) is None
        assert alias_for("P1", device_type) is None

    def test_the_meter_keys_they_resemble_are_untouched(self) -> None:
        assert alias_for("P", "MFM") == "AC_ACTIVE_POWER"
        assert alias_for("IR", "INVERTER") == "AC_CURRENT_R"
