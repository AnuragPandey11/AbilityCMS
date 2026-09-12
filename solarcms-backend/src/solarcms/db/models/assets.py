"""Regions, Plants, Blocks, Devices, Tag Bindings, and the ingress topic registry.

The three groupings of a Device (MASTER §3.4, I-10) are three *separate*
relationships, and no column may express another's meaning:

    block_id              → where is it?            geographic
    parent_device_id      → what is it wired into?  electrical (the SLD)
    reports_via_device_id → what transmits it?      communication

Collapsing any two makes both unanswerable. The third is what distinguishes a
failed Collector from genuine generation downtime — without it, a communication
failure is recorded as equipment downtime and corrupts the availability figures
that performance guarantees are calculated from.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base, created_at, pk

PLANT_STATUSES = ("draft", "commissioning", "active", "decommissioned")
DEVICE_STATUSES = ("active", "maintenance", "decommissioned")


class Region(Base):
    """A state or geographic grouping that Plants belong to."""

    __tablename__ = "regions"

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    country: Mapped[str] = mapped_column(String(2), nullable=False, default="IN")
    # CO2-avoided varies by grid, so it belongs to the Region, not a constant.
    grid_emission_factor_kg_per_kwh: Mapped[float | None] = mapped_column(Numeric(6, 4))
    created_at: Mapped[datetime] = created_at()


class Plant(Base):
    """One physical generation site, belonging to exactly one Client.

    A Plant in `draft` or `commissioning` is excluded from Portfolio aggregates,
    so a half-mapped Plant never drags fleet PR down (MASTER §6.5).
    """

    __tablename__ = "plants"
    __table_args__ = (
        UniqueConstraint("client_id", "code"),
        CheckConstraint(f"status IN {PLANT_STATUSES}", name="plant_status"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False
    )
    region_id: Mapped[int | None] = mapped_column(ForeignKey("regions.id"))
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="draft")
    ac_capacity_kw: Mapped[float | None] = mapped_column(Numeric(12, 2))
    dc_capacity_kwp: Mapped[float | None] = mapped_column(Numeric(12, 2))
    latitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    longitude: Mapped[float | None] = mapped_column(Numeric(9, 6))
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="Asia/Kolkata")
    commissioned_on: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = created_at()


class Block(Base):
    """An optional, Client-defined subdivision of a Plant. Flat — no sub-Blocks.

    Geographic, not electrical: a Block never appears in the Single Line Diagram
    (Guardrail 11). It carries capacity so that PR, CUF and specific yield are
    reportable per Block.
    """

    __tablename__ = "blocks"
    __table_args__ = (UniqueConstraint("plant_id", "code"),)

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False
    )
    plant_id: Mapped[int] = mapped_column(
        ForeignKey("plants.id", ondelete="CASCADE"), nullable=False
    )
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    capacity_kwp: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    # Deliberately no parent_block_id. Blocks are flat, one level only (MASTER §2.2).


class Device(Base):
    """One physical piece of equipment installed at a Plant."""

    __tablename__ = "devices"
    __table_args__ = (
        UniqueConstraint("plant_id", "code"),
        UniqueConstraint("id", "plant_id", name="uq_device_plant"),
        # I-3: a Device's parent must belong to the same Plant. Enforced by a
        # composite FK rather than a trigger, so it cannot be bypassed.
        ForeignKeyConstraint(
            ["parent_device_id", "plant_id"],
            ["devices.id", "devices.plant_id"],
            name="fk_parent_same_plant",
        ),
        CheckConstraint(f"status IN {DEVICE_STATUSES}", name="device_status"),
        CheckConstraint("parent_device_id IS NULL OR parent_device_id <> id",
                        name="device_not_own_parent"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False
    )
    plant_id: Mapped[int] = mapped_column(
        ForeignKey("plants.id", ondelete="CASCADE"), nullable=False
    )
    device_model_id: Mapped[int] = mapped_column(ForeignKey("device_models.id"), nullable=False)
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    serial_number: Mapped[str | None] = mapped_column(Text)

    # ── The three groupings (§3.4). Independent by design. ──────────────────
    block_id: Mapped[int | None] = mapped_column(ForeignKey("blocks.id"))
    parent_device_id: Mapped[int | None] = mapped_column(nullable=True)
    reports_via_device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id"))

    # The MQTT topic this Device publishes on. MASTER §3.7: this column already
    # *is* the data-source mapping, which is why `data_source_connections` was
    # dropped once ingestion became MQTT-only.
    source_address: Mapped[str | None] = mapped_column(Text, unique=True)
    # Set per Device from observation at commissioning, never from the assumed
    # default — the test broker publishes ~21x faster than assumed.
    expected_interval_s: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    rated_capacity_kw: Mapped[float | None] = mapped_column(Numeric(12, 2))
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="active")
    installed_on: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = created_at()


class DeviceTagBinding(Base):
    """What a specific Device was actually wired as. Per-Device, never per-Model.

    MASTER §5.2's worked example: INV-01 binds AC_ACTIVE_POWER to source key `pa`
    at scale 0.1; INV-02, same Model and Plant on newer firmware, binds the same
    Tag to `P_ac` at scale 1.0. Both are correct.
    """

    __tablename__ = "device_tag_bindings"
    __table_args__ = (
        UniqueConstraint("device_id", "tag_id"),
        UniqueConstraint("device_id", "source_key"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False
    )
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    tag_id: Mapped[int] = mapped_column(ForeignKey("tags.id"), nullable=False)
    source_key: Mapped[str] = mapped_column(Text, nullable=False)
    scale: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    value_offset: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    valid_min: Mapped[float | None] = mapped_column(Float)
    valid_max: Mapped[float | None] = mapped_column(Float)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = created_at()


class TopicPatternRow(Base):
    """Ingress registry: how to read origin out of a topic.

    The topic is the sole authority for origin (Guardrail 5). The canonical
    contract `scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}`
    is one row here; a Client publishing a legacy shape is another row. Keeping
    this as data is what stops a Client's name becoming a code path (I-1).
    """

    __tablename__ = "topic_patterns"

    id: Mapped[int] = pk()
    # NULL client_id = a platform-wide pattern, e.g. the canonical contract.
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"))
    pattern: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=100)
    description: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = created_at()


class BrokerCredential(Base):
    """One credential per publishing endpoint. Issued by the CMS, never by hand.

    The broker authenticates against the CMS and holds no independent user list —
    maintaining one guarantees drift within weeks (MASTER §5.1). Shown once at
    creation and stored irreversibly; lost credentials are regenerated, never
    retrieved. Scope is constrained to the issuing Client's address space (I-9).
    """

    __tablename__ = "broker_credentials"

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False
    )
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"))
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    username: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    topic_scope: Mapped[str] = mapped_column(Text, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()
