"""Grid, Plant and Inverter availability — three levels, judged as a chain.

⚠ PROPOSED (1 Nov 2026). The three definitions are the client's; every number
and every rule for reading them from data is ours, pending OPEN-16, with the
numbers in `assumptions.py`:

* **Grid** — available when the grid meter's frequency is within limits and
  its voltage is present (`AVAILABILITY_GRID_FREQUENCY_HZ`; no voltage band
  until a Plant records its nominal voltage). Only an HV meter is asked (the
  service chooses ABT Meter, else the solar MFMs bound to `HV_VOLTAGE_*`): an
  LT meter sits on the Plant's side and cannot tell the grid from the Plant.
* **Plant** — given a grid, able to generate: unavailable when no Inverter is
  producing while Inverters report, or when every reporting breaker is open.
  One Inverter down is not the Plant down.
* **Inverter** — given a grid and a Plant, each Inverter producing; the Plant
  figure is weighted by each Inverter's rated AC capacity where every one is
  recorded, else by count.

**One lost minute is blamed once.** Each level is judged only over the minutes
the level above it was up: a grid outage costs the grid and nobody else, a
Plant-wide stop costs the Plant and not its Inverters.

Rules every level keeps:

* **Daylight only** — the brightest measuring station's GHI at or above
  `AVAILABILITY_DAYLIGHT_W_PER_M2`, else the sun above
  `AVAILABILITY_DAYLIGHT_SUN_ELEVATION_DEG` at the Plant's location. A station
  that never reached the threshold while the sun was up is not measuring
  (VARDHMAN_GROUP's dead GTI, BROKER_OBSERVATIONS §8.5) and is not asked. With
  neither, a minute is `no_sun` — never judged.
* **No data is never downtime** (Guardrail 16). A minute nothing was heard in
  is counted beside the figure, never in it.
* **Stops shorter than `INVERTER_DOWNTIME_MIN_MINUTES` are not counted**, at the
  Plant level as at the Inverter's: daylight is reached minutes before the
  Inverters wake, and without it every Plant would lose a few minutes a day.
* **Planned work and curtailment** (the PPC holding output at zero with control
  enabled) are neither available nor down.
* **An open breaker with no grid reading is nobody's** — `unattributed`: a grid
  outage that tripped it and a Plant trip with the meter downstream look the
  same, and which it was is the client's to say (who a breaker trip is blamed
  on). Reported, never resolved.

⚠ **The one place a refused reading is used.** A meter that stays powered
through an outage sends 0 Hz, which is outside the frequency range and stored
flagged. Read as "no data", every outage would vanish and the grid would read
100% through the very events it exists to catch — so for the grid a reading at
zero (`AVAILABILITY_ZERO_FRACTION` of its range), flagged or not, is the grid
absent. Any other flagged grid reading is no data, as everywhere else.

Pure: minute indices and floats in, tallies out. Tallies add, so a month is
the sum of its days — and a ratio of summed minutes, never a mean of daily
percentages. `services/availability.py` does the reading and the keeping.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from solarcms.domain.assumptions import (
    AVAILABILITY_CURTAILED_AT_OR_BELOW_KW,
    AVAILABILITY_DAYLIGHT_SUN_ELEVATION_DEG,
    AVAILABILITY_DAYLIGHT_W_PER_M2,
    AVAILABILITY_GRID_FREQUENCY_HZ,
    INVERTER_DOWNTIME_MIN_MINUTES,
    INVERTER_PRODUCING_ABOVE_KW,
)

VARIANT = "grid_plant_inverter_proposed"

_NO_DATA, _UP, _DOWN = 0, 1, 2


# ── What goes in ────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Buckets:
    """One Device's one-minute buckets of one Tag.

    `minutes` are indices from the window's first minute, ascending; a negative
    one is a bucket before the window, which is how a value held across its
    start is known. Each bucket holds for `hold_minutes` after it.
    """

    device_id: int
    hold_minutes: int
    minutes: Sequence[int]
    low: Sequence[float]
    high: Sequence[float]
    mean: Sequence[float]
    flagged: Sequence[bool] = ()


@dataclass(frozen=True, slots=True)
class Meter:
    """A grid meter's frequency and phase voltages, each with what counts as zero."""

    device_id: int
    frequency: Buckets | None
    voltages: Sequence[Buckets] = ()
    frequency_zero: float = 0.0
    voltage_zero: float = 0.0


@dataclass(frozen=True, slots=True)
class Controller:
    """A PPC's active power control enable and setpoint."""

    device_id: int
    enable: Buckets | None
    setpoint: Buckets | None


@dataclass(frozen=True, slots=True)
class Inverter:
    """An Inverter's AC output (good buckets only) and its planned work."""

    device_id: int
    power: Buckets
    planned: Sequence[tuple[int, int]] = ()


@dataclass(frozen=True, slots=True)
class PlantMinutes:
    """Everything one window of one Plant is judged from."""

    minutes: int
    stations: Sequence[Buckets] = ()
    #: The sun's elevation in each minute, where the Plant's location is known.
    sun_elevation: Sequence[float] | None = None
    meters: Sequence[Meter] = ()
    breakers: Sequence[Buckets] = ()
    controllers: Sequence[Controller] = ()
    inverters: Sequence[Inverter] = ()
    #: Planned work on the whole Plant, as [start, end) minute ranges.
    planned: Sequence[tuple[int, int]] = ()


# ── What comes out ──────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Level:
    """One level's minutes: judged with data, of those down, and with no data."""

    judged: int = 0
    down: int = 0
    no_data: int = 0

    def __add__(self, other: Level) -> Level:
        return Level(self.judged + other.judged, self.down + other.down,
                     self.no_data + other.no_data)

    def to_json(self) -> list[int]:
        return [self.judged, self.down, self.no_data]

    @classmethod
    def from_json(cls, raw: Sequence[Any]) -> Level:
        return cls(int(raw[0]), int(raw[1]), int(raw[2]))


@dataclass(frozen=True, slots=True)
class Tally:
    """A window's minutes at every level. Tallies add: a month is its days summed."""

    daylight: int = 0
    no_sun: int = 0
    grid: Level = field(default_factory=Level)
    plant: Level = field(default_factory=Level)
    #: Breaker open with no grid reading to say whose it was.
    unattributed: int = 0
    curtailed: int = 0
    planned: int = 0
    #: Plant minutes judged with nothing saying whether the grid was there.
    plant_without_grid: int = 0
    inverters: Mapping[int, Level] = field(default_factory=dict)

    def __add__(self, other: Tally) -> Tally:
        inverters = dict(self.inverters)
        for device_id, level in other.inverters.items():
            inverters[device_id] = inverters.get(device_id, Level()) + level
        return Tally(
            daylight=self.daylight + other.daylight,
            no_sun=self.no_sun + other.no_sun,
            grid=self.grid + other.grid,
            plant=self.plant + other.plant,
            unattributed=self.unattributed + other.unattributed,
            curtailed=self.curtailed + other.curtailed,
            planned=self.planned + other.planned,
            plant_without_grid=self.plant_without_grid + other.plant_without_grid,
            inverters=inverters,
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "daylight": self.daylight, "no_sun": self.no_sun,
            "grid": self.grid.to_json(), "plant": self.plant.to_json(),
            "unattributed": self.unattributed, "curtailed": self.curtailed,
            "planned": self.planned, "plant_without_grid": self.plant_without_grid,
            "inverters": {str(k): v.to_json() for k, v in self.inverters.items()},
        }

    @classmethod
    def from_json(cls, raw: Mapping[str, Any]) -> Tally:
        return cls(
            daylight=int(raw["daylight"]), no_sun=int(raw["no_sun"]),
            grid=Level.from_json(raw["grid"]), plant=Level.from_json(raw["plant"]),
            unattributed=int(raw["unattributed"]), curtailed=int(raw["curtailed"]),
            planned=int(raw["planned"]), plant_without_grid=int(raw["plant_without_grid"]),
            inverters={int(k): Level.from_json(v) for k, v in raw["inverters"].items()},
        )


@dataclass(frozen=True, slots=True)
class Figure:
    value: float | None
    reason: str | None = None


# ── The fold ────────────────────────────────────────────────────────────────


class _Cursor:
    """Walks one series minute by minute: the bucket in force at `t`, if any."""

    __slots__ = ("series", "pointer")

    def __init__(self, series: Buckets) -> None:
        self.series = series
        self.pointer = 0

    def at(self, t: int) -> int | None:
        minutes = self.series.minutes
        p = self.pointer
        while p < len(minutes) and minutes[p] <= t:
            p += 1
        self.pointer = p
        if p == 0 or t - minutes[p - 1] > self.series.hold_minutes:
            return None
        return p - 1


class _Run:
    """A stop in progress; counted as down only once it is long enough."""

    __slots__ = ("length", "down", "min_stop")

    def __init__(self, min_stop: int) -> None:
        self.length = 0
        self.down = 0
        self.min_stop = min_stop

    def close(self) -> None:
        if self.length >= self.min_stop:
            self.down += self.length
        self.length = 0


def _mask(ranges: Sequence[tuple[int, int]], minutes: int) -> bytearray | None:
    if not ranges:
        return None
    mask = bytearray(minutes)
    for start, end in ranges:
        for t in range(max(0, start), min(minutes, end)):
            mask[t] = 1
    return mask


def _measuring(station: Buckets, sun: Sequence[float] | None, minutes: int,
               daylight_w: float, daylight_deg: float) -> bool:
    """False for a station that never reached daylight while the sun was up."""
    if sun is None or not any(e >= daylight_deg for e in sun[:minutes]):
        return True
    return any(
        value >= daylight_w for at, value in zip(station.minutes, station.mean, strict=False)
        if 0 <= at < minutes
    )


def _meter_state(signals: Sequence[tuple[_Cursor, float, bool]], t: int,
                 band: tuple[float, float]) -> int:
    seen_up = False
    for cursor, zero, is_frequency in signals:
        i = cursor.at(t)
        if i is None:
            continue
        b = cursor.series
        if abs(b.low[i]) <= zero:
            return _DOWN  # absent — flagged or not: the refusal is the evidence
        if b.flagged and b.flagged[i]:
            continue
        if is_frequency and not (band[0] <= b.low[i] and b.high[i] <= band[1]):
            return _DOWN
        seen_up = True
    return _UP if seen_up else _NO_DATA


def fold(
    plant: PlantMinutes,
    *,
    daylight_w: float = AVAILABILITY_DAYLIGHT_W_PER_M2,
    daylight_deg: float = AVAILABILITY_DAYLIGHT_SUN_ELEVATION_DEG,
    frequency_band: tuple[float, float] = AVAILABILITY_GRID_FREQUENCY_HZ,
    producing_above_kw: float = INVERTER_PRODUCING_ABOVE_KW,
    curtailed_at_or_below_kw: float = AVAILABILITY_CURTAILED_AT_OR_BELOW_KW,
    min_stop_minutes: int = INVERTER_DOWNTIME_MIN_MINUTES,
) -> Tally:
    """Fold one window of one Plant, minute by minute, into its three levels."""
    n = plant.minutes
    sun = plant.sun_elevation
    stations = [_Cursor(s) for s in plant.stations
                if _measuring(s, sun, n, daylight_w, daylight_deg)]
    meters: list[list[tuple[_Cursor, float, bool]]] = []
    for m in plant.meters:
        signals = [(_Cursor(v), m.voltage_zero, False) for v in m.voltages]
        if m.frequency is not None:
            signals.insert(0, (_Cursor(m.frequency), m.frequency_zero, True))
        meters.append(signals)
    breakers = [_Cursor(b) for b in plant.breakers]
    controllers = [
        (_Cursor(c.enable), _Cursor(c.setpoint))
        for c in plant.controllers if c.enable is not None and c.setpoint is not None
    ]
    inverters = [_Cursor(inv.power) for inv in plant.inverters]
    inverter_masks = [_mask(inv.planned, n) for inv in plant.inverters]
    plant_mask = _mask(plant.planned, n)

    daylight = no_sun = unattributed = curtailed = planned = without_grid = 0
    grid_judged = grid_down = grid_no_data = 0
    plant_judged = plant_no_data = 0
    plant_run = _Run(min_stop_minutes)
    inv_judged = [0] * len(inverters)
    inv_no_data = [0] * len(inverters)
    inv_runs = [_Run(min_stop_minutes) for _ in inverters]

    def close_inverters() -> None:
        for run in inv_runs:
            run.close()

    def close_all() -> None:
        plant_run.close()
        close_inverters()

    for t in range(n):
        # ── Is it daylight?
        brightest: float | None = None
        for cursor in stations:
            i = cursor.at(t)
            if i is not None:
                value = cursor.series.mean[i]
                brightest = value if brightest is None else max(brightest, value)
        if brightest is not None:
            is_day = brightest >= daylight_w
        elif sun is not None:
            is_day = sun[t] >= daylight_deg
        else:
            no_sun += 1
            close_all()
            continue
        if not is_day:
            close_all()
            continue
        daylight += 1

        # ── The grid, and the breakers at the Plant's boundary.
        grid: int | None = None
        if meters:
            states = [_meter_state(signals, t, frequency_band) for signals in meters]
            grid = (_UP if _UP in states else _DOWN if _DOWN in states else _NO_DATA)
        reporting_breakers = open_breakers = 0
        for cursor in breakers:
            i = cursor.at(t)
            if i is not None:
                reporting_breakers += 1
                open_breakers += cursor.series.mean[i] < 0.5
        all_open = reporting_breakers > 0 and open_breakers == reporting_breakers

        if all_open and grid != _UP:
            unattributed += 1
            close_all()
            continue
        if grid == _NO_DATA:
            grid_no_data += 1
        elif grid is not None:
            grid_judged += 1
            if grid == _DOWN:
                grid_down += 1
                close_all()
                continue

        # ── The Plant, given a grid.
        if plant_mask is not None and plant_mask[t]:
            planned += 1
            close_all()
            continue
        if any(
            (i := enable.at(t)) is not None and enable.series.mean[i] >= 0.5
            and (j := setpoint.at(t)) is not None
            and setpoint.series.mean[j] <= curtailed_at_or_below_kw
            for enable, setpoint in controllers
        ):
            curtailed += 1
            close_all()
            continue
        states = []
        for cursor in inverters:
            i = cursor.at(t)
            states.append(
                _NO_DATA if i is None
                else _UP if cursor.series.high[i] > producing_above_kw else _DOWN
            )
        if all_open:
            plant_up = False
        elif _UP in states:
            plant_up = True
        elif _DOWN in states:
            plant_up = False
        else:
            plant_no_data += 1
            close_all()
            continue
        plant_judged += 1
        if grid is None or grid == _NO_DATA:
            without_grid += 1
        if not plant_up:
            plant_run.length += 1
            close_inverters()
            continue
        plant_run.close()

        # ── Each Inverter, given a grid and a Plant.
        for k, state in enumerate(states):
            mask = inverter_masks[k]
            if mask is not None and mask[t]:
                inv_runs[k].close()
            elif state == _NO_DATA:
                inv_no_data[k] += 1
                inv_runs[k].close()
            elif state == _UP:
                inv_judged[k] += 1
                inv_runs[k].close()
            else:
                inv_judged[k] += 1
                inv_runs[k].length += 1

    close_all()
    return Tally(
        daylight=daylight, no_sun=no_sun,
        grid=Level(grid_judged, grid_down, grid_no_data),
        plant=Level(plant_judged, plant_run.down, plant_no_data),
        unattributed=unattributed, curtailed=curtailed, planned=planned,
        plant_without_grid=without_grid,
        inverters={
            inv.device_id: Level(inv_judged[k], inv_runs[k].down, inv_no_data[k])
            for k, inv in enumerate(plant.inverters)
        },
    )


# ── The three figures ───────────────────────────────────────────────────────


def figures(
    tally: Tally, *, has_meter: bool, weights: Mapping[int, float | None],
) -> tuple[Figure, Figure, Figure, str]:
    """Grid, Plant and Inverter availability from a tally, and how Inverters
    were weighted ("capacity" or "count"). Undefined with a reason, never 1.0,
    where nothing was judged."""
    if not has_meter:
        grid = Figure(None, "no grid meter measuring HV voltage or frequency is registered")
    elif tally.daylight == 0:
        grid = Figure(None, "no daylight in this period yet")
    elif tally.grid.judged == 0:
        grid = Figure(None, "the grid meter sent nothing usable in daylight")
    else:
        grid = Figure((tally.grid.judged - tally.grid.down) / tally.grid.judged)

    if tally.daylight == 0:
        plant = Figure(None, "no daylight in this period yet"
                       if tally.no_sun == 0 else
                       "no weather station is measuring and no location is recorded, "
                       "so daylight cannot be told from a stoppage")
    elif tally.plant.judged == 0:
        plant = Figure(None, "no daylight minute with the grid there and Inverters reporting")
    else:
        plant = Figure((tally.plant.judged - tally.plant.down) / tally.plant.judged)

    basis = (
        "capacity"
        if weights and all(w is not None and w > 0 for w in weights.values())
        else "count"
    )
    if len(weights) < 2:
        inverter = Figure(None, "only one Inverter at this Plant: its stops are the Plant's")
    else:
        numerator = denominator = 0.0
        for device_id, level in tally.inverters.items():
            weight = (weights.get(device_id) or 0.0) if basis == "capacity" else 1.0
            numerator += weight * (level.judged - level.down)
            denominator += weight * level.judged
        inverter = (
            Figure(numerator / denominator) if denominator > 0
            else Figure(None, "no minute yet in which the Plant was generating")
        )
    return grid, plant, inverter, basis


def worst_inverter(tally: Tally) -> tuple[int, int] | None:
    """The Inverter with the most downtime, and its minutes; None if none was down."""
    down = [(level.down, device_id) for device_id, level in tally.inverters.items()
            if level.down > 0]
    if not down:
        return None
    minutes, device_id = max(down)
    return device_id, minutes
