"""What each PV string on an Inverter is doing, as a verdict. Pure — no I/O.

The String Analysis screen colours every string of every Inverter by one of
five states, and the rule behind those colours lives here so it can be tested
and replaced without touching a screen:

* **no_reading** — nothing fresh for this string: not bound, nothing received,
  or its last value is older than the Inverter's own hold. Never a zero.
* **no_current** — carries nothing while the Inverter is generating. The one
  state that is plainly a fault: a blown fuse, an open connector, a string
  shaded out entirely.
* **idle** — carries nothing, and nothing is expected: the Inverter is not
  generating. At night every string is idle, and calling each one "no current"
  would be a page of red about the sun having set.
* **low** — carries current, but less than `1 - STRING_DEVIATION_FRACTION` of
  the median of the same Inverter's producing strings.
* **normal** — anything else that carries current.

⚠ **Compared with its own Inverter's strings, never a fixed figure.** A string's
expected current depends on the sun at that minute, so an absolute threshold is
wrong most of the day; the strings beside it on the same Inverter see the same
sky, and the median of them is the fairest "expected" the data can offer. The
median is taken over strings **carrying current**: an Inverter with half its
strings dead still has a meaningful healthy median, where a median over the
zeros would be zero and would hide every low string beside them.

⚠ **Not judged in weak light.** Below `STRING_LOW_MIN_MEDIAN_A` a 20% gap is a
fraction of an amp and orientation alone produces it, so no string is called
low then — it is called normal, and the reason says why it was not compared.

⚠ PROPOSED. The client has supplied no rule for string health. The fraction is
the one already assumed for `STRING_CURRENT_DEVIATION` (`assumptions.py`), so a
string the screen calls low is the string that Alarm would describe, if it were
evaluated; the floor is new and equally assumed. Strings of different lengths
on one Inverter carry the same current (it is the voltage that differs), which
is why current, not power, is the measure; strings on differently oriented
MPPTs do not, and would read low here against a south-facing median.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import median
from typing import Literal

from solarcms.domain.assumptions import STRING_DEVIATION_FRACTION, STRING_LOW_MIN_MEDIAN_A

StringStateCode = Literal["normal", "low", "no_current", "idle", "no_reading"]

# In the order a reader should care about them: the screen counts and sorts by it.
STRING_STATES: tuple[StringStateCode, ...] = (
    "no_current", "low", "normal", "idle", "no_reading",
)


@dataclass(frozen=True)
class StringReading:
    """One string's latest good current, as the service found it."""

    n: int
    # Whether a PVn current Tag is bound on this Inverter at all. An unbound
    # string has no reading for a reason nobody at the Plant can fix by waiting.
    bound: bool
    current: float | None = None
    # When that value was measured (the start of its one-minute bucket).
    at: datetime | None = None
    # Flagged readings in the window — stored, never presented as a value, and
    # the difference between "nothing arrived" and "only nonsense arrived".
    flagged: int = 0


@dataclass(frozen=True)
class StringVerdict:
    n: int
    state: StringStateCode
    # A sentence, for a tooltip: why this state, in the terms of this string.
    reason: str
    # The value actually judged — None where it was absent or too old.
    current: float | None


def fresh(at: datetime | None, now: datetime, hold: timedelta) -> bool:
    """Whether a value measured at `at` still stands at `now`.

    `hold` is how long the Inverter's value is good for — the same span the
    operating rule and the health sweep use — so a string is never judged on a
    reading the Inverter itself would be called late for. The bucket is dated
    by its start, so a minute is added to reach its end.
    """
    return at is not None and now - at <= hold + timedelta(minutes=1)


def producing_median(currents: Sequence[float | None]) -> float | None:
    """The median of the strings carrying current, or None if none are."""
    carrying = [value for value in currents if value is not None and value > 0]
    return median(carrying) if carrying else None


def classify_strings(
    readings: Sequence[StringReading],
    *,
    generating: bool,
    generating_known: bool,
    now: datetime,
    hold: timedelta,
    unit: str = "A",
    low_fraction: float = STRING_DEVIATION_FRACTION,
    min_median: float = STRING_LOW_MIN_MEDIAN_A,
) -> tuple[list[StringVerdict], float | None]:
    """Every string's verdict, and the median the low ones were judged against.

    The median is None when no comparison was made — nothing carrying current,
    or too little light for a difference to mean anything.
    """
    currents = [
        reading.current if reading.bound and fresh(reading.at, now, hold) else None
        for reading in readings
    ]
    reference = producing_median(currents)
    compared = generating and reference is not None and reference >= min_median
    floor = (1.0 - low_fraction) * reference if compared and reference is not None else None

    verdicts: list[StringVerdict] = []
    for reading, current in zip(readings, currents, strict=True):
        verdicts.append(StringVerdict(
            reading.n,
            *_state(reading, current, generating=generating,
                    generating_known=generating_known, reference=reference,
                    floor=floor, min_median=min_median, unit=unit),
            current,
        ))
    return verdicts, reference if compared else None


def _state(
    reading: StringReading,
    current: float | None,
    *,
    generating: bool,
    generating_known: bool,
    reference: float | None,
    floor: float | None,
    min_median: float,
    unit: str,
) -> tuple[StringStateCode, str]:
    if not reading.bound:
        return "no_reading", (
            f"PV{reading.n} current is not bound on this Inverter, so nothing it "
            "sends for this string is decoded."
        )
    if current is None:
        if reading.current is not None:
            return "no_reading", (
                "Its last reading is older than this Inverter's reporting interval "
                "allows, so it is not judged."
            )
        if reading.flagged:
            return "no_reading", (
                f"{reading.flagged} reading(s) arrived and every one was flagged "
                "out of range, so none is shown as a value."
            )
        return "no_reading", "Nothing received for this string in the last 30 minutes."

    if current <= 0:
        if generating:
            return "no_current", (
                "No current while the Inverter is generating — shading, a blown "
                "fuse or an open connector."
            )
        if not generating_known:
            return "idle", (
                "No current. Whether the Inverter is generating is not known, so "
                "this is not called a fault."
            )
        return "idle", "No current, and none expected: the Inverter is not generating."

    if floor is not None and reference is not None and current < floor:
        below = 1.0 - current / reference
        return "low", (
            f"{below:.0%} below the median of this Inverter's producing strings "
            f"({reference:.2f} {unit})."
        )
    if not generating:
        return "normal", "Carrying current; the Inverter is not generating, so it is not compared."
    if reference is not None and reference < min_median:
        return "normal", (
            f"Carrying current. Not compared with its neighbours: their median "
            f"({reference:.2f} {unit}) is below {min_median:g} {unit}, too little "
            "light for a difference to mean anything."
        )
    return "normal", "Carrying current, within range of this Inverter's other strings."


def count_states(verdicts: Sequence[StringVerdict]) -> dict[str, int]:
    """How many strings are in each state — every state present, zero or not."""
    counts: dict[str, int] = dict.fromkeys(STRING_STATES, 0)
    for verdict in verdicts:
        counts[verdict.state] += 1
    return counts
