"""The Data Issues classification: which facts become which row. Plain values only."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

from solarcms.domain.assumptions import QUALITY_OUT_OF_RANGE as OOR
from solarcms.domain.assumptions import QUALITY_UNPARSEABLE as EMPTY
from solarcms.domain.data_issues import (
    BindingFact,
    DeviceFact,
    PlantFacts,
    ReplayBurst,
    TagHealth,
    UnregisteredTopic,
    find_issues,
    natural_key,
)

NOW = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
TYPES = frozenset({"INVERTER", "SMB", "MFM", "WMS", "PLANT_KPI", "VCB"})
TAGS = frozenset({
    "AC_ACTIVE_POWER", "FREQUENCY", "HV_VOLTAGE_RY", "AMBIENT_TEMPERATURE", "GHI",
    "INVERTER_EFFICIENCY", *(f"PV{n}_CURRENT" for n in range(1, 29)),
})


def binding(binding_id: int, key: str, tag: str, *, enabled: bool = True) -> BindingFact:
    return BindingFact(
        binding_id=binding_id, source_key=key, tag_code=tag, unit=None,
        enabled=enabled, scale=1.0, value_offset=0.0, valid_min=0.0, valid_max=100.0,
    )


def device(
    device_id: int = 1, code: str = "MFM", type_code: str = "MFM", **kw: object,
) -> DeviceFact:
    base = DeviceFact(
        device_id=device_id, code=code, type_code=type_code, status="active",
        comm_status="online", collector_code=None,
        primary_topic=f"SCMS/V1/C/P/{code}", expected_interval_s=30,
        rated_capacity_kw=100.0, variant="string" if type_code == "INVERTER" else None,
    )
    return replace(base, **kw)  # type: ignore[arg-type]


def plant(*devices: DeviceFact, **kw: object) -> PlantFacts:
    base = PlantFacts(
        plant_id=7, plant_code="P", ac_capacity_kw=1000.0, dc_capacity_kwp=1200.0,
        devices=devices, unregistered=(), device_type_codes=TYPES, tag_codes=TAGS,
    )
    return replace(base, **kw)  # type: ignore[arg-type]


def kinds(facts: PlantFacts) -> list[str]:
    return [issue.kind for issue in find_issues(facts)]


def publishing(dev: DeviceFact, **keys: object) -> DeviceFact:
    return replace(dev, recent_messages=10, recent_keys=dict(keys))


def topic(code: str, *, collector: str | None = None) -> UnregisteredTopic:
    prefix = f"SCMS/V1/C/P/{collector}/" if collector else "SCMS/V1/C/P/"
    return UnregisteredTopic(
        topic=prefix + code, device_code=code, collector_code=collector,
        last_seen=NOW, messages=40, interval_s=30.0, keys=("I1", "P1"),
    )


class TestAHealthyPlant:
    def test_has_no_issues(self) -> None:
        meter = publishing(
            device(bindings=(binding(1, "P", "AC_ACTIVE_POWER"), binding(2, "F", "FREQUENCY"))),
            P=120.0, F=50.0,
        )
        assert find_issues(plant(meter)) == []

    def test_the_kpi_panel_is_never_judged(self) -> None:
        kpi = device(9, "P-KPI", "PLANT_KPI", primary_topic=None)
        assert find_issues(plant(kpi)) == []


class TestKeys:
    def test_a_key_nobody_mapped_is_data_being_lost(self) -> None:
        meter = publishing(device(bindings=(binding(1, "P", "AC_ACTIVE_POWER"),)), P=1, F=50)
        [issue] = find_issues(plant(meter))
        assert issue.kind == "unmapped_key"
        assert issue.category == "data_lost"
        assert issue.facts["source_key"] == "F"
        assert issue.facts["suggested_tag_code"] == "FREQUENCY"
        assert issue.facts["sample"] == 50
        assert issue.key == "unmapped:1:F"

    def test_a_suggestion_outside_the_catalogue_is_not_offered(self) -> None:
        meter = publishing(device(), F=50)
        [issue] = find_issues(plant(meter, tag_codes=frozenset({"AC_ACTIVE_POWER"})))
        assert issue.facts["suggested_tag_code"] is None

    def test_a_suggested_tag_already_taken_names_the_key_that_has_it(self) -> None:
        # PAC and P both mean AC_ACTIVE_POWER; P is already bound and still sent.
        meter = publishing(
            device(bindings=(binding(1, "P", "AC_ACTIVE_POWER"),)), P=1, PAC=1)
        [issue] = find_issues(plant(meter))
        assert issue.kind == "unmapped_key"
        assert issue.facts["suggested_taken_by"] == "P"
        assert issue.facts["suggested_binding_id"] == 1

    def test_a_disabled_binding_still_counts_as_mapped(self) -> None:
        # Disabling a mapping is how a person says "known, not wanted".
        meter = publishing(
            device(bindings=(binding(1, "F", "FREQUENCY", enabled=False),)), F=50)
        assert find_issues(plant(meter)) == []

    def test_a_key_that_stopped_is_reported_on_its_binding(self) -> None:
        meter = publishing(
            device(bindings=(binding(1, "P", "AC_ACTIVE_POWER"), binding(2, "F", "FREQUENCY"))),
            P=1,
        )
        [issue] = find_issues(plant(meter))
        assert issue.kind == "binding_silent"
        assert issue.facts["binding_id"] == 2
        assert issue.facts["tag_code"] == "FREQUENCY"

    def test_missing_string_inputs_are_one_row_per_device(self) -> None:
        # A string topic gone missing takes I17..I28 and P17..P28 with it.
        bindings = (
            binding(1, "PAC", "AC_ACTIVE_POWER"),
            *(binding(10 + n, f"I{n}", f"PV{n}_CURRENT") for n in range(17, 20)),
            *(binding(40 + n, f"P{n}", f"PV{n}_ACTIVE_POWER") for n in range(17, 20)),
        )
        inverter = publishing(device(5, "INVERTER_5", "INVERTER", bindings=bindings,
                                     string_count=19), PAC=10.0)
        issues = [i for i in find_issues(plant(inverter)) if i.category == "data_lost"]
        assert [i.kind for i in issues] == ["strings_not_arriving"]
        assert issues[0].facts["inputs"] == [17, 18, 19]
        assert len(issues[0].facts["binding_ids"]) == 6
        assert "17-19" in issues[0].title

    def test_missing_strings_name_who_can_attach_them(self) -> None:
        inverter = publishing(device(5, "INVERTER_5", "INVERTER",
                                     bindings=(binding(17, "I17", "PV17_CURRENT"),)))
        hidden = find_issues(plant(inverter, unregistered=None))
        visible = find_issues(plant(inverter, unregistered=()))
        assert "platform administrator can attach it" in next(
            i for i in hidden if i.kind == "strings_not_arriving").detail
        assert "no unattached string topic" in next(
            i for i in visible if i.kind == "strings_not_arriving").detail

    def test_a_disabled_binding_is_not_expected_to_arrive(self) -> None:
        meter = publishing(device(bindings=(binding(2, "F", "FREQUENCY", enabled=False),)))
        assert "binding_silent" not in kinds(plant(meter))

    def test_one_stopped_key_and_one_new_key_meaning_the_same_tag_is_a_rename(self) -> None:
        # The 16 Sep broker change, in miniature: Frequency became F.
        meter = publishing(device(bindings=(binding(3, "Frequency", "FREQUENCY"),)), F=50)
        [issue] = find_issues(plant(meter))
        assert issue.kind == "key_renamed"
        assert issue.facts["source_key"] == "Frequency"
        assert issue.facts["new_key"] == "F"
        assert issue.facts["binding_id"] == 3
        assert issue.facts["sample"] == 50

    def test_an_ambiguous_rename_is_not_guessed(self) -> None:
        # Two new keys that both mean FREQUENCY: which one replaced it is a
        # person's call, so both are listed and the binding reported stopped.
        meter = publishing(device(bindings=(binding(3, "Frequency", "FREQUENCY"),)), F=50, Hz=50)
        assert sorted(kinds(plant(meter))) == ["binding_silent", "unmapped_key", "unmapped_key"]

    def test_the_alias_is_read_for_the_device_type(self) -> None:
        # VRY is HV_VOLTAGE_RY on a meter and AC_VOLTAGE_RY on an Inverter.
        meter = publishing(device(bindings=(binding(4, "VoltageRY", "HV_VOLTAGE_RY"),)), VRY=11.0)
        assert kinds(plant(meter)) == ["key_renamed"]
        inverter = publishing(
            device(2, "INVERTER_1", "INVERTER",
                   bindings=(binding(5, "VoltageRY", "HV_VOLTAGE_RY"),)),
            VRY=800.0,
        )
        assert "key_renamed" not in kinds(plant(inverter))

    def test_nothing_is_said_about_keys_without_messages(self) -> None:
        silent = device(bindings=(binding(1, "P", "AC_ACTIVE_POWER"),))
        other = publishing(device(2, "WMS", "WMS"))
        assert kinds(plant(silent, other)) == ["device_silent"]


class TestSilence:
    def test_one_quiet_device_on_a_working_plant(self) -> None:
        quiet = device(1, "MFM", last_heard=NOW)
        working = publishing(device(2, "WMS", "WMS"))
        [issue] = find_issues(plant(quiet, working))
        assert issue.kind == "device_silent"
        assert issue.device_id == 1

    def test_a_whole_silent_plant_is_one_row_not_one_per_device(self) -> None:
        facts = plant(device(1, "MFM"), device(2, "WMS", "WMS"), device(3, "VCB", "VCB"))
        [issue] = find_issues(facts)
        assert issue.kind == "plant_silent"
        assert issue.facts["devices"] == 3

    def test_a_decommissioned_device_is_never_reported(self) -> None:
        retired = device(1, "MFM", status="decommissioned")
        working = publishing(device(2, "WMS", "WMS"))
        assert find_issues(plant(retired, working)) == []


class TestInterval:
    def test_slower_than_recorded_reads_late(self) -> None:
        meter = publishing(device(expected_interval_s=30, measured_interval_s=86.0,
                                  measured_gaps=10))
        [issue] = find_issues(plant(meter))
        assert issue.kind == "interval_slower"
        assert issue.category == "data_wrong"
        assert issue.facts == {"expected_interval_s": 30, "measured_interval_s": 86}

    def test_faster_than_recorded(self) -> None:
        meter = publishing(device(expected_interval_s=86, measured_interval_s=30.2,
                                  measured_gaps=10))
        [issue] = find_issues(plant(meter))
        assert issue.kind == "interval_faster"
        assert issue.facts["measured_interval_s"] == 30

    def test_close_enough_is_fine(self) -> None:
        meter = publishing(device(expected_interval_s=30, measured_interval_s=40.0,
                                  measured_gaps=10))
        assert find_issues(plant(meter)) == []

    def test_too_few_gaps_to_judge(self) -> None:
        meter = publishing(device(expected_interval_s=30, measured_interval_s=300.0,
                                  measured_gaps=2))
        assert find_issues(plant(meter)) == []


class TestRejectedValues:
    def health(self, **kw: object) -> TagHealth:
        base = TagHealth(tag_code="FREQUENCY", total=100, out_of_range=0, unparseable=0,
                         valid_min=45.0, valid_max=55.0)
        return replace(base, **kw)  # type: ignore[arg-type]

    def meter(self, health: TagHealth) -> DeviceFact:
        return publishing(device(bindings=(binding(2, "F", "FREQUENCY"),),
                                 tag_health=(health,)), F=0)

    def test_values_outside_the_range(self) -> None:
        facts = plant(self.meter(self.health(out_of_range=30, latest_quality=OOR,
                                             latest_value=-5.0,
                                             flagged_min=-5.0, flagged_max=-1.0)))
        [issue] = find_issues(facts)
        assert issue.kind == "values_rejected"
        assert issue.category == "data_wrong"
        assert "outside the allowed range" in issue.detail
        assert issue.facts["binding_id"] == 2
        assert issue.facts["flagged_min"] == -5.0
        assert issue.facts["derived"] is False

    def test_empty_values_are_named_as_the_equipment(self) -> None:
        [issue] = find_issues(plant(self.meter(self.health(unparseable=40, latest_quality=EMPTY))))
        assert "arriving empty" in issue.title

    def test_a_range_widened_since_clears_it_at_once(self) -> None:
        # 40960 was rejected against 0-1000; the range now admits it.
        widened = TagHealth(tag_code="FREQUENCY", total=120, out_of_range=78, unparseable=0,
                            latest_quality=OOR, latest_value=40960.0, flagged_min=40960.0,
                            flagged_max=40960.0, valid_min=0.0, valid_max=65535.0,
                            recent_rejected=10)
        assert find_issues(plant(self.meter(widened))) == []

    def test_a_rejection_that_stopped_is_not_reported(self) -> None:
        # A scale fixed: the last values are good, though the hour still holds bad ones.
        fixed = self.health(out_of_range=60, latest_quality=0, latest_value=50.0,
                            flagged_min=11037.0, flagged_max=11040.0, recent_rejected=0)
        assert find_issues(plant(self.meter(fixed))) == []

    def test_an_intermittent_rejection_still_happening_is_reported(self) -> None:
        flapping = self.health(out_of_range=30, latest_quality=0, latest_value=50.0,
                               flagged_min=99.0, flagged_max=99.0, recent_rejected=3)
        assert kinds(plant(self.meter(flapping))) == ["values_rejected"]

    def test_one_stray_value_among_many_good_ones_is_noise(self) -> None:
        assert find_issues(plant(self.meter(self.health(unparseable=1)))) == []

    def test_but_a_latest_value_rejected_is_reported_whatever_the_share(self) -> None:
        facts = plant(self.meter(self.health(out_of_range=1, latest_quality=OOR,
                                             latest_value=99.0,
                                             flagged_min=99.0, flagged_max=99.0)))
        assert kinds(facts) == ["values_rejected"]

    def test_zero_from_a_sleeping_inverter_is_not_an_issue(self) -> None:
        # 0 Hz once an Inverter shuts down for the night: equipment saying
        # "nothing", which no mapping could change.
        night = self.health(out_of_range=40, latest_quality=OOR, latest_value=0.0,
                            flagged_min=0.0, flagged_max=0.0)
        assert find_issues(plant(self.meter(night))) == []

    def test_a_small_negative_irradiance_at_night_is_not_an_issue(self) -> None:
        dark = TagHealth(tag_code="GHI", total=30, out_of_range=30, unparseable=0,
                         latest_quality=OOR, latest_value=-1.0, flagged_min=-1.0,
                         flagged_max=-1.0, valid_min=0.0, valid_max=1500.0)
        wms = publishing(device(3, "WMS", "WMS", bindings=(binding(9, "GHI", "GHI"),),
                                tag_health=(dark,)), GHI=-1)
        assert find_issues(plant(wms)) == []

    def test_a_status_code_beyond_an_assumed_range_is_an_issue(self) -> None:
        # DEVICE_STATUS 40960 (0xA000) against an assumed 0-1000.
        code = TagHealth(tag_code="FREQUENCY", total=10, out_of_range=2, unparseable=0,
                         latest_quality=OOR, latest_value=40960.0, flagged_min=40960.0,
                         flagged_max=40960.0, valid_min=0.0, valid_max=1000.0)
        [issue] = find_issues(plant(self.meter(code)))
        assert issue.facts["flagged_max"] == 40960.0
        assert issue.facts["latest_rejected"] is True

    def test_a_sentinel_far_outside_the_range_is_an_issue(self) -> None:
        # 6553.4 W/m²: a 16-bit register's "no reading", divided by ten.
        sentinel = TagHealth(tag_code="GHI", total=18, out_of_range=18, unparseable=0,
                             latest_quality=OOR, latest_value=6553.4, flagged_min=6550.6,
                             flagged_max=6553.4, valid_min=0.0, valid_max=1500.0)
        wms = publishing(device(3, "WMS", "WMS", bindings=(binding(9, "GHI", "GHI"),),
                                tag_health=(sentinel,)), GHI=6553.4)
        assert kinds(plant(wms)) == ["values_rejected"]

    def test_empty_values_are_never_excused_as_idle(self) -> None:
        empty = self.health(unparseable=20, latest_quality=EMPTY, latest_value=0.0)
        assert kinds(plant(self.meter(empty))) == ["values_rejected"]

    def test_a_calculated_tag_has_no_mapping_to_correct(self) -> None:
        inverter = publishing(
            device(2, "INVERTER1", "INVERTER", tag_health=(TagHealth(
                tag_code="DC_POWER", total=31, out_of_range=31, unparseable=0,
                latest_quality=OOR, latest_value=-7710.0, flagged_min=-50640.0,
                flagged_max=-7710.0, valid_min=0.0, valid_max=5000.0),)),
        )
        [issue] = [i for i in find_issues(plant(inverter)) if i.kind == "values_rejected"]
        assert issue.facts["derived"] is True
        assert "calculated from other readings" in issue.detail


class TestStrings:
    def inverter(self, *, string_count: int | None, sent: int, working: int,
                 **kw: object) -> DeviceFact:
        bindings = tuple(binding(n, f"I{n}", f"PV{n}_CURRENT") for n in range(1, sent + 1))
        return publishing(
            device(1, "INVERTER_1", "INVERTER", string_count=string_count,
                   bindings=bindings,
                   string_current_max={n: (8.0 if n <= working else 0.0)
                                       for n in range(1, sent + 1)},
                   **kw),
            **{f"I{n}": 1.0 for n in range(1, sent + 1)},
        )

    def test_strings_arriving_with_no_count(self) -> None:
        [issue] = find_issues(plant(self.inverter(string_count=None, sent=28, working=26)))
        assert issue.kind == "string_count_missing"
        assert issue.category == "setup"
        assert issue.facts["inputs_sent"] == 28
        assert issue.facts["inputs_with_current"] == 26

    def test_working_strings_above_the_count_are_hidden_data(self) -> None:
        [issue] = find_issues(plant(self.inverter(string_count=16, sent=28, working=27)))
        assert issue.kind == "strings_hidden"
        assert issue.facts["hidden"] == list(range(17, 28))
        assert "17-27" in issue.detail

    def test_unused_inputs_above_the_count_are_not_hidden_data(self) -> None:
        # Vardhman: sixteen inputs sent, ten carry current, count set to ten.
        assert find_issues(plant(self.inverter(string_count=10, sent=16, working=10))) == []

    def test_a_count_above_what_arrives(self) -> None:
        [issue] = find_issues(plant(self.inverter(string_count=32, sent=28, working=28)))
        assert issue.kind == "string_count_high"

    def test_the_count_matching_what_arrives_is_fine(self) -> None:
        assert find_issues(plant(self.inverter(string_count=28, sent=28, working=20))) == []

    def test_a_meter_has_no_strings(self) -> None:
        meter = publishing(device(bindings=(binding(1, "I1", "PV1_CURRENT"),)), I1=3)
        assert "string_count_missing" not in kinds(plant(meter))


class TestInverterSetup:
    def test_no_type_and_no_size(self) -> None:
        inverter = publishing(device(1, "INVERTER_1", "INVERTER", variant=None,
                                     rated_capacity_kw=None))
        assert sorted(kinds(plant(inverter))) == ["inverter_capacity_missing",
                                                  "inverter_type_missing"]

    def test_type_hint_when_it_reports_its_own_strings(self) -> None:
        inverter = publishing(device(1, "INVERTER_1", "INVERTER", variant=None,
                                     bindings=(binding(1, "I1", "PV1_CURRENT"),),
                                     string_count=1), I1=4.0)
        [issue] = [i for i in find_issues(plant(inverter)) if i.kind == "inverter_type_missing"]
        assert issue.facts["sends_strings"] is True


class TestPlant:
    def test_missing_capacity(self) -> None:
        [issue] = find_issues(plant(ac_capacity_kw=None))
        assert issue.kind == "plant_capacity_missing"
        assert issue.title.startswith("AC capacity")
        both = find_issues(plant(ac_capacity_kw=None, dc_capacity_kwp=None))
        assert both[0].title.startswith("DC capacity and AC capacity")

    def test_a_replayed_backlog(self) -> None:
        burst = ReplayBurst(minute=NOW, messages=196, topics=56)
        [issue] = find_issues(plant(replay_bursts=(burst,)))
        assert issue.kind == "replay_burst"
        assert issue.category == "data_wrong"
        assert issue.key == f"replay:7:{NOW.isoformat()}"
        assert issue.title == "196 old messages arrived in one burst"

    def test_many_bursts_are_one_row_keyed_on_the_latest(self) -> None:
        # A new burst changes the key, so an acknowledgement covers only the
        # bursts it was made about.
        earlier = ReplayBurst(minute=NOW.replace(hour=10), messages=140, topics=20)
        later = ReplayBurst(minute=NOW, messages=23, topics=23)
        [issue] = find_issues(plant(replay_bursts=(later, earlier)))
        assert issue.key == f"replay:7:{NOW.isoformat()}"
        assert issue.facts["messages"] == 163
        assert [b["messages"] for b in issue.facts["bursts"]] == [140, 23]


class TestUnregisteredTopics:
    def test_nothing_is_claimed_to_a_caller_who_cannot_see_them(self) -> None:
        # None means "not visible", not "none" — and produces no rows.
        assert find_issues(plant(unregistered=None)) == []

    def test_a_publishing_device_nobody_registered(self) -> None:
        [issue] = find_issues(plant(unregistered=(topic("WMS_WEST"),)))
        assert issue.kind == "unregistered_topic"
        assert issue.category == "data_lost"
        assert issue.facts["suggested_type"] == "WMS"
        assert issue.facts["code_taken"] is False

    def test_an_unknown_kind_of_equipment_says_so(self) -> None:
        [issue] = find_issues(plant(unregistered=(topic("BATTERY_1"),)))
        assert issue.facts["suggested_type"] is None
        assert "needs a developer" in issue.detail

    def test_a_string_topic_of_a_registered_inverter_is_attached_not_registered(self) -> None:
        inverter = publishing(device(4, "INVERTER_3", "INVERTER", collector_code="MCR"))
        [issue] = find_issues(plant(
            inverter, unregistered=(topic("INVERTER_3_STRING16", collector="MCR"),)))
        assert issue.kind == "string_topic_unattached"
        assert issue.facts["owner_device_id"] == 4
        assert issue.facts["topic"] == "SCMS/V1/C/P/MCR/INVERTER_3_STRING16"

    def test_an_unattached_string_topic_explains_its_keys_stopping(self) -> None:
        # Its I17..I28 bindings stopped arriving because the topic carrying them
        # is not attached: one row says so, not one per key.
        inverter = publishing(
            device(4, "INVERTER_3", "INVERTER", collector_code="MCR", string_count=17,
                   bindings=(binding(1, "I1", "PV1_CURRENT"), binding(2, "I17", "PV17_CURRENT"))),
            I1=3.0,
        )
        strings = replace(topic("INVERTER_3_STRING28", collector="MCR"), keys=("I17", "P17"))
        # And input 17 is counted as sent, so a count of 17 is not "too high".
        assert kinds(plant(inverter, unregistered=(strings,))) == ["string_topic_unattached"]

    def test_a_string_topic_from_another_enclosure_is_not_offered_for_attaching(self) -> None:
        inverter = publishing(device(4, "INVERTER_3", "INVERTER", collector_code="ICR"))
        issues = find_issues(plant(
            inverter, unregistered=(topic("INVERTER_3_STRING16", collector="MCR"),)))
        assert [i.kind for i in issues] == ["unregistered_topic"]

    def test_strings_of_an_unregistered_owner_are_one_row(self) -> None:
        # ISPL's SMB1 publishes nothing but its two string topics.
        [issue] = find_issues(plant(unregistered=(
            topic("SMB1_STRING24", collector="MCR"), topic("SMB1_STRING16", collector="MCR"))))
        assert issue.kind == "unregistered_strings"
        assert issue.facts["owner_code"] == "SMB1"
        assert issue.facts["suggested_type"] == "SMB"
        assert [t["device_code"] for t in issue.facts["topics"]] == [
            "SMB1_STRING16", "SMB1_STRING24"]

    def test_a_silent_device_reappearing_on_a_new_topic_has_moved(self) -> None:
        old = device(1, "MFM", comm_status="offline")
        working = publishing(device(2, "WMS", "WMS"))
        [issue] = find_issues(plant(old, working, unregistered=(topic("MFM", collector="MCR"),)))
        assert issue.kind == "topic_moved"
        assert issue.device_id == 1
        assert issue.facts["old_topic"] == "SCMS/V1/C/P/MFM"
        assert issue.facts["topic"] == "SCMS/V1/C/P/MCR/MFM"

    def test_the_same_name_while_the_registered_one_still_sends_is_not_a_move(self) -> None:
        live = publishing(device(1, "MFM"))
        [issue] = find_issues(plant(live, unregistered=(topic("MFM", collector="MCR"),)))
        assert issue.kind == "unregistered_topic"
        assert issue.facts["code_taken"] is True


class TestOrdering:
    def test_costliest_first_then_as_a_person_counts(self) -> None:
        a = publishing(device(1, "INVERTER_10", "INVERTER", variant=None))
        b = publishing(device(2, "INVERTER_2", "INVERTER", variant=None))
        c = publishing(device(3, "MFM"), F=50)
        issues = find_issues(plant(a, b, c, ac_capacity_kw=None))
        assert [(i.category, i.device_code) for i in issues] == [
            ("data_lost", "MFM"),
            ("setup", None),
            ("setup", "INVERTER_2"),
            ("setup", "INVERTER_10"),
        ]

    def test_natural_key(self) -> None:
        assert sorted(["INVERTER_10", "INVERTER_2", "INVERTER_1"], key=natural_key) == [
            "INVERTER_1", "INVERTER_2", "INVERTER_10"]


def test_every_issue_key_is_unique_on_a_messy_plant() -> None:
    inverter = publishing(
        device(1, "INVERTER_1", "INVERTER", variant=None, rated_capacity_kw=None,
               bindings=(binding(1, "Frequency", "FREQUENCY"),
                         binding(2, "I1", "PV1_CURRENT")),
               collector_code="MCR"),
        F=50, I1=3.0, XYZ=1,
    )
    facts = plant(inverter, ac_capacity_kw=None,
                  unregistered=(topic("INVERTER_1_STRING16", collector="MCR"),
                                topic("WMS"), topic("SMB1_STRING16")),
                  replay_bursts=(ReplayBurst(minute=NOW, messages=9, topics=3),))
    keys = [issue.key for issue in find_issues(facts)]
    assert len(keys) == len(set(keys))
