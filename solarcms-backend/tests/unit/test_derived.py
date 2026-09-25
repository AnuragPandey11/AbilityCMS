"""Derived Tags: the whitelist, the arithmetic, and the client's own formulas.

Pure `domain/` tests — no database, no Redis, no broker. These cover the part of
the system most likely to be wrong and most expensive to be wrong quietly: a PR
that disagrees with the client's by a few points is reported as a system defect,
not as a definitional difference (BACKEND_SPEC §12.2).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solarcms.domain.assumptions import (
    DERIVED_TAG_FORMULAS,
    PLANT_START_ABOVE_KW,
    QUALITY_OUT_OF_RANGE,
    TAG_SPECS,
)
from solarcms.domain.decoding import (
    DerivedBinding,
    DeviceResolution,
    TagBinding,
    decode,
)
from solarcms.domain.derived import (
    DerivedTag,
    InvalidFormula,
    compile_formula,
    evaluate,
    evaluate_all,
    referenced_names,
)
from solarcms.services.plant_kpi import (
    OPERATING_POWER,
    PlantInputs,
    day_state_from_history,
    is_rollover_moment,
    local_hours,
    rollover_boundary,
    stateful_kpis,
)

# ── The whitelist ───────────────────────────────────────────────────────────
# A formula is typed by an administrator into a text field and stored as data.
# Everything that is not arithmetic over named values must be refused at the
# boundary, not at evaluation, where "undefined" would hide it forever.

@pytest.mark.parametrize("expression", [
    "__import__('os').system('rm -rf /')",
    "open('/etc/passwd').read()",
    "A.__class__.__bases__",
    "[x for x in range(10)]",
    "lambda: 1",
    "A if B else C",
    "A > B",
    "f'{A}'",
    "A()",
    "{'a': 1}",
])
def test_rejects_everything_that_is_not_arithmetic(expression: str) -> None:
    with pytest.raises(InvalidFormula):
        compile_formula(expression)


def test_rejects_a_dotted_aggregate_in_a_device_formula() -> None:
    # A device-scope formula reads that Device's own Tags. An aggregate over a
    # Plant has no meaning there and would silently never resolve.
    with pytest.raises(InvalidFormula):
        compile_formula("SUM.ENERGY_TODAY", scope="device")


def test_rejects_an_unknown_aggregate_prefix() -> None:
    with pytest.raises(InvalidFormula):
        compile_formula("MEDIAN.ENERGY_TODAY", scope="plant")


def test_accepts_the_aggregates_a_plant_formula_uses() -> None:
    names = referenced_names(
        "(SUM.ENERGY_TODAY / AVG.GHI_CUMULATIVE) * 100.0", scope="plant")
    assert names == {"SUM.ENERGY_TODAY", "AVG.GHI_CUMULATIVE"}


# ── The arithmetic ──────────────────────────────────────────────────────────

def test_missing_input_is_undefined_not_zero() -> None:
    # An Inverter that has not published EFFICIENCY has no DC POWER. Zero would
    # be a claim about the machine; None is the absence of one.
    assert evaluate("A / B", {"A": 10.0}) is None


def test_division_by_zero_is_undefined() -> None:
    # The normal night-time case: PR with no irradiation, DC POWER at 0%
    # efficiency. Neither is an error and neither is infinity.
    assert evaluate("A / B", {"A": 10.0, "B": 0.0}) is None


def test_published_value_beats_a_computed_one() -> None:
    """A meter that genuinely transmits AVG VOLTAGE keeps its own figure.

    This is the rule that makes derivation safe to switch on for every Device
    without a per-Device opt-in.
    """
    spec = DerivedTag("HV_VOLTAGE_AVG", "(A + B + C) / 3", "device")
    computed = evaluate_all([spec], {"A": 10.0, "B": 20.0, "C": 30.0,
                                     "HV_VOLTAGE_AVG": 99.0})
    assert computed == {}


def test_resolves_a_formula_that_depends_on_another_formula() -> None:
    first = DerivedTag("B", "A * 2", "device")
    second = DerivedTag("C", "B + 1", "device")
    # Declared out of dependency order on purpose: the caller must never have to
    # sort them, or adding a formula becomes a question about the others.
    assert evaluate_all([second, first], {"A": 5.0}) == {"B": 10.0, "C": 11.0}


def test_a_dependency_cycle_leaves_both_undefined_rather_than_hanging() -> None:
    a = DerivedTag("A", "B + 1", "device")
    b = DerivedTag("B", "A + 1", "device")
    assert evaluate_all([a, b], {}) == {}


# ── The client's own formulas (docs/TAG_CATALOGUE.md §2.15) ─────────────────

def _formula(tag_code: str) -> DerivedTag:
    expression, scope = DERIVED_TAG_FORMULAS[tag_code]
    return DerivedTag(tag_code, expression, scope)


def test_every_seeded_formula_parses_and_reads_only_known_names() -> None:
    for tag_code, (expression, scope) in DERIVED_TAG_FORMULAS.items():
        assert tag_code in TAG_SPECS, f"{tag_code} has a formula but is not a Tag"
        compile_formula(expression, scope=scope)


def test_average_voltage_is_the_mean_of_the_three_phases() -> None:
    # SUPPLIED: (VOLTAGE RY + VOLTAGE YB + VOLTAGE BR)/3
    values = {"HV_VOLTAGE_RY": 11.37, "HV_VOLTAGE_YB": 11.43, "HV_VOLTAGE_BR": 11.31}
    result = evaluate_all([_formula("HV_VOLTAGE_AVG")], values)
    assert result["HV_VOLTAGE_AVG"] == pytest.approx(11.37, abs=1e-9)


def test_total_current_is_the_sum_of_the_three_phases() -> None:
    # SUPPLIED: ( R PHASE CURRENT + Y PHASE CURRENT + B PHASE CURRENT )
    values = {"AC_CURRENT_R": 0.3535, "AC_CURRENT_Y": 0.3741, "AC_CURRENT_B": 0.497}
    result = evaluate_all([_formula("AC_CURRENT_TOTAL")], values)
    assert result["AC_CURRENT_TOTAL"] == pytest.approx(1.2246)


def test_dc_power_divides_active_power_by_efficiency() -> None:
    # SUPPLIED: ACTIVE_POWER / (EFFICIENCY/100). DC power exceeds AC power, which
    # is the sanity check: an inverter loses energy, it does not create it.
    values = {"AC_ACTIVE_POWER": 950.0, "INVERTER_EFFICIENCY": 98.0}
    result = evaluate_all([_formula("DC_POWER")], values)
    assert result["DC_POWER"] == pytest.approx(969.387755, rel=1e-6)
    assert result["DC_POWER"] > values["AC_ACTIVE_POWER"]


def test_specific_yield_is_undefined_without_a_rated_capacity() -> None:
    # SUPPLIED: (DAILY_ENERGY / INV_CAPACITY). An Inverter registered without its
    # rated capacity has no specific yield — a gap the commissioning screen
    # reports, rather than a zero nobody questions.
    assert evaluate_all([_formula("SPECIFIC_YIELD")], {"ENERGY_TODAY": 4800.0}) == {}
    with_capacity = evaluate_all(
        [_formula("SPECIFIC_YIELD")],
        {"ENERGY_TODAY": 4800.0, "INV_CAPACITY": 1000.0},
    )
    assert with_capacity["SPECIFIC_YIELD"] == pytest.approx(4.8)


def test_performance_ratio_reproduces_the_figure_the_client_publishes() -> None:
    """The client's PR formula against the client's own observed numbers.

    `docs/BROKER_OBSERVATIONS.md` §4.1 records the test broker publishing
    PerformanceRatio 87.105 alongside TodayExport 26,913.12 kWh and AverageGHI
    5.517 kWh/m², against a Plant inferred at ~5,600 kWp. Feeding their inputs
    into their formula must reproduce their output — which is the one check that
    says the transcription is right rather than merely plausible.

    ⚠ This is deliberately NOT `formulas.performance_ratio`, which is the IEC
    61724 definition over POA irradiance and returns a fraction. Both exist so
    the two can be compared instead of conflated (OPEN-16).
    """
    values = {
        "PLANT_ENERGY_TODAY": 26913.12,
        "AVG.GHI_CUMULATIVE": 5.517306,
        "DC_CAPACITY": 5600.0,
    }
    result = evaluate_all([_formula("PERFORMANCE_RATIO")], values)
    assert result["PERFORMANCE_RATIO"] == pytest.approx(87.105, abs=0.05)


def test_performance_ratio_is_undefined_at_night() -> None:
    # No irradiation means PR is not computable. Reporting 0 would drag every
    # daily average down with a number that describes darkness, not the Plant.
    values = {"PLANT_ENERGY_TODAY": 0.0, "AVG.GHI_CUMULATIVE": 0.0,
              "DC_CAPACITY": 5600.0}
    assert evaluate_all([_formula("PERFORMANCE_RATIO")], values) == {}


# ── Plant KPIs that are comparisons rather than arithmetic ──────────────────

def _inputs(power: float | None, operating: float | None = None) -> PlantInputs:
    values = {} if power is None else {"PLANT_ACTIVE_POWER": power}
    if operating is not None:
        values[OPERATING_POWER] = operating
    return PlantInputs(plant_id=1, client_id=1, kpi_device_id=9,
                       timezone="Asia/Kolkata", values=values)


def test_peak_power_records_a_new_high_with_the_time_it_happened() -> None:
    at = datetime(2026, 9, 16, 6, 15, tzinfo=UTC)  # 11:45 in Asia/Kolkata
    result, _ = stateful_kpis(_inputs(4200.0), {"TODAY_PEAK_POWER": 3100.0}, at)
    assert result["TODAY_PEAK_POWER"] == 4200.0
    assert result["TODAY_PEAK_POWER_TIME"] == pytest.approx(11.75)


def test_peak_power_is_not_rewritten_by_a_lower_reading() -> None:
    at = datetime(2026, 9, 16, 9, 0, tzinfo=UTC)
    result, _ = stateful_kpis(_inputs(2000.0), {"TODAY_PEAK_POWER": 4200.0}, at)
    assert "TODAY_PEAK_POWER" not in result


def test_plant_start_time_is_the_first_crossing_of_the_threshold() -> None:
    at = datetime(2026, 9, 16, 1, 30, tzinfo=UTC)  # 07:00 local
    first, _ = stateful_kpis(_inputs(None, PLANT_START_ABOVE_KW + 0.1), {}, at)
    assert first["PLANT_START_TIME"] == pytest.approx(7.0)

    # An hour later it is still running: the morning must not be rewritten.
    later = datetime(2026, 9, 16, 2, 30, tzinfo=UTC)
    again, _ = stateful_kpis(_inputs(None, 3000.0), {"PLANT_START_TIME": 7.0}, later)
    assert "PLANT_START_TIME" not in again


def test_start_and_stop_read_the_inverters_not_the_meter() -> None:
    # A meter reading 400 kW does not start a Plant whose Inverters read 0: the
    # rule is the Inverters' own output, which is what was specified.
    at = datetime(2026, 9, 16, 1, 30, tzinfo=UTC)
    result, _ = stateful_kpis(_inputs(400.0, 0.0), {}, at)
    assert "PLANT_START_TIME" not in result


def test_plant_stop_time_is_only_recorded_after_a_start() -> None:
    # Before sunrise the Plant has not started. A stop time then would name
    # midnight as the moment it shut down.
    at = datetime(2026, 9, 16, 0, 30, tzinfo=UTC)
    before, _ = stateful_kpis(_inputs(None, 0.0), {}, at)
    assert "PLANT_STOP_TIME" not in before

    evening = datetime(2026, 9, 16, 13, 0, tzinfo=UTC)  # 18:30 local
    stopped, _ = stateful_kpis(_inputs(None, 0.0), {"PLANT_START_TIME": 7.0}, evening)
    assert stopped["PLANT_STOP_TIME"] == pytest.approx(18.5)


def test_plant_stop_time_is_not_rewritten_by_every_tick_of_the_evening() -> None:
    # It used to be: every tick below the threshold after a start set it again,
    # so by the rollover it read 23:54.
    later = datetime(2026, 9, 16, 16, 0, tzinfo=UTC)  # 21:30 local
    result, cleared = stateful_kpis(
        _inputs(None, 0.0), {"PLANT_START_TIME": 7.0, "PLANT_STOP_TIME": 18.5}, later)
    assert "PLANT_STOP_TIME" not in result
    assert cleared == ()


def test_stop_needs_the_output_back_at_zero_not_merely_below_the_start() -> None:
    at = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
    dim, _ = stateful_kpis(_inputs(None, 0.3), {"PLANT_START_TIME": 7.0}, at)
    assert "PLANT_STOP_TIME" not in dim


def test_a_restart_takes_the_stop_back_and_keeps_the_morning() -> None:
    at = datetime(2026, 9, 16, 6, 0, tzinfo=UTC)  # 11:30 local, after an 11:00 trip
    result, cleared = stateful_kpis(
        _inputs(None, 850.0), {"PLANT_START_TIME": 7.0, "PLANT_STOP_TIME": 11.0}, at)
    assert "PLANT_START_TIME" not in result
    assert cleared == ("PLANT_STOP_TIME",)


def test_no_power_reading_produces_no_stateful_kpis() -> None:
    assert stateful_kpis(_inputs(None), {}, datetime.now(UTC)) == ({}, ())


# ── The day's figures, when Redis has lost them ────────────────────────────

def _at(hour: int, minute: int = 0, day: int = 25) -> datetime:
    return datetime(2026, 9, day, hour, minute, tzinfo=UTC)


def test_day_state_keeps_the_first_start_not_the_last() -> None:
    # Measured 24 Sep 2026: after every silence the scheduler wrote a new
    # "start". Rebuilt from history, the day's start is the first one.
    rows = [
        ("PLANT_START_TIME", _at(8, 25), 13.94),
        ("PLANT_START_TIME", _at(12, 33), 18.06),
        ("PLANT_START_TIME", _at(14, 18), 19.80),
    ]
    assert day_state_from_history(rows)["PLANT_START_TIME"] == pytest.approx(13.94)


def test_day_state_keeps_the_highest_peak_with_its_own_time() -> None:
    # A silence reset the running peak, so a later, lower value was written
    # after the real one; the day's peak is the highest ever written.
    rows = [
        ("TODAY_PEAK_POWER", _at(9, 4), 3468.3),
        ("TODAY_PEAK_POWER_TIME", _at(9, 4), 14.57),
        ("TODAY_PEAK_POWER", _at(17, 14), 1612.5),
        ("TODAY_PEAK_POWER_TIME", _at(17, 14), 22.73),
    ]
    state = day_state_from_history(rows)
    assert state["TODAY_PEAK_POWER"] == pytest.approx(3468.3)
    assert state["TODAY_PEAK_POWER_TIME"] == pytest.approx(14.57)


def test_day_state_takes_the_latest_stop() -> None:
    rows = [
        ("PLANT_START_TIME", _at(1), 7.0),
        ("PLANT_STOP_TIME", _at(5), 11.0),
        ("PLANT_STOP_TIME", _at(13), 18.5),
    ]
    assert day_state_from_history(rows)["PLANT_STOP_TIME"] == pytest.approx(18.5)


def test_an_empty_history_is_an_empty_day() -> None:
    assert day_state_from_history([]) == {}


def test_the_day_begins_at_local_2355_not_at_midnight() -> None:
    # 10:26 IST on the 25th belongs to the day that began at 23:55 IST on the
    # 24th — 18:25 UTC. One second before 23:55, it is still the day before.
    began_24th = datetime(2026, 9, 24, 18, 25, tzinfo=UTC)
    began_25th = datetime(2026, 9, 25, 18, 25, tzinfo=UTC)
    assert rollover_boundary(_at(4, 56), "Asia/Kolkata") == began_24th
    just_before = datetime(2026, 9, 25, 18, 24, 59, tzinfo=UTC)
    assert rollover_boundary(just_before, "Asia/Kolkata") == began_24th
    assert rollover_boundary(_at(18, 25), "Asia/Kolkata") == began_25th


# ── The day boundary ────────────────────────────────────────────────────────

def test_local_hours_is_hours_since_local_midnight() -> None:
    assert local_hours(datetime(2026, 9, 16, 8, 15, tzinfo=UTC), "Asia/Kolkata") == (
        pytest.approx(13.75)
    )


def test_rollover_fires_in_the_tick_containing_local_2355() -> None:
    """23:55 Plant-local, not UTC.

    A Plant in Asia/Kolkata rolls over at 18:25 UTC. Running this on the server's
    day boundary would attribute five and a half hours of generation to the wrong
    day — every day, silently.
    """
    assert is_rollover_moment(
        datetime(2026, 9, 16, 18, 25, 10, tzinfo=UTC), "Asia/Kolkata", 60)
    assert not is_rollover_moment(
        datetime(2026, 9, 16, 18, 24, 0, tzinfo=UTC), "Asia/Kolkata", 60)
    assert not is_rollover_moment(
        datetime(2026, 9, 16, 23, 55, 0, tzinfo=UTC), "Asia/Kolkata", 60)
    # The same instant is the boundary for a Plant that really is in UTC.
    assert is_rollover_moment(
        datetime(2026, 9, 16, 23, 55, 0, tzinfo=UTC), "UTC", 60)


def test_an_unreadable_timezone_falls_back_rather_than_skipping_the_plant() -> None:
    # Wrong by hours is visible and reported. Skipping the Plant's KPIs entirely
    # is not.
    assert local_hours(datetime(2026, 9, 16, 8, 15, tzinfo=UTC), "Mars/Olympus") == (
        pytest.approx(8.25)
    )


# ── Derivation inside the decode path ───────────────────────────────────────

def _binding(source_key: str, tag_id: int, tag_code: str) -> TagBinding:
    return TagBinding(source_key=source_key, tag_id=tag_id, tag_code=tag_code)


def _resolution(derived: tuple[DerivedBinding, ...]) -> DeviceResolution:
    return DeviceResolution(
        device_id=1, client_id=1, plant_id=1, expected_interval_s=3,
        bindings={
            "VoltageRY": _binding("VoltageRY", 10, "HV_VOLTAGE_RY"),
            "VoltageYB": _binding("VoltageYB", 11, "HV_VOLTAGE_YB"),
            "VoltageBR": _binding("VoltageBR", 12, "HV_VOLTAGE_BR"),
        },
        derived=derived,
    )


_AVG_VOLTAGE = DerivedBinding(
    tag_id=13, tag_code="HV_VOLTAGE_AVG",
    expression="(HV_VOLTAGE_RY + HV_VOLTAGE_YB + HV_VOLTAGE_BR) / 3",
    valid_min=0.0, valid_max=800.0,
)


def test_decode_emits_a_derived_reading_alongside_the_measured_ones() -> None:
    now = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
    payload = {"VoltageRY": "11.37", "VoltageYB": "11.43", "VoltageBR": "11.31"}
    result = decode("KULAR_GREEN/DATA", payload, _resolution((_AVG_VOLTAGE,)), now)

    by_code = {r.tag_code: r.value for r in result.readings}
    assert by_code["HV_VOLTAGE_AVG"] == pytest.approx(11.37, abs=1e-9)
    assert len(result.readings) == 4  # three measured, one computed


def test_derivation_spans_messages_using_the_standing_values() -> None:
    """The client's broker splits one instrument's signals across topics.

    Requiring every input in a single payload would mean AVG VOLTAGE never
    computed at all for the Plant that is actually publishing today.
    """
    now = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
    result = decode(
        "KULAR_GREEN/DATA", {"VoltageRY": "11.37"}, _resolution((_AVG_VOLTAGE,)), now,
        standing={"HV_VOLTAGE_YB": 11.43, "HV_VOLTAGE_BR": 11.31},
    )
    by_code = {r.tag_code: r.value for r in result.readings}
    assert by_code["HV_VOLTAGE_AVG"] == pytest.approx(11.37, abs=1e-9)


def test_a_device_with_no_formulas_derives_nothing() -> None:
    now = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
    result = decode("KULAR_GREEN/DATA", {"VoltageRY": "11.37"}, _resolution(()), now)
    assert [r.tag_code for r in result.readings] == ["HV_VOLTAGE_RY"]


def test_an_out_of_range_computed_value_is_stored_and_flagged() -> None:
    # Out-of-range values are stored and flagged, never discarded — the rule
    # applies to a value we computed exactly as to one we received.
    now = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
    payload = {"VoltageRY": "9000", "VoltageYB": "9000", "VoltageBR": "9000"}
    result = decode("KULAR_GREEN/DATA", payload, _resolution((_AVG_VOLTAGE,)), now)
    computed = next(r for r in result.readings if r.tag_code == "HV_VOLTAGE_AVG")
    assert computed.value == pytest.approx(9000.0)
    assert computed.quality == QUALITY_OUT_OF_RANGE


def test_a_derived_tag_observes_its_own_throttle() -> None:
    # Without this, a broker publishing every 2.8s produces a derived row per
    # formula per message — the throttle a Device's own Tags observe, bypassed by
    # the values we add ourselves.
    now = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
    throttled = DerivedBinding(
        tag_id=13, tag_code="HV_VOLTAGE_AVG",
        expression="(HV_VOLTAGE_RY + HV_VOLTAGE_YB + HV_VOLTAGE_BR) / 3",
        min_interval_s=60,
    )
    payload = {"VoltageRY": "11.37", "VoltageYB": "11.43", "VoltageBR": "11.31"}
    result = decode(
        "KULAR_GREEN/DATA", payload, _resolution((throttled,)), now,
        last_written={13: now - timedelta(seconds=5)},
    )
    assert "HV_VOLTAGE_AVG" not in {r.tag_code for r in result.readings}
