# SolarCMS Backend

Multi-tenant solar plant monitoring: MQTT ingestion → TimescaleDB → REST/WebSocket API.

Authority for this code is the two specifications, in this order:

1. [`docs/MASTER_SPECIFICATION.md`](../docs/MASTER_SPECIFICATION.md) — what is **true**
   (vocabulary, confirmed decisions, data model, scope).
2. [`docs/BACKEND_SPEC.md`](../docs/BACKEND_SPEC.md) — how to **build** (structure,
   libraries, endpoints, build order). Subordinate to MASTER on any fact.

Observed facts about the client's live test broker are in
[`docs/BROKER_OBSERVATIONS.md`](../docs/BROKER_OBSERVATIONS.md). Read it before touching
ingestion: the broker does not currently publish the contracted topic format.

---

## Processes

Five, sharing only Postgres and Redis (BACKEND_SPEC §1). Ingestion never runs inside the
API process — it must survive API deploys (I-7), and it is the one architectural rule that
is expensive to undo.

```bash
uvicorn solarcms.api.main:app --reload       # REST + WebSocket
python -m solarcms.workers.ingest            # MQTT → decode → Redis + COPY batch
python -m solarcms.workers.alarm             # consumes stream:readings
python -m solarcms.workers.health_sweeper    # periodic staleness / frozen-value sweep
python -m solarcms.workers.scheduler         # report crons, escalation timers
```

---

## Local setup

### With Docker

```bash
docker compose up -d           # Postgres+TimescaleDB, Redis, EMQX
cp .env.example .env           # then set TIMESCALE_ENABLED=true
```

### Without Docker (macOS, Homebrew)

This is the current local path — Docker is not installed on this machine.

```bash
brew install python@3.12 redis postgresql@18
brew services start redis
brew services start postgresql@18

# Application role and database
createuser --login solarcms            # or: CREATE ROLE solarcms LOGIN PASSWORD 'solarcms';
createdb -O solarcms solarcms

python3.12 -m venv .venv
.venv/bin/pip install -e ".[dev]"
```

Python **3.12** specifically: `asyncpg==0.29.0` has no wheels for 3.13+, and the spec pins
`requires-python = ">=3.12"`.

`weasyprint` is an extra (`pip install -e ".[reports]"`) because it needs system
pango/cairo and is not required until Phase 9.

### TimescaleDB

TimescaleDB is **CONFIRMED for production** (MASTER F-4) — the retention cascade in §5.3 is
hypertables and continuous aggregates, and there is no substitute for it at 10-year scale.

**Installed locally: TimescaleDB 2.30.0 on Postgres 18.6.** Verified working, including
hierarchical continuous aggregates (an aggregate built on an aggregate), which is what the
§6.2 rollup cascade requires. `TIMESCALE_ENABLED=true`.

How it was installed, for reproducing on another machine:

```bash
brew trust timescale/tap          # the tap ships untrusted
brew install timescaledb          # builds from source; also upgrades postgresql@18
timescaledb_move.sh               # moves the extension into the Postgres tree
# Append to /opt/homebrew/var/postgresql@18/postgresql.conf:
#   shared_preload_libraries = 'timescaledb'
brew services restart postgresql@18
psql -d solarcms -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

⚠ Two things to know. `timescaledb-tune` — the recommended step that sizes memory settings
— ships as an **x86-only binary and will not run on arm64**, so `shared_preload_libraries`
was set by hand instead; that is the formula's own documented alternative, and only memory
tuning is forgone. And `brew install timescaledb` **upgrades `postgresql@18`** as a
dependency (18.1 → 18.6 here), so the restart is not optional. The previous config is saved
at `postgresql.conf.bak-pre-timescale`.

Migrations still detect the extension and fall back to plain tables with materialised views
when it is absent, so CI and a colleague's bare Postgres are not blocked. **Never
`TIMESCALE_ENABLED=false` in production** — the retention policies have no fallback.

---

## Running the whole thing locally

```bash
# One-time
psql -d solarcms -f scripts/bootstrap_roles.sql   # as a superuser
.venv/bin/alembic upgrade head
.venv/bin/python -m solarcms.cli seed             # 17 Device Types, 92 Tags, roles, rules
.venv/bin/python -m solarcms.cli create-superadmin --email you@example.com --password ...

# Register the client's test broker as real assets (Client, Plant, 3 Devices)
.venv/bin/python -m solarcms.cli onboard-test-plant

# API, then each worker in its own process
.venv/bin/uvicorn solarcms.api.main:app --reload
.venv/bin/python -m solarcms.workers.ingest
.venv/bin/python -m solarcms.workers.alarm
.venv/bin/python -m solarcms.workers.health_sweeper
.venv/bin/python -m solarcms.workers.scheduler
```

**A local MQTT broker.** Docker is unavailable here, so development uses
mosquitto (`brew install mosquitto`) with an explicit listener:

```
listener 1883 127.0.0.1
allow_anonymous true
persistence false
```

Anonymous and unencrypted is acceptable locally and nowhere else — the
production broker is ours to operate, with TLS on 8883 and per-endpoint
credentials issued by the CMS (MASTER F-17, §5.1).

**Two `.env` files** are kept side by side, because the two brokers exercise
different ingress paths and both need to work: `.env.clientbroker` points at the
client's live broker on its legacy `{PLANT}/{CATEGORY}` topics, and `.env.local`
at mosquitto on the canonical `scms/v1/#` contract.

```bash
.venv/bin/python tools/simulate.py --host 127.0.0.1 --client demo-client \
    --plant DEMO-PLANT --devices 9 --interval 2 --fault silent
```

`--fault` induces what you cannot wait for: `silent` for the health sweeper,
`frozen` for the stuck-sensor check, `underperform` for the sibling comparison.

## A fabricated multi-Client fleet

The client's broker carries one Plant, which cannot show whether one Client
can see another's data. `tools/simulate_fleet.py` publishes two Clients × two
Plants of deliberately different shape to the Docker broker (see the module
docstring for the fleet and why each Plant is shaped as it is), using the same
short payload keys the client's equipment sends, so commissioning binds the
same Tags it would for real equipment. **The values are invented**: they say
nothing about units, scaling or formulas (OPEN-14/15/16).

```bash
# 1. Point ingest at the Docker broker — .env already does; .env.clientbroker
#    is the client-broker version, and `cp .env.clientbroker .env` switches back.
# 2. Create the two Clients, four Plants and one Client Admin login each.
.venv/bin/python scripts/seed_fleet.py
# 3. Start publishing, and leave it running.
.venv/bin/python tools/simulate_fleet.py
# 4. Let the app discover and register the equipment — the same path a real
#    customer's Devices take. Dry run first; read the plan; then apply.
.venv/bin/python -m solarcms.cli commission-from-broker --topic 'scms/v1/#' --seconds 250
.venv/bin/python -m solarcms.cli commission-from-broker --topic 'scms/v1/#' --seconds 250 --apply
.venv/bin/python -m solarcms.cli commission-from-broker --topic 'SCMS/V1/#' --seconds 150 --apply
# 5. Run the five processes as usual.
```

⚠ One filter per commissioning run. With several filters the command splits
`--seconds` between them, and 150 s across two filters gives each 75 s — less
than one cycle of the slowest Plant (WH2, 120 s), which is then simply absent
from the plan. The window must also see every topic **twice**, or its
interval is not measured and it is registered at the 60 s default.

Logins: `sunfield@example.com` and `roofco@example.com`, password
`fleet12345` (or `--password`), each a Client Admin over their own two Plants.
`admin@example.com` (Super Admin) sees all four.

Faults are a flag, not a scenario, so the same fleet can be broken in any way
on any run:

```bash
.venv/bin/python tools/simulate_fleet.py --fault SF_NORTH:INVERTER_5:silent   # COMM_LOST
.venv/bin/python tools/simulate_fleet.py --fault SF_NORTH:MCR_B:silent        # one COLLECTOR_OFFLINE, not six
.venv/bin/python tools/simulate_fleet.py --fault WH2:*:silent                 # PLANT_SILENT
.venv/bin/python tools/simulate_fleet.py --fault WH1:INVERTER_2:frozen        # stuck values
.venv/bin/python tools/simulate_fleet.py --speed 4                            # every interval ÷ 4
```

`SF_NORTH/INVERTER_9` always runs 40% below its siblings — the case a relative
underperformance rule exists for. Both Clients are `is_demo = true`; that flag,
never the code, is how anything should tell them from a real tenant.

Restarting the simulator is safe: every energy and irradiation counter is saved
to `.artifacts/simulate_fleet_state.json` after each cycle and resumed on the
next run, so a restart reads as a short silence rather than a jump. Before
23 Sep 2026 each run started the lifetime counters at a new random value, and
the KPI endpoint (which subtracts the lowest counter reading from the highest)
turned every restart into gigawatt-hours of "generation" — PR in the tens of
thousands of percent. `--fresh` deliberately starts the counters over — which
puts exactly that jump into the stored readings, so use it only after clearing
the fleet's counter readings:

```bash
.venv/bin/python tools/simulate_fleet.py --fresh
```

## Tests

```bash
.venv/bin/pytest tests/unit                  # domain/ only — no services required
.venv/bin/pytest tests/integration           # testcontainers: real Postgres + Redis
.venv/bin/pytest tests/unit/test_formulas.py::test_performance_ratio   # one test
.venv/bin/ruff check . && .venv/bin/mypy src/solarcms
```

`tests/unit` covers `domain/` and must stay dependency-free: plain values in, plain values
out. That boundary is what makes the formulas — the part most likely to be wrong, and
certain to change when OPEN-15/16 are answered — replaceable without touching
infrastructure.

The non-negotiable test (BACKEND_SPEC §11): authenticate as Client A, query every endpoint,
assert no Client B row is ever returned.

---

## Inspecting a broker

```bash
.venv/bin/python tools/probe_broker.py --host 122.180.254.239 --port 1883 \
    --topic 'KULAR_GREEN/#' --seconds 75 --out probe.json
```

Read-only: it subscribes to the given filter and records topic shapes, payload keys,
publish rates, and observed value ranges. It establishes the *shape* of data and cannot
establish its *meaning* — units, scale factors, and counter semantics are OPEN-15 and
OPEN-14, answerable only by the client (MASTER §5.4).

---

## Working on this code

Every assumed value — units, scale factors, thresholds, formula coefficients, intervals —
lives in [`src/solarcms/domain/assumptions.py`](src/solarcms/domain/assumptions.py) and
nowhere else. When the client supplies the real figures, that is a single-file edit. A
constant that escapes into a service, router, or worker turns it into a search across the
project, which is why BACKEND_SPEC §0.3 calls this the most important rule in the
specification.

The guardrails in BACKEND_SPEC §14 each protect something recorded as confirmed. The two
easiest to violate by accident:

- **Never a column per metric.** Metrics are rows in `tags` (I-2). This is the decision
  that makes new Device Models an `INSERT` rather than a migration.
- **Never infer a Client from payload contents.** The topic is the sole authority (§5.1).
  Where a topic does not match the canonical format, it is interpreted through the ingress
  pattern registry — as data, never as a code path named after a client.
