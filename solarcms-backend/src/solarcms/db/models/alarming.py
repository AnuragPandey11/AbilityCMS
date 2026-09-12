"""Alarm Rules, Alarms, Escalation, Notifications, Incident Snapshots.

One Alarm Rule breaching continuously on one Device produces exactly one Alarm,
not one per Reading — enforced by a partial unique index on
(rule_id, device_id) WHERE state IN ('active','acknowledged'). A fault persisting
six hours is one row (MASTER §3.5).
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    ARRAY,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base, created_at, pk

SEVERITIES = ("critical", "high", "medium", "low")
ALARM_STATES = ("active", "acknowledged", "resolved")
CHANNELS = ("email", "whatsapp", "sms")
RULE_SCOPES = ("global", "client", "plant", "device_type", "device")
OPERATORS = ("gt", "lt", "outside", "inside", "eq", "is_true", "is_false", "special")


class AlarmRule(Base):
    """A configured condition that raises an Alarm when breached.

    Scope resolution is most-specific-wins: device → plant → device_type →
    global. A rule with NULL client_id is a platform default inherited by every
    Client (BACKEND_SPEC §10.1).
    """

    __tablename__ = "alarm_rules"
    __table_args__ = (
        CheckConstraint(f"severity IN {SEVERITIES}", name="rule_severity"),
        CheckConstraint(f"scope_type IN {RULE_SCOPES}", name="rule_scope_type"),
        CheckConstraint(f"operator IN {OPERATORS}", name="rule_operator"),
        UniqueConstraint("client_id", "code", "scope_type", "scope_id"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int | None] = mapped_column(ForeignKey("clients.id", ondelete="CASCADE"))
    code: Mapped[str] = mapped_column(String(64), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False, default="global")
    scope_id: Mapped[int | None] = mapped_column(BigInteger)
    tag_id: Mapped[int | None] = mapped_column(ForeignKey("tags.id"))
    operator: Mapped[str] = mapped_column(String(16), nullable=False)
    threshold: Mapped[float | None] = mapped_column(Float)
    threshold_high: Mapped[float | None] = mapped_column(Float)
    # Hysteresis: clear at clear_threshold if set, otherwise at threshold.
    clear_threshold: Mapped[float | None] = mapped_column(Float)
    # Debounce: the condition must hold this long before opening. Stops flapping.
    duration_s: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    severity: Mapped[str] = mapped_column(String(16), nullable=False, default="medium")
    classification: Mapped[str | None] = mapped_column(String(32))
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = created_at()


class Alarm(Base):
    """A single occurrence of a condition that breached an Alarm Rule."""

    __tablename__ = "alarms"
    __table_args__ = (
        CheckConstraint(f"state IN {ALARM_STATES}", name="alarm_state"),
        CheckConstraint(f"severity IN {SEVERITIES}", name="alarm_severity"),
        Index("ix_alarms_client_opened", "client_id", "opened_at"),
        Index("ix_alarms_plant_state", "plant_id", "state"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    rule_id: Mapped[int] = mapped_column(ForeignKey("alarm_rules.id", ondelete="CASCADE"),
                                         nullable=False)
    # NULL for an Alarm raised about a topic that resolved to no Device at all.
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    plant_id: Mapped[int | None] = mapped_column(BigInteger)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    severity: Mapped[str] = mapped_column(String(16), nullable=False)
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acknowledged_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    trigger_value: Mapped[float | None] = mapped_column(Float)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    # 'communication' vs 'equipment' — kept separate per tender §18.
    classification: Mapped[str | None] = mapped_column(String(32))
    escalation_level: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class EscalationPolicy(Base):
    __tablename__ = "escalation_policies"
    __table_args__ = (
        CheckConstraint("scope_type IN ('client','plant')", name="escalation_scope_type"),
        CheckConstraint(f"min_severity IN {SEVERITIES}", name="escalation_min_severity"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    scope_type: Mapped[str] = mapped_column(String(16), nullable=False)
    scope_id: Mapped[int | None] = mapped_column(BigInteger)
    min_severity: Mapped[str] = mapped_column(String(16), nullable=False, default="high")
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class EscalationStep(Base):
    """One rung of an escalation ladder.

    ⚠ Driven primarily by `notify_user_id` (named people). Tender §23's example
    escalates Operator → Plant Manager → Management, three distinct roles, but
    the CONFIRMED four-role model (F-7) has only Admin and Employee on the client
    side — so three levels cannot be expressed by role alone. `notify_role_id` is
    a coarse fallback. See MASTER §3.6 and OPEN-2.
    """

    __tablename__ = "escalation_steps"
    __table_args__ = (
        UniqueConstraint("policy_id", "level"),
        CheckConstraint(f"channel IN {CHANNELS}", name="step_channel"),
        CheckConstraint(
            "notify_user_id IS NOT NULL OR notify_role_id IS NOT NULL",
            name="step_has_recipient",
        ),
    )

    id: Mapped[int] = pk()
    policy_id: Mapped[int] = mapped_column(
        ForeignKey("escalation_policies.id", ondelete="CASCADE"), nullable=False
    )
    level: Mapped[int] = mapped_column(Integer, nullable=False)
    delay_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    notify_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    notify_role_id: Mapped[int | None] = mapped_column(ForeignKey("roles.id"))
    channel: Mapped[str] = mapped_column(String(16), nullable=False)


class NotificationSubscription(Base):
    """Who wants to hear about what, and how. Tender §22."""

    __tablename__ = "notification_subscriptions"
    __table_args__ = (
        CheckConstraint(f"channel IN {CHANNELS}", name="subscription_channel"),
        CheckConstraint(f"min_severity IN {SEVERITIES}", name="subscription_min_severity"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"),
                                         nullable=False)
    plant_id: Mapped[int | None] = mapped_column(ForeignKey("plants.id", ondelete="CASCADE"))
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    min_severity: Mapped[str] = mapped_column(String(16), nullable=False, default="medium")
    message_template: Mapped[str | None] = mapped_column(Text)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)


class NotificationLog(Base):
    """One delivery attempt, to one recipient, via one channel. Tender §24."""

    __tablename__ = "notification_log"
    __table_args__ = (
        CheckConstraint(f"channel IN {CHANNELS}", name="notification_channel"),
        CheckConstraint(
            "delivery_status IN ('queued','sent','delivered','failed')",
            name="notification_delivery_status",
        ),
        Index("ix_notification_log_client_sent", "client_id", "sent_at"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    alarm_id: Mapped[int | None] = mapped_column(ForeignKey("alarms.id", ondelete="SET NULL"))
    report_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("report_runs.id", ondelete="SET NULL")
    )
    recipient_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    channel: Mapped[str] = mapped_column(String(16), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    escalation_level: Mapped[int | None] = mapped_column(Integer)
    sent_at: Mapped[datetime] = created_at()
    delivery_status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    failure_reason: Mapped[str | None] = mapped_column(Text)


class IncidentSnapshot(Base):
    """Freezes the raw Reading window around a High/Critical Alarm.

    PROPOSED — OPEN-6. Raw retention is 30 days; without this, raw evidence for
    any fault older than that is unrecoverable, which matters for warranty
    claims. Severity-gated so Low and Medium Alarms trigger nothing.
    """

    __tablename__ = "incident_snapshots"
    __table_args__ = (
        CheckConstraint("state IN ('queued','captured','failed')", name="snapshot_state"),
    )

    id: Mapped[int] = pk()
    client_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    alarm_id: Mapped[int | None] = mapped_column(ForeignKey("alarms.id", ondelete="SET NULL"))
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), nullable=False)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    window_end: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # faulted Device + siblings + parent + local Weather Station
    devices_included: Mapped[list[int]] = mapped_column(ARRAY(BigInteger), nullable=False)
    artifact_url: Mapped[str | None] = mapped_column(Text)
    row_count: Mapped[int | None] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
