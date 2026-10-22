"""A refused reading is shown, marked, and never used (Guardrail 33).

Found on UNIT1 on 22 Oct 2026: its Inverter sends an efficiency of -1 for "not
available". The reading was stored flagged — correctly — and then used anyway:
ingest wrote every reading into the live values whatever its quality, so the
dashboard showed -1.00 % as a reading, and the formula `AC_ACTIVE_POWER /
(INVERTER_EFFICIENCY / 100)` picked the -1 up from the standing values and
put DC Power at -49,410 kW on the Plant's schematic. Pure tests: no Redis, no
database.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from solarcms.cache.live import parse_device_hash
from solarcms.domain.assumptions import (
    QUALITY_GOOD,
    QUALITY_OUT_OF_RANGE,
    QUALITY_UNPARSEABLE,
)
from solarcms.domain.decoding import (
    DerivedBinding,
    DeviceResolution,
    TagBinding,
    current_state,
    decode,
)
from solarcms.domain.slots import (
    KIND_DEVICE_TAG,
    UNDEFINED_NO_VALUE,
    DeviceFacts,
    PlantFacts,
    RejectedReading,
    SlotCandidate,
    SlotSpec,
    resolve_slot,
)

NOW = datetime(2026, 10, 22, 6, 0, tzinfo=UTC)
TOPIC = "SCMS/V1/ISPL/UNIT1/MCR/INVERTER1"

PAC = TagBinding(source_key="PAC", tag_id=1, tag_code="AC_ACTIVE_POWER",
                 valid_min=-5000.0, valid_max=5000.0)
EFF = TagBinding(source_key="EFF", tag_id=2, tag_code="INVERTER_EFFICIENCY",
                 valid_min=0.0, valid_max=100.0)
DC_POWER = DerivedBinding(tag_id=3, tag_code="DC_POWER",
                          expression="AC_ACTIVE_POWER / (INVERTER_EFFICIENCY / 100)",
                          valid_min=0.0, valid_max=5000.0)
# A formula over another calculated Tag, so a withdrawal has to follow the chain.
DC_POWER_MW = DerivedBinding(tag_id=4, tag_code="DC_POWER_MW", expression="DC_POWER / 1000")

INVERTER = DeviceResolution(
    device_id=81, client_id=5, plant_id=5, expected_interval_s=30,
    bindings={"PAC": PAC, "EFF": EFF}, derived=(DC_POWER, DC_POWER_MW),
)


# ── A calculation never uses a refused input ────────────────────────────────


def test_a_refused_efficiency_calculates_no_dc_power() -> None:
    result = decode(TOPIC, {"PAC": "498.8", "EFF": "-1"}, INVERTER, NOW)
    by_code = {r.tag_code: r for r in result.readings}
    assert by_code["INVERTER_EFFICIENCY"].quality == QUALITY_OUT_OF_RANGE
    assert "DC_POWER" not in by_code, "-49,880 kW is our arithmetic, not a reading"
    assert result.unresolved_derived[DC_POWER.tag_id] == "INVERTER_EFFICIENCY"


def test_nor_an_efficiency_it_had_before_the_refusal() -> None:
    # The message's own -1 is refused; the 98.5 standing from an earlier message
    # is not the Inverter's efficiency now, and must not stand in for it.
    result = decode(TOPIC, {"PAC": "498.8", "EFF": "-1"}, INVERTER, NOW,
                    standing={"INVERTER_EFFICIENCY": 98.5})
    assert "DC_POWER" not in {r.tag_code for r in result.readings}


def test_a_formula_over_a_withdrawn_tag_is_withdrawn_for_the_same_reason() -> None:
    result = decode(TOPIC, {"PAC": "498.8", "EFF": "-1"}, INVERTER, NOW)
    assert result.unresolved_derived[DC_POWER_MW.tag_id] == "INVERTER_EFFICIENCY"


def test_an_undefined_formula_is_withdrawn_without_blaming_anything() -> None:
    # Efficiency 0 at night: DC Power is unknown, not zero, and its afternoon
    # value must stop standing — but nothing was refused.
    result = decode(TOPIC, {"PAC": "0", "EFF": "0"}, INVERTER, NOW)
    assert result.unresolved_derived[DC_POWER.tag_id] is None


def test_a_message_that_carries_no_input_leaves_the_formula_alone() -> None:
    # An Inverter's strings arrive on a topic of their own; a message there says
    # nothing about DC Power and must not withdraw it.
    strings = DeviceResolution(
        device_id=81, client_id=5, plant_id=5, expected_interval_s=30,
        bindings={"PAC": PAC, "EFF": EFF,
                  "I1": TagBinding(source_key="I1", tag_id=9, tag_code="PV1_CURRENT")},
        derived=(DC_POWER,),
    )
    result = decode(TOPIC + "_STRING16", {"I1": "8.1"}, strings, NOW)
    assert result.unresolved_derived == {}


def test_good_inputs_still_calculate() -> None:
    result = decode(TOPIC, {"PAC": "490", "EFF": "98"}, INVERTER, NOW)
    by_code = {r.tag_code: r for r in result.readings}
    assert by_code["DC_POWER"].value == pytest.approx(500.0)
    assert by_code["DC_POWER"].quality == QUALITY_GOOD
    assert result.unresolved_derived == {}


# ── What may stand as a current value ───────────────────────────────────────


def test_a_refused_reading_is_not_a_current_value_and_says_what_arrived() -> None:
    result = decode(TOPIC, {"PAC": "498.8", "EFF": "-1"}, INVERTER, NOW)
    state = current_state(result.readings, result.unresolved_derived, INVERTER)
    assert state.accepted == {PAC.tag_id: pytest.approx(498.8)}
    assert state.rejected[EFF.tag_id] == {
        "value": -1.0, "quality": QUALITY_OUT_OF_RANGE, "source_key": "EFF",
        "valid_min": 0.0, "valid_max": 100.0, "because": None,
    }
    assert state.rejected[DC_POWER.tag_id]["because"] == "INVERTER_EFFICIENCY"
    assert state.rejected[DC_POWER.tag_id]["value"] is None
    assert state.cleared == ()


def test_an_unreadable_value_did_not_arrive_as_zero() -> None:
    result = decode(TOPIC, {"PAC": "498.8", "EFF": None}, INVERTER, NOW)
    state = current_state(result.readings, result.unresolved_derived, INVERTER)
    assert state.rejected[EFF.tag_id]["quality"] == QUALITY_UNPARSEABLE
    assert state.rejected[EFF.tag_id]["value"] is None, "stored as 0.0 for the row, not sent as 0"


def test_an_undefined_calculation_is_cleared_not_rejected() -> None:
    result = decode(TOPIC, {"PAC": "0", "EFF": "0"}, INVERTER, NOW)
    state = current_state(result.readings, result.unresolved_derived, INVERTER)
    assert DC_POWER.tag_id in state.cleared
    assert DC_POWER.tag_id not in state.rejected


def test_the_live_hash_keeps_values_and_refusals_apart() -> None:
    values, rejected = parse_device_hash({
        "1": "498.8", "_ts": "2026-10-22T06:00:00+00:00",
        "_rejected:2": '{"value": -1.0, "quality": 1, "source_key": "EFF"}',
        "_rejected:3": "not json", "x": "1.0", "5": "nan-ish",
    })
    assert values == {1: pytest.approx(498.8)}
    assert rejected == {2: {"value": -1.0, "quality": 1, "source_key": "EFF"}}


# ── A slot shows what it could not use, and never uses it ───────────────────


def _inverter(code: str, power: float | None, refused: float | None = None) -> DeviceFacts:
    return DeviceFacts(
        device_id=abs(hash(code)) % 10_000, code=code, device_type_code="INVERTER",
        bound_tag_codes=frozenset({"AC_ACTIVE_POWER"}),
        values={} if power is None else {"AC_ACTIVE_POWER": power},
        rejected={} if refused is None else {"AC_ACTIVE_POWER": RejectedReading(
            device_id=abs(hash(code)) % 10_000, device_code=code,
            tag_code="AC_ACTIVE_POWER", value=refused, quality=QUALITY_OUT_OF_RANGE,
            source_key="PAC", valid_min=-5000.0, valid_max=5000.0,
        )},
        online=True, in_power_path=True,
    )


INVERTER_POWER = SlotSpec(
    code="sld.inv.ac_power", label="AC Power", panel="sld.INVERTERS", position=1,
    unit_hint="kW",
    candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "INVERTER", "AC_ACTIVE_POWER", "sum"),),
)


def test_a_sum_leaves_a_refused_device_out_and_says_so() -> None:
    facts = PlantFacts(plant_id=1, devices=(
        _inverter("INV-01", 200.0), _inverter("INV-02", 210.0),
        _inverter("INV-03", None, refused=99999.0),
    ))
    resolved = resolve_slot(INVERTER_POWER, facts)
    assert resolved.value == pytest.approx(410.0)
    assert resolved.source is not None and resolved.source.device_count == 2
    assert [r.device_code for r in resolved.rejected] == ["INV-03"]


def test_a_slot_with_only_refused_values_is_blank_and_names_them() -> None:
    facts = PlantFacts(plant_id=1, devices=(_inverter("INV-01", None, refused=-49410.0),))
    resolved = resolve_slot(INVERTER_POWER, facts)
    assert resolved.value is None
    # Unchanged, so a screen that has not learned `rejected` still parses it.
    assert resolved.undefined_reason == UNDEFINED_NO_VALUE
    assert resolved.rejected[0].value == -49410.0
    assert resolved.source is not None and resolved.source.device_type_code == "INVERTER"


def test_a_fallback_past_a_refused_source_carries_the_refusal() -> None:
    irradiance = SlotSpec(
        code="env.irradiance", label="Irradiance", panel="environment", position=1,
        unit_hint="W/m2",
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "WMS", "GTI", "avg"),
                    SlotCandidate(KIND_DEVICE_TAG, 2, "WMS", "GHI", "avg")),
    )
    station = DeviceFacts(
        device_id=7, code="WMS", device_type_code="WMS",
        bound_tag_codes=frozenset({"GTI", "GHI"}), values={"GHI": 584.4},
        rejected={"GTI": RejectedReading(device_id=7, device_code="WMS", tag_code="GTI",
                                         value=5844.0, quality=QUALITY_OUT_OF_RANGE)},
    )
    resolved = resolve_slot(irradiance, PlantFacts(plant_id=1, devices=(station,)))
    assert resolved.value == pytest.approx(584.4)
    assert resolved.source is not None and resolved.source.degraded is True
    assert [r.tag_code for r in resolved.rejected] == ["GTI"]


def test_first_names_only_a_refusal_that_would_have_been_chosen() -> None:
    first = SlotSpec(
        code="sld.grid.voltage", label="Grid Voltage", panel="sld.GRID", position=1,
        unit_hint="kV",
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "INVERTER", "AC_ACTIVE_POWER", "first"),),
    )
    facts = PlantFacts(plant_id=1, devices=(
        _inverter("INV-01", 200.0), _inverter("INV-02", None, refused=1e9),
    ))
    resolved = resolve_slot(first, facts)
    assert resolved.value == 200.0
    assert resolved.rejected == (), "INV-02 was never going to be the figure"
