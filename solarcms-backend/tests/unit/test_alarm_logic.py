"""Threshold, debounce, hysteresis, DI state rules, scope resolution."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solarcms.domain.alarm_logic import (
    Action,
    AlarmRuleSpec,
    RuleState,
    RuleTarget,
    applies_to,
    evaluate,
    has_cleared,
    is_breaching,
    resolve_rules,
    restored_state,
    rules_for,
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

    @pytest.mark.parametrize("order", [(0, 1), (1, 0)])
    def test_at_the_same_scope_the_clients_own_rule_wins(
        self, order: tuple[int, int]
    ) -> None:
        # The tie used to go to whichever row Postgres returned first, and a
        # `cli seed` rewriting the default could reverse it. Both orders now
        # give the same answer.
        platform = rule(rule_id=10, code="INV_OVERTEMP", scope_type="device_type",
                        scope_id=3, threshold=75.0)
        own = rule(rule_id=50, code="INV_OVERTEMP", scope_type="device_type",
                   scope_id=3, threshold=70.0, client_id=1)
        pair = [platform, own]
        resolved = resolve_rules([pair[order[0]], pair[order[1]]])
        assert [r.rule_id for r in resolved] == [50]

    def test_a_narrower_default_beats_a_wider_client_rule(self) -> None:
        # Scope is compared first: ownership only breaks a tie. A Client rule
        # for everything it owns does not replace a default about Inverters.
        platform = rule(rule_id=10, code="INV_OVERTEMP", scope_type="device_type",
                        scope_id=3)
        own = rule(rule_id=50, code="INV_OVERTEMP", scope_type="client",
                   scope_id=1, client_id=1)
        assert resolve_rules([own, platform])[0].rule_id == 10

    def test_a_narrower_client_rule_beats_the_default(self) -> None:
        platform = rule(rule_id=10, code="INV_OVERTEMP", scope_type="device_type",
                        scope_id=3)
        own = rule(rule_id=50, code="INV_OVERTEMP", scope_type="plant",
                   scope_id=2, client_id=1)
        assert resolve_rules([platform, own])[0].rule_id == 50


class TestRuleReach:
    """Which rules reach a target at all, before precedence. SUNFIELD (1) owns
    SF_NORTH (1) and SF_SOUTH (2); ROOFCO (2) owns WH1 (3); INVERTER is Type 3."""

    SF_SOUTH_INVERTER = RuleTarget(client_id=1, plant_id=2, device_id=40,
                                   device_type_id=3)
    WH1_INVERTER = RuleTarget(client_id=2, plant_id=3, device_id=5, device_type_id=3)

    def test_another_clients_rule_never_reaches(self) -> None:
        sunfield = rule(code="INV_OVERTEMP", scope_type="device_type", scope_id=3,
                        client_id=1)
        assert applies_to(sunfield, self.SF_SOUTH_INVERTER)
        assert not applies_to(sunfield, self.WH1_INVERTER)

    def test_a_platform_default_reaches_every_client(self) -> None:
        default = rule(code="INV_OVERTEMP", scope_type="device_type", scope_id=3)
        assert applies_to(default, self.SF_SOUTH_INVERTER)
        assert applies_to(default, self.WH1_INVERTER)

    @pytest.mark.parametrize(
        ("scope_type", "scope_id", "expected"),
        [("global", None, True), ("client", 1, True), ("client", 2, False),
         ("plant", 2, True), ("plant", 1, False), ("device_type", 3, True),
         ("device_type", 6, False), ("device", 40, True), ("device", 41, False)],
    )
    def test_each_scope_matches_only_its_target(
        self, scope_type: str, scope_id: int | None, expected: bool
    ) -> None:
        candidate = rule(scope_type=scope_type, scope_id=scope_id)
        assert applies_to(candidate, self.SF_SOUTH_INVERTER) is expected

    def test_a_subject_without_a_device_matches_no_device_scoped_rule(self) -> None:
        # A Collector or a whole Plant has no Device and no Type.
        collector = RuleTarget(client_id=1, plant_id=2)
        assert not applies_to(rule(scope_type="device_type", scope_id=3), collector)
        assert applies_to(rule(scope_type="plant", scope_id=2), collector)

    def test_the_worked_example(self) -> None:
        # The flow agreed on 25 Sep 2026, end to end: the platform's 75 for all
        # Inverters, SUNFIELD's 70 for all of its Inverters, and SUNFIELD's 78
        # for SF_SOUTH alone.
        rules = [
            rule(rule_id=10, code="INV_OVERTEMP", scope_type="device_type",
                 scope_id=3, threshold=75.0),
            rule(rule_id=50, code="INV_OVERTEMP", scope_type="device_type",
                 scope_id=3, threshold=70.0, client_id=1),
            rule(rule_id=51, code="INV_OVERTEMP", scope_type="plant",
                 scope_id=2, threshold=78.0, client_id=1),
        ]
        sf_north = RuleTarget(client_id=1, plant_id=1, device_id=30, device_type_id=3)
        assert rules_for(rules, sf_north)[0].threshold == 70.0
        assert rules_for(rules, self.SF_SOUTH_INVERTER)[0].threshold == 78.0
        assert rules_for(rules, self.WH1_INVERTER)[0].threshold == 75.0


class TestRestoredState:
    """The worker keeps state in memory; what it rebuilds from open Alarms."""

    OPENED = NOW - timedelta(minutes=40)

    def test_an_alarm_open_before_a_restart_can_still_clear(self) -> None:
        # Before: an empty state after a restart meant "not open", and a value
        # back to normal was "not breaching" — NO_CHANGE, for ever.
        overtemp = rule(rule_id=9, code="INV_OVERTEMP", threshold=75.0)
        state = restored_state([overtemp], {"INV_OVERTEMP": self.OPENED})
        actions = evaluate(60.0, 0, [overtemp], state, NOW)
        assert actions[0].action is Action.CLEAR

    def test_a_restored_alarm_that_still_breaches_is_not_raised_again(self) -> None:
        overtemp = rule(rule_id=9, code="INV_OVERTEMP", threshold=75.0)
        state = restored_state([overtemp], {"INV_OVERTEMP": self.OPENED})
        assert evaluate(80.0, 0, [overtemp], state, NOW)[0].action is Action.NO_CHANGE

    def test_the_rule_now_in_force_inherits_an_alarm_raised_under_another(
        self,
    ) -> None:
        # The platform default raised it; SUNFIELD's rule with the same code has
        # since taken over. Matched by code, so SUNFIELD's rule treats it as its
        # own: no second Alarm while it breaches, and a CLEAR when it stops.
        sunfield = rule(rule_id=50, code="INV_OVERTEMP", threshold=70.0, client_id=1)
        state = restored_state([sunfield], {"INV_OVERTEMP": self.OPENED})
        assert state[50].is_open
        assert evaluate(80.0, 0, [sunfield], state, NOW)[0].action is Action.NO_CHANGE
        assert evaluate(60.0, 0, [sunfield], state, NOW)[0].action is Action.CLEAR

    def test_only_codes_with_an_open_alarm_are_restored(self) -> None:
        rules = [rule(rule_id=9, code="INV_OVERTEMP"), rule(rule_id=10, code="INV_DC_OV")]
        assert set(restored_state(rules, {"INV_OVERTEMP": self.OPENED})) == {9}


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
