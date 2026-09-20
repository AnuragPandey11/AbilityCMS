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
        CheckConstraint("collector_code IS NULL OR length(btrim(collector_code)) > 0",
                        name="collector_code_not_blank"),
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
    # The communications enclosure this Device sits in — the `{collector_code}`
    # segment of the topic. A Collector is **not a Device** (migration 0022): it
    # publishes nothing, carries no current, and appears in the diagram as a box
    # drawn *around* its Devices, never as a node in the chain. NULL is a real
    # answer, not missing data — the five-segment topic shape has no Collector,
    # and a Device on it genuinely sits in none.
    #
    # Beside `reports_via_device_id`, not instead of it: "transmitted by that
    # datalogger" and "in the same room as that Inverter" are different claims,
    # and only the first is a Device-to-Device relationship.
    collector_code: Mapped[str | None] = mapped_column(String(64))

    # The MQTT topic this Device publishes on. MASTER §3.7: this column already
    # *is* the data-source mapping, which is why `data_source_connections` was
    # dropped once ingestion became MQTT-only.
    source_address: Mapped[str | None] = mapped_column(Text, unique=True)
    # Set per Device from observation at commissioning, never from the assumed
    # default — the test broker publishes ~21x faster than assumed.
    expected_interval_s: Mapped[int] = mapped_column(Integer, nullable=False, default=60)
    rated_capacity_kw: Mapped[float | None] = mapped_column(Numeric(12, 2))
    # How many inputs of a repeating group this unit actually has — the number of
    # PV strings on an Inverter. NULL where the Model has no repeating group.
    string_count: Mapped[int | None] = mapped_column(Integer)
    # Which of the four stages this Device folds into, overriding its Type's
    # default for this Device alone (migration 0027). NULL is the normal case.
    #
    # Exists because `device_types.sld_stage` is global: an LT feeder meter wired
    # upstream of the transformer is Type MFM and folds into Grid, and correcting
    # that by editing the Type would move every MFM on every Plant of every
    # Client. Set only by a human accepting a reported contradiction between the
    # wiring and the Type default — never by inference.
    sld_stage_override: Mapped[str | None] = mapped_column(String(16))
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


class PlantCollector(Base):
    """What one enclosure feeds into. Created by migration 0024.

    ⚠ **Not a Device and never to become one** (Guardrail 12). No Device Model,
    no Device Type, no Tags, no topic, no Readings — and `devices` carries no
    foreign key to this table. It holds the single fact a Collector owns beyond
    its name: the Device its outgoing connection lands on.

    Membership stays on `devices.collector_code`, which comes from the topic and
    is the sole authority for it (Guardrail 5). A Collector needs **no row here
    to exist** — sixteen Devices can share `collector_code = 'MCR'` with nothing
    in this table and the box still draws. A row appears only once somebody has
    said something *about* the enclosure, so the table is expected to be sparse
    in the manner of `plant_dashboard_slot_overrides`, and every join to it is
    LEFT.

    ⚠ This class exists so `alembic revision --autogenerate` does not propose
    dropping the table. Nothing reads through the ORM — the routers use explicit
    SQL — but a table absent from the metadata is a table autogenerate believes
    has been deleted, and the generated migration would take the Plant's
    collector wiring with it.
    """

    __tablename__ = "plant_collectors"
    __table_args__ = (
        UniqueConstraint("plant_id", "code", name="uq_plant_collectors_plant_code"),
        # I-3 applied to the box: a Collector cannot feed into a Device at
        # another Plant. Structural, exactly as `fk_parent_same_plant` is for a
        # Device, so no code path can bypass it.
        ForeignKeyConstraint(
            ["parent_device_id", "plant_id"], ["devices.id", "devices.plant_id"],
            name="fk_collector_parent_same_plant",
        ),
        CheckConstraint("length(btrim(code)) > 0", name="collector_code_not_blank"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False
    )
    plant_id: Mapped[int] = mapped_column(
        ForeignKey("plants.id", ondelete="CASCADE"), nullable=False
    )
    # Case-sensitive, exactly as the topic spells it: folding would merge two
    # enclosures for the same reason it would merge two origins.
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    # NULL is a real answer — an enclosure whose outward connection nobody has
    # recorded yet, which is every Collector the moment it first appears.
    parent_device_id: Mapped[int | None] = mapped_column(nullable=True)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at()


class PlantDeviceCount(Base):
    """The planned Device count per Device Type. Created by migration 0019.

    ⚠ **No longer collected.** The onboarding input was removed on 19 Sep 2026:
    a figure typed from a contract before a single Device existed began drifting
    from reality the moment one was registered, and nothing depended on it
    closely enough to catch it being wrong. The count that matters is derived —
    `count(*)` over registered Devices, grouped by Type — and cannot drift.

    The table is kept rather than dropped so no history is destroyed, and
    modelled here for the same reason `PlantCollector` is: a table missing from
    the metadata is one autogenerate believes has been deleted.
    """

    __tablename__ = "plant_device_counts"
    __table_args__ = (
        UniqueConstraint("plant_id", "device_type_id",
                         name="uq_plant_device_counts_plant_type"),
        CheckConstraint("planned_count >= 0", name="positive"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False
    )
    plant_id: Mapped[int] = mapped_column(
        ForeignKey("plants.id", ondelete="CASCADE"), nullable=False
    )
    device_type_id: Mapped[int] = mapped_column(
        ForeignKey("device_types.id"), nullable=False
    )
    planned_count: Mapped[int] = mapped_column(Integer, nullable=False)


class PlantDashboardSlotOverride(Base):
    """Where the default candidate order resolves wrongly for one Plant.

    Most often a Plant with parallel feeder metering, where the catalogue's
    default `first` reads one of two feeders and `sum` is the correct answer
    (`domain/dashboard_spec._METERED_AGGREGATE`).

    ⚠ This is **not** a per-Plant dashboard, which Guardrail 2 forbids. It holds
    a deviation from a shared default, keyed to a Plant, and is expected to be
    empty for almost every Plant — that it is usually empty is exactly what
    distinguishes the two. Nothing here reaches a code path or a table name.

    `note` records *why*, because a year later nobody remembers.
    """

    __tablename__ = "plant_dashboard_slot_overrides"
    __table_args__ = (UniqueConstraint("plant_id", "slot_id"),)

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="RESTRICT"), nullable=False
    )
    plant_id: Mapped[int] = mapped_column(
        ForeignKey("plants.id", ondelete="CASCADE"), nullable=False
    )
    slot_id: Mapped[int] = mapped_column(
        ForeignKey("dashboard_slots.id", ondelete="CASCADE"), nullable=False
    )
    # All NULL with hidden = True means "do not show this slot on this Plant"
    # without proposing a different source.
    kind: Mapped[str | None] = mapped_column(Text)
    device_type_id: Mapped[int | None] = mapped_column(
        ForeignKey("device_types.id", ondelete="CASCADE")
    )
    tag_id: Mapped[int | None] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"))
    aggregate: Mapped[str | None] = mapped_column(Text)
    plant_attribute: Mapped[str | None] = mapped_column(Text)
    online_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at()
