"""Readings and the raw payload archive. Both hypertables.

`readings` is narrow — one row per (time, device, tag) — not a column per metric.
Device Models expose different Tag sets: a Weather Station has no voltage, a
String Box no irradiance, a three-winding Transformer reports three windings
where a two-winding reports two. A wide table would be mostly NULL and every new
Device Model would need a migration (MASTER §3.5, I-2).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    Index,
    Integer,
    SmallInteger,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base


class Reading(Base):
    """One value of one Tag, from one Device, at one instant.

    No surrogate key: the hypertable is partitioned on `time` and the natural key
    is (time, device_id, tag_id). `client_id` is deliberately denormalised —
    redundant with devices → plants → clients, but it lets row-level security and
    chunk pruning work without a three-table join on every historical query. The
    cost is a few bytes per row that compression largely erases (MASTER §3.5).
    """

    __tablename__ = "readings"
    __table_args__ = (
        # Composite PK cannot be used: TimescaleDB requires the partitioning
        # column in every unique index, and readings are append-only anyway.
        Index("ix_readings_device_tag_time", "device_id", "tag_id", "time"),
        Index("ix_readings_client_time", "client_id", "time"),
        {"info": {"hypertable": "time"}},
    )

    time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), primary_key=True, nullable=False
    )
    client_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, nullable=False)
    device_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, nullable=False)
    tag_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False)
    # 0 good, 1 out of range, 2 stale, 3 unparseable. Out-of-range values are
    # stored and flagged, never discarded — 3.29151E-41 in a reactive-power Tag
    # is diagnostic information (BACKEND_SPEC §6.4).
    quality: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)
    # Device clock, per tender §28. NULL where the publisher sends no timestamp —
    # which is the case for the client's current test broker.
    source_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MqttRaw(Base):
    """Every payload as received, before decoding.

    The only path back to correct history if a binding scale factor is later
    found wrong (MASTER §5.3) — and the quarantine destination for a message on
    an unrecognised topic, which is never attributed to a Client by inference.
    """

    __tablename__ = "mqtt_raw"
    __table_args__ = (
        Index("ix_mqtt_raw_topic_time", "topic", "time"),
        Index("ix_mqtt_raw_quarantined", "time", postgresql_where=text("quarantined")),
        {"info": {"hypertable": "time"}},
    )

    time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), primary_key=True, nullable=False
    )
    topic: Mapped[str] = mapped_column(Text, primary_key=True, nullable=False)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, nullable=False, default=0)
    payload: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    # NULL when the topic could not be resolved. Never guessed.
    client_id: Mapped[int | None] = mapped_column(BigInteger)
    device_id: Mapped[int | None] = mapped_column(BigInteger)
    quarantined: Mapped[bool] = mapped_column(nullable=False, default=False)
    reason: Mapped[str | None] = mapped_column(Text)
