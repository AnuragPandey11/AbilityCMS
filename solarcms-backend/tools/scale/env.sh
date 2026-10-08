# Environment for a load test. Source it; never edit .env for this.
#
#     source tools/scale/env.sh
#
# Every setting is an environment variable, and environment variables override
# `.env` (pydantic-settings), so this points every process at its own database,
# Redis database and broker session while `.env` stays the development one.

export SCALE_DB=solarcms_scale
export DATABASE_URL="postgresql+asyncpg://solarcms:solarcms@localhost:5433/${SCALE_DB}"
# Database 1, not 0: the development stack's keys stay where they are.
export REDIS_URL="redis://localhost:6379/1"
export MQTT_HOST=localhost
export MQTT_PORT=1883
export MQTT_TLS=false
# Its own persistent session, and its own topic root (tools/scale/fleet.py).
export MQTT_CLIENT_ID=solarcms-ingest-loadtest
export MQTT_SUBSCRIBE_TOPICS='["loadtest/v1/#"]'
export LOG_JSON=false
export LOG_LEVEL=INFO
