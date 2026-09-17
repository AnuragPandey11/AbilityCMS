"""Topic parsing, value scaling, and quality classification. Pure — no I/O.

BACKEND_SPEC §6.3. Everything here is callable with plain Python values and
returns plain Python values, which is what makes it fully unit-testable.

Two rules from the specification shape this module:

* **The topic is the sole source of origin** (§6.1, Guardrail 5). The payload is
  never inspected to determine Client, Plant, Collector, or Device. A wrong
  inference silently merges one Client's data into another's history, which is
  unrecoverable and invisible.
* **Nothing is discarded.** Out-of-range and unparseable values are stored and
  flagged (§6.4) — `3.29151E-41` in a reactive-power Tag is diagnostic
  information, not noise.

The canonical topic contract is `scms/v1/{client_code}/{plant_code}/
{collector_code}/{device_code}`. The client's test broker does not use it (see
`docs/BROKER_OBSERVATIONS.md`), so topics are matched against a *registry* of
patterns rather than split positionally. The registry is data — rows, seeded per
deployment — so that a Client publishing a different shape is an INSERT, never a
code path named after them (I-1, Guardrail 2).
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Final

from solarcms.domain.assumptions import (
    NEGATIVE_DELTA_IS_SUSPECT,
    QUALITY_GOOD,
    QUALITY_OUT_OF_RANGE,
    QUALITY_STALE,
    QUALITY_UNPARSEABLE,
    STALE_SOURCE_TIME_MULTIPLIER,
)
from solarcms.domain.derived import DerivedTag, evaluate_all

# Field names a topic pattern may capture. A pattern using any other name is
# rejected at construction — a typo must not silently produce an unmatched topic.
CAPTURABLE_FIELDS: Final[frozenset[str]] = frozenset(
    {"client_code", "plant_code", "collector_code", "device_code", "category"}
)


class InvalidPattern(ValueError):
    """A topic pattern is malformed. Raised at registry load, never per message."""


@dataclass(frozen=True, slots=True)
class TopicPattern:
    """One row of the ingress registry: a topic shape and how to read it.

    Segments are matched positionally. A segment written `{field_name}` captures
    that segment's text; any other segment must match literally.

        scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}
        {plant_code}/{category}

    `priority` orders evaluation — lowest first — so the canonical contract can
    be matched ahead of a legacy shape that would also match.
    """

    pattern: str
    priority: int = 100

    def __post_init__(self) -> None:
        for segment in self.pattern.split("/"):
            if segment.startswith("{") and segment.endswith("}"):
                name = segment[1:-1]
                if name not in CAPTURABLE_FIELDS:
                    raise InvalidPattern(
                        f"pattern {self.pattern!r} captures unknown field {name!r}; "
                        f"expected one of {sorted(CAPTURABLE_FIELDS)}"
                    )
            elif "{" in segment or "}" in segment:
                raise InvalidPattern(
                    f"pattern {self.pattern!r} has a malformed segment {segment!r}"
                )

    def match(self, topic: str) -> dict[str, str] | None:
        """Return captured fields, or None if this pattern does not apply."""
        expected = self.pattern.split("/")
        actual = topic.split("/")
        if len(expected) != len(actual):
            return None
        captured: dict[str, str] = {}
        for want, got in zip(expected, actual, strict=True):
            if want.startswith("{"):
                if not got:
                    return None  # an empty segment identifies nothing
                captured[want[1:-1]] = got
            elif want != got:
                return None
        return captured


def parse_topic(topic: str, patterns: list[TopicPattern]) -> dict[str, str] | None:
    """Match a topic against the registry, lowest `priority` first.

    Returns the captured origin fields, or None when no pattern applies — which
    the caller must treat as quarantine, never as a reason to guess (§5.1).
    """
    for pattern in sorted(patterns, key=lambda p: p.priority):
        captured = pattern.match(topic)
        if captured is not None:
            return captured
    return None


@dataclass(frozen=True, slots=True)
class TagBinding:
    """What a specific Device was actually wired as.

    Per-Device, not per-Model: the Model's Tag defaults are a template, and field
    wiring never matches the datasheet (MASTER §3.5). Two Devices of one Model on
    different firmware may bind the same Tag to different source keys and scales,
    and both are correct.
    """

    source_key: str
    tag_id: int
    tag_code: str
    scale: float = 1.0
    offset: float = 0.0
    valid_min: float | None = None
    valid_max: float | None = None
    min_interval_s: int = 0
    cumulative: bool = False


@dataclass(frozen=True, slots=True)
class DerivedBinding:
    """A Tag this Device computes rather than receives.

    Present when the Tag registry carries a device-scope formula and every input
    that formula reads is bound on this Device. Nothing is configured per Device:
    a meter that publishes three phase voltages gets AVG VOLTAGE computed because
    it has the inputs, and a VCB — which publishes nothing but contacts — gets
    nothing, because it has none of them.
    """

    tag_id: int
    tag_code: str
    expression: str
    valid_min: float | None = None
    valid_max: float | None = None
    min_interval_s: int = 0


@dataclass(frozen=True, slots=True)
class DeviceResolution:
    """Everything needed to decode one Device's payload, resolved upstream.

    Assembled by the worker from the database (cached in Redis, §6.3 rule 3) and
    passed in, so that this module performs no I/O.
    """

    device_id: int
    client_id: int
    plant_id: int
    expected_interval_s: int
    bindings: dict[str, TagBinding]  # source key → binding
    # Tags this Device computes. Empty for most Devices.
    derived: tuple[DerivedBinding, ...] = ()
    # Values a formula may read that are not Tags: the Device's own rated
    # capacity (the client writes it `INV_CAPACITY`), and its Plant's.
    constants: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class DecodedReading:
    """One row destined for `readings`, plus the alarm stream and Redis."""

    device_id: int
    client_id: int
    plant_id: int
    tag_id: int
    tag_code: str
    value: float
    quality: int
    time: datetime  # receipt — the authoritative index column
    source_time: datetime | None  # device clock; NULL where none is published


@dataclass(slots=True)
class DecodeResult:
    """Outcome of decoding one message."""

    readings: list[DecodedReading] = field(default_factory=list)
    rejection: str | None = None  # set → quarantine to mqtt_raw, raise an Alarm
    unmapped_keys: list[str] = field(default_factory=list)  # published, not bound
    throttled_keys: list[str] = field(default_factory=list)  # dropped by min_interval_s
    suspect_counters: list[str] = field(default_factory=list)  # negative delta

    @property
    def quarantined(self) -> bool:
        return self.rejection is not None


def normalise_payload(payload: dict[str, object]) -> tuple[dict[str, object], str | None]:
    """Reduce either published payload shape to flat {source_key: value}.

    Two shapes exist and both must work:

    * **The canonical envelope** (BACKEND_SPEC §6.2), which the contract we hand
      the client specifies::

          {"device": "INV-01", "timestamp": "...",
           "readings": [{"tag": "AC_ACTIVE_POWER", "value": "1985"}]}

    * **Flat**, which is what the client's test broker actually publishes today::

          {"VoltageRY": "11.36", "Frequency": "50.01"}

    Returns the flat values and the payload timestamp, if any.

    ⚠ The envelope's `device` field is deliberately **ignored**. The topic is the
    sole authority for origin (Guardrail 5); trusting a payload field here would
    let a mislabelled message write into another Device's history, and nothing
    downstream could detect it.
    """
    readings = payload.get("readings")
    if not isinstance(readings, list):
        return payload, None  # already flat

    flat: dict[str, object] = {}
    for item in readings:
        if not isinstance(item, dict):
            continue
        tag = item.get("tag")
        if isinstance(tag, str):
            flat[tag] = item.get("value")

    timestamp = payload.get("timestamp")
    return flat, timestamp if isinstance(timestamp, str) else None


def coerce_value(raw: object) -> float | None:
    """Coerce a published value to a float, or None if it cannot be read.

    The client's systems transmit numbers as strings — `"336"`, not `336`
    (MASTER §9.5) — so string input is the normal case, not an error. Booleans
    are accepted because status Tags legitimately arrive as JSON true/false.
    """
    if isinstance(raw, bool):
        return 1.0 if raw else 0.0
    if isinstance(raw, int | float):
        value = float(raw)
    elif isinstance(raw, str):
        try:
            value = float(raw.strip())
        except ValueError:
            return None
    else:
        return None
    # NaN and infinity are not storable values; they are unparseable input.
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return value


def apply_scaling(raw_value: float, binding: TagBinding) -> float:
    """Apply the Device's own scale and offset."""
    return raw_value * binding.scale + binding.offset


def classify_quality(
    value: float | None,
    binding: TagBinding,
    *,
    now: datetime,
    source_time: datetime | None,
    expected_interval_s: int,
) -> int:
    """Classify a value per §6.4. Order matters: unparseable dominates.

    Staleness is only assessable where the publisher sends a timestamp. The
    client's test broker sends none, so this check is inert for that source and
    silence is caught by the health sweeper instead.
    """
    if value is None:
        return QUALITY_UNPARSEABLE
    if binding.valid_min is not None and value < binding.valid_min:
        return QUALITY_OUT_OF_RANGE
    if binding.valid_max is not None and value > binding.valid_max:
        return QUALITY_OUT_OF_RANGE
    if source_time is not None:
        limit = timedelta(seconds=expected_interval_s * STALE_SOURCE_TIME_MULTIPLIER)
        if now - source_time > limit:
            return QUALITY_STALE
    return QUALITY_GOOD


def decode(
    topic: str,
    payload: dict[str, object],
    resolver: DeviceResolution,
    now: datetime,
    *,
    source_time: datetime | None = None,
    last_written: dict[int, datetime] | None = None,
    last_counter_value: dict[int, float] | None = None,
    standing: dict[str, float] | None = None,
) -> DecodeResult:
    """Decode one message into Readings. No I/O; fully unit-testable.

    `last_written` and `last_counter_value` are keyed by `tag_id` for this
    Device, supplied by the caller from Redis. They are read, never mutated —
    the caller owns that state.

    Note what is *not* here: nothing reads Client, Plant, or Device from
    `payload`. Origin came from the topic before this function was called, and
    `topic` is retained only for the quarantine message.
    """
    result = DecodeResult()

    if not isinstance(payload, dict):
        result.rejection = f"payload on {topic!r} is not a JSON object"
        return result
    if not payload:
        result.rejection = f"payload on {topic!r} is empty"
        return result

    # Accept either the canonical envelope or a flat body (see normalise_payload).
    values, envelope_timestamp = normalise_payload(payload)
    if not values:
        result.rejection = f"payload on {topic!r} carried no readings"
        return result
    if source_time is None and envelope_timestamp is not None:
        with contextlib.suppress(ValueError):
            source_time = datetime.fromisoformat(envelope_timestamp)

    last_written = last_written or {}
    last_counter_value = last_counter_value or {}

    for source_key, raw in values.items():
        binding = resolver.bindings.get(source_key)
        if binding is None:
            # Published but not bound. Not an error: a Device may report more
            # than has been mapped. Surfaced so commissioning can complete the
            # bindings rather than silently losing the Tag.
            result.unmapped_keys.append(source_key)
            continue

        # Throttle before doing any further work. A Tag's min_interval_s is the
        # deliberate write rate; the broker may publish far faster.
        written_at = last_written.get(binding.tag_id)
        if (
            binding.min_interval_s > 0
            and written_at is not None
            and (now - written_at) < timedelta(seconds=binding.min_interval_s)
        ):
            result.throttled_keys.append(source_key)
            continue

        coerced = coerce_value(raw)
        value = apply_scaling(coerced, binding) if coerced is not None else None
        quality = classify_quality(
            value,
            binding,
            now=now,
            source_time=source_time,
            expected_interval_s=resolver.expected_interval_s,
        )

        # A counter that decreases is either a rollover or a meter replacement.
        # Those are indistinguishable in the stream and opposite in meaning
        # (MASTER §5.4, OPEN-14), so neither is assumed: flag, never correct.
        if binding.cumulative and value is not None and NEGATIVE_DELTA_IS_SUSPECT:
            previous = last_counter_value.get(binding.tag_id)
            if previous is not None and value < previous:
                result.suspect_counters.append(source_key)

        result.readings.append(
            DecodedReading(
                device_id=resolver.device_id,
                client_id=resolver.client_id,
                plant_id=resolver.plant_id,
                tag_id=binding.tag_id,
                tag_code=binding.tag_code,
                # An unparseable value is still a row: the quality flag carries
                # the fact, and a gap in the series would hide it.
                value=value if value is not None else 0.0,
                quality=quality,
                time=now,
                source_time=source_time,
            )
        )

    result.readings.extend(
        derive(resolver, result.readings, now, source_time=source_time,
               standing=standing, last_written=last_written)
    )
    return result


def derive(
    resolver: DeviceResolution,
    readings: list[DecodedReading],
    now: datetime,
    *,
    source_time: datetime | None = None,
    standing: dict[str, float] | None = None,
    last_written: dict[int, datetime] | None = None,
) -> list[DecodedReading]:
    """Compute this Device's calculated Tags from what it just published.

    `standing` is the Device's last known value per Tag code, so a formula whose
    inputs arrive in *different* messages still resolves — the client's broker
    splits voltages and power across separate topics, and requiring every input
    in one payload would mean AVG VOLTAGE never computed at all.

    A published value always beats a computed one: if this Device genuinely
    transmits AVG VOLTAGE, `evaluate_all` leaves it alone. That is what makes
    this safe to run for every Device without a per-Device switch.
    """
    if not resolver.derived:
        return []

    values: dict[str, float] = dict(standing or {})
    values.update(resolver.constants)
    # This message wins over anything standing: it is the newer measurement.
    values.update({r.tag_code: r.value for r in readings if r.quality == QUALITY_GOOD})

    computed = evaluate_all(
        [DerivedTag(d.tag_code, d.expression, "device") for d in resolver.derived],
        values,
    )
    written_at_by_tag = last_written or {}
    out: list[DecodedReading] = []
    for spec in resolver.derived:
        value = computed.get(spec.tag_code)
        if value is None:
            continue
        # A computed Tag is throttled by its own min_interval_s exactly as a
        # received one is. Without this, a broker publishing every 2.8s would
        # produce a derived row per formula per message — the throttle a Device's
        # own Tags observe, silently bypassed by the values we add ourselves.
        written_at = written_at_by_tag.get(spec.tag_id)
        if (
            spec.min_interval_s > 0
            and written_at is not None
            and (now - written_at) < timedelta(seconds=spec.min_interval_s)
        ):
            continue
        # Range checking applies to a computed value exactly as it does to a
        # received one. A DC POWER of 40,000 kW from a 3% efficiency reading is
        # not a measurement, and it must be stored and flagged, never dropped.
        quality = QUALITY_GOOD
        if spec.valid_min is not None and value < spec.valid_min:
            quality = QUALITY_OUT_OF_RANGE
        elif spec.valid_max is not None and value > spec.valid_max:
            quality = QUALITY_OUT_OF_RANGE
        out.append(DecodedReading(
            device_id=resolver.device_id,
            client_id=resolver.client_id,
            plant_id=resolver.plant_id,
            tag_id=spec.tag_id,
            tag_code=spec.tag_code,
            value=value,
            quality=quality,
            time=now,
            source_time=source_time,
        ))
    return out
