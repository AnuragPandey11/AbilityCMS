# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## State of this repository

SolarCMS is a multi-tenant solar plant monitoring platform: MQTT ingestion → TimescaleDB → REST/WebSocket API. The backend lives in [solarcms-backend/](solarcms-backend/) and all 11 build phases are complete: migrations 0001–0017 apply and reverse, all 50 specified endpoints exist, five worker/API processes run, and 150 tests pass. Not a git repository.

Four documents carry the design, in this precedence order:

- [docs/MASTER_SPECIFICATION.md](docs/MASTER_SPECIFICATION.md) (v2.1) — **authoritative on facts**: vocabulary, client-confirmed decisions, data model, scope, open questions.
- [docs/BACKEND_SPEC.md](docs/BACKEND_SPEC.md) (v1.3) — **authoritative on implementation**: structure, pinned dependencies, endpoints, build order. Subordinate to MASTER on any fact.
- [docs/TAG_CATALOGUE.md](docs/TAG_CATALOGUE.md) — the client's own Device List and signal schedule. **Authoritative on units** for the 7 Device Types it covers; silent on scaling and ranges.
- [docs/BROKER_OBSERVATIONS.md](docs/BROKER_OBSERVATIONS.md) — measured behaviour of the client's test broker. Evidence of *shape*, never of meaning.

Where they conflict, that order decides it. Other documents the specs cite — `HIGH_LEVEL_DESIGN.md`, `backend/schema/001_core_schema.sql`, a `backend/`+`frontend/` prototype, `SINGLE_SOURCE_OF_TRUTH.md`, `PLATFORM_ARCHITECTURE.md` — **are not present in this working tree**. Do not assume they exist; if one appears, the spec's precedence table (MASTER §0.3) ranks it, and the SQL sketch uses superseded names (`tenants`, `tag_definitions`, `alarm_events`, a retired `locations`) so it is reference-only, never a migration.

When editing the specs, respect their status-marker discipline: decision status (CONFIRMED / AGREED / PROPOSED / OPEN / SUPERSEDED) is orthogonal to implementation status (BUILT / IN SCHEMA / SPECIFIED / NOT BUILT). Every claim carries both. New facts go in with markers, and MASTER §10 gets a change-log row.

## Working on the backend

Python **3.12** specifically (`asyncpg==0.29.0` has no 3.13+ wheels). Local stack is native, not Docker: Postgres 18.6 + TimescaleDB 2.30, Redis, and mosquitto as the dev broker. Setup, including the TimescaleDB install and the two `.env` files, is in [solarcms-backend/README.md](solarcms-backend/README.md).

Five processes share only Postgres and Redis:

```
uvicorn solarcms.api.main:app            # REST + WebSocket
python -m solarcms.workers.ingest        # MQTT → decode → Redis + COPY batch
python -m solarcms.workers.alarm         # consumes stream:readings
python -m solarcms.workers.health_sweeper  # 60s staleness/frozen-value sweep
python -m solarcms.workers.scheduler     # report crons, escalation timers
```

Migrations are Alembic only (`alembic upgrade head`), currently `0001`–`0017`. **Roles are created outside them** — run `scripts/bootstrap_roles.sql` as a superuser first, since a migration role normally has no CREATEROLE. Seed with `python -m solarcms.cli seed` (idempotent).

Tests: `pytest tests/unit` is pure-`domain/` and needs nothing running; `pytest tests/integration` needs the migrated database. Lint and types must both stay clean: `ruff check .` and `mypy src/solarcms` (strict). `tools/simulate.py` publishes either topic shape and can induce faults (`--fault silent|frozen|underperform`) that are otherwise impossible to wait for.

## Architecture: the load-bearing decisions

**`domain/` is pure.** Plain Python values in and out, no DB, no network, no I/O — that is what makes the formulas (the part most likely to be wrong) testable and replaceable. Topic decoding, PR/CUF/availability, alarm debounce/hysteresis, health logic, tier selection, and SLD tree building all live there.

**Nothing is known yet about units, formulas, thresholds, or intervals.** Every placeholder lives in `domain/assumptions.py` and nowhere else, so the client's real table is a one-file edit. BACKEND_SPEC §12 lists them; a factor-of-1000 voltage error looks entirely plausible in the data, which is why this is enforced rather than advised.

**Readings are narrow rows, never columns.** `(time, client_id, device_id, tag_id, value, quality, source_time)`. Device Models expose different Tag sets, so a wide table would be mostly NULL and every new model a migration. `client_id` is deliberately denormalised onto `readings` so row-level security and chunk pruning avoid a three-table join.

**Isolation is enforced by Postgres, not application code** — a forgotten `WHERE client_id` returns zero rows, not another Client's generation data. Four session variables (`app.user_id`, `app.client_id`, `app.role_code`, `app.is_platform_admin`) are set from verified JWT claims per transaction, alongside `SET LOCAL ROLE solarcms_api`, so the migration owner's privileges never serve a request. If a pooler is added, **PgBouncer must run in transaction mode**; statement mode leaks these between Clients and defeats the whole model.

**Telemetry isolation works differently, and the reason is not obvious.** TimescaleDB refuses RLS on a compressed hypertable (`columnstore cannot be used on table with row security`) in either order, which pits §5.3's compression sizing against §5.4's "RLS on every Client-owned table, including `readings`". Both are kept: `readings`, `mqtt_raw` and the `agg_*` tiers stay compressed with **no RLS**, and the API holds *no privilege at all* on them, reading only through `*_v` `security_barrier` views (migrations 0008 and 0010). **Never query `readings` from request-serving code** — it will fail, which is the design working. Plant scoping in those views rides on the RLS already enforced on `devices`, which is small by design (F-2).

**A Device has three independent groupings** and collapsing any two makes both unanswerable: `block_id` (where it is — geographic), `parent_device_id` (what it feeds into — electrical, the SLD), `reports_via_device_id` (what transmits it — communication). The third is what separates "communication loss" from "equipment downtime"; without it a failed collector is recorded as generation downtime and corrupts availability figures.

**Retention is a tier cascade**: raw 30d → `agg_1m` 1y → `agg_15m` 3y → `agg_1h`/`agg_1d` 10y. Each aggregate stores avg/min/max/last/count because a continuous aggregate cannot branch on `tags.rollup_method`; the read path picks the column. Reports query aggregates, never raw.

## Vocabulary is enforced

Canonical terms from MASTER §1 appear identically in table names, columns, classes, variables, API fields, UI labels, and log messages. The retired synonyms must not appear anywhere: **tenant/company/organisation** (→ Client), **site/facility/project** (→ Plant), **zone/section/array** (→ Block), **parameter/metric/point/signal** (→ Tag), **equipment/asset/unit** (→ Device), **alert/event/incident** (→ Alarm), **location** (retired entirely). Each was used for more than one concept. Use `clients`, `tags`, `alarms`, `device_tag_bindings`.

## Guardrails

These break something recorded as confirmed; BACKEND_SPEC §14 is the full list, MASTER §3.3 the invariants behind them.

1. Never a column per metric — metrics are rows in `tags`.
2. Never name a table, column, or code path after a specific Client, Plant, or Device (dashboards are configuration-driven; no per-Plant dashboards).
3. Never run ingestion inside the API process.
4. Never broadcast live data to all sockets — Client+Plant scoped rooms only.
5. Never infer a Client from payload contents. The MQTT topic `scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}` is the sole authority; an unknown topic is quarantined to `mqtt_raw` and alarmed, never attributed by inference.
6. Never let an assumed constant live outside `domain/assumptions.py`.
7. Never treat an empty `user_plant_access` as full access — zero assignments means zero Plants.
8. Never compute Financial Reports from MFM Readings — the ABT Meter is the sealed settlement instrument.
9. Never put I/O in `domain/`.
10. Never modify a `backend/`/`frontend/` prototype if one appears.
11. Never put a Block in the Single Line Diagram, and never nest Blocks.

Two more worth holding in mind: out-of-range and unparseable values are **stored and flagged**, never discarded (`3.29151E-41` in a reactive-power Tag is diagnostic information); and MQTT is acknowledged only **after** commit, so a crash causes redelivery rather than loss — which is why the batch window is 2 seconds.

Two guardrails were added from the client's signal schedule: **never throttle a status Tag** (`min_interval_s = 0` on every Digital Input — a 60 s throttle discards a trip contact that opened and re-closed inside the window; enforced by a CHECK constraint in migration 0009), and **never write a threshold rule against a Device Type that publishes only Digital Inputs** — `TRANSFORMER` and `VCB` have no analogue value to compare, so they use the `is_true`/`is_false` operators instead.

## Things that surprised the build

Each of these was found by running the system, and each is a trap worth not re-discovering:

- **Payloads come in two shapes.** The canonical envelope (`{device, timestamp, readings:[{tag,value}]}`) and the flat body the client's broker actually sends. `domain/decoding.normalise_payload` handles both. The envelope's `device` field is deliberately ignored — the topic is the sole authority for origin.
- **Throttling also erased the liveness signal.** `_accept` returned before recording anything when every Tag in a message was inside its throttle window, so a Device on 300 s-throttled Tags was invisible for 57 of every 60 s and the health sweep flapped it `online → offline` each minute. "Heard" and "stored" are now separate: ingest touches `seen:device:{id}` in Redis on every accepted message, and the sweep takes the later of that and `max(readings_v.time)`. Never derive liveness from `readings` alone.
- **A permissive RLS policy is not a GRANT.** Migration 0015 created `device_health_scheduler … WITH CHECK (true)` but never granted the scheduler INSERT/UPDATE, so every health sweep failed with "permission denied", logged it, and slept — `comm_status` stayed NULL fleet-wide and nothing else noticed. Fixed in 0017. A worker that catches-and-logs its main loop needs a test that asserts a row was written.
- **The integration suite runs against the dev database and leaves its fixtures behind** — `tests/conftest.py` says so (no Docker here). Every run adds ~30 Plants and ~35 Clients (`ESC-*`, `REP-*`, `iso-*`…), and an IDE test-runner that fires on save compounds it. Nothing tears them down.
- **Throttling also throttles alarm evaluation**, because the pipeline throttles before publishing to the alarm stream. Measured: detection latency is `min_interval_s + duration_s`, so a 60 s throttle plus a 60 s debounce opens an Alarm 120 s after onset. See BACKEND_SPEC §12.4.
- **A failed login cannot share a transaction with the 401 it records.** The raise rolls the audit row back, and tender §33 requires failed logins. `auth.py` commits that row in its own transaction first.
- **Authentication is circular**: `memberships` is needed to set `app.client_id`, but its policy filters on `app.client_id`. Resolved by setting `app.user_id` after the password verifies and letting a session read its own memberships (migration 0014). `SECURITY DEFINER` does *not* work here — `FORCE ROW LEVEL SECURITY` subjects the owner too.
- **asyncpg cannot infer a parameter's type used only in `IS NULL`**, and `:param::type` collides with SQLAlchemy's bind syntax. Use `CAST(:param AS type)`.
- **`INET` comes back as `ipaddress.IPv4Address`**, which the JSON serialiser rejects; the audit query casts with `host()`.
- **RLS silently makes a migration's data fix a no-op.** `FORCE ROW LEVEL SECURITY` applies to the owner, so a migration that touches data in a protected table matches zero rows — no error, just nothing happening. Any such migration must `SELECT set_config('app.is_platform_admin','true',true)` first.
- **The scheduler runs with platform privileges, so the barrier views do not scope it.** Report generation must filter by `client_id` itself; it is the one place isolation is not inherited from the database, and it leaked another Client's meter into a Financial Report before the predicate was added.
- **`INSERT ... RETURNING` needs SELECT** on the returned columns, not just INSERT.
- **Three runtime roles, not two**: `solarcms_api`, `solarcms_ingest`, `solarcms_scheduler`. The scheduler reads alarms, escalations and users — none of which ingestion should see.

## Blocked work

MASTER §8.1 lists fourteen open items awaiting a client answer. Do not build numeric display, reports, or thresholds as if settled: **OPEN-15** (unit and scale per Tag), **OPEN-16** (the client's PR/CUF/Availability formulas), **OPEN-14** (counters vs instantaneous, rollover maximum, ABT-vs-MFM precedence) gate anything that shows or computes a number. Observation of the data stream reveals shape, never meaning (MASTER §5.4) — resist treating these as discovery tasks.
