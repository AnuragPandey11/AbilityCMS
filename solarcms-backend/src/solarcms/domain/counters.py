"""Energy and irradiation over a period, from cumulative registers. Pure — no I/O.

A cumulative register (a meter's lifetime export, a weather station's
irradiation-so-far-today) answers "how much in this period" as the sum of its
*steps*, not as its highest reading minus its lowest. The difference matters
exactly when something has gone wrong, which is when the figure is read most
carefully:

* **A backwards step** is a rollover, a replaced meter or a reset. Those are
  indistinguishable in the data and opposite in meaning (MASTER §5.4), and the
  rollover maximum that would tell them apart is OPEN-14. So the step is not
  counted, and it is *reported* — never silently turned into a figure.
* **A step too large to be generation** — bigger than nameplate capacity could
  produce in the time between the two readings — is a counter that jumped, not
  a Plant that worked. Same treatment. It is the case "highest minus lowest"
  turned into a PR of 76,000% when a simulator restarted its counters.
* **Two meters are two registers.** A settlement meter and a check meter on one
  Plant each count their own number; subtracting one's reading from the
  other's is arithmetic on nothing. Each Device is integrated on its own, and
  one Device *Type* is chosen per Plant by precedence, so the Plant's energy is
  never the sum of two meters measuring the same power.

A daily register (irradiation) resets at midnight by design, so for it a
backwards step means "the day turned over": the reading after it is what has
accrued since, and it counts.

Nothing here corrects a figure. An excluded step leaves the total lower than the
truth, and the anomaly list says by how much it could not know.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from itertools import pairwise
from typing import Literal

from solarcms.domain.assumptions import (
    COUNTER_JUMP_CAPACITY_MARGIN,
    COUNTER_ROLLOVER_MAXIMUM,
    COUNTER_STEP_MIN_ELAPSED_S,
    MAX_IRRADIATION_KWH_PER_M2_PER_HOUR,
)

AnomalyKind = Literal["backwards", "implausible_jump"]


@dataclass(frozen=True, slots=True)
class CounterSample:
    at: datetime
    value: float


@dataclass(frozen=True, slots=True)
class CounterStep:
    """An accepted increment, stamped with the later reading's time — the time
    by which it had certainly accrued, which is how it is attributed to a day."""

    at: datetime
    amount: float


@dataclass(frozen=True, slots=True)
class CounterAnomaly:
    """A step refused as generation."""

    previous_at: datetime
    at: datetime
    from_value: float
    to_value: float
    kind: AnomalyKind
    # The most the step could plausibly have been, for `implausible_jump`.
    limit: float | None = None


@dataclass(frozen=True, slots=True)
class CounterIntegral:
    total: float
    steps: tuple[CounterStep, ...]
    anomalies: tuple[CounterAnomaly, ...]
    samples: int
    first: CounterSample | None
    last: CounterSample | None


def integrate_counter(
    samples: Sequence[CounterSample],
    *,
    max_rate_per_hour: float | None,
    resets_expected: bool = False,
    rollover_maximum: float | None = COUNTER_ROLLOVER_MAXIMUM,
) -> CounterIntegral:
    """Sum a register's steps, refusing the ones that cannot be what they claim.

    `max_rate_per_hour` is the fastest the register can legitimately climb — a
    Plant's AC capacity in kW for an energy counter. `None` switches the jump
    check off (capacity unknown); backwards steps are still refused.

    `resets_expected` is for a register that restarts from zero by design (a
    daily total): a backwards step then counts the reading after it.

    `rollover_maximum` is the value a lifetime counter wraps at — OPEN-14, and
    `None` until the client states it. When known, a backwards step is first
    read as a rollover, `(maximum - before) + after`, and counted if that
    passes the jump check; a replaced meter will usually fail it and be
    reported, which is the one distinction the maximum makes possible.
    """
    ordered = sorted(samples, key=lambda sample: sample.at)
    steps: list[CounterStep] = []
    anomalies: list[CounterAnomaly] = []
    total = 0.0

    for previous, current in pairwise(ordered):
        elapsed_s = max(
            (current.at - previous.at).total_seconds(), COUNTER_STEP_MIN_ELAPSED_S)
        limit = None if max_rate_per_hour is None else max_rate_per_hour * elapsed_s / 3600.0
        delta = current.value - previous.value

        if delta < 0:
            if resets_expected:
                # The register restarted between the two readings; what it reads
                # now is what has accrued since.
                delta = current.value
            elif rollover_maximum is not None:
                delta = (rollover_maximum - previous.value) + current.value
            else:
                anomalies.append(CounterAnomaly(
                    previous.at, current.at, previous.value, current.value, "backwards"))
                continue

        if limit is not None and delta > limit:
            anomalies.append(CounterAnomaly(
                previous.at, current.at, previous.value, current.value,
                "implausible_jump", limit))
            continue

        # Zero steps are kept: an hour whose readings did not move made nothing,
        # which is a different fact from an hour with no readings at all.
        steps.append(CounterStep(current.at, delta))
        total += delta

    return CounterIntegral(
        total=total, steps=tuple(steps), anomalies=tuple(anomalies),
        samples=len(ordered),
        first=ordered[0] if ordered else None,
        last=ordered[-1] if ordered else None,
    )


# ── A Plant's energy: one Device Type, every Device of it ──────────────────

@dataclass(frozen=True, slots=True)
class DeviceSeries:
    device_id: int
    device_code: str
    device_type_code: str
    tag_code: str
    samples: tuple[CounterSample, ...]
    # The Device's own nameplate, where recorded — an Inverter's ceiling is its
    # own rating, not the Plant's.
    rated_capacity_kw: float | None = None


@dataclass(frozen=True, slots=True)
class DeviceEnergy:
    series: DeviceSeries
    integral: CounterIntegral


@dataclass(frozen=True, slots=True)
class PassedOver:
    device_type_code: str
    reason: str


@dataclass(frozen=True, slots=True)
class PlantEnergy:
    """A Plant's energy and where it came from.

    `value` is None when no Type in the precedence could answer — never 0.0,
    because "made nothing" and "nothing to read" mean opposite things.
    """

    value: float | None
    device_type_code: str | None
    tag_code: str | None
    devices: tuple[DeviceEnergy, ...]
    passed_over: tuple[PassedOver, ...]
    undefined_reason: str | None = None
    # False when no capacity was known, so impossible jumps could not be caught.
    jump_check: bool = True

    @property
    def anomalies(self) -> tuple[tuple[DeviceSeries, CounterAnomaly], ...]:
        return tuple(
            (device.series, anomaly)
            for device in self.devices for anomaly in device.integral.anomalies
        )

    @property
    def steps(self) -> tuple[CounterStep, ...]:
        return tuple(step for device in self.devices for step in device.integral.steps)


def plant_energy(
    series: Sequence[DeviceSeries],
    precedence: Sequence[tuple[str, str]],
    *,
    plant_ac_capacity_kw: float | None,
) -> PlantEnergy:
    """The first (Device Type, Tag) in `precedence` that can answer, integrated
    per Device and summed across the Devices of that Type.

    Summed within a Type, as `services/plant_kpi` does: two settlement meters on
    one Plant export the sum of both. Never across Types: stopping at the first
    Type that answers is what keeps a meter total and an Inverter total from
    being added together. A Type "can answer" when at least one of its Devices
    has two readings in the period — one reading has no step to count.
    """
    by_pair: dict[tuple[str, str], list[DeviceSeries]] = {}
    for item in series:
        by_pair.setdefault((item.device_type_code, item.tag_code), []).append(item)

    passed: list[PassedOver] = []
    for type_code, tag_code in precedence:
        candidates = by_pair.get((type_code, tag_code), [])
        if not candidates:
            passed.append(PassedOver(
                type_code, f"no {type_code} reported {tag_code} in the period"))
            continue
        usable = [item for item in candidates if len(item.samples) >= 2]
        if not usable:
            passed.append(PassedOver(
                type_code,
                f"{type_code} reported fewer than two {tag_code} readings in the period"))
            continue

        jump_check = True
        devices: list[DeviceEnergy] = []
        for item in usable:
            # A meter sees the whole Plant; an Inverter sees itself.
            ceiling = item.rated_capacity_kw if type_code == "INVERTER" else None
            ceiling = ceiling or plant_ac_capacity_kw
            if not ceiling or ceiling <= 0:
                jump_check = False
                rate = None
            else:
                rate = ceiling * COUNTER_JUMP_CAPACITY_MARGIN
            devices.append(DeviceEnergy(
                item, integrate_counter(item.samples, max_rate_per_hour=rate)))

        return PlantEnergy(
            value=sum(device.integral.total for device in devices),
            device_type_code=type_code, tag_code=tag_code,
            devices=tuple(devices), passed_over=tuple(passed), jump_check=jump_check,
        )

    return PlantEnergy(
        value=None, device_type_code=None, tag_code=None, devices=(),
        passed_over=tuple(passed),
        undefined_reason="no energy counter in the precedence reported twice in the period",
    )


# ── A Plant's irradiation: the mean of its weather stations ────────────────

@dataclass(frozen=True, slots=True)
class PlantIrradiation:
    """kWh/m² over the period; None when no station reported twice."""

    value: float | None
    stations: tuple[DeviceEnergy, ...] = field(default_factory=tuple)
    undefined_reason: str | None = None


def plant_irradiation(series: Sequence[DeviceSeries]) -> PlantIrradiation:
    """Mean across stations of each one's integrated daily register.

    A mean, as the client's own PR formula uses (`AVG.GHI_CUMULATIVE`): two
    stations on one Plant measure the same sky, and summing them would double it.
    Integrated rather than maxed, because the register resets every midnight — the
    maximum over a month is one day's sun, not thirty.
    """
    stations = [
        DeviceEnergy(item, integrate_counter(
            item.samples, max_rate_per_hour=MAX_IRRADIATION_KWH_PER_M2_PER_HOUR,
            resets_expected=True))
        for item in series if len(item.samples) >= 2
    ]
    if not stations:
        return PlantIrradiation(None, (), "no weather station reported twice in the period")
    return PlantIrradiation(
        sum(station.integral.total for station in stations) / len(stations), tuple(stations))


def bucket_steps(
    steps: Sequence[CounterStep], label: Callable[[datetime], str],
) -> dict[str, float]:
    """Sum accepted steps under a label computed from each step's time — a
    Plant-local date for a daily Report, a local hour for an hourly one. The
    caller supplies the labelling so the timezone rule lives with the caller."""
    totals: dict[str, float] = {}
    for step in steps:
        name = label(step.at)
        totals[name] = totals.get(name, 0.0) + step.amount
    return totals
