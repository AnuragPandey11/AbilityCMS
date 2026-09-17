"""Slot resolution and the four-stage SLD.

Pure `domain/` tests — no database, no Redis, no broker. These cover the layer
that decides *which Device answers a tile*, which is the part of the dashboard
most likely to be wrong quietly: a tile that silently sums inverter-side and
feeder-side meters shows a plausible number that is twice the truth, and nothing
downstream can detect it.

Two Plants recur, because they are the two shapes the mechanism exists to cover:
a bare rooftop Plant that publishes four Inverters and nothing else, and an 8 MW
Plant with a settlement meter, transformers, an MCR section and a weather
station.
"""

from __future__ import annotations

import pytest

from solarcms.domain.dashboard_spec import DEFAULT_SLOTS, SLD_STAGE_SLOTS
from solarcms.domain.dashboard_spec import validate as validate_spec
from solarcms.domain.sld_stages import (
    DEFAULT_STAGE_BY_DEVICE_TYPE,
    SLD_STAGES,
    build_stages,
)
from solarcms.domain.slots import (
    KIND_DEVICE_COUNT,
    KIND_DEVICE_TAG,
    KIND_PLANT_ATTRIBUTE,
    UNDEFINED_NO_CANDIDATES,
    UNDEFINED_NO_SOURCE,
    UNDEFINED_NO_VALUE,
    DeviceFacts,
    PlantFacts,
    SlotCandidate,
    SlotSpec,
    resolve_all,
    resolve_slot,
)


def inverter(code: str, power: float | None, *, online: bool = True) -> DeviceFacts:
    return DeviceFacts(
        device_id=abs(hash(code)) % 10_000, code=code, device_type_code="INVERTER",
        bound_tag_codes=frozenset({"AC_ACTIVE_POWER", "DC_VOLTAGE"}),
        values={} if power is None else {"AC_ACTIVE_POWER": power, "DC_VOLTAGE": 800.0},
        online=online, in_power_path=True,
    )


def meter(code: str, power: float | None, type_code: str = "ABT_METER") -> DeviceFacts:
    return DeviceFacts(
        device_id=abs(hash(code)) % 10_000, code=code, device_type_code=type_code,
        bound_tag_codes=frozenset({"AC_ACTIVE_POWER"}),
        values={} if power is None else {"AC_ACTIVE_POWER": power},
        online=power is not None, in_power_path=True,
    )


CURRENT_POWER = SlotSpec(
    code="kpi.current_power", label="Current Power", panel="kpi_row", position=1,
    unit_hint="kW", hide_when_unresolved=False,
    candidates=(
        SlotCandidate(KIND_DEVICE_TAG, 1, "ABT_METER", "AC_ACTIVE_POWER", "first"),
        SlotCandidate(KIND_DEVICE_TAG, 2, "MFM", "AC_ACTIVE_POWER", "first"),
        SlotCandidate(KIND_DEVICE_TAG, 3, "INVERTER", "AC_ACTIVE_POWER", "sum"),
    ),
)


# ════════════════════════════════════════════════════════════════════════════
# Precedence: the same slot, answered differently by differently-wired Plants.
# ════════════════════════════════════════════════════════════════════════════


def test_settlement_meter_outranks_the_inverters() -> None:
    """A published measurement beats a computed sum, even when they disagree.

    The meter reads less than the Inverters claim — transformer and cable losses
    are real — and the meter is still the right answer.
    """
    facts = PlantFacts(plant_id=1, devices=(
        meter("ABT-01", 980.0),
        inverter("INV-01", 250.0), inverter("INV-02", 250.0),
        inverter("INV-03", 250.0), inverter("INV-04", 250.0),
    ))
    resolved = resolve_slot(CURRENT_POWER, facts)
    assert resolved.value == 980.0
    assert resolved.source is not None
    assert resolved.source.device_type_code == "ABT_METER"
    assert resolved.source.degraded is False


def test_a_rooftop_plant_with_no_meter_sums_its_inverters() -> None:
    """The same slot, no code change, a different source. This is the whole point."""
    facts = PlantFacts(plant_id=2, devices=(
        inverter("INV-01", 60.2), inverter("INV-02", 58.1),
        inverter("INV-03", 59.3), inverter("INV-04", 57.8),
    ))
    resolved = resolve_slot(CURRENT_POWER, facts)
    assert resolved.value == pytest.approx(235.4)
    assert resolved.source is not None
    assert resolved.source.device_type_code == "INVERTER"
    assert resolved.source.device_count == 4
    assert resolved.source.is_aggregated is True


def test_a_bound_but_silent_meter_falls_through_and_is_flagged_degraded() -> None:
    """The operational panel must show something when the settlement meter goes quiet.

    But it must not pretend the number came from the meter — the fallback is
    marked, so the screen can say so.
    """
    facts = PlantFacts(plant_id=3, devices=(
        meter("ABT-01", None),
        inverter("INV-01", 100.0), inverter("INV-02", 100.0),
    ))
    resolved = resolve_slot(CURRENT_POWER, facts)
    assert resolved.value == 200.0
    assert resolved.source is not None
    assert resolved.source.device_type_code == "INVERTER"
    assert resolved.source.degraded is True


def test_a_slot_that_refuses_to_fall_back_reports_the_silence_instead() -> None:
    """I-8's posture, available per slot: a settlement figure has no substitute."""
    strict = SlotSpec(
        code="energy.settlement", label="Settlement Energy", panel="kpi_row",
        position=2, fallback_when_silent=False,
        candidates=CURRENT_POWER.candidates,
    )
    facts = PlantFacts(plant_id=4, devices=(meter("ABT-01", None), inverter("INV-01", 100.0)))
    resolved = resolve_slot(strict, facts)
    assert resolved.value is None
    assert resolved.undefined_reason == UNDEFINED_NO_VALUE
    # The planned source is still named: "no reading from the ABT Meter" is
    # actionable where a bare blank is not.
    assert resolved.source is not None
    assert resolved.source.device_type_code == "ABT_METER"


# ════════════════════════════════════════════════════════════════════════════
# Undefined is not zero, and the three ways of being undefined differ.
# ════════════════════════════════════════════════════════════════════════════


def test_no_bound_source_is_no_source_not_zero() -> None:
    """A PR of zero and an unknown PR mean opposite things (domain/derived.py)."""
    irradiance = SlotSpec(
        code="env.irradiance", label="Irradiance", panel="environment", position=1,
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "WMS", "GTI", "avg"),),
    )
    facts = PlantFacts(plant_id=5, devices=(inverter("INV-01", 100.0),))
    resolved = resolve_slot(irradiance, facts)
    assert resolved.value is None
    assert resolved.undefined_reason == UNDEFINED_NO_SOURCE
    # Hidden rather than blank: a Plant with no weather station is normal, and a
    # permanent dash teaches operators to ignore dashes.
    assert resolved.hidden is True


def test_a_headline_tile_shows_an_honest_dash_rather_than_disappearing() -> None:
    facts = PlantFacts(plant_id=6, devices=())
    resolved = resolve_slot(CURRENT_POWER, facts)
    assert resolved.value is None
    assert resolved.undefined_reason == UNDEFINED_NO_SOURCE
    assert resolved.hidden is False


def test_a_silent_source_is_never_hidden() -> None:
    """The one condition the screen must not conceal: an instrument that stopped."""
    strict = SlotSpec(
        code="kpi.only_meter", label="Meter", panel="kpi_row", position=3,
        hide_when_unresolved=True, fallback_when_silent=False,
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "ABT_METER", "AC_ACTIVE_POWER"),),
    )
    facts = PlantFacts(plant_id=7, devices=(meter("ABT-01", None),))
    resolved = resolve_slot(strict, facts)
    assert resolved.undefined_reason == UNDEFINED_NO_VALUE
    assert resolved.hidden is False


def test_a_slot_with_no_candidates_says_so() -> None:
    empty = SlotSpec(code="kpi.empty", label="Empty", panel="kpi_row", position=4)
    resolved = resolve_slot(empty, PlantFacts(plant_id=8))
    assert resolved.undefined_reason == UNDEFINED_NO_CANDIDATES


# ════════════════════════════════════════════════════════════════════════════
# Aggregation. Summing an intensive quantity is the error that looks plausible.
# ════════════════════════════════════════════════════════════════════════════


def test_voltage_is_averaged_and_power_is_summed() -> None:
    facts = PlantFacts(plant_id=9, devices=(
        inverter("INV-01", 100.0), inverter("INV-02", 200.0),
    ))
    power = resolve_slot(SlotSpec(
        code="p", label="P", panel="kpi_row", position=1,
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "INVERTER", "AC_ACTIVE_POWER", "sum"),),
    ), facts)
    voltage = resolve_slot(SlotSpec(
        code="v", label="V", panel="kpi_row", position=2,
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "INVERTER", "DC_VOLTAGE", "avg"),),
    ), facts)
    assert power.value == 300.0
    assert voltage.value == 800.0  # not 1600 — two machines at one bus voltage


def test_a_device_reporting_nothing_does_not_drag_an_average_toward_zero() -> None:
    """Contributors are the Devices with a value, not every Device of the Type."""
    facts = PlantFacts(plant_id=10, devices=(
        inverter("INV-01", 100.0), inverter("INV-02", None),
    ))
    resolved = resolve_slot(SlotSpec(
        code="p", label="P", panel="kpi_row", position=1,
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "INVERTER", "AC_ACTIVE_POWER", "avg"),),
    ), facts)
    assert resolved.value == 100.0
    assert resolved.source is not None
    assert resolved.source.device_count == 1


def test_counting_devices_yields_a_real_zero() -> None:
    """"0 Inverters online" is information, not a missing reading."""
    facts = PlantFacts(plant_id=11, devices=(
        inverter("INV-01", None, online=False), inverter("INV-02", None, online=False),
    ))
    total = resolve_slot(SlotSpec(
        code="n", label="Inverters", panel="plant_status", position=1,
        candidates=(SlotCandidate(KIND_DEVICE_COUNT, 1, "INVERTER", aggregate="count"),),
    ), facts)
    online = resolve_slot(SlotSpec(
        code="n_on", label="Online", panel="plant_status", position=2,
        candidates=(SlotCandidate(
            KIND_DEVICE_COUNT, 1, "INVERTER", aggregate="count", online_only=True
        ),),
    ), facts)
    assert total.value == 2.0
    assert online.value == 0.0
    assert online.undefined_reason is None


def test_a_plant_attribute_answers_with_every_link_down() -> None:
    capacity = SlotSpec(
        code="kpi.capacity", label="Capacity", panel="kpi_row", position=1,
        candidates=(SlotCandidate(KIND_PLANT_ATTRIBUTE, 1, plant_attribute="dc_capacity_kwp"),),
    )
    facts = PlantFacts(plant_id=12, devices=(), attributes={"dc_capacity_kwp": 8000.0})
    assert resolve_slot(capacity, facts).value == 8000.0
    blank = PlantFacts(plant_id=13, attributes={"dc_capacity_kwp": None})
    assert resolve_slot(capacity, blank).undefined_reason == UNDEFINED_NO_SOURCE


def test_first_is_stable_across_reorderings_of_the_device_list() -> None:
    """A tile whose value jumps between two meters between refreshes is unreadable."""
    a, b = meter("MFM-02", 500.0, "MFM"), meter("MFM-01", 400.0, "MFM")
    spec = SlotSpec(
        code="m", label="M", panel="kpi_row", position=1,
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "MFM", "AC_ACTIVE_POWER", "first"),),
    )
    assert resolve_slot(spec, PlantFacts(plant_id=14, devices=(a, b))).value == 400.0
    assert resolve_slot(spec, PlantFacts(plant_id=14, devices=(b, a))).value == 400.0


def test_the_unit_follows_the_candidate_that_answered() -> None:
    """A slot that fell back from a meter in kV to an Inverter in V is not mislabelled."""
    spec = SlotSpec(
        code="v", label="Voltage", panel="kpi_row", position=1, unit_hint="kV",
        candidates=(SlotCandidate(KIND_DEVICE_TAG, 1, "INVERTER", "DC_VOLTAGE", "avg"),),
    )
    facts = PlantFacts(plant_id=15, devices=(inverter("INV-01", 100.0),))
    [resolved] = resolve_all([spec], facts, {"DC_VOLTAGE": "V"})
    assert resolved.unit == "V"


# ════════════════════════════════════════════════════════════════════════════
# The four-stage SLD.
# ════════════════════════════════════════════════════════════════════════════


def test_all_four_stages_render_in_order_on_an_empty_plant() -> None:
    """A Plant nobody has wired still produces the same diagram shape."""
    stages = build_stages(PlantFacts(plant_id=16), SLD_STAGE_SLOTS)
    assert [s.code for s in stages.stages] == list(SLD_STAGES)
    assert all(s.instrumented is False for s in stages.stages)
    assert all(s.health == "unmonitored" for s in stages.stages)


def test_a_rooftop_plant_with_no_transformer_still_shows_the_transformer_stage() -> None:
    facts = PlantFacts(plant_id=17, devices=(
        inverter("INV-01", 60.0), inverter("INV-02", 60.0), meter("MFM-01", 118.0, "MFM"),
    ))
    stages = build_stages(facts, SLD_STAGE_SLOTS)
    by_code = {s.code: s for s in stages.stages}
    assert by_code["TRANSFORMER"].instrumented is False
    assert by_code["INVERTERS"].device_count == 2
    assert by_code["GRID"].device_count == 1


def test_devices_fold_into_the_stage_their_type_belongs_to() -> None:
    def device(code: str, type_code: str) -> DeviceFacts:
        return DeviceFacts(
            device_id=abs(hash(code)) % 10_000, code=code,
            device_type_code=type_code, online=True, in_power_path=True,
        )

    facts = PlantFacts(plant_id=18, devices=(
        device("SMB-01", "SMB"), device("DCDB-01", "DCDB"),
        device("INV-01", "INVERTER"), device("ACDB-01", "ACDB"),
        device("TX-01", "TRANSFORMER"), device("VCB-01", "VCB"),
        device("MCR-01", "MCR_SECTION"), device("ABT-01", "ABT_METER"),
    ))
    by_code = {s.code: s for s in build_stages(facts, SLD_STAGE_SLOTS).stages}
    assert {d.code for d in by_code["PV_ARRAY"].devices} == {"SMB-01", "DCDB-01"}
    assert {d.code for d in by_code["INVERTERS"].devices} == {"INV-01", "ACDB-01"}
    assert {d.code for d in by_code["TRANSFORMER"].devices} == {"TX-01", "VCB-01"}
    assert {d.code for d in by_code["GRID"].devices} == {"MCR-01", "ABT-01"}


def test_a_stage_metric_cannot_reach_a_device_in_another_stage() -> None:
    """Each stage resolves against only its own Devices.

    The Grid stage's export power must not quietly answer from the Inverters
    sitting one stage upstream — that is precisely the confusion between
    generation and export the panel exists to show.
    """
    facts = PlantFacts(plant_id=19, devices=(
        inverter("INV-01", 500.0), inverter("INV-02", 500.0),
    ))
    by_code = {s.code: s for s in build_stages(facts, SLD_STAGE_SLOTS).stages}
    inverter_power = {s.slot_code: s.value for s in by_code["INVERTERS"].slots}
    assert inverter_power["sld.inv.ac_power"] == 1000.0
    grid = {s.slot_code: s for s in by_code["GRID"].slots}
    assert grid["sld.grid.export_power"].value is None


def test_partial_loss_is_degraded_and_total_loss_is_down() -> None:
    """Eleven of twelve Inverters running is not an outage."""
    partial = PlantFacts(plant_id=20, devices=(
        inverter("INV-01", 100.0), inverter("INV-02", None, online=False),
    ))
    dead = PlantFacts(plant_id=21, devices=(
        inverter("INV-01", None, online=False), inverter("INV-02", None, online=False),
    ))
    assert _stage(partial, "INVERTERS").health == "degraded"
    assert _stage(dead, "INVERTERS").health == "down"


def test_a_weather_station_is_excluded_silently_and_a_staged_gap_is_reported() -> None:
    """Absence by design is not a gap; absence by oversight is."""
    wms = DeviceFacts(
        device_id=1, code="WMS-01", device_type_code="WMS", online=True, in_power_path=False
    )
    unknown = DeviceFacts(
        device_id=2, code="SWG-01", device_type_code="NEW_SWITCHGEAR",
        online=True, in_power_path=True,
    )
    stages = build_stages(PlantFacts(plant_id=22, devices=(wms, unknown)), SLD_STAGE_SLOTS)
    assert [d.code for d in stages.unstaged] == ["SWG-01"]


def _stage(facts: PlantFacts, code: str):  # type: ignore[no-untyped-def]
    return next(s for s in build_stages(facts, SLD_STAGE_SLOTS).stages if s.code == code)


# ════════════════════════════════════════════════════════════════════════════
# The shipped catalogue itself.
# ════════════════════════════════════════════════════════════════════════════


def test_the_default_catalogue_validates() -> None:
    validate_spec()


def test_every_staged_device_type_is_one_of_the_four() -> None:
    assert set(DEFAULT_STAGE_BY_DEVICE_TYPE.values()) <= set(SLD_STAGES)


def test_no_slot_is_named_after_a_client_plant_or_device() -> None:
    """Guardrail 2, asserted rather than trusted.

    Every code is `panel.name`, and every candidate names a Device *Type*. A slot
    that ever acquires a customer's name in it fails here.
    """
    for spec in DEFAULT_SLOTS:
        assert "." in spec.code, spec.code
        assert spec.code.islower() or spec.code.replace(".", "").isalnum()
        for candidate in spec.candidates:
            assert candidate.device_type_code is None or candidate.device_type_code.isupper()


def test_the_headline_row_is_answerable_by_a_bare_inverter_only_plant() -> None:
    """The test each headline tile has to pass to be in the headline row.

    Current power and today's energy must resolve for a Plant whose entire
    instrumentation is four Inverters, or the fixed layout is a fiction.
    """
    facts = PlantFacts(
        plant_id=23,
        devices=tuple(
            DeviceFacts(
                device_id=i, code=f"INV-0{i}", device_type_code="INVERTER",
                bound_tag_codes=frozenset({"AC_ACTIVE_POWER", "ENERGY_TODAY"}),
                values={"AC_ACTIVE_POWER": 60.0, "ENERGY_TODAY": 300.0},
                online=True, in_power_path=True,
            )
            for i in range(1, 5)
        ),
        attributes={"dc_capacity_kwp": 250.0},
    )
    by_code = {s.slot_code: s for s in resolve_all(list(DEFAULT_SLOTS), facts)}
    assert by_code["kpi.current_power"].value == 240.0
    assert by_code["kpi.energy_today"].value == 1200.0
    assert by_code["kpi.plant_capacity"].value == 250.0
