"""Which failures are worth waiting out, for the workers' retry loops.

A worker that meets an error must choose between two wrong answers if it
cannot tell them apart. Retrying a message that will always fail (a payload
that trips a bug) stalls everything behind it for ever; giving up on a message
because the database restarted for ten seconds loses data that would have been
saved a moment later. This module draws the line: a dropped or refused
connection, a timeout, a database that is starting or shutting down — wait and
retry. Anything else — set the one item aside and carry on.

The cause chain is followed because SQLAlchemy wraps the driver's error and
redis-py re-raises socket errors as its own.
"""

from __future__ import annotations

import asyncpg
import redis.exceptions
import sqlalchemy.exc

_TRANSIENT: tuple[type[BaseException], ...] = (
    OSError,  # ConnectionRefusedError, ConnectionResetError, socket errors
    TimeoutError,
    redis.exceptions.ConnectionError,
    redis.exceptions.TimeoutError,
    redis.exceptions.BusyLoadingError,
    asyncpg.exceptions.ConnectionDoesNotExistError,
    asyncpg.exceptions.InterfaceError,
    asyncpg.exceptions.CannotConnectNowError,
    asyncpg.exceptions.TooManyConnectionsError,
    asyncpg.exceptions.AdminShutdownError,
    asyncpg.exceptions.CrashShutdownError,
    asyncpg.exceptions.ConnectionFailureError,
    asyncpg.exceptions.SerializationError,
    asyncpg.exceptions.DeadlockDetectedError,
    sqlalchemy.exc.OperationalError,
    sqlalchemy.exc.InterfaceError,
    sqlalchemy.exc.TimeoutError,  # pool checkout timed out
)


def is_transient(exc: BaseException) -> bool:
    """True when the failure is the infrastructure's, and a retry may succeed."""
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, _TRANSIENT):
            return True
        if isinstance(current, sqlalchemy.exc.DBAPIError) and current.connection_invalidated:
            return True
        current = current.__cause__ or current.__context__
    return False


def next_delay(delay: float, ceiling: float = 30.0) -> float:
    """Exponential backoff: double, up to `ceiling` seconds."""
    return min(delay * 2, ceiling)
