"""Where the wiring and the four-stage fold disagree. Pure — no I/O.

Two inputs describe a Plant's electrical shape and they are different *kinds* of
statement:

* `device_types.sld_stage` says **which box** a Device belongs in. It is a
  per-Type default and knows nothing about any particular Plant.
* `devices.parent_device_id` says **what feeds what** on this Plant. It says
  nothing about box membership — a chain `A→B→C` gives relative position only.

Most of the time they agree, because the defaults were written from the ordinary
topology. They part company on the unusual one: an LT feeder meter wired between
the Inverters and the Transformer is `Type = MFM`, so it folds into **Grid** —
the rightmost box — while the wiring puts it third from the left. Two screens,
one meter, two positions.

── Why this flags rather than resolves ─────────────────────────────────────
The wiring is the more specific claim and should win, exactly as a Device-scoped
alarm rule outranks a global one. But wiring is *hand-entered in a dropdown* and
verified against nothing — unlike a topic, which the broker states. So the
disagreement is also the only cross-check the system has: when the two views
part company, something is wrong, and silently letting one overrule the other
throws that signal away and propagates a single mistyped parent into both
diagrams.

So this module reports the contradiction and the assignments that would satisfy
it. A human picks. The decision is then stored on the Device
(`devices.sld_stage_override`) as an audited fact, not recomputed on every
render — and re-validated later, so an override that the wiring has since made
unnecessary is reported stale instead of quietly outliving its reason.

── What is *not* checked ───────────────────────────────────────────────────
Only real edges. A Device with no parent and no children is never compared with
anything, so a Plant nobody has wired yields no conflicts at all rather than a
page of them — the same reason discovery stopped offering dead topics.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from solarcms.domain.sld_stages import SLD_STAGES

#: Position of each stage, generation (0) to grid (3). Comparing these is the
#: whole test: upstream must never sit further right than downstream.
STAGE_POSITION: Final[dict[str, int]] = {
    code: index for index, code in enumerate(SLD_STAGES)
}



@dataclass(frozen=True, slots=True)
class WiredDevice:
    """One Device as conflict detection needs it: its stage and its wiring."""

    device_id: int
    code: str
    device_type_code: str
    parent_device_id: int | None
    in_power_path: bool
    #: From `device_types.sld_stage`. None for a Type that carries no current.
    type_stage: str | None
    #: From `devices.sld_stage_override` — a decision somebody made and we kept.
    stage_override: str | None = None

    @property
    def effective_stage(self) -> str | None:
        """The override where one was accepted, else the Type's default.

        An override naming a stage that does not exist is ignored rather than
        raising: the column is CHECK-constrained, so this can only happen if the
        catalogue's stage list shrinks under it, and a diagram that still draws
        is better than one that 500s.
        """
        if self.stage_override in STAGE_POSITION:
            return self.stage_override
        return self.type_stage if self.type_stage in STAGE_POSITION else None


@dataclass(frozen=True, slots=True)
class StageConflict:
    """One Device whose stage contradicts what it is wired to."""

    device_id: int
    code: str
    device_type_code: str
    #: The stage it currently folds into.
    stage: str
    #: What it is wired into, and the stage that Device folds into. Always the
    #: downstream side: a violating edge is anchored on its *upstream* Device,
    #: so one edge produces exactly one conflict rather than one at each end.
    feeds_into_device_id: int
    feeds_into_code: str
    feeds_into_stage: str
    #: Stages that would satisfy every wired neighbour. Empty means the wiring
    #: itself is inconsistent — no assignment can satisfy it, and the wiring is
    #: what needs fixing.
    candidate_stages: tuple[str, ...]
    #: Where to put it if the operator simply accepts: the allowed stage nearest
    #: its Type's own default, i.e. the smallest move that satisfies the wiring.
    suggested_stage: str | None

    @property
    def resolvable_by_restaging(self) -> bool:
        return bool(self.candidate_stages)


def _staged(devices: list[WiredDevice]) -> dict[int, WiredDevice]:
    """Power-path Devices that fold into a stage, by id.

    A Weather Station is excluded because it is deliberately not on the diagram;
    a power-path Type with no stage is excluded here and reported separately by
    `build_stages`, which is the screen that can actually explain it.
    """
    return {
        d.device_id: d for d in devices
        if d.in_power_path and d.effective_stage is not None
    }


def _bounds(
    device: WiredDevice, by_id: dict[int, WiredDevice],
    children: dict[int, list[WiredDevice]], stage_of: dict[int, str],
) -> tuple[int, int]:
    """The window of stage positions this Device's neighbours allow.

    Lower bound: no further left than anything feeding it. Upper bound: no
    further right than what it feeds. A Device with neither is unconstrained.
    """
    lower = 0
    for child in children.get(device.device_id, ()):
        lower = max(lower, STAGE_POSITION[stage_of[child.device_id]])

    upper = len(SLD_STAGES) - 1
    parent_id = device.parent_device_id
    if parent_id is not None and parent_id in by_id:
        upper = min(upper, STAGE_POSITION[stage_of[parent_id]])

    return lower, upper


def detect_stage_conflicts(devices: list[WiredDevice]) -> list[StageConflict]:
    """Devices whose stage contradicts the wiring, one entry per Device.

    The test is applied to each wired edge: for `child → parent`, the child is
    upstream, so `position(child) <= position(parent)` must hold. Checking direct
    edges is sufficient — a transitive violation always shows up on some edge
    along the way — and it keeps this linear in the number of Devices.
    """
    by_id = _staged(devices)
    if not by_id:
        return []

    stage_of = {d.device_id: s for d in by_id.values()
                if (s := d.effective_stage) is not None}
    children: dict[int, list[WiredDevice]] = {}
    for device in by_id.values():
        parent_id = device.parent_device_id
        if parent_id is not None and parent_id in by_id:
            children.setdefault(parent_id, []).append(device)

    conflicts: list[StageConflict] = []
    seen: set[int] = set()

    # Sorted so the report is stable between runs; an operator re-reading the
    # screen should not find the same conflicts in a different order.
    for device in sorted(by_id.values(), key=lambda d: d.code):
        if device.device_id in seen:
            continue
        parent_id = device.parent_device_id
        if parent_id is None or parent_id not in by_id:
            continue
        # ⚠ Anchored on the upstream Device only. Checking both ends would
        # report one disagreement twice — once as "the meter is too far right"
        # and once as "the transformer is too far left" — and an operator
        # cannot resolve the same edge in two places.
        position = STAGE_POSITION[stage_of[device.device_id]]
        if position <= STAGE_POSITION[stage_of[parent_id]]:
            continue

        neighbour = by_id[parent_id]
        lower, upper = _bounds(device, by_id, children, stage_of)
        candidates = tuple(
            code for code in SLD_STAGES
            if lower <= STAGE_POSITION[code] <= upper
            and code != stage_of[device.device_id]
        )
        # ⚠ Nearest the Type default, not simply the leftmost allowed. With
        # nothing wired into it a Device has no lower bound, and "leftmost"
        # then proposes PV Array for a meter — allowed by the constraints and
        # obviously silly. The smallest move from what its Type already says is
        # the defensible automatic answer; every other candidate stays offered.
        anchor = STAGE_POSITION.get(
            device.type_stage or "", STAGE_POSITION[stage_of[device.device_id]]
        )
        suggested = min(
            candidates, key=lambda c: (abs(STAGE_POSITION[c] - anchor),
                                       STAGE_POSITION[c]),
            default=None,
        )
        seen.add(device.device_id)
        conflicts.append(StageConflict(
            device_id=device.device_id, code=device.code,
            device_type_code=device.device_type_code,
            stage=stage_of[device.device_id],
            feeds_into_device_id=neighbour.device_id,
            feeds_into_code=neighbour.code,
            feeds_into_stage=stage_of[neighbour.device_id],
            candidate_stages=candidates,
            suggested_stage=suggested,
        ))
    return conflicts


@dataclass(frozen=True, slots=True)
class StaleOverride:
    """An accepted stage move the wiring no longer needs."""

    device_id: int
    code: str
    override_stage: str
    type_stage: str | None


def stale_overrides(devices: list[WiredDevice]) -> list[StaleOverride]:
    """Overrides that would cause no conflict if removed.

    Wiring gets corrected. An override accepted against last month's wiring can
    outlive the reason it was accepted, and an override nobody can justify is a
    second source of truth quietly rotting — the same failure
    `plant_dashboard_slot_overrides` avoids by being expected to stay empty.
    """
    stale: list[StaleOverride] = []
    for device in devices:
        if device.stage_override is None or device.type_stage is None:
            continue
        if device.stage_override == device.type_stage:
            continue
        # Put this one Device back on its Type default and re-test. Everything
        # else keeps whatever it has, because we are asking about this override
        # alone, not proposing to clear them all at once.
        without = [
            WiredDevice(
                device_id=d.device_id, code=d.code,
                device_type_code=d.device_type_code,
                parent_device_id=d.parent_device_id,
                in_power_path=d.in_power_path, type_stage=d.type_stage,
                stage_override=None if d.device_id == device.device_id
                else d.stage_override,
            )
            for d in devices
        ]
        if any(c.device_id == device.device_id
               for c in detect_stage_conflicts(without)):
            continue
        stale.append(StaleOverride(
            device_id=device.device_id, code=device.code,
            override_stage=device.stage_override, type_stage=device.type_stage,
        ))
    return stale
