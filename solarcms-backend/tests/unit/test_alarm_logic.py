"""Threshold, debounce, hysteresis, DI state rules, scope resolution."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solarcms.domain.alarm_logic import (
    Action,
    AlarmRuleSpec,
    RuleState,
    evaluate,
    has_cleared,
    is_breaching,
    resolve_rules,
    should_escalate,
    underperforming_devices,
)

NOW = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)


def rule(**kw: object) -> AlarmRuleSpec:
    base: dict[str, object] = {
        "rule_id": 1, "code": "R", "tag_id": 1, "operator": "gt", "threshold": 100.0,
        "threshold_high": None, "clear_threshold": None, "duration_s": 0,
        "severity": "high",
    }
    return AlarmRuleSpec(**{**base, **kw})  # type: ignore[arg-type]


class TestOperators:
    def test_gt_and_lt(self) -> None:
        assert is_breaching(rule(operator="gt", threshold=100.0), 101.0)
        assert not is_breaching(rule(operator="gt", threshold=100.0), 100.0)
        assert is_breaching(rule(operator="lt", threshold=100.0), 99.0)

    def test_outside_and_inside_a_band(self) -> None:
        band = rule(operator="outside", threshold=49.0, threshold_high=51.0)
        assert is_breaching(band, 48.9) and is_breaching(band, 51.1)
        assert not is_breaching(band, 50.0)
        assert is_breaching(rule(operator="inside", threshold=49.0, threshold_high=51.0), 50.0)

    @pytest.mark.parametrize(("value", "expected"), [(1.0, True), (0.0, False), (0.5, True)])
    def test_is_true_reads_a_contact_not_a_number(self, value: float, expected: bool) -> None:
        # Compared against 0.5 so 1/0, true/false and a scaled 100 all read alike.
        assert is_breaching(rule(operator="is_true", threshold=None), value) is expected

    def test_is_false_fires_on_loss_of_a_healthy_signal(self) -> None:
        # VCB TC HEALTHY: the healthy state is 1, so absence of health is the fault.
        healthy = rule(operator="is_false", threshold=None)
        assert is_breaching(healthy, 0.0)
        assert not is_breaching(healthy, 1.0)

    def test_a_threshold_operator_with_no_threshold_never_fires(self) -> None:
        assert not is_breaching(rule(operator="gt", threshold=None), 1e9)


class TestHysteresis:
    def test_clears_at_clear_threshold_not_at_threshold(self) -> None:
        r = rule(operator="gt", threshold=100.0, clear_threshold=90.0)
        assert not has_cleared(r, 95.0)  # below threshold but inside the band
        assert has_cleared(r, 89.0)

    def test_without_clear_threshold_clears_at_threshold(self) -> None:
        assert has_cleared(rule(operator="gt", threshold=100.0), 99.0)

    def test_digital_input_has_no_hysteresis_band(self) -> None:
        # A contact is closed or it is not; chattering is debounce's job.
        r = rule(operator="is_true", threshold=None, clear_threshold=None)
        assert has_cleared(r, 0.0) and not has_cleared(r, 1.0)


class TestDebounce:
    def test_does_not_open_before_the_debounce_period(self) -> None:
        actions = evaluate(150.0, 0, [rule(duration_s=60)], {}, NOW)
        assert actions[0].action is Action.NO_CHANGE
        assert actions[0].next_state.first_breach_at == NOW

    def test_opens_once_the_breach_has_been_held(self) -> None:
        state = {1: RuleState(first_breach_at=NOW - timedelta(seconds=61))}
        actions = evaluate(150.0, 0, [rule(duration_s=60)], state, NOW)
        assert actions[0].action is Action.OPEN
        assert actions[0].next_state.is_open

    def test_a_non_breaching_reading_resets_the_clock(self) -> None:
        # The breach must be continuous, not cumulative across an intermittent fault.
        state = {1: RuleState(first_breach_at=NOW - timedelta(seconds=59))}
        actions = evaluate(10.0, 0, [rule(duration_s=60)], state, NOW)
        assert actions[0].next_state.first_breach_at is None

    def test_trip_contacts_open_immediately(self) -> None:
        # Debounce 0: a protection trip is not a transient to wait out.
        trip = rule(operator="is_true", threshold=None, duration_s=0, severity="critical")
        assert evaluate(1.0, 0, [trip], {}, NOW)[0].action is Action.OPEN


class TestOpenAndClear:
    def test_an_already_open_alarm_does_not_reopen(self) -> None:
        # One rule breaching continuously produces ONE Alarm, not one per Reading.
        state = {1: RuleState(first_breach_at=NOW, is_open=True)}
        assert evaluate(150.0, 0, [rule()], state, NOW)[0].action is Action.NO_CHANGE

    def test_an_open_alarm_clears_when_the_condition_goes_away(self) -> None:
        state = {1: RuleState(first_breach_at=NOW, is_open=True)}
        actions = evaluate(10.0, 0, [rule()], state, NOW)
        assert actions[0].action is Action.CLEAR
        assert not actions[0].next_state.is_open

    @pytest.mark.parametrize("quality", [1, 2, 3])
    def test_bad_quality_readings_are_not_evaluated(self, quality: int) -> None:
        # 3.29151E-41 would breach every threshold at once and bury the real
        # fault under spurious Alarms. The value is still stored and flagged.
        assert evaluate(1e9, quality, [rule()], {}, NOW)[0].action is Action.NO_CHANGE

    def test_special_operators_are_not_per_reading_decisions(self) -> None:
        assert evaluate(1.0, 0, [rule(operator="special")], {}, NOW) == []


class TestScopeResolution:
    def test_most_specific_scope_wins(self) -> None:
        rules = [
            rule(rule_id=1, code="GRID_V", scope_type="global", threshold=12.1),
            rule(rule_id=2, code="GRID_V", scope_type="device", threshold=11.9),
            rule(rule_id=3, code="GRID_V", scope_type="plant", threshold=12.0),
        ]
        resolved = resolve_rules(rules)
        assert len(resolved) == 1
        assert resolved[0].rule_id == 2  # device beats plant beats global

    def test_distinct_codes_all_survive(self) -> None:
        rules = [rule(rule_id=1, code="A"), rule(rule_id=2, code="B")]
        assert len(resolve_rules(rules)) == 2


class TestEscalationGating:
    @pytest.mark.parametrize(
        ("severity", "expected"),
        [("critical", True), ("high", True), ("medium", False), ("low", False)],
    )
    def test_low_and_medium_never_escalate_at_min_high(
        self, severity: str, expected: bool
    ) -> None:
        assert should_escalate(severity, "high") is expected


class TestUnderperformance:
    def test_flags_devices_below_the_sibling_median(self) -> None:
        power = {1: 100.0, 2: 98.0, 3: 102.0, 4: 80.0}
        assert underperforming_devices(
            power, 800.0, fraction=0.10, min_irradiance=400.0
        ) == [4]

    def test_silent_below_the_irradiance_gate(self) -> None:
        # At low light every Inverter looks bad; comparing them is meaningless.
        power = {1: 100.0, 2: 98.0, 3: 102.0, 4: 10.0}
        assert underperforming_devices(
            power, 100.0, fraction=0.10, min_irradiance=400.0
        ) == []

    def test_needs_at_least_three_peers_to_have_a_median(self) -> None:
        # With two devices a "median" is one device's opinion, not a baseline.
        assert underperforming_devices(
            {1: 100.0, 2: 10.0}, 800.0, fraction=0.10, min_irradiance=400.0
        ) == []

    def test_all_devices_down_together_flags_nobody(self) -> None:
        # A plant-wide outage is not underperformance; the median falls with it.
        power = {1: 10.0, 2: 10.0, 3: 10.0}
        assert underperforming_devices(
            power, 800.0, fraction=0.10, min_irradiance=400.0
        ) == []
