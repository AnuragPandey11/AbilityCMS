"""The four-stage Single Line Diagram: PV Array → Inverters → Transformer → Grid.

`sld.py` builds the *true* tree from `parent_device_id` — one box per Device,
whatever shape the Plant is. That is the view you want when something is wrong
and you need to know which Inverter. This module builds the other one: a fixed
four-stage spine that looks identical on every Plant, because an operator
comparing two Plants cannot do it across two differently-shaped diagrams.

Every power-path Device folds into exactly one of four stages, by **Device Type**
— never by Device, Plant or Client (Guardrail 2):

    PV_ARRAY     DC generation and DC collection   PV_ARRAY, SMB, DCDB
    INVERTERS    DC→AC conversion, LT collection   INVERTER, ACDB, ICR_SECTION
    TRANSFORMER  LT→HT step-up and HT switching    TRANSFORMER, VCB, ISOLATOR
    GRID         evacuation and metering           MCR_SECTION, MFM, ABT_METER

The mapping below is the *default*. It is seeded into `device_types.sld_stage`,
which is the thing actually read at runtime, so moving the VCBs that sit in an
MCR from the Transformer stage to the Grid stage is an UPDATE rather than an
argument about this docstring. A Type with no stage — WMS, PPC, UPS, PLANT_KPI —
is not in the electrical path and does not appear, exactly as in `sld.py`.

**All four stages always render, including empty ones.** A rooftop Plant with no
Transformer still shows the Transformer stage, marked not instrumented. Dropping
it would make the diagram a different shape per Plant, which is the thing this
view exists to prevent, and "the platform sees no transformer here" is itself
worth reading — on an 8 MW Plant it means a Device nobody registered.

Pure (Guardrail 9): Devices and slot specs in, stages out.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final

from solarcms.domain.slots import DeviceFacts, PlantFacts, ResolvedSlot, SlotSpec, resolve_all

# Left to right, generation to grid — the order every engineer reads a single
# line diagram in, and fixed regardless of what the Plant contains.
SLD_STAGES: Final[tuple[str, ...]] = ("PV_ARRAY", "INVERTERS", "TRANSFORMER", "GRID")

STAGE_LABELS: Final[dict[str, str]] = {
    "PV_ARRAY": "PV Array",
    "INVERTERS": "Inverters",
    "TRANSFORMER": "Transformer",
    "GRID": "Grid",
}

# The stage each Device Type folds into. Seeded to `device_types.sld_stage`;
# a Type absent here carries no current and is not drawn (MASTER §2.3).
DEFAULT_STAGE_BY_DEVICE_TYPE: Final[dict[str, str]] = {
    # ── Generation and DC collection.
    "PV_ARRAY": "PV_ARRAY",
    "SMB": "PV_ARRAY",      # String Monitoring Box — per-string DC currents
    "DCDB": "PV_ARRAY",     # DC Distribution Board — combines strings to the inverter
    # ── Conversion and LT collection.
    "INVERTER": "INVERTERS",
    "ACDB": "INVERTERS",        # AC Distribution Board — combines inverter LT outputs
    "ICR_SECTION": "INVERTERS", # Inverter Control Room — where that collection lives
    # ── Step-up and HT switching.
    "TRANSFORMER": "TRANSFORMER",
    "VCB": "TRANSFORMER",       # ⚠ a VCB in an MCR is arguably Grid-side; see below
    "ISOLATOR": "TRANSFORMER",
    # ── Evacuation and metering.
    "MCR_SECTION": "GRID",  # Main Control Room — HT switchgear, incomers and feeders
    "MFM": "GRID",          # operational metering at the evacuation point
    "ABT_METER": "GRID",    # the sealed settlement instrument (I-8)
}

# ⚠ VCB is the one genuinely ambiguous Type: the client's schedule places VCBs at
# both transformer bays and MCR feeder positions, and a Type can only fold one
# way. Defaulted to TRANSFORMER because protection around the step-up is the more
# common position; a Plant that disagrees changes the column, not this file.


@dataclass(frozen=True, slots=True)
class SldStage:
    """One of the four boxes, with everything that folded into it."""

    code: str
    label: str
    position: int
    devices: tuple[DeviceFacts, ...] = ()
    slots: tuple[ResolvedSlot, ...] = ()

    @property
    def device_count(self) -> int:
        return len(self.devices)

    @property
    def online_count(self) -> int:
        return sum(1 for d in self.devices if d.online)

    @property
    def instrumented(self) -> bool:
        """False when no Device folds into this stage.

        Not the same as "the stage is down" — it means the platform has no Device
        registered here at all, which on a rooftop Plant is normal and on an 8 MW
        Plant is a commissioning gap. The caller renders the two differently.
        """
        return bool(self.devices)

    @property
    def health(self) -> str:
        """`ok`, `degraded`, `down`, or `unmonitored` — what colours the box.

        Partial loss is `degraded` rather than `down` because eleven of twelve
        Inverters running is not an outage, and colouring it the same as a dead
        stage trains operators to ignore the colour.
        """
        if not self.devices:
            return "unmonitored"
        if self.online_count == 0:
            return "down"
        if self.online_count < self.device_count:
            return "degraded"
        return "ok"


@dataclass(slots=True)
class SldStages:
    stages: list[SldStage] = field(default_factory=list)
    # Power-path Devices whose Type maps to no stage. Reported rather than
    # dropped: a Type someone added to the catalogue without giving it a stage
    # would otherwise vanish from the diagram with nothing said. Devices outside
    # the power path are not listed here — their absence is intended, not a gap.
    unstaged: list[DeviceFacts] = field(default_factory=list)


def stage_for(
    device_type_code: str, stage_by_type: Mapping[str, str] | None = None
) -> str | None:
    mapping = stage_by_type if stage_by_type is not None else DEFAULT_STAGE_BY_DEVICE_TYPE
    stage = mapping.get(device_type_code)
    return stage if stage in SLD_STAGES else None


def build_stages(
    facts: PlantFacts,
    stage_slots: Mapping[str, Sequence[SlotSpec]] | None = None,
    stage_by_type: Mapping[str, str] | None = None,
    units: Mapping[str, str] | None = None,
) -> SldStages:
    """Fold a Plant's Devices into the four stages and resolve each stage's slots.

    `stage_slots` maps a stage code to the slots drawn inside its box. Each stage
    resolves against **only its own Devices** — a narrowed `PlantFacts` — so a
    candidate written as "SUM of INVERTER.AC_ACTIVE_POWER" inside the Inverters
    stage cannot accidentally pick up a meter sitting in the Grid stage.
    """
    stage_slots = stage_slots or {}
    result = SldStages()

    buckets: dict[str, list[DeviceFacts]] = {code: [] for code in SLD_STAGES}
    for device in sorted(facts.devices, key=lambda d: d.code):
        code = stage_for(device.device_type_code, stage_by_type)
        if code is None:
            # A Weather Station or a Plant KPI panel is *deliberately* absent
            # from an electrical diagram (MASTER §2.3) and is not worth
            # reporting. A Device that does carry current and still has no stage
            # is a gap in the catalogue, and saying so is the only way anyone
            # finds out before the diagram is quietly missing a switchyard.
            if device.in_power_path:
                result.unstaged.append(device)
            continue
        buckets[code].append(device)

    for position, code in enumerate(SLD_STAGES):
        devices = tuple(buckets[code])
        scoped = PlantFacts(
            plant_id=facts.plant_id, devices=devices, attributes=facts.attributes
        )
        specs = list(stage_slots.get(code, ()))
        readouts = tuple(
            slot for slot in resolve_all(specs, scoped, units) if not slot.hidden
        )
        result.stages.append(
            SldStage(
                code=code, label=STAGE_LABELS[code], position=position,
                devices=devices, slots=readouts,
            )
        )
    return result
