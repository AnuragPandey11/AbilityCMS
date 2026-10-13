"""Who may be emailed about which Alarms. Pure — no I/O.

A subscription says "email this User about this Client's Alarms of at least
this severity", for one Plant or Client-wide. The rule this module holds is the
one every screen already obeys: **nobody is told about a Plant they cannot
see.** A Client Admin sees every Plant of their Client; anyone else sees only
the Plants assigned to them, and zero assignments means zero Plants (I-5).

The same rule is applied twice, on purpose: when a subscription is created,
so an administrator is told *why* one cannot be; and again when an email is
about to be queued (`services/notifications.queue_alarm_notifications`), because
access changes after the fact — a User loses a Plant, or leaves the Client —
and a subscription must not outlive the access it was granted under.
"""

from __future__ import annotations

from collections.abc import Collection
from dataclasses import dataclass
from typing import Final

#: Lowest first. A subscription at `medium` receives medium, high and critical.
SEVERITIES: Final = ("low", "medium", "high", "critical")
SEVERITY_RANK: Final = {severity: rank for rank, severity in enumerate(SEVERITIES)}

#: The channels a subscription may use today. WhatsApp and SMS exist in the
#: schema, but a User has no phone number on record and no provider is chosen
#: (MASTER §8.2), so a subscription on either could never be delivered.
CHANNELS: Final = ("email",)


@dataclass(frozen=True)
class Recipient:
    """A User as seen from one Client, at the moment of asking."""

    is_member: bool
    is_active: bool
    #: The role on *this* Client's membership; None when not a member.
    role_code: str | None
    #: Plants assigned to them on this Client. Ignored for a Client Admin.
    plant_ids: Collection[int]
    name: str = "This User"


def severities_received(min_severity: str) -> tuple[str, ...]:
    """The severities a subscription at `min_severity` is emailed about."""
    rank = SEVERITY_RANK[min_severity]
    return tuple(s for s in SEVERITIES if SEVERITY_RANK[s] >= rank)


def sees_every_plant(recipient: Recipient) -> bool:
    return recipient.role_code == "admin"


def refusal(recipient: Recipient, plant_id: int | None) -> str | None:
    """Why this User may not be emailed about `plant_id` (None: Client-wide).

    None when they may. The words are shown to an administrator as they are.
    """
    who = recipient.name
    if not recipient.is_member:
        return f"{who} is not a member of this Client."
    if not recipient.is_active:
        return f"{who} is disabled, so nothing would be sent."
    if sees_every_plant(recipient):
        return None
    if plant_id is None:
        return (f"{who} is not a Client Admin, so a subscription to every Plant "
                f"would email them about Plants they cannot see. Choose one of "
                f"their Plants instead.")
    if plant_id not in recipient.plant_ids:
        return (f"{who} cannot see that Plant. Assign it to them under Users "
                f"first, or choose one of their Plants.")
    return None
