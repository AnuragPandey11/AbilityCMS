#!/bin/sh
# Which SolarCMS process this container runs. One image, five processes plus
# the migration step (docs/CAPACITY_AND_DEPLOYMENT.md §5.5, §6.2).
set -eu

case "${1:-api}" in
    api)
        # Several workers per task (§5.8). Behind a load balancer, trust its
        # X-Forwarded-For only from its own subnets, so the audit log records
        # the client's address, not the balancer's (§5.4): set
        # FORWARDED_ALLOW_IPS to those subnets.
        #
        # No line per request unless API_ACCESS_LOG=true: every screen polls,
        # and at fleet scale a line per request is most of the logging bill
        # (§6.6). The load balancer's own access logs, written to S3, are the
        # cheap record of requests; errors are logged here regardless.
        access_log="--no-access-log"
        if [ "${API_ACCESS_LOG:-false}" = "true" ]; then access_log="--access-log"; fi
        exec uvicorn solarcms.api.main:app --host 0.0.0.0 --port "${PORT:-8000}" \
            --workers "${API_WORKERS:-2}" --proxy-headers \
            --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1}" "$access_log"
        ;;
    ingest|alarm|health_sweeper|scheduler)
        # Each takes its leader lock first; a second copy waits as a standby
        # (workers/leadership.py, §4.6).
        exec python -m "solarcms.workers.$1"
        ;;
    migrate)
        # Once per deploy, before the new tasks start (§6.2). Roles are created
        # outside the migrations, once, by hand: scripts/bootstrap_roles.sql.
        alembic upgrade head
        exec python -m solarcms.cli seed
        ;;
    *)
        exec "$@"
        ;;
esac
