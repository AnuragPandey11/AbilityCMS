"""Artifact storage for rendered Reports and incident snapshots.

Two backends with the same three methods: the local filesystem, for one
machine, and S3, for any deployment with more than one task — a Report the
scheduler writes to its own disk cannot be downloaded through an API task, and
every file is lost when a task is replaced (docs/CAPACITY_AND_DEPLOYMENT.md
§5.1). Setting `S3_BUCKET` selects S3; `boto3` is the optional `aws` extra,
pinned there, so a laptop needs none of it.

The distinction that matters is the **signed URL**: a Report may contain a
Client's generation and financial data, so it must never be served from a
guessable path. The local backend issues a token-bearing URL the API validates;
S3 would issue a presigned one. Both expire.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import secrets
from abc import ABC, abstractmethod
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

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


def _signing_secret() -> bytes:
    """`ARTIFACT_SIGNING_SECRET` if set, else the JWT secret (as before).

    Separate so that rotating the login secret need not invalidate every
    outstanding download link (docs/CAPACITY_AND_DEPLOYMENT.md §5.9).
    """
    settings = get_settings()
    secret = settings.artifact_signing_secret or settings.jwt_secret
    return secret.get_secret_value().encode()


class LocalArtifactStore(ArtifactStore):
    """Filesystem-backed, for development and single-node deployments.

    Links are signed with `ARTIFACT_SIGNING_SECRET`, or the JWT secret where
    that is unset (`_signing_secret`).
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
        secret = _signing_secret()
        signature = hmac.new(
            secret, f"{key}:{expires}".encode(), hashlib.sha256
        ).hexdigest()
        return f"/reports/artifacts/{key}?expires={expires}&signature={signature}"

    @staticmethod
    def verify(key: str, expires: int, signature: str) -> bool:
        if datetime.now(UTC).timestamp() > expires:
            return False
        secret = _signing_secret()
        expected = hmac.new(
            secret, f"{key}:{expires}".encode(), hashlib.sha256
        ).hexdigest()
        # Constant-time: a timing-variable comparison here leaks the signature
        # one byte at a time.
        return hmac.compare_digest(expected, signature)


_store: ArtifactStore | None = None


class S3ArtifactStore(ArtifactStore):
    """S3-backed, for any deployment of more than one task (§5.1).

    boto3 is synchronous, so each call runs in a thread. Downloads are S3
    presigned URLs, which expire like the local ones; the bucket itself stays
    private. Objects are encrypted at rest by S3 (SSE-S3, `AES256`).

    ⚠ Credentials come from boto3's own chain — on ECS the task role — never
    from this app's settings.
    """

    def __init__(self, bucket: str, region: str, client: Any = None) -> None:
        self.bucket = bucket
        if client is None:
            import boto3  # the optional `aws` extra

            client = boto3.client("s3", region_name=region)
        self._client = client

    async def put(self, key: str, content: bytes, content_type: str) -> str:
        await asyncio.to_thread(
            self._client.put_object, Bucket=self.bucket, Key=key, Body=content,
            ContentType=content_type, ServerSideEncryption="AES256")
        log.info("artifact stored", key=key, bytes=len(content), type=content_type,
                 bucket=self.bucket)
        return f"s3://{self.bucket}/{key}"

    async def get(self, key: str) -> bytes | None:
        def fetch() -> bytes | None:
            try:
                body = self._client.get_object(Bucket=self.bucket, Key=key)["Body"]
                return bytes(body.read())
            except self._client.exceptions.NoSuchKey:
                return None

        return await asyncio.to_thread(fetch)

    async def signed_url(self, key: str, ttl: timedelta = DEFAULT_URL_TTL) -> str:
        url = await asyncio.to_thread(
            self._client.generate_presigned_url, "get_object",
            Params={"Bucket": self.bucket, "Key": key},
            ExpiresIn=int(ttl.total_seconds()))
        return str(url)


def get_store() -> ArtifactStore:
    global _store
    if _store is None:
        settings = get_settings()
        # Never a silent fallback to local files when a bucket is configured: a
        # deployment that asked for S3 and got its own disk would only find out
        # when a Report was needed, from another task, after a deploy.
        _store = (S3ArtifactStore(settings.s3_bucket, settings.s3_region)
                  if settings.s3_bucket else LocalArtifactStore())
    return _store


def artifact_key(client_id: int, run_id: int, extension: str) -> str:
    """A key with a random component, so a Report is not reachable by guessing
    an adjacent run id."""
    return f"reports/{client_id}/{run_id}-{secrets.token_hex(8)}.{extension}"
