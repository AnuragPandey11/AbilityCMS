"""Artifact storage for rendered Reports and incident snapshots.

S3 is the production target (BACKEND_SPEC §4 carries `s3_bucket`/`s3_region`), but
`boto3` is not among the specification's pinned dependencies, and adding an
unpinned one to satisfy a Phase 9 deliverable would be the wrong trade. So the
interface is defined here with a local-filesystem implementation that works now,
and an S3 implementation is a class with the same three methods.

The distinction that matters is the **signed URL**: a Report may contain a
Client's generation and financial data, so it must never be served from a
guessable path. The local backend issues a token-bearing URL the API validates;
S3 would issue a presigned one. Both expire.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from abc import ABC, abstractmethod
from datetime import UTC, datetime, timedelta
from pathlib import Path

import structlog

from solarcms.config import get_settings

log = structlog.get_logger(__name__)

DEFAULT_URL_TTL = timedelta(hours=24)


class ArtifactStore(ABC):
    @abstractmethod
    async def put(self, key: str, content: bytes, content_type: str) -> str:
        """Store bytes and return an opaque locator."""

    @abstractmethod
    async def signed_url(self, key: str, ttl: timedelta = DEFAULT_URL_TTL) -> str:
        """A time-limited URL. Never a guessable path."""

    @abstractmethod
    async def get(self, key: str) -> bytes | None: ...


class LocalArtifactStore(ArtifactStore):
    """Filesystem-backed, for development and single-node deployments.

    Signing uses the JWT secret rather than a second key: it is already required
    to be long and random, and a separate one would be a second thing to rotate.
    """

    def __init__(self, root: Path | None = None) -> None:
        self.root = root or Path(".artifacts")
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        # Keys are generated internally, never taken from a request; the check is
        # belt-and-braces against a future caller passing one through.
        if ".." in key or key.startswith("/"):
            raise ValueError(f"refusing suspicious artifact key {key!r}")
        path = self.root / key
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    async def put(self, key: str, content: bytes, content_type: str) -> str:
        self._path(key).write_bytes(content)
        log.info("artifact stored", key=key, bytes=len(content), type=content_type)
        return f"local://{key}"

    async def get(self, key: str) -> bytes | None:
        path = self._path(key)
        return path.read_bytes() if path.exists() else None

    async def signed_url(self, key: str, ttl: timedelta = DEFAULT_URL_TTL) -> str:
        expires = int((datetime.now(UTC) + ttl).timestamp())
        secret = get_settings().jwt_secret.get_secret_value().encode()
        signature = hmac.new(
            secret, f"{key}:{expires}".encode(), hashlib.sha256
        ).hexdigest()
        return f"/reports/artifacts/{key}?expires={expires}&signature={signature}"

    @staticmethod
    def verify(key: str, expires: int, signature: str) -> bool:
        if datetime.now(UTC).timestamp() > expires:
            return False
        secret = get_settings().jwt_secret.get_secret_value().encode()
        expected = hmac.new(
            secret, f"{key}:{expires}".encode(), hashlib.sha256
        ).hexdigest()
        # Constant-time: a timing-variable comparison here leaks the signature
        # one byte at a time.
        return hmac.compare_digest(expected, signature)


_store: ArtifactStore | None = None


def get_store() -> ArtifactStore:
    global _store
    if _store is None:
        settings = get_settings()
        if settings.s3_bucket:
            # An S3ArtifactStore implementing the same three methods belongs here.
            # Deliberately not stubbed with a silent fallback: a deployment that
            # configured a bucket and got local files instead would only discover
            # it when a Report was needed.
            raise NotImplementedError(
                "S3_BUCKET is set but the S3 artifact store is not implemented; "
                "unset it to use local storage, or add the S3 backend."
            )
        _store = LocalArtifactStore()
    return _store


def artifact_key(client_id: int, run_id: int, extension: str) -> str:
    """A key with a random component, so a Report is not reachable by guessing
    an adjacent run id."""
    return f"reports/{client_id}/{run_id}-{secrets.token_hex(8)}.{extension}"
