"""Every environment variable in the system, declared once.

BACKEND_SPEC §4: no `os.getenv` anywhere else in the codebase.

Note the distinction this module maintains: settings here are *infrastructure*
facts (hosts, pool sizes, credentials, feature switches). Assumed *domain*
values — units, scale factors, thresholds, formula coefficients — never live
here; they live in `domain/assumptions.py` and nowhere else (BACKEND_SPEC §0.3).
"""

from __future__ import annotations

from pydantic import Field, PostgresDsn, RedisDsn, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="forbid"
    )

    # ── Database ────────────────────────────────────────────────────────────
    database_url: PostgresDsn  # postgresql+asyncpg://...
    db_pool_size: int = 10

    # TimescaleDB is CONFIRMED for production (MASTER F-4). Local Postgres
    # installations may not have the extension yet, so migrations degrade to
    # plain tables + materialised views when this is false. Never false in
    # production: the retention cascade (§5.3) depends on real hypertables.
    timescale_enabled: bool = True

    # ── Redis ───────────────────────────────────────────────────────────────
    redis_url: RedisDsn

    # ── MQTT ────────────────────────────────────────────────────────────────
    # In production we operate the broker (MASTER F-17) and TLS is mandatory.
    # The client's current *test* broker is plaintext on 1883 and we are the
    # subscriber, so the local .env overrides both port and TLS.
    mqtt_host: str
    mqtt_port: int = 8883
    mqtt_tls: bool = True
    mqtt_username: str | None = None  # None while the test broker is anonymous
    mqtt_password: SecretStr | None = None
    mqtt_client_id: str = "solarcms-ingest"  # fixed: persistent session needs a stable id

    # Topics the ingest worker subscribes to. The canonical contract is
    # `scms/v1/#` (MASTER §5.1); the client's test broker currently publishes a
    # different shape, so this is a list and the mapping from topic to
    # (client, plant, collector, device) is data in `topic_patterns`, never code.
    mqtt_subscribe_topics: list[str] = Field(default_factory=lambda: ["scms/v1/#"])
    mqtt_topic_root: str = "scms/v1"

    # ── Auth ────────────────────────────────────────────────────────────────
    jwt_secret: SecretStr
    jwt_access_ttl_seconds: int = 900  # 15 min
    jwt_refresh_ttl_seconds: int = 604800  # 7 days

    # ── Ingestion tuning ────────────────────────────────────────────────────
    ingest_batch_max_rows: int = 5000
    ingest_batch_max_seconds: float = 2.0

    # ── Storage ─────────────────────────────────────────────────────────────
    s3_bucket: str | None = None
    s3_region: str = "ap-south-1"

    # ── Notifications ───────────────────────────────────────────────────────
    smtp_url: str | None = None
    whatsapp_api_url: str | None = None  # ⚠ provider unconfirmed (MASTER §8.2)
    whatsapp_api_token: SecretStr | None = None

    # ── Observability ───────────────────────────────────────────────────────
    log_level: str = "INFO"
    log_json: bool = True  # False for human-readable local development

    @property
    def asyncpg_dsn(self) -> str:
        """DSN for a raw asyncpg connection (the ingest COPY path).

        asyncpg does not understand SQLAlchemy's `+asyncpg` driver marker.
        """
        return str(self.database_url).replace("postgresql+asyncpg://", "postgresql://", 1)


_settings: Settings | None = None


def get_settings() -> Settings:
    """Process-wide settings, loaded once."""
    global _settings
    if _settings is None:
        _settings = Settings()  # type: ignore[call-arg]
    return _settings
