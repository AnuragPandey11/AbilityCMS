#!/usr/bin/env bash
#
# Is what dev-up.sh started actually still running?

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev-run/pids"

if [ ! -f "$PID_FILE" ]; then
    echo "Nothing recorded — dev-up.sh has not been run (or dev-down.sh already ran)."
    exit 0
fi

while IFS=: read -r name pid; do
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then
        printf "  %-14s pid %-7s running\n" "$name" "$pid"
    else
        printf "  %-14s pid %-7s NOT running (check its log)\n" "$name" "$pid"
    fi
done < "$PID_FILE"
