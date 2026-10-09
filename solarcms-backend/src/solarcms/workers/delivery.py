"""MQTT delivery bookkeeping for ingest: acknowledge after commit, store once.

Pure — no network, no clock of its own — so the rules can be tested without a
broker.

── Why ingest acknowledges by hand ────────────────────────────────────────────
paho (under aiomqtt) sends PUBACK the moment a QoS 1 message arrives, and ingest
saves it up to `ingest_batch_max_seconds` later. A crash, or a database error
that ended the process, in that window lost the message for good: the broker
had been told it was delivered. With manual acknowledgement a message is
acknowledged only once the batch holding it has committed, so anything not yet
saved is redelivered when ingest reconnects (the session is persistent).

Measured on the client's broker, 8 Oct 2026: 56 of 64 messages arrive at QoS 1,
8 at QoS 0. QoS 0 has no acknowledgement and no redelivery — nothing can make
it safer than "written soon" — so a buffered QoS 0 row is never thrown away on
a reconnect; only the acknowledgements are generation-bound.

── Ordering ────────────────────────────────────────────────────────────────────
MQTT 3.1.1 §4.6: PUBACKs go in the order the PUBLISHes arrived. Every QoS 1
message therefore takes a place in the batch's ack list as it arrives — even
one whose readings were all throttled away and that writes nothing — and the
list is acknowledged front to back after the commit.

── Redelivery after a reconnect ────────────────────────────────────────────────
A message identifier belongs to one connection, so acknowledgements still
pending when the connection drops can never be sent; the broker resends those
messages on the next connection. Their rows are still in the buffer and will
be written, so the resent copies are recognised by fingerprint (topic and exact
payload) and acknowledged without being stored again. The expectation lapses
after `window_s`: a resend arrives first thing after a reconnect, and a later
message that merely repeats an earlier payload is a real one.
"""

from __future__ import annotations

import hashlib
from collections import Counter
from dataclasses import dataclass


def fingerprint(topic: str, payload: bytes) -> bytes:
    """A message's identity for redelivery: its topic and its exact payload."""
    digest = hashlib.blake2b(digest_size=16)
    digest.update(topic.encode("utf-8"))
    digest.update(b"\0")
    digest.update(payload)
    return digest.digest()


@dataclass(frozen=True, slots=True)
class PendingAck:
    """A QoS ≥ 1 message waiting for its batch to commit."""

    generation: int  # which connection delivered it — an mid means nothing on another
    mid: int
    qos: int
    fingerprint: bytes


class RedeliveryFilter:
    """Recognises the broker's resends of messages already buffered."""

    def __init__(self, window_s: float = 120.0) -> None:
        self.window_s = window_s
        self._expected: Counter[bytes] = Counter()
        self._until: float = 0.0

    def connection_lost(self, unacknowledged: list[PendingAck], now: float) -> None:
        """Expect a resend of each message whose acknowledgement can no longer go."""
        for pending in unacknowledged:
            self._expected[pending.fingerprint] += 1
        if unacknowledged:
            self._until = now + self.window_s

    def is_resend(self, print_: bytes, now: float) -> bool:
        """True, once per expected copy, for a message already buffered."""
        if now > self._until:
            self._expected.clear()
            return False
        if self._expected[print_] > 0:
            self._expected[print_] -= 1
            return True
        return False

    @property
    def expected(self) -> int:
        return sum(self._expected.values())
