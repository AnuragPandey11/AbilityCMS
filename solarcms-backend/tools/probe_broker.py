"""Read-only probe of an MQTT broker: records topic shapes, payload keys, rates.

Purpose. Observation reveals the *shape* of data, never its *meaning*
(MASTER §5.4). This tool establishes shape — which topics exist, which keys
each carries, how often they publish, what magnitudes appear — so that the
ingress mapping is built on fact rather than guesswork. It cannot tell you a
unit, a scale factor, or whether a counter rolls over; those are OPEN-14/15 and
only the client can answer them.

It never writes to the broker and never subscribes outside the topic filter
given on the command line.

    python tools/probe_broker.py --host 122.180.254.239 --port 1883 \
        --topic 'KULAR_GREEN/#' --seconds 60 --out probe.json
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import statistics
import sys
import time
from collections import defaultdict
from typing import Any

import aiomqtt

from solarcms.domain.decoding import normalise_payload


class TopicObservation:
    """Accumulated facts about one topic."""

    def __init__(self) -> None:
        self.count = 0
        self.timestamps: list[float] = []
        self.first_payload: str | None = None
        self.keys: set[str] = set()
        self.value_ranges: dict[str, tuple[float, float]] = {}
        self.non_numeric_keys: set[str] = set()
        self.string_typed = False
        self.undecodable = 0

    def record(self, payload: bytes, now: float) -> None:
        self.count += 1
        self.timestamps.append(now)
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            self.undecodable += 1
            return
        if self.first_payload is None:
            self.first_payload = text[:2000]
        try:
            doc = json.loads(text)
        except json.JSONDecodeError:
            self.non_numeric_keys.add("<not json>")
            return
        if not isinstance(doc, dict):
            self.non_numeric_keys.add(f"<json {type(doc).__name__}>")
            return

        # ⚠ Reduce the envelope before reading keys, using the *same* function
        # ingest uses — never a copy of the rule.
        #
        # Two payload shapes are published (BACKEND_SPEC §6.2): the flat body
        # the client's test broker sends, and the canonical envelope the
        # contract specifies, `{device, timestamp, readings:[{tag, value}]}`.
        # Reading `doc.items()` directly is correct for the first and silently
        # wrong for the second: it records `device`, `timestamp` and `readings`
        # as this Device's three signals.
        #
        # That is not a cosmetic difference in a report. `commission-from-broker`
        # binds Tags from exactly these keys, so against an envelope publisher
        # it would register every Device with **zero bindings** — equipment that
        # exists, appears on every screen, and decodes nothing, which is
        # indistinguishable from equipment that is broken.
        flat, _timestamp = normalise_payload(doc)
        for key, raw in flat.items():
            self.keys.add(key)
            if isinstance(raw, str):
                self.string_typed = True
            # `normalise_payload` returns values as `object`, because a payload
            # can carry anything. Narrowed here rather than coerced: a nested
            # dict or a null is a fact about the publisher worth reporting, not
            # something to quietly drop on a failed float().
            if not isinstance(raw, str | int | float):
                self.non_numeric_keys.add(key)
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                self.non_numeric_keys.add(key)
                continue
            lo, hi = self.value_ranges.get(key, (value, value))
            self.value_ranges[key] = (min(lo, value), max(hi, value))

    def summary(self) -> dict[str, Any]:
        gaps = [
            b - a for a, b in zip(self.timestamps, self.timestamps[1:], strict=False)
        ]
        return {
            "messages": self.count,
            "median_interval_s": round(statistics.median(gaps), 3) if gaps else None,
            "min_interval_s": round(min(gaps), 3) if gaps else None,
            "max_interval_s": round(max(gaps), 3) if gaps else None,
            "key_count": len(self.keys),
            "keys": sorted(self.keys),
            "values_sent_as_strings": self.string_typed,
            "non_numeric_keys": sorted(self.non_numeric_keys),
            "undecodable_payloads": self.undecodable,
            "observed_ranges": {
                k: [round(lo, 6), round(hi, 6)] for k, (lo, hi) in sorted(self.value_ranges.items())
            },
            "first_payload": self.first_payload,
        }


async def probe(
    host: str, port: int, topic: str, seconds: float, username: str | None, password: str | None
) -> dict[str, Any]:
    observations: dict[str, TopicObservation] = defaultdict(TopicObservation)
    started = time.monotonic()

    async def consume() -> None:
        async with aiomqtt.Client(
            hostname=host,
            port=port,
            username=username,
            password=password,
            identifier=f"solarcms-probe-{int(time.time())}",
        ) as client:
            await client.subscribe(topic, qos=0)
            print(f"subscribed to {topic!r} on {host}:{port}", file=sys.stderr)
            async for message in client.messages:
                # aiomqtt types `payload` as any of str/bytes/bytearray/int/float
                # because MQTT itself is untyped. Only the bytes-like cases carry
                # a JSON body; anything else is recorded as an undecodable
                # payload rather than coerced into one.
                payload = message.payload
                if isinstance(payload, bytes | bytearray):
                    body = bytes(payload)
                elif isinstance(payload, str):
                    body = payload.encode()
                else:
                    body = b""
                observations[str(message.topic)].record(body, time.monotonic())

    with contextlib.suppress(TimeoutError):
        await asyncio.wait_for(consume(), timeout=seconds)

    elapsed = time.monotonic() - started
    return {
        "broker": f"{host}:{port}",
        "topic_filter": topic,
        "observed_seconds": round(elapsed, 1),
        "distinct_topics": len(observations),
        "total_messages": sum(o.count for o in observations.values()),
        "topics": {t: o.summary() for t, o in sorted(observations.items())},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--topic", required=True, help="MQTT topic filter, e.g. 'scms/v1/#'")
    parser.add_argument("--seconds", type=float, default=60.0)
    parser.add_argument("--username", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--out", default=None, help="write JSON here instead of stdout")
    args = parser.parse_args()

    report = asyncio.run(
        probe(args.host, args.port, args.topic, args.seconds, args.username, args.password)
    )
    text = json.dumps(report, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        print(f"wrote {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
