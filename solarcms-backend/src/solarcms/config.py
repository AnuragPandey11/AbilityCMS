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
    # QoS 1 messages are acknowledged only after their batch commits, and a
    # broker stops delivering once a client holds its in-flight limit
    # unacknowledged (Mosquitto 20, EMQX 32 by default). A batch is flushed
    # before it holds this many, so that limit never becomes a throughput
    # ceiling of "limit ÷ batch seconds". Keep it below the broker's.
    ingest_max_unacked: int = 16
    # How long after a reconnect the broker's resends of still-buffered
    # messages are recognised and not stored twice (`workers/delivery.py`).
    ingest_redelivery_window_s: float = 120.0

    # ── Notification delivery (the scheduler's dispatcher, migration 0035) ──
    # Tries per notification before it is recorded failed, backing off
    # 1, 2, 4, 8 minutes between them; and how many are sent at once, so one
    # slow recipient cannot hold up the rest.
    notify_max_attempts: int = 5
    notify_concurrency: int = 4

    # ── One active copy of each worker (workers/leadership.py, §4.6) ────────
    # Each worker takes a Postgres advisory lock before working; a second copy
    # waits as a hot standby. Off only for a test that runs two on purpose.
    leader_lock_enabled: bool = True
    # The lock needs a real session: behind a pooler in transaction mode, set
    # this to a direct connection to the database. Defaults to the ingest DSN.
    leader_lock_dsn: str | None = None

    # A read-only token for `GET /health/metrics`, so a monitoring agent can
    # scrape it without a user login (§6.6). Unset: platform administrators only.
    metrics_token: SecretStr | None = None

    # ── Deployment (docs/CAPACITY_AND_DEPLOYMENT.md §5) ──────────────────────
    # Every default below is the laptop's behaviour; AWS sets them.
    #
    # "production" refuses the fabricated-fleet scripts (§6.4 item 18).
    environment: str = "development"
    # Browser origins allowed to call the API. "*" suits development, where the
    # Vite proxy serves both from one origin anyway; production names the
    # app's own domain (§5.2).
    cors_origins: list[str] = Field(default_factory=lambda: ["*"])
    # Behind a pooler in transaction mode asyncpg's prepared-statement caches
    # break (a statement prepared on one server connection is run on another):
    # set 0 there (§5.6). None keeps the driver's default.
    db_statement_cache_size: int | None = None
    db_max_overflow: int = 10
    # TLS to Postgres for both connection paths — SQLAlchemy and raw asyncpg —
    # from one setting (§5.7): disable | prefer | require | verify-ca |
    # verify-full. None leaves it to the DSN. Redis takes `rediss://` instead.
    database_ssl: str | None = None
    # Signs report download links. Unset, the JWT secret does — so rotating
    # the login secret invalidates every outstanding link (§5.9); set this to
    # rotate the two independently.
    artifact_signing_secret: SecretStr | None = None

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
    # A line that is true of every message a Device sends ("these keys are not
    # mapped", "this topic is not registered") is logged once per this many
    # seconds per Device or topic, with the count held back (logging.RepeatGate).
    log_repeat_window_s: int = 3600

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
