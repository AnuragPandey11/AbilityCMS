"""The assumptions module is the single point of change for every unknown.

These tests guard that property. They fail when a placeholder escapes, when a
seed points at a Tag that does not exist, or when a Guardrail encoded as data is
quietly broken — all of which are otherwise invisible until production.
"""

from __future__ import annotations

from solarcms.domain import assumptions as a


class TestTagRegistry:
    def test_every_alias_resolves_to_a_defined_tag(self) -> None:
        unknown = {k: v for k, v in a.SOURCE_KEY_ALIASES.items() if v not in a.TAG_SPECS}
        assert unknown == {}

    def test_every_rule_seed_references_a_defined_tag(self) -> None:
        unknown = [
            s.code for s in a.ALL_ALARM_RULE_SEEDS
            if s.tag_code is not None and s.tag_code not in a.TAG_SPECS
        ]
        assert unknown == []

    def test_cumulative_tags_never_average(self) -> None:
        # Averaging a cumulative counter is meaningless (MASTER §3.5).
        offenders = [
            code for code, spec in a.TAG_SPECS.items()
            if spec.cumulative and spec.rollup_method == "avg"
        ]
        assert offenders == []

    def test_valid_ranges_are_ordered(self) -> None:
        offenders = [c for c, s in a.TAG_SPECS.items() if s.valid_min > s.valid_max]
        assert offenders == []


class TestDigitalInputs:
    def test_every_digital_input_is_a_status_tag_that_takes_the_last_value(self) -> None:
        for code, spec in a.DIGITAL_INPUT_TAGS.items():
            assert spec.category == "status", code
            assert spec.rollup_method == "last", code
            assert (spec.valid_min, spec.valid_max) == (0.0, 1.0), code

    def test_status_tags_are_never_throttled(self) -> None:
        # Guardrail 11. A 60s throttle would discard a trip contact that opened
        # and re-closed inside the window — the most important event a Device
        # will ever report. Enforced in the schema by 0009 as well.
        assert a.MIN_INTERVAL_S_BY_CATEGORY["status"] == 0

    def test_state_rules_carry_no_threshold(self) -> None:
        # A threshold on is_true/is_false is a contradiction; there is nothing to
        # compare. Also enforced by a CHECK constraint in migration 0009.
        for seed in a.DIGITAL_INPUT_RULE_SEEDS:
            assert seed.operator in ("is_true", "is_false"), seed.code
            assert seed.threshold is None and seed.threshold_high is None, seed.code

    def test_protection_trips_are_not_debounced(self) -> None:
        # Delaying a Buchholz trip to be sure would be indefensible.
        #
        # Matched on the code suffix only. "VCB Trip Coil Unhealthy" contains the
        # word trip but is a *health* contact — a momentary flicker there is not
        # a fault, so it is debounced 60s on purpose.
        trips = [s for s in a.DIGITAL_INPUT_RULE_SEEDS if s.code.endswith("_TRIP")]
        assert len(trips) >= 5, "expected the transformer and VCB trip contacts"
        for seed in trips:
            assert seed.duration_s == 0, seed.code

    def test_health_contacts_are_debounced(self) -> None:
        # The converse: a health signal must NOT fire on a single flicker.
        health = {s.code: s for s in a.DIGITAL_INPUT_RULE_SEEDS}
        assert health["VCB_TC_UNHEALTHY"].duration_s > 0
        assert health["VCB_RELAY_UNHEALTHY"].duration_s > 0


class TestClientSuppliedUnits:
    def test_mfm_voltage_thresholds_are_in_kilovolts(self) -> None:
        # The correction that mattered: 440 V and 380 V were wrong by 1000x
        # against an 11 kV feeder (TAG_CATALOGUE §2.3). The broker reads 11.37.
        grid = {s.code: s for s in a.ALARM_RULE_SEEDS if s.code.startswith("GRID_VOLTAGE")}
        assert grid["GRID_VOLTAGE_HIGH"].tag_code == "HV_VOLTAGE_RY"
        assert 11.0 < grid["GRID_VOLTAGE_HIGH"].threshold < 13.0  # type: ignore[operator]
        assert 9.0 < grid["GRID_VOLTAGE_LOW"].threshold < 11.5  # type: ignore[operator]

    def test_no_transformer_rule_expects_an_analogue_temperature(self) -> None:
        # The client's Transformer publishes only DI contacts, so a threshold
        # rule against it would have no input and could never fire (OPEN-18).
        for seed in a.ALL_ALARM_RULE_SEEDS:
            if seed.scope == "TRANSFORMER":
                assert seed.operator in ("is_true", "is_false"), seed.code

    def test_instantaneous_and_cumulative_irradiance_are_distinct_tags(self) -> None:
        # Conflating W/m2 with kWh/m2 is a 1000x error, and it is the ambiguity
        # the broker's `AverageGHI` turns on (BROKER_OBSERVATIONS §4.1).
        assert a.TAG_SPECS["GHI"].unit == "W/m2"
        assert a.TAG_SPECS["GHI_CUMULATIVE"].unit == "kWh/m2"
        assert a.TAG_SPECS["GHI_CUMULATIVE"].cumulative

    def test_the_inverters_mixed_energy_units_are_preserved_not_normalised(self) -> None:
        # The client gives DAILY/MONTHLY in kWh and CUMULATIVE in MWh. Silently
        # normalising would hide a question that needs asking (T-5).
        assert a.TAG_SPECS["ENERGY_TODAY"].unit == "kWh"
        assert a.TAG_SPECS["ENERGY_MONTHLY"].unit == "kWh"
        assert a.TAG_SPECS["ENERGY_CUMULATIVE_MWH"].unit == "MWh"


class TestUnknownsStayUnknown:
    def test_counter_rollover_maximum_is_not_invented(self) -> None:
        # OPEN-14. A rollover and a meter replacement are identical in the data
        # and opposite in meaning; guessing a maximum would silently corrupt
        # energy on the day one happens.
        assert a.COUNTER_ROLLOVER_MAXIMUM is None
        assert a.NEGATIVE_DELTA_IS_SUSPECT is True
