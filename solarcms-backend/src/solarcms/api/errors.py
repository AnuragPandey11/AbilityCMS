"""RFC 7807 problem+json responses (BACKEND_SPEC §8.3)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

CONTENT_TYPE = "application/problem+json"

_TITLES = {
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    409: "Conflict", 422: "Unprocessable Entity", 500: "Internal Server Error",
}


def problem(status_code: int, detail: str, **extra: Any) -> JSONResponse:
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": _TITLES.get(status_code, "Error"),
        "status": status_code,
        "detail": detail,
        **extra,
    }
    return JSONResponse(status_code=status_code, content=body, media_type=CONTENT_TYPE)


async def http_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, HTTPException)
    response = problem(exc.status_code, str(exc.detail), instance=str(request.url.path))
    if exc.headers:
        response.headers.update(exc.headers)
    return response


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Deliberately opaque. An internal error's text can carry table names, SQL, or
    # another Client's identifiers; the detail belongs in the log, not the response.
    return problem(500, "internal server error", instance=str(request.url.path))
