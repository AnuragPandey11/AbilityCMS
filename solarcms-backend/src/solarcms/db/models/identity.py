"""Clients, Users, roles, permissions, memberships, dashboard access.

Canonical vocabulary (MASTER §1.1): a customer company is a **Client**, never a
tenant. `clients` is the unit of data isolation.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from solarcms.db.base import Base, created_at, pk

CLIENT_STATUSES = ("onboarding", "active", "suspended", "decommissioned")
PLATFORM_ROLES = ("super_admin", "none")


class Client(Base):
    """A customer company owning one or more Plants. The isolation boundary."""

    __tablename__ = "clients"
    __table_args__ = (
        CheckConstraint(f"status IN {CLIENT_STATUSES}", name="client_status"),
    )

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="onboarding")
    # I-6: a Guest may only be granted access to a Client flagged for demonstration.
    is_demo: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ── Commercial identity ─────────────────────────────────────────────────
    # ⚠ PROPOSED, not client-confirmed (migration 0019). Every column is
    # nullable and nothing reads them in a formula, so if the real onboarding
    # sheet names different fields this stays additive.
    #
    # These were added by 0019 and never mirrored here, which made
    # `alembic revision --autogenerate` propose **dropping all five** — a
    # migration that would have silently deleted every Client's GSTIN and
    # contract dates. A column that exists in the database and not in the
    # metadata is a column autogenerate believes has been deleted.
    client_number: Mapped[str | None] = mapped_column(String(64))
    gst_number: Mapped[str | None] = mapped_column(String(15))
    # The organisation's commercial contact — NOT a login. A User signs in
    # through `users.email`; this address has no account attached.
    contact_email: Mapped[str | None] = mapped_column(String(320))
    contract_start_date: Mapped[date | None] = mapped_column(Date)
    # Stored as a date, though the form asks for a duration: a day count is
    # stale the day after it is written, so the route resolves it once.
    contract_valid_till: Mapped[date | None] = mapped_column(Date)

    created_at: Mapped[datetime] = created_at()


class User(Base):
    """A person. May hold memberships of several Clients (MASTER §3.2)."""

    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(f"platform_role IN {PLATFORM_ROLES}", name="user_platform_role"),
    )

    id: Mapped[int] = pk()
    # citext: email equality must be case-insensitive, enforced by the type rather
    # than by every query remembering to lower().
    email: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    full_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Super Admin sits OUTSIDE memberships entirely (MASTER §3.5): access comes
    # from a policy predicate, not from rows granting membership of every Client.
    platform_role: Mapped[str] = mapped_column(String(32), nullable=False, default="none")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = created_at()
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Role(Base):
    """A named set of permissions. A table, not an enum — custom roles are data."""

    __tablename__ = "roles"

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class Permission(Base):
    """One action. The catalogue is MASTER §4.3."""

    __tablename__ = "permissions"

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    description: Mapped[str] = mapped_column(Text, nullable=False)


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role_id: Mapped[int] = mapped_column(
        ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )
    permission_id: Mapped[int] = mapped_column(
        ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True
    )


class Membership(Base):
    """Links a User to a Client with a Role — access dimension A-1."""

    __tablename__ = "memberships"
    __table_args__ = (UniqueConstraint("user_id", "client_id"),)

    id: Mapped[int] = pk()
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    client_id: Mapped[int] = mapped_column(
        ForeignKey("clients.id", ondelete="CASCADE"), nullable=False
    )
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id"), nullable=False)
    created_at: Mapped[datetime] = created_at()


class Dashboard(Base):
    """A dashboard *type* a User may be permitted to open — dimension A-3."""

    __tablename__ = "dashboards"

    id: Mapped[int] = pk()
    code: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)


class UserDashboardAccess(Base):
    """No rows + role 'admin' → all dashboards. No rows otherwise → none (cf. I-5)."""

    __tablename__ = "user_dashboard_access"

    membership_id: Mapped[int] = mapped_column(
        ForeignKey("memberships.id", ondelete="CASCADE"), primary_key=True
    )
    dashboard_id: Mapped[int] = mapped_column(
        ForeignKey("dashboards.id", ondelete="CASCADE"), primary_key=True
    )


class UserPlantAccess(Base):
    """Plant Assignment — dimension A-2.

    Defined in migration 0003, after `plants` exists. An Employee with zero rows
    here sees zero Plants: absence of assignment is never full access (I-5).
    """

    __tablename__ = "user_plant_access"

    membership_id: Mapped[int] = mapped_column(
        ForeignKey("memberships.id", ondelete="CASCADE"), primary_key=True
    )
    plant_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("plants.id", ondelete="CASCADE"), primary_key=True
    )
