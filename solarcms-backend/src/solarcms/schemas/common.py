"""Shared response shapes."""

from __future__ import annotations

from datetime import datetime
from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """Cursor pagination. Never OFFSET on Readings (BACKEND_SPEC §8.3)."""

    items: list[T]
    next_cursor: str | None = None


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_at: datetime


class LoginRequest(BaseModel):
    email: str
    password: str
    client_id: int | None = Field(
        default=None,
        description="Which membership to activate. Defaults to the only one, or "
                    "fails when the User belongs to several Clients.",
    )
