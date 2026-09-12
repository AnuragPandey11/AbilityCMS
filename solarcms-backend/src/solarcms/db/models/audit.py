"""Immutable log of user actions and configuration changes.

Every mutation writes a row here *in the same transaction* as the change, not
after it (BACKEND_SPEC §8.3). Tender §33 additionally requires login, logout and
failed-login events, which have no other table.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base, created_at, pk


class AuditLog(Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_client_time", "client_id", "occurred_at"),
        Index("ix_audit_log_action", "action", "occurred_at"),
    )

    id: Mapped[int] = pk()
    # NULL for platform-level actions and for failed logins, where the Client is
    # not yet established — a failed login must be recorded even when the email
    # matches no user at all.
    client_id: Mapped[int | None] = mapped_column(BigInteger)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    actor_email: Mapped[str | None] = mapped_column(Text)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    entity_type: Mapped[str | None] = mapped_column(String(64))
    entity_id: Mapped[int | None] = mapped_column(BigInteger)
    before: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    after: Mapped[dict[str, object] | None] = mapped_column(JSONB)
    ip_address: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(Text)
    occurred_at: Mapped[datetime] = created_at()
