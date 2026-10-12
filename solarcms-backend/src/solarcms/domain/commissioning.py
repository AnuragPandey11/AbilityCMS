"""What commissioning reads out of a Device code. Pure — no I/O.

Commissioning proposes; a person accepts (`cli commission-from-broker` is a dry
run until `--apply`). Everything here is therefore a *proposal* about a code the
broker carried — never a runtime inference about where a message came from,
which stays the topic's alone (Guardrail 5).
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Final

from solarcms.domain.assumptions import STRING_TOPIC_DEVICE_SUFFIX

_STRING_TOPIC: Final = re.compile(rf"^(?P<owner>.+?){STRING_TOPIC_DEVICE_SUFFIX}$")


def string_topic_owner(device_code: str) -> str | None:
    """The Device whose PV strings a topic carries, or None.

        INVERTER_1_STRING16 → INVERTER_1
        SMB1_STRING24       → SMB1
        INVERTER_1_STRING   → INVERTER_1
        INVERTER_1          → None

    ⚠ Without this, `INVERTER_1_STRING16` reads as an Inverter in its own right
    — it starts with `INVERTER` — and commissioning registers a second machine
    for every Inverter on the Plant, each carrying no power and every one of
    them ranked on Inverter Monitoring.
    """
    match = _STRING_TOPIC.match(device_code)
    return match.group("owner") if match else None


def own_topic_of(topic: str) -> str | None:
    """The topic a string topic's owner publishes its own readings on, or None.

        …/MCR/INVERTER_1_STRING16 → …/MCR/INVERTER_1
        …/MCR/INVERTER_1_STRING   → …/MCR/INVERTER_1
        …/MCR/INVERTER_1          → None

    Only the last segment changes: an owner sits in the same enclosure as its
    strings, and the topic decides the enclosure (Guardrail 13).

    ⚠ An Inverter that publishes on its own topic must be registered *there*,
    with this one attached. Registered on its string topic instead, its power,
    energy and voltages arrive on a topic it is not registered on, and every one
    of them is thrown away. Only equipment whose own topic never publishes (an
    SMB known only by `SMB1_STRING16`) is registered on a string topic.
    """
    head, separator, device_code = topic.rpartition("/")
    owner = string_topic_owner(device_code)
    if owner is None or not separator:
        return None
    return f"{head}/{owner}"


def match_device_type(device_code: str, type_codes: Iterable[str]) -> str | None:
    """Match a Device code against the Device Type catalogue.

    In order, the first rule that answers wins:

    1. **Exact** — `MFM` → MFM.
    2. **Prefix, longest first** — `INVERTER_7` → INVERTER, `WMS_WEST` → WMS.
    3. **A whole token** — `MAIN_MFM` → MFM, `ICOG_MFM` → MFM: the Type is one
       `_`-delimited part of the code (a unit number may follow it), and exactly
       one Type is. Two Types in one code (`VCB_MFM`) is a question, not an
       answer.
    4. **The code abbreviates exactly one Type** — `MCR` → MCR_SECTION. `M`
       must stay a question for the operator rather than silently becoming MFM,
       MCR_SECTION or MODULE_TRACKER.

    Returns None when nothing matches, which is a question for the operator
    rather than a default to fall back on.
    """
    codes = list(type_codes)
    upper = device_code.upper()

    if upper in codes:
        return upper
    forward = [c for c in codes if upper.startswith(c)]
    if forward:
        return max(forward, key=len)
    tokens = [
        c for c in codes
        if re.search(rf"(?:^|_){re.escape(c)}\d*(?:_|$)", upper)
    ]
    if len(tokens) == 1:
        return tokens[0]
    if tokens:
        return None
    reverse = [c for c in codes if c.startswith(upper)]
    return reverse[0] if len(reverse) == 1 else None
