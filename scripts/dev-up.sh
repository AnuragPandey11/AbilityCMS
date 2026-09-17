#!/usr/bin/env bash
#
# Starts every SolarCMS process except infrastructure: the API, the four
# workers, and the frontend dev server. Postgres, Redis and the broker are
# yours — `docker compose -f solarcms-backend/docker-compose.yml up -d`
# (or the native equivalents in solarcms-backend/README.md) before running
# this, not after.
#
# This does NOT run migrations or the seed. Those are one-time setup steps,
# not services — run them yourself once:
#   .venv/bin/alembic upgrade head
#   .venv/bin/python -m solarcms.cli seed
#
# Everything here reads solarcms-backend/.env exactly as the process would if
# you started it by hand — this script does not choose or override it.
#
# Usage:
#   scripts/dev-up.sh          # start everything
#   scripts/dev-down.sh        # stop everything this script started
#   scripts/dev-status.sh      # check what's running right now

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/solarcms-backend"
FRONTEND_DIR="$ROOT_DIR/solarcms-frontend"
RUN_DIR="$ROOT_DIR/.dev-run"
LOG_DIR="$RUN_DIR/logs"
PID_FILE="$RUN_DIR/pids"

VENV_PY="$BACKEND_DIR/.venv/bin/python"
VENV_UVICORN="$BACKEND_DIR/.venv/bin/uvicorn"

# ── Guard against a second, competing set of processes ──────────────────────
# Two ingest workers on the same MQTT client_id fight the broker for the
# session; two schedulers double-write every Plant KPI tick. Refuse rather
# than silently stacking a second copy on top of a live one.
if [ -f "$PID_FILE" ]; then
    still_running=0
    while IFS=: read -r name pid; do
        if kill -0 "$pid" 2>/dev/null; then
            still_running=1
            echo "  already running: $name (pid $pid)"
        fi
    done < "$PID_FILE"
    if [ "$still_running" -eq 1 ]; then
        echo
        echo "Something from a previous dev-up.sh is still alive. Run"
        echo "  scripts/dev-down.sh"
        echo "first, or it will end up racing the processes above."
        exit 1
    fi
    rm -f "$PID_FILE"
fi

mkdir -p "$LOG_DIR"
: > "$PID_FILE"

# ── Preflight: fail with a clear reason, not a crash-loop in a log file ──────
if [ ! -x "$VENV_PY" ]; then
    echo "No virtualenv at $BACKEND_DIR/.venv — see solarcms-backend/README.md."
    exit 1
fi
if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    echo "No node_modules in $FRONTEND_DIR — run 'npm install' there first."
    exit 1
fi

check_port() {
    local label="$1" host="$2" port="$3"
    if ! (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then
        echo "  ⚠ $label ($host:$port) is not accepting connections yet."
        echo "    Start it (docker compose, or the native services) before trusting what follows."
        return 1
    fi
    exec 3>&- 3<&-
    return 0
}

echo "Checking infrastructure (not managed by this script)..."
DB_LINE=$(grep -E '^DATABASE_URL=' "$BACKEND_DIR/.env" 2>/dev/null || true)
DB_HOST=$(echo "$DB_LINE" | sed -E 's#.*@([^:/]+):([0-9]+)/.*#\1#')
DB_PORT=$(echo "$DB_LINE" | sed -E 's#.*@([^:/]+):([0-9]+)/.*#\2#')
REDIS_LINE=$(grep -E '^REDIS_URL=' "$BACKEND_DIR/.env" 2>/dev/null || true)
REDIS_HOST=$(echo "$REDIS_LINE" | sed -E 's#redis://([^:/]+):([0-9]+).*#\1#')
REDIS_PORT=$(echo "$REDIS_LINE" | sed -E 's#redis://([^:/]+):([0-9]+).*#\2#')

[ -n "$DB_HOST" ] && check_port "Postgres" "$DB_HOST" "$DB_PORT" || true
[ -n "$REDIS_HOST" ] && check_port "Redis" "$REDIS_HOST" "$REDIS_PORT" || true
echo

# ── Launch, one process per line, each with its own log ─────────────────────
start() {
    local name="$1" dir="$2"
    shift 2
    (
        cd "$dir"
        # setsid so a later `kill` on the recorded pid takes the process
        # itself, not a shell that already exited out from under it.
        exec "$@"
    ) > "$LOG_DIR/$name.log" 2>&1 &
    local pid=$!
    echo "$name:$pid" >> "$PID_FILE"
    printf "  %-14s pid %-7s log: %s\n" "$name" "$pid" "$LOG_DIR/$name.log"
}

echo "Starting SolarCMS..."
start api            "$BACKEND_DIR" "$VENV_UVICORN" solarcms.api.main:app --reload
start ingest         "$BACKEND_DIR" "$VENV_PY" -m solarcms.workers.ingest
start alarm          "$BACKEND_DIR" "$VENV_PY" -m solarcms.workers.alarm
start health_sweeper "$BACKEND_DIR" "$VENV_PY" -m solarcms.workers.health_sweeper
start scheduler      "$BACKEND_DIR" "$VENV_PY" -m solarcms.workers.scheduler
start frontend       "$FRONTEND_DIR" npm run dev

echo
echo "All 6 processes started. PIDs recorded in $PID_FILE."
echo
echo "  tail -f $LOG_DIR/<name>.log     — watch one process"
echo "  scripts/dev-status.sh           — is everything still alive"
echo "  scripts/dev-down.sh             — stop all of the above"
