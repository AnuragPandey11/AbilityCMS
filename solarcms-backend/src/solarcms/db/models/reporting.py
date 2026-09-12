"""Report definitions, schedules and runs.

Reports render from aggregate tiers, never raw `readings` — a monthly all-Plant
Report is a query over agg_1d, not a scan of billions of rows (MASTER §6.6).
Financial Reports use ABT Meter Readings only (I-11).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base, created_at, pk

RUN_STATES = ("queued", "running", "succeeded", "failed")
FORMATS = ("pdf", "xlsx", "csv")


class ReportDefinition(Base):
    """A template plus a query specification. Generic by design — the full tender
    §25 catalogue is rows here, not code."""

    __tablename__ = "report_definitions"

    id: Mapped[int] = pk()
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    # {scope, period, tags, devices, aggregation…}
    query_spec: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    # I-11: when true, only ABT Meter Readings are admissible as input.
    is_financial: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = created_at()


class ReportSchedule(Base):
    __tablename__ = "report_schedules"

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False
    )
    definition_id: Mapped[int] = mapped_column(
        ForeignKey("report_definitions.id", ondelete="CASCADE"), nullable=False
    )
    cron: Mapped[str] = mapped_column(String(64), nullable=False)
    timezone: Mapped[str] = mapped_column(String(64), nullable=False, default="Asia/Kolkata")
    recipient_user_ids: Mapped[list[int]] = mapped_column(ARRAY(BigInteger), nullable=False)
    formats: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ReportRun(Base):
    __tablename__ = "report_runs"
    __table_args__ = (CheckConstraint(f"state IN {RUN_STATES}", name="run_state"),)

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    definition_id: Mapped[int] = mapped_column(
        ForeignKey("report_definitions.id", ondelete="CASCADE"), nullable=False
    )
    schedule_id: Mapped[int | None] = mapped_column(
        ForeignKey("report_schedules.id", ondelete="SET NULL")
    )
    requested_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    period_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    artifact_urls: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    row_count: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at()
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
