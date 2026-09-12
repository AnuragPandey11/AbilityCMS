"""Device Health: the communication and data-quality state of a Device.

Distinct from its Readings. A Device that stops transmitting generates no
message and therefore triggers nothing — the periodic sweep is the only
mechanism that detects a silent Device (MASTER §6.3).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base, pk

COMM_STATUSES = ("online", "degraded", "offline", "unknown")


class DeviceHealth(Base):
    """Current state, one row per Device.

    A hot table updated every sweep, so autovacuum is tuned aggressively in the
    migration: at ~150 rows the scale factor never triggers on its own.
    """

    __tablename__ = "device_health"
    __table_args__ = (
        CheckConstraint(f"comm_status IN {COMM_STATUSES}", name="health_comm_status"),
    )

    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True
    )
    client_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    plant_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    comm_status: Mapped[str] = mapped_column(String(16), nullable=False, default="unknown")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Catches the opposite failure to silence: a Device reporting exactly on
    # schedule with a value that has not changed. Every staleness check reads a
    # stuck sensor as healthy.
    frozen_tag_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completeness_24h: Mapped[float | None] = mapped_column(Float)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DeviceHealthEvent(Base):
    """One status transition. Availability is computed time-weighted from here.

    Never from current state: a Device that is online now says nothing about the
    six hours it was offline this morning.
    """

    __tablename__ = "device_health_events"
    __table_args__ = (Index("ix_device_health_events_device_time", "device_id", "occurred_at"),)

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    device_id: Mapped[int] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), nullable=False
    )
    plant_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    from_status: Mapped[str | None] = mapped_column(String(16))
    to_status: Mapped[str] = mapped_column(String(16), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 'communication' vs 'equipment' — tender §18 lists them as separate loss
    # categories, and conflating them corrupts availability figures.
    cause: Mapped[str | None] = mapped_column(Text)
