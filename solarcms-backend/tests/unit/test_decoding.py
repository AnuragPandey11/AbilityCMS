"""Topic parsing, coercion, scaling, quality and throttling. Plain values only."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from solarcms.domain.assumptions import (
    QUALITY_GOOD,
    QUALITY_OUT_OF_RANGE,
    QUALITY_STALE,
    QUALITY_UNPARSEABLE,
)
from solarcms.domain.decoding import (
    DeviceResolution,
    InvalidPattern,
    TagBinding,
    TopicPattern,
    coerce_value,
    decode,
    parse_topic,
)

CANONICAL = TopicPattern(
    "scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}", priority=10
)
LEGACY = TopicPattern("{plant_code}/{category}", priority=50)
NOW = datetime(2026, 9, 10, 12, 0, tzinfo=UTC)


def binding(**kw: object) -> TagBinding:
    defaults: dict[str, object] = {
        "source_key": "pa", "tag_id": 1, "tag_code": "AC_ACTIVE_POWER", "scale": 1.0
    }
    return TagBinding(**{**defaults, **kw})  # type: ignore[arg-type]


def resolution(*bindings: TagBinding, interval: int = 60) -> DeviceResolution:
    return DeviceResolution(
        device_id=7, client_id=3, plant_id=5, expected_interval_s=interval,
        bindings={b.source_key: b for b in bindings},
    )


class TestTopicPattern:
    def test_canonical_topic_captures_all_origin_fields(self) -> None:
        got = CANONICAL.match("scms/v1/vardhman/plant-015/plc-01/INV-01")
        assert got == {
            "client_code": "vardhman", "plant_code": "plant-015",
            "collector_code": "plc-01", "device_code": "INV-01",
        }

    def test_segment_count_must_match_exactly(self) -> None:
        assert CANONICAL.match("scms/v1/vardhman/plant-015/plc-01") is None
        assert CANONICAL.match("scms/v1/a/b/c/d/e") is None

    def test_literal_segments_must_match(self) -> None:
        assert CANONICAL.match("scms/v2/a/b/c/d") is None

    def test_empty_segment_identifies_nothing(self) -> None:
        assert CANONICAL.match("scms/v1//plant-015/plc-01/INV-01") is None

    def test_legacy_two_segment_shape(self) -> None:
        # The client's test broker, observed: {PLANT}/{CATEGORY}, no Device.
        assert LEGACY.match("KULAR_GREEN/DATA") == {
            "plant_code": "KULAR_GREEN", "category": "DATA"
        }

    def test_unknown_capture_field_is_rejected_at_construction(self) -> None:
        # A typo must fail loudly at registry load, not silently stop matching.
        with pytest.raises(InvalidPattern, match="unknown field"):
            TopicPattern("scms/v1/{clint_code}")

    def test_malformed_segment_is_rejected(self) -> None:
        with pytest.raises(InvalidPattern, match="malformed"):
            TopicPattern("scms/{plant_code")


class TestParseTopic:
    def test_priority_decides_when_both_patterns_match(self) -> None:
        two_segment = TopicPattern("{client_code}/{plant_code}", priority=5)
        assert parse_topic("KULAR_GREEN/DATA", [LEGACY, two_segment]) == {
            "client_code": "KULAR_GREEN", "plant_code": "DATA"
        }

    def test_unmatched_topic_returns_none_and_never_guesses(self) -> None:
        assert parse_topic("random/deep/topic/shape", [CANONICAL, LEGACY]) is None

    def test_empty_registry_matches_nothing(self) -> None:
        assert parse_topic("scms/v1/a/b/c/d", []) is None


class TestCoerceValue:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("336", 336.0), ("339.5432", 339.5432), (" 12.5 ", 12.5), (42, 42.0),
         (1.5, 1.5), (True, 1.0), (False, 0.0), ("-5.82", -5.82), ("1e3", 1000.0)],
    )
    def test_accepts_the_shapes_the_field_actually_sends(
        self, raw: object, expected: float
    ) -> None:
        # Every value on the client's broker arrives as a JSON string.
        assert coerce_value(raw) == expected

    @pytest.mark.parametrize("raw", ["", "abc", None, [], {}, "12,5"])
    def test_rejects_unreadable_values(self, raw: object) -> None:
        assert coerce_value(raw) is None

    @pytest.mark.parametrize("raw", ["nan", "inf", "-inf", float("nan"), float("inf")])
    def test_rejects_nan_and_infinity(self, raw: object) -> None:
        # Not storable as a measurement; they are unparseable input.
        assert coerce_value(raw) is None

    def test_denormalised_float_is_readable_and_tiny(self) -> None:
        # MASTER §9.5's real example; it must survive coercion so the range check
        # can flag it as diagnostic information rather than be dropped here.
        value = coerce_value("3.29151E-41")
        assert value is not None and 0 < value < 1e-40


class TestDecode:
    def test_applies_the_worked_example_from_the_specification(self) -> None:
        # MASTER §5.2: pa=1985 at scale 0.1 is 198.5 kW.
        result = decode("t", {"pa": "1985"}, resolution(binding(scale=0.1)), NOW)
        assert [r.value for r in result.readings] == [198.5]
        assert result.readings[0].quality == QUALITY_GOOD

    def test_same_tag_different_device_different_key_and_scale(self) -> None:
        # The other half of §5.2: INV-02 binds the same Tag to P_ac at scale 1.0.
        other = resolution(binding(source_key="P_ac", scale=1.0))
        result = decode("t", {"P_ac": "198.5"}, other, NOW)
        assert [r.value for r in result.readings] == [198.5]

    def test_offset_is_applied_after_scale(self) -> None:
        result = decode("t", {"pa": "100"},
                        resolution(binding(scale=2.0, offset=5.0)), NOW)
        assert result.readings[0].value == 205.0

    def test_out_of_range_is_stored_and_flagged_never_dropped(self) -> None:
        result = decode("t", {"pa": "99999"},
                        resolution(binding(valid_min=0, valid_max=5000)), NOW)
        assert len(result.readings) == 1
        assert result.readings[0].quality == QUALITY_OUT_OF_RANGE

    def test_unparseable_is_stored_and_flagged_never_dropped(self) -> None:
        result = decode("t", {"pa": "garbage"}, resolution(binding()), NOW)
        assert len(result.readings) == 1
        assert result.readings[0].quality == QUALITY_UNPARSEABLE

    def test_stale_source_time_is_flagged(self) -> None:
        result = decode("t", {"pa": "10"}, resolution(binding(), interval=60), NOW,
                        source_time=NOW - timedelta(seconds=300))
        assert result.readings[0].quality == QUALITY_STALE

    def test_absent_source_time_cannot_be_stale(self) -> None:
        # The client's broker publishes no timestamp, so this check is inert there
        # and silence must be caught by the health sweeper instead.
        result = decode("t", {"pa": "10"}, resolution(binding()), NOW, source_time=None)
        assert result.readings[0].quality == QUALITY_GOOD
        assert result.readings[0].source_time is None

    def test_unmapped_keys_are_surfaced_not_silently_lost(self) -> None:
        result = decode("t", {"pa": "1", "unknown_key": "2"},
                        resolution(binding()), NOW)
        assert result.unmapped_keys == ["unknown_key"]
        assert len(result.readings) == 1

    def test_throttle_drops_a_reading_inside_min_interval(self) -> None:
        res = resolution(binding(min_interval_s=60))
        result = decode("t", {"pa": "1"}, res, NOW,
                        last_written={1: NOW - timedelta(seconds=10)})
        assert result.readings == []
        assert result.throttled_keys == ["pa"]

    def test_throttle_allows_a_reading_past_min_interval(self) -> None:
        res = resolution(binding(min_interval_s=60))
        result = decode("t", {"pa": "1"}, res, NOW,
                        last_written={1: NOW - timedelta(seconds=61)})
        assert len(result.readings) == 1

    def test_throttle_at_60s_against_the_observed_278ms_cadence(self) -> None:
        # The broker publishes every ~2.78s; with min_interval_s=60 only the first
        # of a 60s burst is kept. Asserted explicitly because the quantity of data
        # this discards is a deliberate decision, not an accident.
        res = resolution(binding(min_interval_s=60))
        kept = 0
        published = 0
        last: dict[int, datetime] = {}
        for step in range(23):  # 0..22 inclusive spans 61.2s at 2.78s intervals
            now = NOW + timedelta(seconds=2.78 * step)
            published += 1
            out = decode("t", {"pa": "1"}, res, now, last_written=dict(last))
            if out.readings:
                kept += 1
                last[1] = now
        # 23 messages arrive; 2 are stored. The ~91% discard rate is the direct
        # consequence of min_interval_s=60 against this broker's cadence, and is
        # asserted so that changing either value fails this test deliberately.
        assert (published, kept) == (23, 2)

    def test_negative_counter_delta_is_flagged_not_corrected(self) -> None:
        # A decrease is either a rollover or a meter replacement: indistinguishable
        # in data, opposite in meaning. Flag, never silently accept (OPEN-14).
        res = resolution(binding(cumulative=True))
        result = decode("t", {"pa": "100"}, res, NOW, last_counter_value={1: 500.0})
        assert result.suspect_counters == ["pa"]
        assert result.readings[0].value == 100.0  # still stored

    def test_rising_counter_is_not_suspect(self) -> None:
        res = resolution(binding(cumulative=True))
        result = decode("t", {"pa": "600"}, res, NOW, last_counter_value={1: 500.0})
        assert result.suspect_counters == []

    def test_empty_payload_is_quarantined(self) -> None:
        result = decode("t", {}, resolution(binding()), NOW)
        assert result.quarantined and result.readings == []

    def test_origin_is_never_read_from_the_payload(self) -> None:
        # A payload claiming another Client must not move the row. Origin came
        # from the topic before decode was called (Guardrail 5).
        payload = {"pa": "1", "client_id": "999", "plant": "OTHER", "device": "X"}
        result = decode("t", payload, resolution(binding()), NOW)
        assert [r.client_id for r in result.readings] == [3]
        assert [r.plant_id for r in result.readings] == [5]
        assert [r.device_id for r in result.readings] == [7]
        assert sorted(result.unmapped_keys) == ["client_id", "device", "plant"]

    def test_real_broker_payload_decodes_end_to_end(self) -> None:
        # Verbatim from KULAR_GREEN/DATA, with the observed CamelCase keys.
        bindings = [
            binding(source_key="VoltageRY", tag_id=10, tag_code="HV_VOLTAGE_RY"),
            binding(source_key="Frequency", tag_id=11, tag_code="FREQUENCY",
                    valid_min=45, valid_max=55),
            binding(source_key="AvgPowerFactor", tag_id=12, tag_code="POWER_FACTOR"),
        ]
        payload = {"VoltageRY": "11.366865", "Frequency": "50.018",
                   "AvgPowerFactor": "0.757", "CurrentR": "0.3535"}
        result = decode("KULAR_GREEN/DATA", payload, resolution(*bindings), NOW)
        assert len(result.readings) == 3
        assert all(r.quality == QUALITY_GOOD for r in result.readings)
        assert result.unmapped_keys == ["CurrentR"]


class TestPayloadShapes:
    """Both published shapes must decode identically (BACKEND_SPEC §6.2)."""

    def test_canonical_envelope_is_unwrapped(self) -> None:
        payload = {
            "device": "INV-01",
            "timestamp": "2026-09-10T13:40:46+05:30",
            "readings": [{"tag": "pa", "value": "1985"}],
        }
        result = decode("t", payload, resolution(binding(scale=0.1)), NOW)
        assert [r.value for r in result.readings] == [198.5]
        assert result.readings[0].source_time is not None

    def test_envelope_device_field_is_ignored(self) -> None:
        # The topic is the sole authority for origin. A payload naming a different
        # Device must not move the row (Guardrail 5).
        payload = {"device": "SOMEONE-ELSE", "readings": [{"tag": "pa", "value": "10"}]}
        result = decode("t", payload, resolution(binding()), NOW)
        assert [r.device_id for r in result.readings] == [7]

    def test_flat_payload_still_decodes(self) -> None:
        result = decode("t", {"pa": "10"}, resolution(binding()), NOW)
        assert [r.value for r in result.readings] == [10.0]

    def test_envelope_with_no_readings_is_quarantined(self) -> None:
        result = decode("t", {"device": "X", "readings": []}, resolution(binding()), NOW)
        assert result.quarantined

    def test_unparseable_envelope_timestamp_does_not_reject_the_message(self) -> None:
        # A drifted or malformed device clock is not a reason to lose the data;
        # readings.time (receipt) remains authoritative either way.
        payload = {"timestamp": "not-a-date", "readings": [{"tag": "pa", "value": "5"}]}
        result = decode("t", payload, resolution(binding()), NOW)
        assert len(result.readings) == 1
        assert result.readings[0].source_time is None
