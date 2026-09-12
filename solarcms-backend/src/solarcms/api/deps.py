"""Request dependencies: authentication, the RLS session, and permission guards.

BACKEND_SPEC §8.1. Every request verifies its token, opens a transaction, sets
the four RLS variables and assumes the API role, then yields.

All four access dimensions (MASTER §4.2) are enforced here *and* in the database:

    A-1 Client     memberships           → the token's client_id, RLS
    A-2 Plant      user_plant_access     → RLS policies
    A-3 Dashboard  user_dashboard_access → require_dashboard
    A-4 Action     role_permissions      → require_permission

Hiding a menu item is not an access control and satisfies none of them.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.api.auth import AuthError, decode_token
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session


@dataclass(frozen=True, slots=True)
class CurrentUser:
    user_id: int
    client_id: int | None
    role_code: str | None
    is_platform_admin: bool
    permissions: frozenset[str]

    @property
    def context(self) -> SecurityContext:
        return SecurityContext(
            user_id=self.user_id,
            client_id=self.client_id,
            role_code=self.role_code,
            is_platform_admin=self.is_platform_admin,
        )


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _load_permissions(
    session: AsyncSession, user_id: int, client_id: int | None, is_platform_admin: bool
) -> frozenset[str]:
    """Resolve A-4 from roles → role_permissions → permissions.

    Read from the database on each request rather than carried in the token: a
    revoked permission must take effect immediately, not in fifteen minutes when
    the access token expires.
    """
    if is_platform_admin:
        rows = await session.execute(text("SELECT code FROM permissions"))
        return frozenset(row[0] for row in rows)
    if client_id is None:
        return frozenset()
    rows = await session.execute(text("""
        SELECT p.code
          FROM memberships m
          JOIN role_permissions rp ON rp.role_id = m.role_id
          JOIN permissions p       ON p.id = rp.permission_id
         WHERE m.user_id = :user_id AND m.client_id = :client_id
    """), {"user_id": user_id, "client_id": client_id})
    return frozenset(row[0] for row in rows)


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
) -> CurrentUser:
    """Verify the bearer token and load the caller's effective permissions."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _unauthorized("missing bearer token")
    try:
        claims = decode_token(authorization.split(" ", 1)[1], expect="access")
    except AuthError as exc:
        raise _unauthorized(str(exc)) from exc

    # Permissions are read under a platform context: the lookup spans memberships
    # for a User whose Client scope is exactly what is being established, so it
    # cannot itself be Client-scoped without circularity.
    async with scoped_session(SecurityContext.platform(claims.user_id), role=None) as s:
        active = await s.execute(
            text("SELECT is_active FROM users WHERE id = :id"), {"id": claims.user_id}
        )
        is_active = active.scalar()
        if is_active is None or not is_active:
            # A deactivated User's existing tokens must stop working at once.
            raise _unauthorized("user is inactive")
        permissions = await _load_permissions(
            s, claims.user_id, claims.client_id, claims.is_platform_admin
        )

    return CurrentUser(
        user_id=claims.user_id,
        client_id=claims.client_id,
        role_code=claims.role_code,
        is_platform_admin=claims.is_platform_admin,
        permissions=permissions,
    )


CurrentUserDep = Annotated[CurrentUser, Depends(get_current_user)]


async def get_rls_session(user: CurrentUserDep) -> AsyncIterator[AsyncSession]:
    """A transaction with the caller's security context already applied."""
    async with scoped_session(user.context) as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]


def require_permission(code: str) -> Callable[[CurrentUser], CurrentUser]:
    """Guard one action permission (A-4)."""

    def guard(user: CurrentUserDep) -> CurrentUser:
        if code not in user.permissions:
            # 403, not 404: the caller is authenticated and the resource may well
            # exist. What they cannot see is hidden by RLS returning no rows, not
            # by this guard pretending the route is absent.
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"permission {code} required",
            )
        return user

    return guard


def require_dashboard(code: str) -> Callable[..., object]:
    """Guard dashboard access (A-3).

    Deny by default, mirroring I-5: no rows plus role 'admin' means every
    dashboard; no rows otherwise means none.
    """

    async def guard(user: CurrentUserDep, session: SessionDep) -> CurrentUser:
        if user.is_platform_admin or user.role_code == "admin":
            return user
        rows = await session.execute(text("""
            SELECT 1
              FROM user_dashboard_access uda
              JOIN memberships m ON m.id = uda.membership_id
              JOIN dashboards d  ON d.id = uda.dashboard_id
             WHERE m.user_id = :user_id AND m.client_id = :client_id AND d.code = :code
        """), {"user_id": user.user_id, "client_id": user.client_id, "code": code})
        if rows.first() is None:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"dashboard {code} not assigned",
            )
        return user

    return guard
