"""Async engine, session factory, and the RLS-scoped session dependency."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

import structlog
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from solarcms.config import get_settings
from solarcms.db.rls import API_ROLE, SecurityContext, apply_context

log = structlog.get_logger(__name__)

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            str(settings.database_url),
            pool_size=settings.db_pool_size,
            max_overflow=settings.db_max_overflow,
            pool_pre_ping=True,
            connect_args=engine_connect_args(),
            # The ORM is used for CRUD only. Readings are written with asyncpg's
            # copy_records_to_table, two orders of magnitude faster than INSERT.
            echo=False,
        )
    return _engine


def engine_connect_args() -> dict[str, object]:
    """Driver options from settings, for the SQLAlchemy engine (§5.6, §5.7)."""
    settings = get_settings()
    args: dict[str, object] = {}
    if settings.db_statement_cache_size is not None:
        args["prepared_statement_cache_size"] = settings.db_statement_cache_size
    if settings.database_ssl:
        args["ssl"] = settings.database_ssl
    return args


def asyncpg_connect_args() -> dict[str, object]:
    """The same options for a raw asyncpg connection or pool (ingest, the leader lock)."""
    settings = get_settings()
    args: dict[str, object] = {}
    if settings.db_statement_cache_size is not None:
        args["statement_cache_size"] = settings.db_statement_cache_size
    if settings.database_ssl:
        args["ssl"] = settings.database_ssl
    return args


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            get_engine(), expire_on_commit=False, autoflush=False
        )
    return _sessionmaker


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine, _sessionmaker = None, None


#: A follow-up to a committed transaction, given that transaction's context and role.
AfterCommit = Callable[[SecurityContext, str | None], Awaitable[None]]
_AFTER_COMMIT = "solarcms.after_commit"


@asynccontextmanager
async def scoped_session(
    context: SecurityContext, *, role: str | None = API_ROLE
) -> AsyncIterator[AsyncSession]:
    """A session inside one transaction, with `context` applied before any query.

    The transaction is opened first and the context applied inside it, because
    `SET LOCAL` outside a transaction is silently a no-op — which would leave
    every policy seeing an unconfigured session. Commit on success, roll back on
    any exception, so a failed mutation cannot leave a partial audit trail.
    After a commit, run whatever `after_commit` registered.
    """
    async with get_sessionmaker()() as session:
        async with session.begin():
            await apply_context(session, context, role=role)
            yield session
        steps: dict[str, AfterCommit] = session.info.pop(_AFTER_COMMIT, {})
    for key, step in steps.items():
        try:
            await step(context, role)
        except Exception as exc:
            log.error("after-commit step failed", step=key, error=repr(exc))


def after_commit(session: AsyncSession, key: str, step: AfterCommit) -> None:
    """Run `step` once this session's transaction has committed — never if it rolls back.

    For follow-ups that must come *after* the change is visible: one run between
    a statement and the commit can be overtaken by a reader that sees the old
    rows and records them as current. Once per `key` per transaction, so a route
    that edits several rows registers once. Each step opens its own transaction
    under the same context and role. A failure is logged, never raised: the
    change it follows is already committed, and an error now would report a
    saved edit as a failed one.

    A request's session comes from here (`api/deps.get_rls_session`), and on
    FastAPI 0.115 a dependency closes before the response is sent — so a step
    has run by the time the browser hears the edit succeeded.
    """
    session.info.setdefault(_AFTER_COMMIT, {}).setdefault(key, step)
