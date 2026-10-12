"""A server error still carries the CORS headers, or the browser calls it a CORS failure.

Starlette sends the 500 for an unhandled exception from outside every
`add_middleware`, so a crash reached the browser without
`Access-Control-Allow-Origin` and read as "blocked by CORS policy" — which is
how a failing PDF export first showed itself (13 Oct 2026).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from solarcms import config
from solarcms.api.main import create_app
from solarcms.config import Settings

APP_ORIGIN = "https://app.example.test"


def _settings() -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        database_url="postgresql+asyncpg://u:p@localhost/db",
        redis_url="redis://localhost:6379/0",
        mqtt_host="localhost",
        jwt_secret="test-only",
        cors_origins=[APP_ORIGIN],
    )


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[httpx.AsyncClient]:
    monkeypatch.setattr(config, "_settings", _settings())
    app: FastAPI = create_app()

    @app.get("/test/crash")
    async def crash() -> None:
        raise RuntimeError("boom")

    @app.get("/test/refused")
    async def refused() -> None:
        raise HTTPException(503, "not installed")

    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as c:
        yield c


async def test_an_unhandled_error_keeps_the_cors_header(client: httpx.AsyncClient) -> None:
    response = await client.get("/test/crash", headers={"Origin": APP_ORIGIN})
    assert response.status_code == 500
    assert response.headers.get("access-control-allow-origin") == APP_ORIGIN
    # Still the opaque problem body: the exception's text stays in the log.
    assert response.json()["detail"] == "internal server error"


async def test_a_refusal_keeps_the_cors_header(client: httpx.AsyncClient) -> None:
    response = await client.get("/test/refused", headers={"Origin": APP_ORIGIN})
    assert response.status_code == 503
    assert response.headers.get("access-control-allow-origin") == APP_ORIGIN


async def test_another_origin_is_still_not_allowed(client: httpx.AsyncClient) -> None:
    response = await client.get("/test/crash", headers={"Origin": "https://elsewhere.test"})
    assert response.status_code == 500
    assert "access-control-allow-origin" not in response.headers


async def test_a_preflight_is_still_answered(client: httpx.AsyncClient) -> None:
    response = await client.options("/test/crash", headers={
        "Origin": APP_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    })
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == APP_ORIGIN
