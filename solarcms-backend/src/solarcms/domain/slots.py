"""Slot resolution: how a fixed dashboard renders a Plant nobody designed it for.

Every Plant is wired differently. One Client evacuates through an MCR section fed
by two ICR sections; another is a rooftop array whose entire AC side is a net
meter; a third has an ABT Meter, four MFMs and no Transformer the platform can
see. The dashboard is nonetheless the same screen every time — the same tiles in
the same places — because what varies is not *which* figures matter but *which
Device is in a position to report them*.

A **slot** is a position on that screen: `plant.current_power`, not "the ABT
Meter's AC_ACTIVE_POWER". It carries an ordered list of **candidates**, each
naming a Device Type, a Tag and how to combine several Devices' values. The first
candidate the Plant can actually satisfy wins. `PLANT_ENERGY_SOURCE_PRECEDENCE`
in `assumptions.py` is this idea applied to two figures by hand; this module is
that idea made general, and those two tuples are imported rather than restated so
there is still one source of truth for them.

Four rules carry over from the rest of the system, and all four matter:

* **A missing input yields undefined, never 0.0.** Identical to `derived.py`. A
  Plant with no irradiance sensor has an *unknown* PR, and a tile reading 0.0%
  would be a claim the data does not support.
* **A published value beats a computed one.** Expressed here as candidate order:
  a settlement meter that measures export outranks the sum of what the Inverters
  think they produced.
* **Provenance travels with the value.** Every resolution says which Device Type
  and how many Devices produced it, so the screen can read "Σ 8 Inverters" rather
  than presenting a derived figure as a measurement.
* **Never named after a Client, Plant or Device** (Guardrail 2). A candidate
  names a *Type*. A Plant with three MFMs and a Plant with one resolve through
  the same row.

Pure — no DB, no Redis, no clock (Guardrail 9). The caller assembles `PlantFacts`
and gets `ResolvedSlot`s back.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final

# ── How several Devices' values become one number ───────────────────────────
#
# `sum` and `avg` are not interchangeable and the choice is not cosmetic: eight
# Inverters produce eight lots of power, which add, but they each sit at roughly
# one DC voltage, which does not. Summing voltage across a Plant yields a number
# with no physical meaning that still looks plausible on a tile.
AGGREGATES: Final[tuple[str, ...]] = (
    "sum",    # power, energy, current — quantities that add across Devices
    "avg",    # voltage, frequency, power factor, efficiency — intensive quantities
    "min",
    "max",    # temperatures and peaks: the worst reading is the one that matters
    "first",  # a single-Device reading; several Devices means the lowest code wins
    "count",  # how many Devices of the Type exist
)

# Candidate kinds. Deliberately three, and deliberately closed: every additional
# kind is a new way for a number to reach the screen, and each one has to be
# explainable to the person reading the tile.
KIND_DEVICE_TAG: Final = "device_tag"            # aggregate a Tag over Devices of a Type
KIND_PLANT_ATTRIBUTE: Final = "plant_attribute"  # a column on `plants` (capacity, …)
KIND_DEVICE_COUNT: Final = "device_count"        # how many Devices, optionally online only
CANDIDATE_KINDS: Final[tuple[str, ...]] = (
    KIND_DEVICE_TAG, KIND_PLANT_ATTRIBUTE, KIND_DEVICE_COUNT,
)

# Why a slot has no value. Carried rather than collapsed to null because these
# three mean entirely different things to whoever is looking at the screen: the
# first is a commissioning gap, the second a fault, the third a configuration
# error — and only the second is an operational problem happening right now.
UNDEFINED_NO_SOURCE: Final = "no_source"      # no Device of any candidate Type is bound
UNDEFINED_NO_VALUE: Final = "no_value"        # source exists but is reporting nothing
UNDEFINED_NO_CANDIDATES: Final = "unconfigured"  # the slot declares no candidates at all


@dataclass(frozen=True, slots=True)
class SlotCandidate:
    """One way a slot could be satisfied. Ranked by `priority`, lowest first."""

    kind: str
    priority: int
    device_type_code: str | None = None
    tag_code: str | None = None
    aggregate: str = "first"
    plant_attribute: str | None = None
    # `device_count` only: count the Devices that are online rather than all of
    # them. "4 / 4 Inverters online" is two resolutions of the same Type, and the
    # difference between them is the single most-read number on the screen.
    online_only: bool = False

    def __post_init__(self) -> None:
        if self.kind not in CANDIDATE_KINDS:
            raise ValueError(f"unknown candidate kind {self.kind!r}")
        if self.aggregate not in AGGREGATES:
            raise ValueError(f"unknown aggregate {self.aggregate!r}")
        if self.kind == KIND_DEVICE_TAG and not (self.device_type_code and self.tag_code):
            raise ValueError("device_tag candidate needs both a Device Type and a Tag")
        if self.kind == KIND_PLANT_ATTRIBUTE and not self.plant_attribute:
            raise ValueError("plant_attribute candidate needs an attribute name")
        if self.kind == KIND_DEVICE_COUNT and not self.device_type_code:
            raise ValueError("device_count candidate needs a Device Type")

    @property
    def describes_a_device(self) -> bool:
        return self.kind in (KIND_DEVICE_TAG, KIND_DEVICE_COUNT)


@dataclass(frozen=True, slots=True)
class SlotSpec:
    """A position on the dashboard, and every way it could be filled.

    `panel` and `position` are the fixed layout: the screen does not rearrange
    itself per Plant, which is the whole point of not building a canvas. What
    varies is only which candidate answers.
    """

    code: str
    label: str
    panel: str
    position: int
    candidates: tuple[SlotCandidate, ...] = ()
    unit_hint: str | None = None
    # A slot the Plant genuinely cannot answer is hidden rather than shown empty
    # — a rooftop Plant has no winding temperature and a permanent "—" beside a
    # transformer icon reads as a fault. Tiles that must always be visible
    # (current power, today's energy) set this False and show "—" honestly.
    hide_when_unresolved: bool = True
    # When True, a candidate that is bound but currently silent is passed over
    # for the next one. The operational KPI panel must show *something* when the
    # settlement meter goes quiet (assumptions.py, PLANT_ENERGY_SOURCE_PRECEDENCE
    # note); a Financial Report must not, and never comes through here (I-11).
    fallback_when_silent: bool = True

    @property
    def ordered_candidates(self) -> tuple[SlotCandidate, ...]:
        return tuple(sorted(self.candidates, key=lambda c: c.priority))


@dataclass(frozen=True, slots=True)
class DeviceFacts:
    """One Device as slot resolution needs it.

    `bound_tag_codes` is what the Device is *configured* to report;
    `values` is what it is reporting *now*. Keeping them apart is what lets a
    slot distinguish "this Plant has no meter" from "the meter is offline", which
    are the same blank tile and entirely different phone calls.
    """

    device_id: int
    code: str
    device_type_code: str
    bound_tag_codes: frozenset[str] = frozenset()
    values: Mapping[str, float] = field(default_factory=dict)
    online: bool = False
    # Whether electricity flows through it. Only used by the SLD stages, to tell
    # a Device the diagram is *missing* from one it deliberately excludes: a
    # Weather Station belongs on neither, a new switchgear Type nobody has
    # assigned a stage to belongs on the first.
    in_power_path: bool = False
    # An accepted correction to which stage this Device folds into, overriding
    # its Type's default for this Device alone (migration 0027). NULL is the
    # normal case, and slot resolution ignores this entirely — it matters only
    # to the four-stage fold.
    sld_stage_override: str | None = None


@dataclass(frozen=True, slots=True)
class PlantFacts:
    plant_id: int
    devices: tuple[DeviceFacts, ...] = ()
    # Columns on `plants` a slot may read — dc_capacity_kwp, ac_capacity_kw.
    # Kept as a mapping rather than a Plant object so this module stays pure of
    # the ORM as well as of I/O.
    attributes: Mapping[str, float | None] = field(default_factory=dict)

    def of_type(self, device_type_code: str) -> tuple[DeviceFacts, ...]:
        return tuple(d for d in self.devices if d.device_type_code == device_type_code)


@dataclass(frozen=True, slots=True)
class SlotSource:
    """Where a resolved number came from. Rendered beside the value, not hidden.

    A tile that reads 6.32 MW is a different claim depending on whether a
    settlement meter measured it or twelve Inverters were added together, and the
    person deciding whether to trust it needs to know which.
    """

    kind: str
    device_type_code: str | None
    tag_code: str | None
    aggregate: str
    device_count: int
    device_ids: tuple[int, ...] = ()
    # The preferred candidate was bound but silent, so a lower-ranked one
    # answered. The value is real; the source is not the one normally used.
    degraded: bool = False

    @property
    def is_aggregated(self) -> bool:
        """True when several Devices were combined — the caller shows 'Σ 8 Inverters'."""
        return self.device_count > 1 and self.aggregate in ("sum", "avg", "min", "max")


@dataclass(frozen=True, slots=True)
class ResolvedSlot:
    slot_code: str
    label: str
    panel: str
    position: int
    value: float | None
    unit: str | None
    source: SlotSource | None
    undefined_reason: str | None
    hidden: bool = False


def _aggregate(values: Sequence[float], how: str) -> float | None:
    if not values:
        return None
    if how == "sum":
        return float(sum(values))
    if how == "avg":
        return float(sum(values) / len(values))
    if how == "min":
        return float(min(values))
    if how == "max":
        return float(max(values))
    # "first" and "count" — `count` never reaches here (it needs no values) and
    # `first` is the caller's stable ordering, already applied.
    return float(values[0])


def _candidate_is_bound(candidate: SlotCandidate, facts: PlantFacts) -> bool:
    """Could this candidate *ever* answer, given how the Plant is configured?

    Asked against bindings, not against current values, so the answer does not
    change when a Device goes quiet. A dashboard whose tiles silently re-point at
    a different instrument every time a link flaps is worse than one that says
    the instrument is down.
    """
    if candidate.kind == KIND_PLANT_ATTRIBUTE:
        assert candidate.plant_attribute is not None
        return facts.attributes.get(candidate.plant_attribute) is not None
    devices = facts.of_type(candidate.device_type_code or "")
    if not devices:
        return False
    if candidate.kind == KIND_DEVICE_COUNT:
        return True
    return any(candidate.tag_code in d.bound_tag_codes for d in devices)


def _evaluate(candidate: SlotCandidate, facts: PlantFacts) -> tuple[float | None, SlotSource]:
    """Produce this candidate's value now, plus where it came from."""
    if candidate.kind == KIND_PLANT_ATTRIBUTE:
        assert candidate.plant_attribute is not None
        raw = facts.attributes.get(candidate.plant_attribute)
        source = SlotSource(
            kind=candidate.kind, device_type_code=None,
            tag_code=candidate.plant_attribute, aggregate="first", device_count=0,
        )
        return (None if raw is None else float(raw)), source

    # Stable ordering: a slot whose value jumps between two Devices between
    # refreshes is unreadable, and `first` depends on it entirely.
    devices = sorted(facts.of_type(candidate.device_type_code or ""), key=lambda d: d.code)

    if candidate.kind == KIND_DEVICE_COUNT:
        counted = [d for d in devices if d.online] if candidate.online_only else list(devices)
        source = SlotSource(
            kind=candidate.kind, device_type_code=candidate.device_type_code,
            tag_code=None, aggregate="count", device_count=len(counted),
            device_ids=tuple(d.device_id for d in counted),
        )
        # A count of zero is a real answer — "0 Inverters online" is information,
        # not a missing reading — so this is the one place 0.0 is not a lie.
        return float(len(counted)), source

    assert candidate.tag_code is not None
    contributing = [
        d for d in devices
        if candidate.tag_code in d.bound_tag_codes and candidate.tag_code in d.values
    ]
    values = [float(d.values[candidate.tag_code]) for d in contributing]
    if candidate.aggregate == "first":
        contributing, values = contributing[:1], values[:1]
    source = SlotSource(
        kind=candidate.kind, device_type_code=candidate.device_type_code,
        tag_code=candidate.tag_code, aggregate=candidate.aggregate,
        device_count=len(contributing),
        device_ids=tuple(d.device_id for d in contributing),
    )
    return _aggregate(values, candidate.aggregate), source


def resolve_slot(spec: SlotSpec, facts: PlantFacts, unit: str | None = None) -> ResolvedSlot:
    """Fill one slot from whatever this Plant happens to have.

    Two passes, and the order between them is the design:

    1. **Plan** against bindings — the first candidate the Plant is *configured*
       to answer. This is the source the tile names, and it is stable.
    2. **Read** its current value. If the planned source is silent and the slot
       permits it, walk on to the next bound candidate and mark the result
       `degraded`, so the screen shows a real number while still saying it came
       from the fallback.

    A slot that no candidate is bound for is `no_source` — a commissioning gap.
    One whose sources are all silent is `no_value` — a fault happening now.
    """
    ordered = spec.ordered_candidates
    if not ordered:
        return ResolvedSlot(
            slot_code=spec.code, label=spec.label, panel=spec.panel, position=spec.position,
            value=None, unit=unit or spec.unit_hint, source=None,
            undefined_reason=UNDEFINED_NO_CANDIDATES, hidden=spec.hide_when_unresolved,
        )

    bound = [c for c in ordered if _candidate_is_bound(c, facts)]
    if not bound:
        return ResolvedSlot(
            slot_code=spec.code, label=spec.label, panel=spec.panel, position=spec.position,
            value=None, unit=unit or spec.unit_hint, source=None,
            undefined_reason=UNDEFINED_NO_SOURCE, hidden=spec.hide_when_unresolved,
        )

    planned = bound[0]
    attempts = bound if spec.fallback_when_silent else bound[:1]
    for index, candidate in enumerate(attempts):
        value, source = _evaluate(candidate, facts)
        if value is None:
            continue
        if index > 0:
            # Same fields, one flag flipped. Rebuilt rather than mutated because
            # SlotSource is frozen, and it is frozen because a provenance record
            # that can be edited after the fact is not a provenance record.
            source = SlotSource(
                kind=source.kind, device_type_code=source.device_type_code,
                tag_code=source.tag_code, aggregate=source.aggregate,
                device_count=source.device_count, device_ids=source.device_ids,
                degraded=True,
            )
        return ResolvedSlot(
            slot_code=spec.code, label=spec.label, panel=spec.panel, position=spec.position,
            value=value, unit=unit or spec.unit_hint, source=source, undefined_reason=None,
        )

    # Bound, but nothing is talking. Name the planned source anyway: "no reading
    # from the ABT Meter" is actionable where a bare blank is not.
    _, planned_source = _evaluate(planned, facts)
    return ResolvedSlot(
        slot_code=spec.code, label=spec.label, panel=spec.panel, position=spec.position,
        value=None, unit=unit or spec.unit_hint, source=planned_source,
        undefined_reason=UNDEFINED_NO_VALUE,
        # Never hidden: the source exists and has gone quiet, which is exactly
        # the condition the screen must not conceal.
        hidden=False,
    )


def resolve_all(
    specs: Sequence[SlotSpec],
    facts: PlantFacts,
    units: Mapping[str, str] | None = None,
) -> list[ResolvedSlot]:
    """Resolve every slot, in panel then position order.

    `units` maps Tag code → unit, read from the catalogue rather than inferred
    from the Tag's name (Guardrail 6 in spirit: the unit is a recorded fact about
    the Tag, never something this module decides).
    """
    units = units or {}
    out: list[ResolvedSlot] = []
    for spec in sorted(specs, key=lambda s: (s.panel, s.position, s.code)):
        # The unit follows the Tag the *chosen* candidate used, so a slot that
        # fell back from an MFM in kV to an Inverter in V is not mislabelled.
        resolved = resolve_slot(spec, facts)
        unit = spec.unit_hint
        chosen_tag = None if resolved.source is None else resolved.source.tag_code
        if chosen_tag is not None and chosen_tag in units:
            unit = units[chosen_tag]
        out.append(
            ResolvedSlot(
                slot_code=resolved.slot_code, label=resolved.label, panel=resolved.panel,
                position=resolved.position, value=resolved.value, unit=unit,
                source=resolved.source, undefined_reason=resolved.undefined_reason,
                hidden=resolved.hidden,
            )
        )
    return out
