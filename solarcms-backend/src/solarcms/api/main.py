"""FastAPI application factory: middleware, exception handlers, router wiring."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from solarcms.api import errors
from solarcms.api.routers import (
    alarms,
    audit,
    auth,
    catalog,
    clients,
    devices,
    discovery,
    health,
    operations,
    plants,
    readings,
    regions,
    reports,
    users,
)
from solarcms.api.ws import router as ws_router
from solarcms.cache.live import close_redis
from solarcms.config import get_settings
from solarcms.db.session import dispose_engine
from solarcms.logging import configure_logging

log = structlog.get_logger("api")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    configure_logging(settings.log_level, settings.log_json)
    log.info("api starting", timescale=settings.timescale_enabled)
    yield
    await close_redis()
    await dispose_engine()
    log.info("api stopped")


def create_app() -> FastAPI:
    app = FastAPI(
        title="SolarCMS API",
        version="0.1.0",
        lifespan=lifespan,
        # Timestamps in and out are ISO 8601 with offset; display formatting
        # (DD-MM-YYYY, tender §28) is the frontend's job (BACKEND_SPEC §8.3).
        description="Multi-tenant solar plant monitoring.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_exception_handler(HTTPException, errors.http_exception_handler)
    app.add_exception_handler(Exception, errors.unhandled_exception_handler)

    for router in (auth.router, clients.router, plants.router,
                   plants.blocks_router, devices.router, discovery.router,
                   catalog.router, regions.router, readings.router, alarms.router,
                   reports.router, operations.router,
                   users.router, health.router, audit.router, ws_router):
        app.include_router(router)

    @app.get("/healthz", tags=["ops"])
    async def healthz() -> dict[str, str]:
        """Liveness only. Dependency health is /health/system, which is guarded."""
        return {"status": "ok"}

    return app


app = create_app()
