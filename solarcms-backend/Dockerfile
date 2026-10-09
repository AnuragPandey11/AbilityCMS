# One image for every backend process (docs/CAPACITY_AND_DEPLOYMENT.md §5.5):
# the API, the four workers and the migration step differ only in their command.
#
#   docker build -t solarcms-backend solarcms-backend
#   docker run --env-file .env solarcms-backend api
#   docker run --env-file .env solarcms-backend ingest      (alarm, health_sweeper, scheduler)
#   docker run --env-file .env solarcms-backend migrate     (before new tasks start)
#
# Every setting is an environment variable; `.env` is read only if present.
FROM python:3.12.7-slim-bookworm

# WeasyPrint's system libraries: without them the PDF download is a 503.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz0b libfontconfig1 fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    LOG_JSON=true

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install ".[reports,aws]"
COPY alembic.ini ./
COPY alembic ./alembic
COPY scripts ./scripts
COPY docker/entrypoint.sh /usr/local/bin/solarcms
RUN chmod +x /usr/local/bin/solarcms \
 && useradd --system --uid 10001 solarcms \
 && mkdir -p /app/.artifacts && chown solarcms /app/.artifacts
USER solarcms

EXPOSE 8000
ENTRYPOINT ["solarcms"]
CMD ["api"]
