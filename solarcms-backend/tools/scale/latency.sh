#!/usr/bin/env bash
# Run the ingest benchmark with network delay added to every round trip.
#
#     source tools/scale/env.sh
#     tools/scale/latency.sh 1          (1 ms added to each Postgres and Redis reply)
#     tools/scale/latency.sh 2 1        (2 ms to Postgres, 1 ms to Redis)
#
# On this machine Postgres and Redis answer in ~0.15 ms because they are on the
# same machine. On AWS they are across the network, possibly in another AZ. This
# puts Toxiproxy between ingest and both of them, adds a fixed delay to every
# reply, and re-runs tools/scale/ingest_bench.py through it — so the effect of
# AWS round trips on ingest is measured here instead of assumed.
#
# Leaves nothing behind: the proxy container is removed on exit.
set -euo pipefail

PG_MS="${1:-1}"
REDIS_MS="${2:-$PG_MS}"
NAME=solarcms-latency-proxy
NETWORK=solarcms-backend_default
HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$(cd "$HERE/../.." && pwd)"

: "${SCALE_DB:?source tools/scale/env.sh first}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$NAME" --network "$NETWORK" \
  -p 25433:25433 -p 26379:26379 -p 18474:8474 \
  ghcr.io/shopify/toxiproxy:2.9.0 >/dev/null
for _ in $(seq 1 30); do
  curl -sf localhost:18474/version >/dev/null && break
  sleep 0.5
done

api() { curl -sf -X POST "localhost:18474$1" -H 'Content-Type: application/json' -d "$2" >/dev/null; }
api /proxies '{"name":"pg","listen":"0.0.0.0:25433","upstream":"solarcms-postgres:5432"}'
api /proxies '{"name":"redis","listen":"0.0.0.0:26379","upstream":"solarcms-redis:6379"}'
api /proxies/pg/toxics "{\"type\":\"latency\",\"stream\":\"downstream\",\"attributes\":{\"latency\":$PG_MS,\"jitter\":0}}"
api /proxies/redis/toxics "{\"type\":\"latency\",\"stream\":\"downstream\",\"attributes\":{\"latency\":$REDIS_MS,\"jitter\":0}}"

echo "+${PG_MS} ms per Postgres round trip, +${REDIS_MS} ms per Redis round trip (as set)"
# What the delay actually is: the proxy's setting is not the round trip it
# produces (on Docker Desktop for Mac, "+1 ms" measured ~1.9 ms). Read the
# results against these figures, not against the setting.
"$BACKEND/.venv/bin/python" "$HERE/rtt.py" 5433 6379 "direct"
"$BACKEND/.venv/bin/python" "$HERE/rtt.py" 25433 26379 "through the proxy"
DATABASE_URL="${DATABASE_URL/localhost:5433/localhost:25433}" \
REDIS_URL="${REDIS_URL/localhost:6379/localhost:26379}" \
  "$BACKEND/.venv/bin/python" -W ignore "$HERE/ingest_bench.py" 2>&1 \
  | grep -v -e '^Exception ignored' -e '^Traceback' -e '^  File' -e 'RuntimeError' -e '^    '
