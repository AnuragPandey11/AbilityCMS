"""Device Types, Device Models, and the Tag registry. Global, platform-owned.

I-2: no Tag is ever a database column. Tags are rows in `tags`, which is the
single decision that makes F-12 (new Device Types) and F-14 (config-driven
dashboards) possible — adding a metric is an INSERT, not a migration.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base, created_at, pk

TAG_CATEGORIES = ("performance", "electrical", "diagnostic", "environmental", "status")
ROLLUP_METHODS = ("avg", "last", "max")


class DeviceType(Base):
    """The category a Device belongs to. Extensible — not a fixed list (F-12)."""

    __tablename__ = "device_types"

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # Which of the four fixed SLD stages this Type folds into (domain/sld_stages).
    # NULL means it carries no current and is not drawn. A column rather than a
    # code path because a VCB sits at a transformer bay on one Plant and an MCR
    # feeder position on another, and moving it must not be a deploy.
    sld_stage: Mapped[str | None] = mapped_column(String(16))
    # Determines Single Line Diagram membership. A Device outside the power path
    # is real and monitored, but electricity does not flow through it; placing it
    # in the electrical tree would corrupt the diagram (MASTER §2.3).
    in_power_path: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    variant_set: Mapped[list[str] | None] = mapped_column(ARRAY(Text))
    created_at: Mapped[datetime] = created_at()


class DeviceModel(Base):
    """A specific make and model. Variants are Model-level facts, not Device-level.

    A Sungrow SG250HX is always a string inverter; the variant determines which
    Tags exist and which SLD shape is valid (MASTER §2.3).
    """

    __tablename__ = "device_models"
    __table_args__ = (UniqueConstraint("manufacturer", "model_code"),)

    id: Mapped[int] = pk()
    device_type_id: Mapped[int] = mapped_column(ForeignKey("device_types.id"), nullable=False)
    manufacturer: Mapped[str] = mapped_column(Text, nullable=False)
    model_code: Mapped[str] = mapped_column(Text, nullable=False)
    variant: Mapped[str | None] = mapped_column(String(32))
    rated_capacity_kw: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = created_at()


class Tag(Base):
    """One measurable quantity. The canonical metric registry.

    `rollup_method` is carried per Tag because a continuous aggregate cannot infer
    it from the value: `avg` for power, `last` for cumulative counters, `max` for
    peaks. Averaging a cumulative energy counter is meaningless (MASTER §3.5).
    """

    __tablename__ = "tags"
    __table_args__ = (
        CheckConstraint(f"category IN {TAG_CATEGORIES}", name="tag_category"),
        CheckConstraint(f"rollup_method IN {ROLLUP_METHODS}", name="tag_rollup_method"),
    )

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    # ⚠ unit and scale_default seed from domain/assumptions.py and are wrong until
    # the client supplies the real table (OPEN-15).
    unit: Mapped[str] = mapped_column(String(32), nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False, default="performance")
    rollup_method: Mapped[str] = mapped_column(String(8), nullable=False, default="avg")
    scale_default: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    valid_min: Mapped[float | None] = mapped_column(Float)
    valid_max: Mapped[float | None] = mapped_column(Float)
    min_interval_s: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    is_cumulative: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # A calculated Tag: arithmetic over other Tag codes, evaluated by
    # `domain/derived.py`. NULL means a Device publishes this value. Keeping the
    # formula as data is what makes the client's "Need to Calculate" rows an
    # INSERT rather than a release (migration 0020).
    formula: Mapped[str | None] = mapped_column(Text)
    derived_scope: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = created_at()

    @property
    def is_derived(self) -> bool:
        return self.formula is not None


class DeviceModelTag(Base):
    """The Model's Tag template: which Tags this Model can report, and the usual key.

    A template only. What a specific Device was *actually* wired as lives in
    `device_tag_bindings`, because field wiring never matches the datasheet.
    """

    __tablename__ = "device_model_tags"

    device_model_id: Mapped[int] = mapped_column(
        ForeignKey("device_models.id", ondelete="CASCADE"), primary_key=True
    )
    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True
    )
    default_source_key: Mapped[str | None] = mapped_column(Text)
    # Position within a repeating group — PV1..PV28 on an Inverter. NULL for a
    # signal that appears once. A Device binds these up to its `string_count`,
    # because how many strings a unit has is a fact about the unit, not the Model.
    repeat_index: Mapped[int | None] = mapped_column(Integer)
    # The order the client's own sheet lists the signal in. Alphabetical ordering
    # of eighty PV rows is unreadable to the engineer commissioning the Device.
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class DashboardSlot(Base):
    """A position on the fixed dashboard — `kpi.current_power`, not a Tag.

    The layout is the same on every Plant; what varies is which Device is in a
    position to answer. That is the whole argument against a drag-and-drop canvas:
    a canvas makes every Plant a bespoke artefact nobody can compare against
    another, where this makes every Plant the same screen answered by whatever
    equipment it happens to have.

    ⚠ Not `dashboards` (identity.py), which registers the dashboard *types* a User
    may open. These are positions inside one.
    """

    __tablename__ = "dashboard_slots"
    __table_args__ = (UniqueConstraint("panel", "position"),)

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    panel: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    unit_hint: Mapped[str | None] = mapped_column(Text)
    # A rooftop Plant has no winding temperature, and a permanent dash beside a
    # transformer icon reads as a fault rather than as an absence.
    hide_when_unresolved: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    # The operational panel must show something when the settlement meter goes
    # quiet; a Financial Report must not, and never resolves through here (I-8).
    fallback_when_silent: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = created_at()


class DashboardSlotCandidate(Base):
    """One way a slot could be answered. Lowest `priority` that the Plant is bound for wins.

    Named by Device *Type*, never by Device or Plant (Guardrail 2): a Plant with
    three MFMs and a Plant with one resolve through the same row.
    """

    __tablename__ = "dashboard_slot_candidates"
    __table_args__ = (UniqueConstraint("slot_id", "priority"),)

    id: Mapped[int] = pk()
    slot_id: Mapped[int] = mapped_column(
        ForeignKey("dashboard_slots.id", ondelete="CASCADE"), nullable=False
    )
    priority: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    device_type_id: Mapped[int | None] = mapped_column(
        ForeignKey("device_types.id", ondelete="CASCADE")
    )
    tag_id: Mapped[int | None] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"))
    # How several Devices' readings become one number. Not cosmetic: eight
    # Inverters produce eight lots of power, which sum, but sit at roughly one DC
    # voltage, which does not.
    aggregate: Mapped[str] = mapped_column(Text, nullable=False, default="first")
    plant_attribute: Mapped[str | None] = mapped_column(Text)
    online_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class DeviceTableColumn(Base):
    """Which Tags form the columns of a per-Device table, by Device Type."""

    __tablename__ = "device_table_columns"
    __table_args__ = (
        UniqueConstraint("device_type_id", "tag_id"),
        UniqueConstraint("device_type_id", "position"),
    )

    id: Mapped[int] = pk()
    device_type_id: Mapped[int] = mapped_column(
        ForeignKey("device_types.id", ondelete="CASCADE"), nullable=False
    )
    tag_id: Mapped[int] = mapped_column(
        ForeignKey("tags.id", ondelete="CASCADE"), nullable=False
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)
