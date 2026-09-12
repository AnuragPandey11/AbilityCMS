"""JWT issue and verify, plus password hashing.

BACKEND_SPEC §8.1. Access token 15 minutes, refresh token 7 days. A User may
belong to several Clients (MASTER §3.2), but a token carries exactly **one**
active `client_id`; `POST /auth/switch-client` reissues against another
membership. One active Client per token is what lets the RLS context be a single
scalar rather than a set, which in turn keeps every policy a simple equality.

argon2, not bcrypt: bcrypt silently truncates at 72 bytes, so two different long
passwords can authenticate each other.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final, Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from solarcms.config import get_settings

ALGORITHM: Final = "HS256"
TokenType = Literal["access", "refresh"]

_hasher = PasswordHasher()


class AuthError(Exception):
    """Authentication failed. Never carries detail that distinguishes *why*."""


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Constant-time-ish verification. Returns False rather than raising."""
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, InvalidHashError, ValueError):
        return False


def needs_rehash(password_hash: str) -> bool:
    """True when the stored hash uses outdated parameters and should be upgraded."""
    try:
        return _hasher.check_needs_rehash(password_hash)
    except (InvalidHashError, ValueError):
        return False


@dataclass(frozen=True, slots=True)
class TokenClaims:
    """The verified contents of a token. The only source of a SecurityContext."""

    user_id: int
    client_id: int | None
    role_code: str | None
    is_platform_admin: bool
    token_type: TokenType
    jti: str
    expires_at: datetime


def _now() -> datetime:
    return datetime.now(UTC)


def issue_token(
    *,
    user_id: int,
    client_id: int | None,
    role_code: str | None,
    is_platform_admin: bool,
    token_type: TokenType = "access",
) -> tuple[str, datetime]:
    """Return (encoded token, expiry). Expiry is returned so callers need not
    re-decode a token they just created in order to tell the client when it dies.
    """
    settings = get_settings()
    ttl = (
        settings.jwt_access_ttl_seconds
        if token_type == "access"
        else settings.jwt_refresh_ttl_seconds
    )
    expires_at = _now() + timedelta(seconds=ttl)
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "client_id": client_id,
        "role": role_code,
        "platform_admin": is_platform_admin,
        "typ": token_type,
        # A unique id per token, so that logout can revoke one token rather than
        # every token the User holds.
        "jti": uuid.uuid4().hex,
        "iat": int(_now().timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    encoded = jwt.encode(
        payload, get_settings().jwt_secret.get_secret_value(), algorithm=ALGORITHM
    )
    return encoded, expires_at


def decode_token(token: str, *, expect: TokenType = "access") -> TokenClaims:
    """Verify a token and return its claims, or raise AuthError.

    Signature, expiry *and* type are all checked. The type check matters: a
    refresh token is long-lived, so accepting one as an access token would turn a
    15-minute window into a week.
    """
    try:
        payload = jwt.decode(
            token,
            get_settings().jwt_secret.get_secret_value(),
            algorithms=[ALGORITHM],
            options={"require": ["exp", "sub", "typ"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AuthError("token expired") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthError("invalid token") from exc

    if payload.get("typ") != expect:
        raise AuthError(f"expected a {expect} token")

    return TokenClaims(
        user_id=int(payload["sub"]),
        client_id=payload.get("client_id"),
        role_code=payload.get("role"),
        is_platform_admin=bool(payload.get("platform_admin", False)),
        token_type=expect,
        jti=str(payload.get("jti", "")),
        expires_at=datetime.fromtimestamp(payload["exp"], tz=UTC),
    )
