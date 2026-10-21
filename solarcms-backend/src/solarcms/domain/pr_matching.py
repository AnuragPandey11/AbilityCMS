"""PR from the periods both sides measured, over sunlight the output allows. Pure — no I/O.

PR divides the energy a Plant made by the sunlight it was given, and the two
come from different instruments that fail separately. A hole in one is not a
hole in the other, and dividing a whole of one by part of the other produces a
figure that looks like a result. 21 Oct 2026: an 8-hour outage left
SPINNING_AND_GENERAL_MILLS at 264.3% and UNIT1 at 177.2% — the meters'
registers stepped across the hole and counted the afternoon's energy, while the
stations' live GHI, added up bucket by bucket, had no afternoon. And OASIS_2MW's
station sends 9.75E-42 for zero all day, which no total can see.

Two rules, ⚠ PROPOSED (the user's request, 21 Oct 2026):

* **Match the periods.** The window is cut into `PR_MATCH_PERIOD_MINUTES`
  periods, and a period counts towards PR only when every energy Device owed
  for it, and at least one weather station, covered it whole. Anything else is
  left out of *both* sides, so a hole costs PR its own hours rather than
  tilting the rest. A step up to `PR_SPLIT_MAX_MINUTES` long is shared between
  the periods it crosses in proportion to time; a longer one — a register
  stepping across an outage — is known only as a whole, so the periods it spans
  are judged together, as one.
* **Sunlight the output allows.** In each period, a station whose sunlight
  would put that period's PR above `PR_PERIOD_CEILING` read too little for what
  the Plant evidently received — dead, sending noise for zero, or scaled wrong —
  and is set aside for it. The rest give the period's sunlight; a period with
  none left is left out. It never sets aside sunlight for being too *much*: a
  Plant making little under a bright sky is the underperformance PR exists to
  show. And it never blames a station for energy no sky could give: more than
  the DC capacity makes at `MAX_IRRADIATION_KWH_PER_M2_PER_HOUR` is a counter
  that jumped (KULAR_GREEN's 97 MWh in 26 minutes, 1 Oct 2026), and the period
  is left out as that.

Every energy Device is owed for every period. PR divides by the whole Plant's
DC capacity, so a period one Inverter did not report is a period the Plant's
energy is short — whether it was silent, not yet commissioned or already dead
— and counting it read 74% for a Plant at 80% (21 Oct 2026). It is left out,
and the Device named. Stations are a mean, as in
`domain/irradiation` — two stations see one sky — of those that covered the
period, so one down for an hour does not halve that hour's sun.

Nothing is corrected or estimated. Every figure is a sum of measured steps,
everything left out is listed with the energy and sunlight in it, and a screen
says how much of the period's energy PR stands on.
"""

from __future__ import annotations

from bisect import bisect_right
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from solarcms.domain.assumptions import (
    G_REF_W_PER_M2,
    IRRADIANCE_DAYLIGHT_W_PER_M2,
    MAX_IRRADIATION_KWH_PER_M2_PER_HOUR,
    PR_LEFT_OUT_NOTED_SHARE,
    PR_MATCH_PERIOD_MINUTES,
    PR_MIN_IRRADIATION_WH_PER_M2,
    PR_PERIOD_CEILING,
    PR_SPLIT_MAX_MINUTES,
)
from solarcms.domain.counters import CounterIntegral, CounterStep, PlantEnergy
from solarcms.domain.formulas import FormulaResult, performance_ratio
from solarcms.domain.irradiation import PlantIrradiation

PERIOD = timedelta(minutes=PR_MATCH_PERIOD_MINUTES)
SPLIT_MAX = timedelta(minutes=PR_SPLIT_MAX_MINUTES)
# Periods are counted from here, so every caller cuts the same ones.
_EPOCH = datetime(2000, 1, 1, tzinfo=UTC)
# Coverage is compared in seconds; a reading's own timestamp is exact.
_TOLERANCE_S = 1.0
# Labels a step `(since, at]`: a reading at midnight is the day before's.
_INSTANT = timedelta(microseconds=1)

LeftOutReason = Literal["no_energy", "energy_too_high", "no_sunlight", "sunlight_too_low"]

REASON_WORDS: dict[LeftOutReason, str] = {
    "no_energy": "no energy readings",
    "energy_too_high": "energy above what the Plant could make",
    "no_sunlight": "no sunlight readings",
    "sunlight_too_low": "sunlight too low for the Plant's output",
}


@dataclass(frozen=True, slots=True)
class MatchSeries:
    """One register or integrated sensor, as its accepted steps."""

    device_id: int
    device_code: str
    integral: CounterIntegral


@dataclass(frozen=True, slots=True)
class MatchedPeriod:
    """One period, or several judged together because a step spans them."""

    start: datetime
    end: datetime
    # What the energy Devices recorded in it, whole or not.
    energy_kwh: float
    # The mean of the stations kept; where none was, of those that covered it.
    sunlight_kwh_m2: float | None
    # None: counted towards PR.
    reason: LeftOutReason | None
    # The energy Devices that did not cover it, for `no_energy`.
    missing: tuple[str, ...] = ()
    # Stations set aside in it as reading too little for the output, with the
    # sunlight each read (kWh/m²).
    too_low: tuple[tuple[int, str, float], ...] = ()

    @property
    def counted(self) -> bool:
        return self.reason is None

    @property
    def hours(self) -> float:
        return (self.end - self.start).total_seconds() / 3600.0


@dataclass(frozen=True, slots=True)
class LeftOut:
    """A run of periods left out of PR for one reason."""

    start: datetime
    end: datetime
    reason: LeftOutReason
    energy_kwh: float
    sunlight_kwh_m2: float | None
    missing: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class StationSetAside:
    """A station whose sunlight was set aside in some periods."""

    device_id: int
    device_code: str
    hours: float
    energy_kwh: float
    first: datetime
    last: datetime
    # The sunlight it read in them, kWh/m².
    sunlight_kwh_m2: float = 0.0

    @property
    def reads_dark(self) -> bool:
        """It read no daylight at all while the Plant generated — a dead
        sensor, or one sending near-zero for zero. Otherwise it read *some*
        sun, and the fault may as well be the output's: a DC capacity on
        record that is too low, or a meter counted as solar that is not."""
        if self.hours <= 0:
            return True
        return self.sunlight_kwh_m2 * 1000.0 / self.hours < IRRADIANCE_DAYLIGHT_W_PER_M2


@dataclass(frozen=True, slots=True)
class PrBasis:
    """What PR stands on: the energy and sunlight of the periods counted, and
    what was left out of them."""

    energy_kwh: float
    sunlight_kwh_m2: float
    # Energy recorded in every period judged, counted or not.
    energy_total_kwh: float
    sunlight_total_kwh_m2: float
    # Runs worth naming (`PR_LEFT_OUT_NOTED_SHARE`), in time order.
    left_out: tuple[LeftOut, ...] = ()
    stations_set_aside: tuple[StationSetAside, ...] = ()
    # Every run left out, named or not.
    left_out_count: int = 0

    @property
    def energy_share(self) -> float | None:
        """The share of the energy recorded that PR stands on."""
        if self.energy_total_kwh <= 0:
            return None
        return self.energy_kwh / self.energy_total_kwh

    @property
    def undefined_reason(self) -> str | None:
        """Why there is no PR, when the periods counted hold no sunlight and
        the periods left out say why."""
        if self.sunlight_kwh_m2 * 1000.0 >= PR_MIN_IRRADIATION_WH_PER_M2:
            return None
        made = [run for run in self.left_out if run.energy_kwh > 0]
        if any(run.reason == "sunlight_too_low" for run in made):
            if self.stations_set_aside and all(s.reads_dark for s in self.stations_set_aside):
                return "the weather station read no sunlight while the Plant was generating"
            return ("the sunlight read was under half what the Plant's output needs — a "
                    "sensor reading low, or a DC capacity or meter on record that is wrong")
        if any(run.reason == "no_sunlight" for run in made):
            return "no sunlight readings while the Plant was generating"
        if any(run.reason == "no_energy" for run in self.left_out):
            return "no energy readings while the sun was up"
        if any(run.reason == "energy_too_high" for run in self.left_out):
            return "the energy readings were more than the Plant could make"
        return None


# ── Cutting steps into periods ──────────────────────────────────────────────

@dataclass(frozen=True, slots=True)
class _Piece:
    first: int
    last: int
    start: datetime
    end: datetime
    amount: float


def _first_period(since: datetime) -> int:
    """The period holding the instant just after `since`."""
    return (since - _EPOCH) // PERIOD


def _last_period(at: datetime) -> int:
    """The period holding `at` itself — a step is `(since, at]`."""
    return -((_EPOCH - at) // PERIOD) - 1


def _period_start(index: int) -> datetime:
    return _EPOCH + index * PERIOD


def _pieces(steps: Sequence[CounterStep]) -> list[_Piece]:
    pieces: list[_Piece] = []
    for step in steps:
        since = step.since if step.since is not None else step.at
        if step.reset and step.at - since > SPLIT_MAX:
            # A daily register restarted inside a long silence: it says what
            # accrued since its restart, not since `since`, so the span is not
            # known at all — an outage across midnight read 81.4% for 80%.
            continue
        if step.at <= since:
            index = _last_period(step.at)
            pieces.append(_Piece(index, index, step.at, step.at, step.amount))
            continue
        first, last = _first_period(since), _last_period(step.at)
        if first == last:
            pieces.append(_Piece(first, last, since, step.at, step.amount))
        elif step.at - since <= SPLIT_MAX:
            # Readings minutes apart: what accrued between them is shared in
            # proportion to time.
            span = (step.at - since).total_seconds()
            for index in range(first, last + 1):
                start = max(since, _period_start(index))
                end = min(step.at, _period_start(index + 1))
                share = (end - start).total_seconds() / span
                pieces.append(_Piece(index, index, start, end, step.amount * share))
        else:
            # Across an outage: known only as a whole.
            pieces.append(_Piece(first, last, since, step.at, step.amount))
    return pieces


def _merge(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for first, last in sorted(ranges):
        if merged and first <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], last))
        else:
            merged.append((first, last))
    return merged


@dataclass(slots=True)
class _Group:
    start: datetime
    end: datetime
    energy: list[float]
    energy_covered: list[float]
    sun: list[float]
    sun_covered: list[float]


def _too_much(energy_kwh: float, hours: float, dc_kwp: float) -> bool:
    """More energy than the array could make under the brightest sky there is."""
    ceiling = dc_kwp * MAX_IRRADIATION_KWH_PER_M2_PER_HOUR * 1000.0 / G_REF_W_PER_M2 * hours
    return energy_kwh > ceiling


def _too_little(energy_kwh: float, sunlight_kwh_m2: float, dc_kwp: float) -> bool:
    """More energy than this sunlight could give at `PR_PERIOD_CEILING`."""
    if energy_kwh <= 0:
        return False
    reference_kwh = sunlight_kwh_m2 * 1000.0 / G_REF_W_PER_M2 * dc_kwp
    return energy_kwh > PR_PERIOD_CEILING * reference_kwh


def match_periods(
    energy: Sequence[MatchSeries],
    stations: Sequence[MatchSeries],
    *,
    dc_capacity_kwp: float | None,
) -> tuple[MatchedPeriod, ...]:
    """Every period the window's readings touch, counted or left out, in
    time order. Without a DC capacity no sunlight can be judged against the
    output, and the periods are only matched."""
    energy_pieces = [_pieces(series.integral.steps) for series in energy]
    station_pieces = [_pieces(series.integral.steps) for series in stations]
    groups = _merge([
        (piece.first, piece.last)
        for pieces in (*energy_pieces, *station_pieces)
        for piece in pieces if piece.last > piece.first
    ])
    firsts = [first for first, _last in groups]

    def group_of(index: int) -> tuple[int, int]:
        position = bisect_right(firsts, index) - 1
        if position >= 0 and groups[position][1] >= index:
            return groups[position]
        return (index, index)

    accumulated: dict[tuple[int, int], _Group] = {}

    def add(piece: _Piece, side: str, index: int) -> None:
        key = group_of(piece.first)
        group = accumulated.get(key)
        if group is None:
            group = accumulated[key] = _Group(
                piece.start, piece.end, [0.0] * len(energy), [0.0] * len(energy),
                [0.0] * len(stations), [0.0] * len(stations))
        group.start = min(group.start, piece.start)
        group.end = max(group.end, piece.end)
        covered = (piece.end - piece.start).total_seconds()
        if side == "energy":
            group.energy[index] += piece.amount
            group.energy_covered[index] += covered
        else:
            group.sun[index] += piece.amount
            group.sun_covered[index] += covered

    for index, pieces in enumerate(energy_pieces):
        for piece in pieces:
            add(piece, "energy", index)
    for index, pieces in enumerate(station_pieces):
        for piece in pieces:
            add(piece, "sun", index)

    dc = dc_capacity_kwp if dc_capacity_kwp and dc_capacity_kwp > 0 else None

    periods: list[MatchedPeriod] = []
    for key in sorted(accumulated):
        group = accumulated[key]
        span = (group.end - group.start).total_seconds()
        owed = range(len(energy))
        missing = tuple(
            energy[index].device_code for index in owed
            if group.energy_covered[index] < span - _TOLERANCE_S)
        made = sum(group.energy)
        complete = bool(owed) and not missing
        too_high = complete and dc is not None and _too_much(made, span / 3600.0, dc)
        covering = [
            index for index in range(len(stations))
            if group.sun_covered[index] >= span - _TOLERANCE_S]
        too_low = [
            index for index in covering
            if dc is not None and _too_little(made, group.sun[index], dc)
        ] if complete and not too_high else []
        kept = [index for index in covering if index not in too_low]
        judged = kept or covering
        sunlight = (sum(group.sun[index] for index in judged) / len(judged)
                    if judged else None)

        reason: LeftOutReason | None
        if not complete:
            reason = "no_energy"
        elif too_high:
            reason = "energy_too_high"
        elif not covering:
            reason = "no_sunlight"
        elif not kept:
            reason = "sunlight_too_low"
        else:
            reason = None
        periods.append(MatchedPeriod(
            start=group.start, end=group.end, energy_kwh=made,
            sunlight_kwh_m2=sunlight, reason=reason,
            missing=missing,
            too_low=tuple((stations[i].device_id, stations[i].device_code, group.sun[i])
                          for i in too_low),
        ))
    return tuple(periods)


# ── What PR stands on ───────────────────────────────────────────────────────

def _in_progress(ordered: Sequence[MatchedPeriod]) -> bool:
    """The window's last period, left out for want of a reading, is still in
    progress: the readings that close it have not arrived. It is set aside
    without being named, or every refresh would report the last minutes missing."""
    return bool(ordered) and ordered[-1].reason in ("no_energy", "no_sunlight")


def summarise(periods: Sequence[MatchedPeriod], *, ends_window: bool = True) -> PrBasis:
    """The periods counted, summed, and what was left out of them.

    `ends_window` when the last of `periods` is the window's last, and may
    still be in progress (`_in_progress`).
    """
    ordered = sorted(periods, key=lambda period: period.start)
    if ends_window and _in_progress(ordered):
        ordered = ordered[:-1]

    energy = sum(p.energy_kwh for p in ordered if p.counted)
    sunlight = sum(p.sunlight_kwh_m2 or 0.0 for p in ordered if p.counted)
    energy_total = sum(p.energy_kwh for p in ordered)
    sunlight_total = sum(p.sunlight_kwh_m2 or 0.0 for p in ordered)

    runs: list[LeftOut] = []
    for period in ordered:
        if period.counted:
            continue
        assert period.reason is not None
        previous = runs[-1] if runs else None
        if (previous is not None and previous.end == period.start
                and previous.reason == period.reason and previous.missing == period.missing):
            runs[-1] = LeftOut(
                previous.start, period.end, previous.reason,
                previous.energy_kwh + period.energy_kwh,
                _add(previous.sunlight_kwh_m2, period.sunlight_kwh_m2), previous.missing)
        else:
            runs.append(LeftOut(period.start, period.end, period.reason, period.energy_kwh,
                                period.sunlight_kwh_m2, period.missing))

    def noted(energy_kwh: float, sunlight_kwh_m2: float | None) -> bool:
        return (
            (energy_total > 0 and energy_kwh >= PR_LEFT_OUT_NOTED_SHARE * energy_total)
            or (sunlight_total > 0 and (sunlight_kwh_m2 or 0.0)
                >= PR_LEFT_OUT_NOTED_SHARE * sunlight_total)
        )

    stations: dict[int, StationSetAside] = {}
    for period in ordered:
        for device_id, code, sunlight_read in period.too_low:
            seen = stations.get(device_id)
            stations[device_id] = StationSetAside(
                device_id, code,
                (seen.hours if seen else 0.0) + period.hours,
                (seen.energy_kwh if seen else 0.0) + period.energy_kwh,
                seen.first if seen else period.start, period.end,
                (seen.sunlight_kwh_m2 if seen else 0.0) + sunlight_read)

    return PrBasis(
        energy_kwh=energy, sunlight_kwh_m2=sunlight,
        energy_total_kwh=energy_total, sunlight_total_kwh_m2=sunlight_total,
        left_out=tuple(run for run in runs if noted(run.energy_kwh, run.sunlight_kwh_m2)),
        stations_set_aside=tuple(
            station for station in sorted(stations.values(), key=lambda s: s.device_code)
            if noted(station.energy_kwh, None)),
        left_out_count=len(runs),
    )


def summarise_by_label(
    periods: Sequence[MatchedPeriod], label: Callable[[datetime], str],
) -> dict[str, PrBasis]:
    """What PR stands on under each label — a local day, a month. A period
    whose readings span two labels belongs to neither, as a register step
    across midnight belongs to no day (`report_tables.split_steps`)."""
    ordered = sorted(periods, key=lambda period: period.start)
    if _in_progress(ordered):
        ordered = ordered[:-1]
    by_label: dict[str, list[MatchedPeriod]] = {}
    for period in ordered:
        name = label(period.end - _INSTANT)
        if label(period.start) != name:
            continue
        by_label.setdefault(name, []).append(period)
    return {name: summarise(group, ends_window=False) for name, group in by_label.items()}


def _add(a: float | None, b: float | None) -> float | None:
    if a is None and b is None:
        return None
    return (a or 0.0) + (b or 0.0)


# ── From what the callers already hold ──────────────────────────────────────

def energy_series(energy: PlantEnergy, device_id: int | None = None) -> list[MatchSeries]:
    """The Devices a Plant's energy came from — or one of them."""
    return [
        MatchSeries(device.series.device_id, device.series.device_code, device.integral)
        for device in energy.devices
        if device_id is None or device.series.device_id == device_id
    ]


def station_series(irradiation: PlantIrradiation) -> list[MatchSeries]:
    """The stations a Plant's sunlight came from, each as the source chosen
    for it — its own daily register, or its live GHI added up."""
    series: list[MatchSeries] = []
    for station in irradiation.used:
        integral = station.register if station.source == "register" else station.live
        if integral is not None:
            series.append(MatchSeries(station.device_id, station.device_code, integral))
    return series


def plant_periods(
    energy: PlantEnergy, irradiation: PlantIrradiation, dc_capacity_kwp: float | None,
    *, device_id: int | None = None,
) -> tuple[MatchedPeriod, ...]:
    return match_periods(
        energy_series(energy, device_id), station_series(irradiation),
        dc_capacity_kwp=dc_capacity_kwp)


def matched_performance_ratio(basis: PrBasis, dc_capacity_kwp: float) -> FormulaResult:
    """PR over the periods counted, with why there is none when there is none."""
    result = performance_ratio(
        basis.energy_kwh, basis.sunlight_kwh_m2 * 1000.0, dc_capacity_kwp)
    if result.value is None and dc_capacity_kwp > 0 and basis.undefined_reason:
        return FormulaResult(None, result.variant, basis.undefined_reason)
    return result


@dataclass(frozen=True, slots=True)
class PlantPr:
    """A Plant's PR and what it stands on."""

    result: FormulaResult
    basis: PrBasis | None = None
    periods: tuple[MatchedPeriod, ...] = field(default_factory=tuple)


def plant_pr(
    energy: PlantEnergy, irradiation: PlantIrradiation, dc_capacity_kwp: float,
    *, device_id: int | None = None,
) -> PlantPr:
    """PR from the periods both sides measured (above). Undefined, with the
    reason, where the energy or the sunlight is."""
    if energy.value is None:
        return PlantPr(FormulaResult(
            None, performance_ratio(0.0, 0.0, 0.0).variant, energy.undefined_reason))
    if irradiation.value is None:
        return PlantPr(FormulaResult(
            None, performance_ratio(0.0, 0.0, 0.0).variant,
            irradiation.undefined_reason or "no irradiation in period"))
    periods = plant_periods(energy, irradiation, dc_capacity_kwp, device_id=device_id)
    basis = summarise(periods)
    return PlantPr(matched_performance_ratio(basis, dc_capacity_kwp), basis, periods)


def pr_basis_note(subject: str, basis: PrBasis, zone: ZoneInfo) -> str | None:
    """A Report's sentence on what a PR left out — `subject` is "PR for
    2026-10" or "KULAR_GREEN's PR" — or None when it left out nothing worth
    naming."""
    if not basis.left_out and not basis.stations_set_aside:
        return None
    parts = [
        f"{run.start.astimezone(zone):%d-%m %H:%M} to {run.end.astimezone(zone):%d-%m %H:%M} "
        f"({REASON_WORDS[run.reason]})"
        for run in sorted(basis.left_out, key=lambda r: -r.energy_kwh)[:3]
    ]
    more = len(basis.left_out) - len(parts)
    share = basis.energy_share
    sentence = (f"{subject} stands on {share:.0%} of the energy" if share is not None
                else f"{subject} leaves periods out")
    if parts:
        sentence += (": left out of both the energy and the sunlight were "
                     + "; ".join(parts) + (f" and {more} more" if more > 0 else ""))
    sentence += "."
    for station in basis.stations_set_aside:
        sentence += (
            f" {station.device_code}'s sunlight was set aside for {station.hours:.1f} h as "
            + ("reading no sun while the Plant generated (a dead sensor)."
               if station.reads_dark else
               "under half what the Plant's output needs (a dirty, shaded or wrongly scaled "
               "sensor — or a DC capacity or meter on record that is wrong)."))
    return sentence
