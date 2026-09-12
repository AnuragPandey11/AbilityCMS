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
    created_at: Mapped[datetime] = created_at()


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
