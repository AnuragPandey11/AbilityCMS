"""Absence detection: what is not arriving, and what should be raised for it."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from solarcms.domain.absence import (
    RULE_COLLECTOR_OFFLINE,
    RULE_COMM_LOST,
    RULE_PLANT_SILENT,
    RULE_UNREGISTERED_PUBLISHING,
    AbsenceCondition,
    DeviceAbsenceInput,
    ObservedTopicInput,
    assess_coverage,
    assess_plant_silence,
    classify_topic_liveness,
    diff_conditions,
    in_maintenance,
    plan_device_absence,
    plan_unregistered_publishing,
)
from solarcms.domain.health_logic import CollectorCorrelation

NOW = datetime(2026, 9, 20, 18, 0, tzinfo=UTC)


def device(device_id: int, status: str, **kw: object) -> DeviceAbsenceInput:
    defaults: dict[str, object] = {
        "device_id": device_id, "client_id": 2, "plant_id": 2,
        "code": f"INVERTER_{device_id}", "comm_status": status,
        "collector": "2:MCR", "suppressed": False,
    }
    return DeviceAbsenceInput(**{**defaults, **kw})  # type: ignore[arg-type]


class TestPlanDeviceAbsence:
    def test_a_single_silent_device_raises_comm_lost(self) -> None:
        conditions = plan_device_absence([device(1, "offline")], [], set())
        assert [c.rule_code for c in conditions] == [RULE_COMM_LOST]
        assert conditions[0].device_id == 1

    def test_an_online_device_raises_nothing(self) -> None:
        assert plan_device_absence([device(1, "online")], [], set()) == []

    def test_never_seen_is_not_absence(self) -> None:
        # 'unknown' is a Device registered during commissioning that has not
        # started yet. Alarming on it would cry wolf at every onboarding.
        assert plan_device_absence([device(1, "unknown")], [], set()) == []

    def test_a_collector_failure_is_one_alarm_not_seventeen(self) -> None:
        devices = [device(i, "offline") for i in range(1, 18)]
        correlation = CollectorCorrelation("2:MCR", [d.device_id for d in devices])
        conditions = plan_device_absence(
            devices, [correlation], absorbed=set(range(1, 18))
        )
        assert len(conditions) == 1
        assert conditions[0].rule_code == RULE_COLLECTOR_OFFLINE
        assert conditions[0].subject == "2:MCR"
        assert conditions[0].device_id is None

    def test_a_device_outside_the_correlation_still_gets_its_own_alarm(self) -> None:
        grouped = [device(i, "offline") for i in (1, 2)]
        alone = device(9, "offline", collector=None)
        correlation = CollectorCorrelation("2:MCR", [1, 2])
        conditions = plan_device_absence(
            [*grouped, alone], [correlation], absorbed={1, 2}
        )
        codes = sorted(c.rule_code for c in conditions)
        assert codes == [RULE_COLLECTOR_OFFLINE, RULE_COMM_LOST]
        comm = next(c for c in conditions if c.rule_code == RULE_COMM_LOST)
        assert comm.device_id == 9

    def test_maintenance_suppresses_the_device_alarm(self) -> None:
        assert plan_device_absence(
            [device(1, "offline", suppressed=True)], [], set()
        ) == []

    def test_a_fully_suppressed_collector_raises_nothing(self) -> None:
        devices = [device(i, "offline", suppressed=True) for i in (1, 2)]
        correlation = CollectorCorrelation("2:MCR", [1, 2])
        assert plan_device_absence(devices, [correlation], {1, 2}) == []

    def test_silence_so_far_travels_for_the_debounce(self) -> None:
        # The rule's duration_s is applied by the caller against this, derived
        # fresh each sweep rather than remembered — so a worker restart cannot
        # reset a debounce and a flapping link cannot open by good timing.
        conditions = plan_device_absence(
            [device(1, "offline", silent_for_s=412.0)], [], set()
        )
        assert conditions[0].held_for_s == 412.0

    def test_a_collector_is_only_as_down_as_its_freshest_member(self) -> None:
        devices = [
            device(1, "offline", silent_for_s=900.0),
            device(2, "offline", silent_for_s=120.0),
        ]
        correlation = CollectorCorrelation("2:MCR", [1, 2])
        conditions = plan_device_absence(devices, [correlation], {1, 2})
        assert conditions[0].held_for_s == 120.0

    def test_classification_is_communication_never_equipment(self) -> None:
        # Absence alone never proves equipment failed. Claiming it would
        # understate availability against a performance guarantee.
        conditions = plan_device_absence([device(1, "offline")], [], set())
        assert all("equipment" not in c.message for c in conditions)


class TestTopicLiveness:
    def test_recent_for_its_own_cadence_is_live(self) -> None:
        seen = NOW - timedelta(seconds=90)
        assert classify_topic_liveness(seen, 86.0, NOW) == "live"

    def test_long_silent_for_its_own_cadence_is_silent(self) -> None:
        seen = NOW - timedelta(hours=53)
        assert classify_topic_liveness(seen, 86.0, NOW) == "silent"

    def test_a_slow_publisher_is_not_called_dead_early(self) -> None:
        # A daily total quiet for two hours is entirely normal; a fixed
        # threshold would bury the operator in false positives.
        seen = NOW - timedelta(hours=2)
        assert classify_topic_liveness(seen, 86_400.0, NOW) == "live"

    def test_a_fast_publisher_gets_the_floor_not_a_hair_trigger(self) -> None:
        # 2x of 5s is 10s; the floor stops a momentary drop reading as death.
        seen = NOW - timedelta(seconds=60)
        assert classify_topic_liveness(seen, 5.0, NOW) == "live"

    def test_one_message_ever_has_no_interval_and_uses_the_floor(self) -> None:
        assert classify_topic_liveness(NOW - timedelta(minutes=5), None, NOW) == "live"
        assert classify_topic_liveness(NOW - timedelta(hours=53), None, NOW) == "silent"

    def test_never_seen_is_silent(self) -> None:
        assert classify_topic_liveness(None, 86.0, NOW) == "silent"


class TestUnregisteredPublishing:
    def topic(self, **kw: object) -> ObservedTopicInput:
        defaults: dict[str, object] = {
            "topic": "SCMS/V1/KULAR_GREEN/KULAR_GREEN/VCB",
            "plant_id": 2, "client_id": 2,
            "last_seen_at": NOW - timedelta(seconds=90),
            "observed_interval_s": 86.0, "registered": False, "ignored": False,
        }
        return ObservedTopicInput(**{**defaults, **kw})  # type: ignore[arg-type]

    def test_a_live_unregistered_topic_is_raised(self) -> None:
        conditions = plan_unregistered_publishing([self.topic()], NOW)
        assert [c.rule_code for c in conditions] == [RULE_UNREGISTERED_PUBLISHING]
        assert conditions[0].subject == "SCMS/V1/KULAR_GREEN/KULAR_GREEN/VCB"

    def test_a_registered_topic_is_not_raised(self) -> None:
        assert plan_unregistered_publishing([self.topic(registered=True)], NOW) == []

    def test_a_dead_topic_is_not_raised(self) -> None:
        # The retired shapes. Alarming on these trains the operator to ignore
        # the one alarm in this class that actually costs money.
        dead = self.topic(last_seen_at=NOW - timedelta(hours=53))
        assert plan_unregistered_publishing([dead], NOW) == []

    def test_a_dismissed_topic_is_not_raised(self) -> None:
        assert plan_unregistered_publishing([self.topic(ignored=True)], NOW) == []

    def test_an_unknown_client_is_not_attributed(self) -> None:
        # Guardrail 5: a topic under an unregistered Client is not guessed at.
        assert plan_unregistered_publishing([self.topic(client_id=None)], NOW) == []


class TestPlantSilence:
    def test_messages_arriving_is_never_silence(self) -> None:
        assert assess_plant_silence([86], messages_in_window=1, window_s=600) is False

    def test_nothing_at_all_past_the_slowest_device_is_silence(self) -> None:
        assert assess_plant_silence([86], messages_in_window=0, window_s=600) is True

    def test_judged_against_the_slowest_publisher(self) -> None:
        # One hourly Device means ten minutes of quiet proves nothing.
        assert assess_plant_silence([86, 3600], 0, window_s=600) is False

    def test_a_plant_with_no_publishing_devices_is_not_silent(self) -> None:
        assert assess_plant_silence([], messages_in_window=0, window_s=600) is False


class TestMaintenance:
    def test_inside_a_closed_window(self) -> None:
        windows = [(NOW - timedelta(hours=1), NOW + timedelta(hours=1))]
        assert in_maintenance(NOW, windows) is True

    def test_outside_a_closed_window(self) -> None:
        windows = [(NOW - timedelta(hours=3), NOW - timedelta(hours=2))]
        assert in_maintenance(NOW, windows) is False

    def test_an_open_ended_window_has_not_finished(self) -> None:
        assert in_maintenance(NOW, [(NOW - timedelta(hours=1), None)]) is True

    def test_a_future_window_does_not_suppress_yet(self) -> None:
        assert in_maintenance(NOW, [(NOW + timedelta(hours=1), None)]) is False


class TestCoverage:
    def test_full_coverage_is_complete(self) -> None:
        coverage = assess_coverage(1000, 1000, 86_400)
        assert coverage.ratio == 1.0
        assert coverage.complete is True
        assert coverage.missing_seconds == 0.0

    def test_a_gap_is_visible_and_the_figure_is_not_corrected(self) -> None:
        # Half the data missing. The ratio says so; nothing invents the rest,
        # because a figure adjusted upward to cover a gap is a fabrication.
        coverage = assess_coverage(1000, 500, 86_400)
        assert coverage.ratio == 0.5
        assert coverage.complete is False
        assert coverage.missing_seconds == 43_200.0

    def test_nothing_expected_yields_no_ratio_not_perfect_coverage(self) -> None:
        # A Plant with no publishing Devices has not achieved 100% coverage.
        coverage = assess_coverage(0, 0, 86_400)
        assert coverage.ratio is None
        assert coverage.complete is False

    def test_planned_work_is_excluded_not_counted_against_the_plant(self) -> None:
        # Maintenance is an explained absence. It reduces the period being
        # accounted for rather than appearing as missing data.
        coverage = assess_coverage(1000, 500, 86_400, excluded_seconds=43_200)
        assert coverage.excluded_seconds == 43_200
        assert coverage.missing_seconds == 21_600.0

    def test_more_samples_than_expected_is_capped(self) -> None:
        # A Device publishing faster than registered is mis-registered, not
        # 200% covered.
        assert assess_coverage(100, 200, 3600).ratio == 1.0


class TestDiff:
    def condition(self, code: str, device_id: int | None = None,
                  subject: str | None = None) -> AbsenceCondition:
        return AbsenceCondition(code, 2, 2, device_id, subject, "m")

    def test_a_new_condition_opens(self) -> None:
        desired = [self.condition(RULE_COMM_LOST, device_id=1)]
        to_open, to_clear = diff_conditions(desired, set())
        assert len(to_open) == 1 and to_clear == set()

    def test_an_already_open_condition_is_left_alone(self) -> None:
        # A fault persisting six hours is one row, and re-opening would
        # re-notify whoever is already dealing with it.
        desired = [self.condition(RULE_COMM_LOST, device_id=1)]
        to_open, to_clear = diff_conditions(desired, {(RULE_COMM_LOST, 1, None)})
        assert to_open == [] and to_clear == set()

    def test_a_recovered_condition_clears(self) -> None:
        to_open, to_clear = diff_conditions([], {(RULE_COMM_LOST, 1, None)})
        assert to_open == [] and to_clear == {(RULE_COMM_LOST, 1, None)}

    def test_two_subjects_under_one_rule_are_distinct(self) -> None:
        desired = [
            self.condition(RULE_UNREGISTERED_PUBLISHING, subject="a"),
            self.condition(RULE_UNREGISTERED_PUBLISHING, subject="b"),
        ]
        to_open, _ = diff_conditions(
            desired, {(RULE_UNREGISTERED_PUBLISHING, None, "a")}
        )
        assert [c.subject for c in to_open] == ["b"]

    def test_plant_silent_rule_code_is_stable(self) -> None:
        assert RULE_PLANT_SILENT == "PLANT_SILENT"
