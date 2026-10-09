#!/usr/bin/env bash
#
# Creates (or recreates) a database for the integration suite, migrated and
# seeded, in the Docker Postgres — so the suite never writes its fixtures into
# the development database. Then, one command per line:
#
#     export DATABASE_URL=postgresql+asyncpg://solarcms:solarcms@localhost:5433/solarcms_test
#     export REDIS_URL=redis://localhost:6379/2
#     .venv/bin/pytest tests/integration
#
# Redis database 2 keeps the suite's keys away from the development stack's (0)
# and the load test's (1). Run from solarcms-backend/.

set -euo pipefail

NAME="${1:-solarcms_test}"
case "$NAME" in
    *_test) ;;
    *) echo "refusing: the test database's name must end in _test (got $NAME)"; exit 1 ;;
esac

docker exec -i solarcms-postgres psql -U solarcms -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $NAME WITH (FORCE)" -c "CREATE DATABASE $NAME OWNER solarcms"

URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2- | sed -E "s#/[^/?]+(\?.*)?\$#/$NAME\1#")"
DATABASE_URL="$URL" REDIS_URL="redis://localhost:6379/2" .venv/bin/alembic upgrade head
DATABASE_URL="$URL" REDIS_URL="redis://localhost:6379/2" .venv/bin/python -m solarcms.cli seed >/dev/null
echo "ready: $NAME"
