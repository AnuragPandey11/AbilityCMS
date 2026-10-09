"""Async engine, session factory, and the RLS-scoped session dependency."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from solarcms.config import get_settings
from solarcms.db.rls import API_ROLE, SecurityContext, apply_context

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


@asynccontextmanager
async def scoped_session(
    context: SecurityContext, *, role: str | None = API_ROLE
) -> AsyncIterator[AsyncSession]:
    """A session inside one transaction, with `context` applied before any query.

    The transaction is opened first and the context applied inside it, because
    `SET LOCAL` outside a transaction is silently a no-op — which would leave
    every policy seeing an unconfigured session. Commit on success, roll back on
    any exception, so a failed mutation cannot leave a partial audit trail.
    """
    async with get_sessionmaker()() as session, session.begin():
        await apply_context(session, context, role=role)
        yield session
