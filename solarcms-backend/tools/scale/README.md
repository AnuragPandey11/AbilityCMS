# Load test harness

Measures what the app costs at fleet scale, on a database of its own, so that a
change can be judged by a number before and after. Results from the first run
(8 Oct 2026) are in `docs/CAPACITY_AND_DEPLOYMENT.md` §10.

Everything runs against `$SCALE_DB` (`solarcms_scale`), Redis database 1 and the
`loadtest/v1` topic root. The development database, its Redis keys and its
broker session are never touched, and every script that writes refuses to run
unless `DATABASE_URL` names the load-test database. Run files (simulator state,
logs, results) go to `$SCALE_RUN_DIR`, outside the repository by default.

## The fleet

⚠ **Every Plant is in India (`Asia/Kolkata`)**, as the client's are. Keep it
that way: a Plant on another clock starts its day at another hour, so its
"today" figures are not comparable with an Indian Plant's (`fleet.TIMEZONE`).

`fleet.py`: 10 Clients × 5 Plants, each shaped like KULAR_GREEN — seventeen
Inverters in an MCR, plus MFM, ABT meter, Transformer, VCB, WMS and PPC, every
Device every 30 s, each Inverter's 28 PV strings on two topics of their own as
the client's broker sends them. 50 Plants, 1,150 Devices (1,200 with the Plant
KPI Devices), 2,850 topics, ~95 messages/s, ~1.9M readings per Plant per day.

## Running it

From `solarcms-backend/`, one command per line (zsh does not treat `#` as a
comment):

```
source tools/scale/env.sh
.venv/bin/python tools/scale/setup.py
.venv/bin/python -m solarcms.cli create-superadmin --email admin@loadtest.example.com --password admin12345
.venv/bin/python tools/scale/publish.py --minutes 6 &
.venv/bin/python -m solarcms.cli commission-from-broker --topic 'loadtest/v1/#' --seconds 75
.venv/bin/python -m solarcms.cli commission-from-broker --topic 'loadtest/v1/#' --seconds 75 --apply
```

History (8 days for the three Plants in `fleet.HISTORY_PLANTS`), then aggregates and
compression — the refresh took ~40 minutes on a laptop:

```
.venv/bin/python tools/scale/history.py --plant LT01_P1 --days 8 &
.venv/bin/python tools/scale/history.py --plant LT01_P2 --days 8 &
.venv/bin/python tools/scale/history.py --plant LT01_P3 --days 8 &
wait
.venv/bin/python tools/scale/finish_history.py
```

If time passes before measuring, fill the gap so "today" has no hole:

```
.venv/bin/python tools/scale/history.py --plant LT01_P1 --resume
```

## Measuring

| Script | What it answers |
|---|---|
| `measure.py` | Every per-request and periodic cost: wall time, SQL statements, summed statement time. `--scope` limits it; `--label` names the run. |
| `ingest_bench.py` | Ingest's ceiling in messages/s on the fleet's real message mix. |
| `latency.sh PG_MS [REDIS_MS]` | The same through Toxiproxy with delay on every round trip. ⚠ Its "+1 ms" measured as ~1.9 ms added per round trip on Docker Desktop; calibrate before reading it as a cross-AZ figure. |
| `publish.py --daylight` + the supervisor + `monitor.py` | The live stack at 50 Plants' message rate: is every process keeping up. |
| `viewers.py` | People on the Plant and Portfolio screens, at the frontend's own refresh cadence. Records response sizes too. |
| `traffic.py` | Bytes moved during a live run: broker, Redis and Postgres network counters, Postgres WAL (what a replica receives), live-frame fan-out, and log bytes by level. These feed the AWS lines billed per GB. Run with the supervisor started under `LOG_JSON=true`, and with nothing else using the Docker services. |

The live run, with the stack pointed at the load-test database:

```
.venv/bin/python -m solarcms.supervisor --log-dir "$SCALE_RUN_DIR/logs" &
.venv/bin/python tools/scale/publish.py --daylight --minutes 11 > "$SCALE_RUN_DIR/publish-live.log" &
.venv/bin/python tools/scale/monitor.py --minutes 10 --publish-log "$SCALE_RUN_DIR/publish-live.log"
```

Stop the supervisor with SIGTERM afterwards; it stops its children.

## Cleaning up

```
.venv/bin/python tools/scale/setup.py --drop
docker exec solarcms-redis redis-cli -n 1 flushdb
```

The broker keeps the `solarcms-ingest-loadtest` session until it expires;
nothing publishes to `loadtest/v1` once the publisher stops, so it receives
nothing.