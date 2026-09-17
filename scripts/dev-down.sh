#!/usr/bin/env bash
#
# Stops everything scripts/dev-up.sh started, then clears its logs so the next
# dev-up.sh starts from a clean slate — nothing left over to misread as
# current. Does not touch Postgres, Redis, or the broker — you own those the
# same way you started them.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.dev-run"
PID_FILE="$RUN_DIR/pids"
LOG_DIR="$RUN_DIR/logs"

if [ ! -f "$PID_FILE" ]; then
    echo "No $PID_FILE — nothing to stop (or dev-up.sh was never run from here)."
    # Still clear logs: a previous down already removed the PID file, but a
    # crashed process or a manual run could have left log files behind.
    if [ -d "$LOG_DIR" ] && [ -n "$(ls -A "$LOG_DIR" 2>/dev/null)" ]; then
        rm -f "$LOG_DIR"/*.log
        echo "Cleared leftover logs in $LOG_DIR."
    fi
    exit 0
fi

echo "Stopping..."
while IFS=: read -r name pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null
        printf "  %-14s pid %-7s SIGTERM sent\n" "$name" "$pid"
    else
        printf "  %-14s pid %-7s already gone\n" "$name" "$pid"
    fi
done < "$PID_FILE"

# Ingest holds an MQTT session and flushes a buffer on shutdown; give every
# process a few seconds to exit cleanly before anything is forced.
sleep 3

while IFS=: read -r name pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null
        printf "  %-14s pid %-7s did not exit in time, killed\n" "$name" "$pid"
    fi
done < "$PID_FILE"

rm -f "$PID_FILE"

# Cleared, not just left to be overwritten next time: dev-up.sh truncates a
# log when it starts that same process again, but if a process is ever
# renamed or dropped, its old log would otherwise sit here indefinitely,
# readable as if it were current.
if [ -d "$LOG_DIR" ]; then
    rm -f "$LOG_DIR"/*.log
    echo "Logs cleared."
fi

echo "Done."
