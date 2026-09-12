"""The request's security context, applied to a database transaction.

BACKEND_SPEC §5.4 / §6.7. Four session variables, set from *verified* JWT claims
at the start of every transaction, plus the runtime role the statement executes
as. Nothing here accepts a value a client supplied directly.

Why `SET LOCAL` and not `SET`: LOCAL is scoped to the transaction, so a pooled
connection cannot carry one Client's context into the next request's query. That
is also why PgBouncer must run in **transaction** mode — in statement mode these
leak between Clients and the entire isolation model is void.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

# Runtime roles from scripts/bootstrap_roles.sql. The API assumes API_ROLE per
# transaction so that the owner's privileges are never used to serve a request —
# the owner can read the compressed telemetry tables directly, and a request
# must not be able to.
API_ROLE: Final = "solarcms_api"
INGEST_ROLE: Final = "solarcms_ingest"
# The scheduler and health sweeper: periodic work spanning every Client,
# with no user session and so no Client context to filter by.
SCHEDULER_ROLE: Final = "solarcms_scheduler"


@dataclass(frozen=True, slots=True)
class SecurityContext:
    """Who the database should believe is asking.

    Constructed only from a verified token (`api/auth.py`) or from a worker's own
    fixed identity. A `client_id` of None means no Client context at all, which
    the policies treat as seeing nothing rather than seeing everything.
    """

    user_id: int | None
    client_id: int | None
    role_code: str | None
    is_platform_admin: bool = False

    @classmethod
    def platform(cls, user_id: int) -> SecurityContext:
        """A Super Admin, who is not a member of any Client (MASTER §3.5)."""
        return cls(user_id=user_id, client_id=None, role_code="super_admin",
                   is_platform_admin=True)

    @classmethod
    def anonymous(cls) -> SecurityContext:
        """No identity. Every policy denies; used for the login path only."""
        return cls(user_id=None, client_id=None, role_code=None)


_SET_LOCAL = text("""
    SELECT set_config('app.user_id',           :user_id,      true),
           set_config('app.client_id',         :client_id,    true),
           set_config('app.role_code',         :role_code,    true),
           set_config('app.is_platform_admin', :platform,     true)
""")


async def apply_context(
    connection: AsyncConnection | AsyncSession,
    context: SecurityContext,
    *,
    role: str | None = API_ROLE,
) -> None:
    """Apply `context` to the current transaction.

    `set_config(..., is_local => true)` is used rather than literal `SET LOCAL`
    because it takes bound parameters — a `SET LOCAL` cannot, which would mean
    interpolating values into SQL text on every request.
    """
    await connection.execute(
        _SET_LOCAL,
        {
            # Empty string rather than NULL: the accessor functions map '' to NULL
            # via NULLIF, and set_config rejects a NULL value outright.
            "user_id": str(context.user_id) if context.user_id is not None else "",
            "client_id": str(context.client_id) if context.client_id is not None else "",
            "role_code": context.role_code or "",
            "platform": "true" if context.is_platform_admin else "false",
        },
    )
    # role=None keeps the connection's own identity — used only by the seeder and
    # migrations, which run as the owner and must be able to write catalogue rows
    # that no request-serving role may touch.
    if role is None:
        return
    # SET LOCAL ROLE must be literal — role names cannot be bound parameters. The
    # value never comes from a request: it is one of two module constants.
    if role not in (API_ROLE, INGEST_ROLE, SCHEDULER_ROLE):
        raise ValueError(f"refusing to assume unrecognised role {role!r}")
    await connection.execute(text(f"SET LOCAL ROLE {role}"))
