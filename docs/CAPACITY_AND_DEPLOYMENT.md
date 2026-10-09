# Capacity and Deployment: Findings and Plan

**Date:** 8 Oct 2026.
**Status:** findings are measured; every plan in this document is PROPOSED. Nothing here is recorded in [MASTER_SPECIFICATION.md](MASTER_SPECIFICATION.md) or [BACKEND_SPEC.md](BACKEND_SPEC.md). Where a recommendation changes a decision recorded there, §8 names the decision.
**Launch target:** about **50 Plants** belonging to the client's own customers (several Clients), on AWS across AZs, publishing to an MQTT broker we operate. Growth after that is gradual; 10,000 MW is the long-run horizon.

**Measured on:** the Docker development machine, against its fabricated fleet:

- Apple M2, 16 GB RAM;
- Docker Desktop VM with 8 CPUs and 8 GB;
- TimescaleDB 2.17.2, `shared_buffers` 1,983 MB, `max_connections` 100.

The workers were stopped and the API ran alone. Every benchmark write was rolled back, and Redis was flushed back to empty afterwards.

**Then load-tested at 50 Plants (§10), the same evening,** on a database of its own:

- 1,200 Devices registered through `commission-from-broker`;
- 8 days of history for 3 of the Plants (45M readings);
- the full stack live at 95 messages/s;
- ingest re-measured with network delay added.

The harness is in [`solarcms-backend/tools/scale/`](../solarcms-backend/tools/scale/README.md) and re-runs after every fix. **To run it on your own machine, follow §11.**

**This is a development machine, and the code measured here is the code that will be deployed.** §2.1 separates what the measurements say about the code, which carries to AWS unchanged, from what they say about this machine, which does not.

---

## 1. Summary

- **The load test at 50 Plants (§10) confirmed the limits below and found a larger one.** Queries that filter by Plant through a join read the **whole fleet's** data and discard the other Plants' rows afterwards (§4.9). So one Plant's screen gets slower with every Plant added and every hour since midnight. Measured with history on only 3 of the 50 Plants:

  | Request | Measured |
  |---|---|
  | Today's KPIs | 6 s at 1.8 h into the day, 56 s at 12.2 h, 77 s at 20.4 h |
  | Dashboard | up to 35 s |
  | Inverter report for yesterday | 30–58 s |
  | Health sweep pass (60 s interval) | 107–120 s |

  Passing the Plant's Device and Tag ids into the view cut the worst query from **31 s to 0.04 s** on the same data. The fix is a rewrite of specific queries, not of the architecture.
- **About 100–150 Devices is the capacity of the code as it stands**, on this machine or any other. Fifty Plants is roughly 1,000–1,750 Devices. The number of Clients is not a limit; they are rows separated by row-level security.
- **The app looks fast today only because the database is nearly empty**: 17 days of on-and-off simulator data, 1.93M readings. The limits appear as 30 days of continuous history accumulate, and the first is the health sweep, which reads every reading each Device has stored, every minute.
- **On AWS, ingest gets slower, not faster.** Each MQTT message makes about 15 round trips to Postgres and Redis. Here both services are on the same machine (0.15 ms per trip). Measured with delay added:

  | Round trip | Ingest, messages/s |
  |---|---|
  | 0.15 ms (this machine) | 307 |
  | ~1 ms (typical cross-AZ) | ~60, interpolated |
  | ~2 ms | 31 |

  50 Plants publish **95/s** (§10.4). The round-trip fix (§4.5) is required before launch.
- **On AWS, the API is bound by the database, and screens slow down through the day and as the fleet grows.** Today's KPIs re-read the day's 1-minute data on every request, for every Plant (§4.9). Two fixes: the query rewrite first (§4.9), then compute today's figures incrementally, once a minute (§4.4).
- **Ingest acknowledges MQTT messages on receipt, not after the database commit**, contrary to CLAUDE.md. Every crash, deploy or failover loses the buffered messages.
- **Parts of the code assume a single development machine** (§5):
  - generated report files are written to the local disk;
  - CORS allows every origin;
  - the audit log would record the load balancer's IP;
  - there are no container images;
  - the database connection count exceeds what a managed instance allows without a pooler.

### 1.1 Recommended order of work (priority: scale and speed)

**Keep the stack; change what the code asks of the database.** None of the measured limits comes from Python, FastAPI or Postgres being too slow. Each comes from the code reading far more than it needs:

- the whole fleet's rows when it wants one Plant's (§4.9);
- the whole day on every KPI request (§4.4);
- the whole retention period on every health sweep (§4.2);
- about 15 network round trips for every MQTT message (§4.5).

The load test supports this. Ingest, the alarm worker, the scheduler and the database's write path all kept up at 50 Plants' message rate. Everything that fell over was a specific query or loop. The current architecture handles 50 Plants and well beyond once those are fixed. Kafka, microservices or a rewrite in another language would cost months and touch none of these causes (§6.7).

In this order:

| Step | What | Effect | Detail |
|---|---|---|---|
| **0** | **Measurement harness.** Done: `tools/scale/`, 8 Oct 2026. | Every later step gets a before-and-after number from the same harness. | §10, `tools/scale/README.md` |
| **1** | **Rewrite the queries that filter by Plant through a join**, so the Plant's Device ids (and Tag ids where known) reach the view. | **Measured:** the worst KPI query fell from 31 s to 0.04 s on the same data. Screens stop slowing down as Plants are added. The smallest change for the largest gain. | §4.9 |
| **2** | **Fix the health sweep query.** | Removes the cap at ~130 Devices. Measured: 107–120 s per pass at 1,200 Devices, against a 60 s interval. | §4.2 |
| **3** | **Compute today's figures incrementally, once a minute**; serve the Portfolio in one request; the Plant screen refreshes at most every 15 s. | Screens answer in milliseconds whatever the time of day or the number of people watching (estimate). Coverage, "undefined, never 0.0" and calendar days on the Plant's clock all carry over unchanged. | §4.4 |
| **4** | **Cut ingest's round trips.** | Measured: 31 messages/s at ~2 ms round trips, ~60 at ~1 ms (interpolated). 50 Plants publish 95/s. With round trips cut to one or two per message, an estimated 200–1,000/s. | §4.5 |
| **5** | **Compress the aggregate tiers**, and `readings` after 1 day. | Disk drops ~8× in the first year: ~6.3 TB → ~0.8 TB per database node at 50 Plants (estimate, at the load test's measured 1.9M readings per Plant per day). More of the data fits in memory too, so reads get faster. | §4.3 |
| **6** | **Run more than one of each process:** several API workers per task, a connection pooler in transaction mode, workers safe to run twice. | API capacity scales with tasks; this is also what multi-AZ failover needs. | §4.6, §5.6, §5.8 |

**Alongside these, though they won't make anything faster**, because without them the deployment loses data or does not work at all. Each is small:

- acknowledge MQTT messages only after commit (§4.1);
- the S3 store for report files (§5.1);
- the `/api` path and CORS (§5.2, §5.3);
- client IPs behind the load balancer (§5.4);
- container images and the migration task (§5.5).

§6.4 is the complete checklist before launch; this table is the order to work through it in.

---

## 2. What was measured

### 2.1 What carries over to AWS

| Property | Measured here | On AWS |
|---|---|---|
| Round trips per message and per request; SQL statements per request | §2.5, §2.7 | **Unchanged.** A property of the code. |
| Rows each query reads; how cost grows with history | §2.6 | **Unchanged.** A property of the code. |
| Bytes per row; which tables are compressed | §2.4 | **Unchanged.** A property of the schema and migrations. |
| When MQTT messages are acknowledged | §4.1 | **Unchanged.** A property of the code. |
| Cost of one round trip | 0.17 ms Redis, 0.15 ms Postgres (same machine) | **Higher.** Assumed 0.5–1 ms to ElastiCache and 1–1.5 ms to a managed Postgres, especially across AZs. Measure it in the staging VPC (§6.5). |
| Python speed | Apple M2 | **Probably slower.** Assumed 1.5–2× slower per Fargate vCPU; measure it. |
| Database speed | 8-CPU VM, data mostly in memory | **Depends on the instance chosen**, and on whether the data still fits in memory. |

Every figure below marked as an estimate is a projection from these measurements using the assumptions in this table. None has been tested on AWS.

### 2.2 The fleet

| | Value |
|---|---|
| Clients / Plants / Devices / bindings | 3 / 5 / 61 / 2,165 |
| Database size | 468 MB |
| History | 21 Sep → 8 Oct 2026, intermittent (the laptop sleeps) |
| Readings stored | 1,926,366 |
| Steady hour (8 Oct, 14:55–15:55 UTC) | 117,156 readings from 61 Devices = **1,921 readings per Device per hour** |
| Messages in that hour | 4,664 on 56 topics, one per topic every ~43 s, ~975 bytes of JSON each |

The projections use **1,921 readings per Device per hour**, the fabricated fleet's rate after throttling. The client's broker differs in two ways:

- it publishes every ~30 s;
- it carries each Inverter's PV strings on topics of their own. On KULAR_GREEN, 17 Inverters add 34 string topics to 21 Devices, about **2.5 topics per Device**.

A real Plant may therefore store more than this rate.

### 2.3 Devices per MW (AC)

| Plant | AC MW | Devices | Inverters | Devices per MW |
|---|---|---|---|---|
| SF_NORTH | 4.8 | 19 | 12 | 4.0 |
| SF_SOUTH | 2.0 | 9 | 4 | 4.5 |
| VF_LUDHIANA (rooftop) | 2.0 | 23 | 16 | 11.5 |
| WH1 (rooftop) | 0.45 | 6 | 3 | 13.3 |
| WH2 (rooftop) | 0.2 | 4 | 2 | 20.0 |

Device counts include each Plant's `PLANT_KPI` Device.

### 2.4 Storage

| Table | Size | Compressed? | Bytes per row |
|---|---|---|---|
| `readings` | 94 MB | yes, after 7 days | ~180 uncompressed (with both indexes), ~22 compressed |
| `mqtt_raw` | 35 MB | yes, after 7 days | ~1,344 uncompressed, ~190 compressed (from the ratio) |
| `agg_1m` | 281 MB, 1.78M rows | **no** | 158 |
| `agg_15m` | 25 MB, 160,913 rows | **no** | ~155 |
| `agg_1h` | 12 MB, 69,131 rows | **no** | ~175 |
| `agg_1d` | 3.5 MB, 14,240 rows | **no** | ~245 |

- Compression ratios from `hypertable_compression_stats`: `readings` 237 MB → 19.4 MB (**12.2×**), `mqtt_raw` 78 MB → 11.2 MB (**7×**).
- **None of the four aggregate tiers has compression enabled.** Every view reports `compression_enabled = false`, and the only compression jobs are the two on `readings` and `mqtt_raw`.
- **At this publishing rate `agg_1m` has one row per reading:** 116,091 `agg_1m` rows against 117,156 readings in the steady hour. It is therefore an uncompressed copy of the raw data kept 12× longer (1 year against 30 days), which makes it the largest table.

### 2.5 Ingest

Method: `IngestWorker.handle()` was driven directly against the real Postgres and Redis, without the broker, using the latest real payload from each of 37 Inverter topics (~1,154 bytes each).

| Path | Time per message | Messages per second |
|---|---|---|
| Every Tag inside its throttle window (the common case) | 3.50–3.58 ms | 286 |
| Nothing throttled: every value written to Redis and buffered (54.1 readings per message) | 4.49–4.63 ms | **223** |
| The flush: COPY of 50,000 readings plus 2,000 raw messages in one transaction, rolled back | 200–212 ms | **236,000–250,000 readings/s** |

**Where the time goes**, counted by wrapping the Redis client and the SQLAlchemy engine:

| Per message | Count | Time here |
|---|---|---|
| Postgres: a full transaction opened for the topic lookup, even when the lookup is cached in Redis ([ingest.py:181](../solarcms-backend/src/solarcms/workers/ingest.py#L181)): pool check, `BEGIN`, `set_config`, `COMMIT`, reset | ~5 round trips | 1.2 ms, including SQLAlchemy's own overhead |
| Redis: resolution, throttle state, counters, last-heard, live values, throttle write, counter write, live publish | ~8–9 round trips | ~1.5 ms |
| Everything else (JSON, decoding, Python) | — | 0.7–1.9 ms |

About 60–80% of each message is round trips. Messages are handled strictly one at a time, so round-trip cost sets the ceiling. The database write itself is about 1,000× faster than needed.

### 2.6 Health sweep

Measured with `EXPLAIN ANALYZE`, as `solarcms_scheduler` in the platform context:

| Query | Time |
|---|---|
| The sweep's Device query: `max(time)` plus the 24-hour `count(*)` per Device, 61 Devices | **737 ms** |
| …the `max(time)` part alone | 598 ms |
| …the 24-hour `count(*)` part alone | 101 ms |
| `max(time)` limited to the last 2 days | 105 ms |
| The unregistered-topics query over `mqtt_raw_v` (24 h) | 7.9 ms |

`(SELECT max(time) FROM readings_v r WHERE r.device_id = d.id)` ([health_sweeper.py:238](../solarcms-backend/src/solarcms/workers/health_sweeper.py#L238)) decompresses and reads **every row the Device has in retention**: 31,580 rows per Device on this database. Two things prevent a cheap lookup:

- the security-barrier view stops the planner from turning `max()` into an ordered `LIMIT 1`;
- the only index, `(device_id, tag_id, time DESC)`, has `tag_id` before `time`.

The cost grows with total history, so faster hardware only moves the limit a little.

### 2.7 API

**Timings.** One uvicorn process, as the supervisor runs it ([supervisor.py:55](../solarcms-backend/src/solarcms/supervisor.py#L55)). Medians of 5 requests:

| Request | SF_NORTH (19 Devices) | WH2 (4) | VF_LUDHIANA (23) |
|---|---|---|---|
| `GET /plants/{id}/kpis?period=today` | 264–281 ms | 215 ms | 474–481 ms |
| `GET /plants/{id}/kpis?period=today&compare=true` | 359–366 ms | | 506–508 ms |
| `GET /plants/{id}/kpis?period=month` | 88 ms | | |
| `GET /plants/{id}/dashboard` | 155–218 ms | 108 ms | 204–213 ms |
| `GET /plants/{id}/operating-status` | 72–123 ms | | 116–158 ms |
| `GET /plants/{id}/strings` | 84 ms | | |
| `GET /plants/{id}/forecast` (cached) | 5 ms | | |
| `GET /alarms?limit=100` | 9 ms | | |

**Where the time goes.** SQL statements were counted and timed per request (in-process). Statements run partly in parallel, so their summed time exceeds the request's wall time, and the sum is an upper bound on database work:

| Request | SQL statements | Summed statement time | Redis calls |
|---|---|---|---|
| `kpis?period=today` | 28 | 528 ms (SF_NORTH), 915 ms (VF_LUDHIANA) | 0 |
| `kpis?period=today&compare=true` | 36 | 678 ms, 974 ms | 0 |
| `dashboard` | 26 | 380 ms, 365 ms | 19–23 |
| `operating-status` | 38 | 107 ms, 179 ms | 20–24 |

**The API's cost is database work.** Python and round trips are a small share, so on AWS the API's capacity is set mainly by the database instance.

**`/kpis?period=today` reads the Plant's entire day at 1-minute resolution, three times, on every request.** On VF_LUDHIANA its three slowest statements are all scans of `agg_1m_v` from the Plant's midnight onwards:

| Statement | Time |
|---|---|
| The minutes that hold a reading | 175 ms |
| The values per Device and Tag | 126 ms |
| The sample count for coverage | 88 ms |

Together they are ~390 ms of the ~480 ms request.

**The measured figure understates the problem.** Today's data covered only 2 h 17 min (the simulator ran briefly; 107,553 rows). A full day for this 23-Device Plant is ~1.1M rows, about 10× more. So the request grows through the day, to **an estimated ~4 s by midnight**. `/dashboard` and `/operating-status` also read from midnight and may grow the same way; that has not been measured.

**Concurrent load.** Each simulated viewer made the four heaviest SF_NORTH requests at once:

| Viewers | Wall time | Requests per second |
|---|---|---|
| 1 | 400 ms | 10 |
| 5 | 933 ms | 21 |
| 20 | 2,606 ms | **31** |

**How often the browser asks.** Two parts of the frontend decide it:

- **The Plant screen** invalidates `dashboard`, `kpis` and `operating-status` after every live frame, grouped into one refetch per second ([useLiveRefresh.ts:42](../solarcms-frontend/src/live/useLiveRefresh.ts#L42)). A 20-Device Plant sends a frame every 1–2 s.
- **The Portfolio** requests `/kpis` and `/dashboard` for every Plant every 10 s (`usePlantKpiFanout`). The comment at [hooks.ts:67](../solarcms-frontend/src/api/hooks.ts#L67) says `/kpis` costs 5–10 ms per Plant. That is out of date.

---

## 3. Capacity as built

| Limit | Here (measured, projected with history) | On AWS (estimate) | Why |
|---|---|---|---|
| **Health sweep** | **~130 Devices**. Measured at 1,200 Devices (§10): **107–120 s per pass** against a 60 s interval. | about the same | The sweep reads 1,921 × 24 × 30 ≈ 1.38M readings per Device, ~0.45 s per Device per sweep here. Past ~130 Devices one sweep outlasts its 60 s interval. The cost grows with history, so hardware barely moves it. |
| **Ingest** | 307 messages/s (measured); kept up with 95/s live at 50 Plants (§10.4) | **31/s measured at ~2 ms round trips; ~60/s at ~1 ms** (interpolated) | About 15 round trips per message (§10.3), each costing the network's round-trip time. 50 Plants publish 95/s. |
| **Database time for screens** | **Measured at 50 Plants (§10.2):** today's KPIs 6–77 s, dashboard up to 35 s, the inverter report 30–58 s, with history on only 3 of the 50 Plants | depends on instance size, and **grows through the day and with the fleet** | The queries read every Plant's rows and filter afterwards (§4.9), so each request costs in proportion to the whole fleet's data since the Plant's midnight. |
| **Disk** | ~3 GB per Device per year | the same | Mostly `agg_1m`: 1,921 × 24 × 365 × 158 B ≈ 2.65 GB per Device per year, uncompressed. |

---

## 4. Defects in the code

Listed by severity. None has been fixed yet.

### 4.1 MQTT messages are acknowledged on receipt, not after commit

- **The claim:** CLAUDE.md says "MQTT is acknowledged only **after** commit, so a crash causes redelivery rather than loss", and the [ingest.py](../solarcms-backend/src/solarcms/workers/ingest.py) docstring says the same.
- **What the code does:** aiomqtt 2.3.0 creates its paho 2.1.0 client without `manual_ack`. paho therefore acknowledges as soon as its `on_message` callback returns. aiomqtt's callback only puts the message into an `asyncio.Queue`, which has no size limit by default (`max_queued_incoming_messages = 0`).
- **What is lost:**
  - on a crash, an out-of-memory kill or an AZ failure, every message in that queue plus the up-to-2-second batch;
  - on a graceful stop the batch is flushed, but messages still waiting in aiomqtt's queue are dropped;
  - while the database is down, the backlog grows in memory and the broker believes it was all delivered.
- **Fix:** call `client._client.manual_ack_set(True)` before connecting, keep each message's `mid` with its rows, and call `client._client.ack(mid, qos)` after the COPY commits. This relies on aiomqtt's private `_client` attribute, so pin the aiomqtt version. Also limit the incoming queue, so that a stalled flush makes ingest stop reading instead of buffering without limit.

### 4.2 The health sweep reads every Device's full history every minute

See §2.6. **Fix:**
- limit `max(time)` to the last hour or so, or drop it. The Redis last-heard time is already the primary liveness check;
- take `readings_24h` from `agg_15m.sample_count` instead of counting raw rows.

### 4.3 The aggregate tiers are not compressed

See §2.4. **Fix:** enable compression and a compression policy on all four continuous aggregates, and compress `readings` after 1 day instead of 7. Compression has not been measured on the aggregates; if they compress like `readings` (12×), ~3 GB per Device per year becomes ~0.4 GB (estimate).

### 4.4 Screen requests are computed in full each time, and the browser asks often

See §2.7. A cache alone is not enough. Today's figures re-read the whole day on each computation, an estimated ~4 s per Plant by midnight. A 30-second cache would still run that ~2 times a minute for every Plant someone has open: about 7 database cores for 50 Plants (estimate). **Fix:**
- **compute today's figures incrementally.** Once a minute, for each Plant, add only the minute just ended to a running state: energy, the minutes that held readings, coverage counts, peak, start and stop. The API reads the result. Every rule carries over unchanged: calendar periods on the Plant's clock, "undefined, never 0.0", coverage beside every value, a published value beating a computed one. Only the order of work changes. Month, year and lifetime become daily rollups plus today;
- make the Portfolio one request that reads every Plant's result, instead of two requests per Plant every 10 s;
- make the Plant screen refetch at most every ~15 s instead of after every live frame;
- correct the comment at `hooks.ts:67`.

**Interim, if the incremental state cannot land first:** read today's completed quarter-hours from `agg_15m` (15× fewer rows) and only the current quarter-hour from `agg_1m`, plus a 30 s cache per Plant. Check first that every question `/kpis` asks of the minute data can be answered from quarter-hours.

### 4.5 Ingest makes round trips it does not need

See §2.5. On AWS this decides whether 50 Plants fit (§3). **Fix:**
- check the Redis resolution cache before opening a database session. That removes all ~5 Postgres round trips from a message whose topic is cached;
- with one active ingest worker (§4.6), keep the topic resolution, throttle state and counter values in the worker's own memory, which leaves only writes going to Redis;
- send the writes (live values, last-heard, throttle, counters, live publish) as one pipeline per message, or per flush.

That brings a message to roughly one Redis round trip plus Python, an estimated 200–1,000 messages/s on AWS.

**Measured (§10.3):** about 15 round trips per message today. That's 31 messages/s at ~2 ms round trips, and an interpolated ~60/s at ~1 ms, against the 95/s that 50 Plants publish. Postgres and Redis each account for roughly half of the round-trip cost.

### 4.6 The workers assume exactly one copy of each

- Two ingest workers share one MQTT client identifier and fight over the session.
- The alarm worker's consumer name is fixed (`CONSUMER_NAME = "alarm-1"`, [alarm.py:61](../solarcms-backend/src/solarcms/workers/alarm.py#L61)).
- Two schedulers would send reports and escalations twice.

The supervisor prevents duplicates on one machine only, and it does not run on ECS. ECS runs the old and new task side by side during a rolling deploy by default. **Fix:** each worker takes a Postgres advisory lock at startup. A second copy waits as a hot standby in another AZ and takes over within seconds when the first dies.

### 4.7 Heartbeats are keyed by process name only

`heartbeat:{process}` ([keys.py:135](../solarcms-backend/src/solarcms/cache/keys.py#L135)), so two API tasks, or a worker and its standby, overwrite each other, and System Health shows one. **Fix:** key by process and instance, and have the verdict summarise every instance of a process.

### 4.8 Smaller items

- **Alarm worker:** acknowledges each stream entry with its own Redis call ([alarm.py:294](../solarcms-backend/src/solarcms/workers/alarm.py#L294)). Batch the acknowledgements.
- **Integration tests:** leave their fixtures in whatever database `DATABASE_URL` names (`tests/conftest.py`). Make them refuse to run against anything but a development database.

### 4.9 Queries that filter by Plant through a join read the whole fleet

Found by the load test (§10.2). The most important defect in this document for speed.

**The pattern** is `FROM agg_1m_v a JOIN devices d ON d.id = a.device_id WHERE d.plant_id = $1 AND a.bucket >= $2`. The Plant filter is on the joined `devices` table, outside the security-barrier view, so it cannot be pushed into the scan. The planner therefore:

1. reads **every Plant's** rows in the time window from the 1-minute table, using its `bucket` index;
2. hash-joins them to the Plant's Devices;
3. only then discards the other Plants' rows.

The table already has a `(device_id, bucket)` index that would serve the query; it is never given the ids to use it. Where only some Tags are wanted, the Tag filter is a joined string (`dt.code || ':' || t.code = ANY(...)`), which no index can serve either.

**Measured,** in `/kpis?period=today` on a Plant 12 h into its day, with three Plants' history in the database:

| Statement | Rows read | Rows wanted | Time |
|---|---|---|---|
| Today's counter values (4 registers) | 2,706,569 | 2,820 | 36.5 s in the request; 15.5 s under `EXPLAIN` |
| Today's sample count, for coverage | 2,706,619 | that Plant's 898,795 | 14.2 s |
| The first minute with a reading | 1,357,921 | 1 | 13.8 s |

**The fix, measured on the same data and as the API's role:**

| The counter query… | Time |
|---|---|
| as written | 31.0 s |
| with the Plant's Device ids passed into the view (`a.device_id = ANY(...)`, which the planner can push down) | 3.5 s |
| with the Device ids **and** the 3 counter Tag ids passed in | **0.042 s** |

The same pattern is the likely cause of the other slow requests, which have not been explained individually yet:

| Request | Measured |
|---|---|
| `/dashboard` | up to 35 s |
| `/sld-stages` | up to 25 s |
| `/operating-status` | up to 6 s |
| Inverter report for yesterday | 30–58 s, including a Plant with almost no history of its own |
| Daily report, last 7 days | 1.7–3.8 s |
| `/kpis?period=month` | 2–12 s |

The custom report, which already passes explicit Device ids, took 0.08–0.18 s on the same data.

**Fix:**
- resolve the Plant's Device ids (and Tag ids, where the query wants specific Tags) first, with one cheap query;
- filter the `*_v` view on those columns directly;
- check each rewritten query with `EXPLAIN` under `solarcms_api`, so that what reaches the scan is the index condition, not a filter applied after the join.

The coverage count that genuinely needs all of a Plant's rows should read `agg_15m` for completed quarter-hours: 15× fewer rows, and the same `sample_count` sum. The rewrite changes no result, so the existing tests are the check.

### 4.10 System Health calls an overrunning sweep "working"

During the live run (§10.4), the health sweep took ~107 s per pass against its 60 s interval. All the while, `/health/processes` reported it, like every other process, as `working`, with no errors.

The verdict looks at whether a process completed a cycle recently, not at whether its cycles keep to their interval. So the page cannot show the first limit this document found.

**Fix:** record each cycle's duration in the heartbeat, and judge a periodic worker `degraded` when it exceeds the worker's own interval.

### 4.11 Fleet-wide pages that loop over Plants

| Request | Measured |
|---|---|
| `GET /data-issues/summary` | **13.6 s**, 607 SQL statements: one set per Plant, run in sequence |
| `GET /health/system` (System Health's database figures) | **4.6 s** |

Both grow with the number of Plants. **Fix:** batch the per-Plant queries into set-based ones, or compute these figures in the scheduler and serve them from there.

---

## 5. Code that assumes a development machine

Each of these works on one laptop and breaks, or misleads, once the code runs as several tasks behind a load balancer.

| # | What | Where | Effect on AWS | Fix |
|---|---|---|---|---|
| 5.1 | Generated report files go to the local disk. An S3 store is not implemented, and setting `S3_BUCKET` raises an error. | [storage.py](../solarcms-backend/src/solarcms/services/storage.py) (`LocalArtifactStore`, `.artifacts/`) | A scheduled report written by the scheduler task cannot be downloaded through an API task. Every report is lost when a task is replaced, which happens on every deploy. | Implement the S3 store with presigned URLs, as the module already describes. |
| 5.2 | CORS allows every origin, with credentials. | [main.py:63](../solarcms-backend/src/solarcms/api/main.py#L63) | Low risk today: logins are a bearer token, not a cookie, so another web page cannot borrow a signed-in user's session. It becomes a hole the day anything moves to cookies. | Allow only the app's own domain. |
| 5.3 | The frontend expects `/api` on its own domain, and the Vite dev server strips the prefix before forwarding. | [vite.config.ts](../solarcms-frontend/vite.config.ts), [client.ts:17](../solarcms-frontend/src/api/client.ts#L17) | CloudFront has nothing to strip it, so every request 404s. | Serve the API on its own domain and build with `VITE_API_BASE` and `VITE_WS_BASE` pointing at it. The alternative is a CloudFront function that rewrites the path. |
| 5.4 | The audit log records `request.client.host`. | [auth.py:58](../solarcms-backend/src/solarcms/api/routers/auth.py#L58) | Behind the ALB this is the balancer's private IP, so every failed login (tender §33) records the wrong address. | Run uvicorn with `--proxy-headers --forwarded-allow-ips` set to the ALB's subnets, with tasks reachable only through the ALB. |
| 5.5 | No container images. | — | Nothing to deploy. | One backend image: Python 3.12, the five process commands, WeasyPrint's system libraries (pango/cairo; without them the PDF download is a 503). Plus a frontend build published to S3. |
| 5.6 | Database connections are budgeted for one machine: SQLAlchemy pools of 10 (+10 overflow) in every process, and a 4-connection asyncpg pool for ingest. | [session.py](../solarcms-backend/src/solarcms/db/session.py), [config.py](../solarcms-backend/src/solarcms/config.py) | 2 API tasks × 4 workers alone can open 160 connections; this Postgres allows 100, and managed instances are similar. | Use the managed pooler in **transaction** mode (statement mode leaks the RLS session variables between Clients). asyncpg's prepared statements break under transaction pooling, so disable its statement cache on both connection paths: `prepared_statement_cache_size=0` for SQLAlchemy, `statement_cache_size=0` for the raw ingest pool. |
| 5.7 | Ingest derives its DSN by string replacement from the SQLAlchemy URL. | [config.py](../solarcms-backend/src/solarcms/config.py) (`asyncpg_dsn`) | A managed Postgres requires TLS. The TLS option must be spelled so that both SQLAlchemy and raw asyncpg accept it from the same URL, which is untested. | Test both paths against the managed database. Use `rediss://` for ElastiCache with encryption in transit. |
| 5.8 | The API runs as one uvicorn process. | [supervisor.py:55](../solarcms-backend/src/solarcms/supervisor.py#L55) | Uses one core per task. | Several uvicorn workers per task. |
| 5.9 | `jwt_secret` also signs report download links. | [storage.py](../solarcms-backend/src/solarcms/services/storage.py) | Rotating the login secret invalidates every outstanding download link. | Acceptable; record it, or give links their own secret. |

Already in place: every setting comes from environment variables (`.env` is read only if present); logs are JSON on stdout (`log_json` defaults to true), which CloudWatch takes as-is; and `/healthz` exists for the ALB's health check.

---

## 6. Launch plan: 50 Plants on AWS across AZs

### 6.1 Size (estimate)

The client's Plants run 19–23 Devices each. Assuming 20–35 per Plant and ~2.5 topics per Device:

| | 50 Plants | Limit as built, on AWS |
|---|---|---|
| Devices | ~1,000–1,750 (planning figure 1,250) | health sweep: ~130 |
| MQTT topics | ~2,500–4,400 | |
| MQTT messages | **~70–150/s** (planning figure ~100/s) | ingest: **~50–100/s** |
| Readings | ~670/s, ~58M/day (at the fleet's rate) | COPY: ~250,000/s |
| Disk, first year, per database node | ~6.3 TB as built; **~0.8 TB** with §4.3 (estimates at the load test's measured 1.9M readings per Plant per day; the earlier ~3.7 TB used the development fleet's lower rate) | |

Ingest, the health sweep, screen database time and storage all need their fixes before launch. Only the database write path has headroom as built.

### 6.2 AWS layout

Use Mumbai (ap-south-1), which has three AZs. Spread every component across at least two of them.

| Component | Service | Notes |
|---|---|---|
| Database | **Timescale Cloud on AWS**, with an HA replica in a second AZ, PITR, and its connection pooler in transaction mode | Amazon RDS and Aurora do not offer the TimescaleDB extension. The alternative is self-managed TimescaleDB on EC2 with Patroni. Confirm Timescale Cloud is offered in Mumbai. Starting size, to confirm in the load test: 4–8 vCPU, 32 GB RAM. |
| Redis | ElastiCache (Redis or Valkey), Multi-AZ with automatic failover, encryption in transit | The app already rebuilds what Redis loses. Entries in the alarm stream that were never acknowledged may be lost on failover, a short gap in alarm evaluation. |
| MQTT broker | EMQX: managed EMQX Cloud, or 2 nodes in two AZs behind a Network Load Balancer on 8883 | Ours; the client publishes to it (§6.3). |
| API | ECS Fargate, at least 2 tasks in two AZs, behind an Application Load Balancer with an ACM certificate, several uvicorn workers per task | The ALB carries the WebSocket; live frames already fan out across tasks through Redis pub/sub. |
| Workers | ECS, one service each for ingest, alarm, health sweep and scheduler, each with a standby in the other AZ (§4.6) | They replace the supervisor. |
| Migrations | A one-off ECS task per deploy, run before new tasks start: `alembic upgrade head`, then `cli seed` | `scripts/bootstrap_roles.sql` runs once, by hand. |
| Frontend | S3 + CloudFront | Built with `VITE_API_BASE` and `VITE_WS_BASE` (§5.3). |
| Report files | S3 | Needs §5.1. |
| Secrets | Secrets Manager | JWT secret and database passwords, injected as environment variables. |
| Logs | CloudWatch Logs | |
| Alarm email | SES through its SMTP endpoint | Notifications already send over SMTP (`SMTP_URL`). |

Workers, the database and Redis go in private subnets. Ingest reaches the broker over the private network inside AWS. To keep round trips short (§4.5), the active ingest worker should sit in the same AZ as the Redis primary where possible.

### 6.3 The MQTT broker (ours)

We commission the broker on AWS, and the client moves its dataloggers onto it. Configure it as follows:

- **A login per Client, limited to its own topics**, e.g. publish only under `SCMS/V1/KULAR_GREEN/#`. Topic levels are case-sensitive, so the rules must match the case the client actually uses. The broker then enforces Guardrail 5.
- **TLS on 8883**, with dataloggers connecting to a DNS name, never an IP.
- **A per-session queue of ~100,000 messages and a session expiry of at least an hour.** While ingest fails over to the other AZ, the broker must hold about a minute of messages (~6,000 at 100/s). EMQX holds 1,000 per session by default and then drops messages. This only protects data once §4.1 is fixed.

### 6.4 App changes before launch

The complete checklist. Work through it in the order given in §1.1, starting with the measurement harness (§1.1, step 0), which is not a change to the app but comes first.

**Defects (§4):**
1. Rewrite the queries that filter by Plant through a join (§4.9). The largest measured gain, and screens stop slowing as Plants are added.
2. Acknowledge after commit, and limit the incoming queue (§4.1).
3. Cut ingest's round trips (§4.5). On AWS, 50 Plants do not fit without this (measured, §10.3).
4. Make each worker safe to run twice, with an advisory-lock standby (§4.6).
5. Fix the health sweep query (§4.2).
6. Compress the aggregate tiers, and compress `readings` after 1 day (§4.3).
7. Compute today's figures incrementally once a minute, serve the Portfolio in one request, and slow the Plant screen's refetch (§4.4).
8. Key heartbeats by instance, and judge a periodic worker by whether it keeps to its interval (§4.7, §4.10).
9. Make the fleet-wide Data Issues summary and System Health figures set-based (§4.11).
10. Make the integration tests refuse a non-development database (§4.8).

**Deployment (§5):**

11. S3 store for report files (§5.1).
12. CORS limited to the app's domain, and the API on its own domain with the frontend built against it (§5.2, §5.3).
13. Forwarded client IPs behind the ALB (§5.4).
14. Container images and the migration task (§5.5, §6.2).
15. Connection pooling in transaction mode, with the statement caches disabled (§5.6).
16. TLS to Postgres and Redis on both connection paths (§5.7).
17. Several API workers per task (§5.8).
18. No fabricated fleet or `is_demo` Clients in production.

**Checks on the managed database before committing to it:**

19. `scripts/bootstrap_roles.sql` needs permission to create roles.
20. `SET LOCAL ROLE` needs the connecting user to be a member of the three runtime roles.
21. The migrations must replay cleanly on its TimescaleDB version, which is newer than 2.17.2. TimescaleDB has changed a default under this app once already, in migration 0023.

**After each change,** re-run `tools/scale/measure.py` with a new `--label` and compare its output with the baseline in §10.

### 6.5 Before go-live, in a staging environment of the same shape

- **Measure the real round trips** from ECS to ElastiCache and to the database, and Python speed on Fargate. Replace the assumptions in §2.1 and re-check §3.
- **Load-test at twice the launch size:** 100 Plants, ~2,500 Devices, ~200 messages/s, with **30 days of synthetic history** loaded first. The sweep defect only appears with accumulated history, and an empty database hides it.
- **Run failure drills:**
  - kill ingest mid-batch;
  - fail the database over to its replica;
  - fail Redis over;
  - stop one AZ's tasks.

  Each drill asserts zero readings lost and none duplicated.
- **Run a restore drill** from PITR, once, and write it down.

### 6.6 Soon after launch

- **Notifications from outside the app:** a CloudWatch synthetic check on `GET /health/processes` that emails or texts someone.
- **Process health exported** (queue depth, flush time, sweep duration, stream backlog), so a slow decline is seen before it becomes an outage.

### 6.7 Not needed at launch

Kafka or Redpanda, raw payloads in object storage, read replicas, Kubernetes, and splitting Clients across separate stacks. Revisit them at ~5,000 Devices.

Not a rewrite either: not into microservices, and not into another language or framework. Every limit measured in §2 is a matter of what the code asks the database to do. None is Python's or FastAPI's speed, and none is the database's write capacity, which has ~1,000× headroom (§2.5).

### 6.8 Still open

- **Database:** Timescale Cloud (recommended) or self-managed on EC2.
- **KULAR_GREEN's history:** carry it over from the other development machine's database (or `docs/solarcms.dump`), or start production fresh.

---

## 7. Growth path to 10,000 MW

### 7.1 Size (estimate)

| | Today (measured) | 10,000 MW |
|---|---|---|
| Devices | 61 | ~40,000 at 4 per MW; ~120,000 if mostly rooftop |
| Plants | 5 | ~1,000–5,000 |
| MQTT messages | 1.3/s | ~2,700/s or more |
| Readings stored | 33/s | ~21,000/s, ~1.8 billion/day |
| Disk as built | — | ~0.9 TB/day (readings ~330 GB, `agg_1m` ~290 GB, `mqtt_raw` ~310 GB) |

### 7.2 What to build

**Getting data in**
- Put a durable log (Redpanda or Kafka) between the broker and the database, partitioned by topic so a Device always lands on the same consumer. That gives:
  - several ingest and alarm consumers instead of one;
  - a backlog held on disk during a database outage instead of in memory;
  - exactly-once writes, by committing each consumer's position in the log in the same Postgres transaction as the COPY. Today a redelivery creates duplicate rows, because `readings` has no unique constraint.
- Keep per-topic state in each consumer's memory (partitioning makes it safe), and batch Redis writes per flush.
- Run EMQX as a cluster across AZs, with per-Client logins and topic rules (§6.3).

**Storage**
- Compressed `readings` after 1 day, and compressed aggregates (§4.3).
- Raw payloads in hourly compressed files in S3, still available for replay and `backfill-device`. Ingest maintains a small per-topic statistics table (last seen, message count, median interval) for discovery, Data Issues and the absence rules, which currently scan `mqtt_raw_v`.
- One large TimescaleDB primary on NVMe, a hot standby, PITR, and read replicas for reports and history.
- TimescaleDB's multi-node mode was removed in 2.14, so do not plan on it. Scale-out beyond one database is by Client (§7.3).

**Computing figures**
- Each Plant's KPIs computed once a minute into a snapshot with coverage attached (Guardrail 18), plus a daily rollup per Plant, so month, year and lifetime become sums of days plus today. The calendar-period, "undefined, never 0.0" and coverage rules carry over unchanged.
- The health sweep driven by each message rather than by a scan: last-heard times in a Redis sorted set, and only status changes written.
- The scheduler and sweep sharded by Plant across instances, with leases.

**API and screens**
- One paginated, sortable Portfolio endpoint that reads the snapshots.
- Each Plant's snapshot pushed over the socket once a minute. The figure still comes from the server, so provenance still travels with it.
- Server-side search and paging for Plant pickers and lists.

**Operations**
- A load harness at 40,000 Devices.
- Failure drills as in §6.5.

### 7.3 Stages (Device ranges are estimates)

1. **Launch, ~1,000–2,000 Devices (50 Plants):** §6.
2. **~10,000 Devices (~2.5 GW):** sharded workers (the incremental KPI computation split by Plant across instances), read replicas for reports, and the snapshot pushed over the socket.
3. **~40,000 Devices (10 GW):** the durable log, raw payloads in S3, the EMQX cluster, and failure drills at scale.
4. **Only if one database stops being enough:** separate stacks ("cells"), each holding a subset of Clients. `client_id` is already on every row, which makes the split possible.

---

## 8. Spec decisions these recommendations touch

Each needs a decision and, if changed, a MASTER §10 change-log row:

| Decision | Where | Why it comes up |
|---|---|---|
| Design ceiling: 300 MW and 150+ Devices | MASTER F-2 | 50 Plants is ~1,000–1,750 Devices. |
| `agg_1m` kept for 1 year | MASTER §5.3 (AGREED) | At launch size, compression alone is enough. At 10 GW, about 9 TB even if it compresses like `readings`; 90 days would be about 2 TB. |
| "Portfolio is computed, never stored" | MASTER §1.1 | The incremental per-Plant figures (§4.4, now part of the launch plan) are stored, even though the Portfolio stays a computed view over them. |
| `mqtt_raw` held in Postgres for 90 days | MASTER §5.3 | Moving raw payloads to S3 (§7.2) changes where the replay path reads from. |
| "MQTT is acknowledged only after commit" | CLAUDE.md | Not true of the code today (§4.1). Correct the statement or fix the code. |

---

## 9. Reproducing the measurements

**The load test (§10) is scripted:** §11 walks through running it on another machine, and [`solarcms-backend/tools/scale/README.md`](../solarcms-backend/tools/scale/README.md) has the commands, and every script refuses to run unless `DATABASE_URL` names the load-test database. The first measurements, below, were made by hand before the harness existed.

All against the Docker development stack, with the workers stopped:

- **Storage:** `hypertable_size()`, `hypertable_compression_stats()`, `timescaledb_information.continuous_aggregates` and `timescaledb_information.jobs`, plus row counts by day from `readings` and `mqtt_raw`.
- **Ingest throughput:**
  - construct `IngestWorker`, call `start()`, and feed `handle(topic, payload)` the latest real payload of each Inverter topic from `mqtt_raw`, 1,000–2,000 times per path;
  - for the unthrottled path, replace `live.read_throttle_state` with a function returning `{}`;
  - time COPY with `copy_records_to_table` inside a transaction that is rolled back;
  - flush Redis afterwards.
- **Round trips:**
  - wrap `redis.asyncio.client.Redis.execute_command` and `Pipeline.execute` to count Redis calls;
  - count and time SQL statements with SQLAlchemy's `before_cursor_execute` and `after_cursor_execute` hooks;
  - measure one round trip with 2,000 Redis `PING`s and 2,000 asyncpg `SELECT 1`s, and an empty `scoped_session` 500 times;
  - re-attach the hooks after anything that calls `dispose_engine()`.
- **Sweep:** `EXPLAIN (ANALYZE, TIMING OFF)` of the Device query in `sweep_once()`, as `SET LOCAL ROLE solarcms_scheduler` with `app.is_platform_admin = true`.
- **API:**
  - over HTTP: start uvicorn alone (`python -m uvicorn solarcms.api.main:app --port 8765`), log in as `admin@example.com`, take the median of 5 requests per endpoint, and fire 1, 5 and 20 sets of the four heaviest requests at once with `asyncio.gather`;
  - in-process, for the statement counts: `httpx.ASGITransport` around `create_app()`.

Re-run the same measurements in the staging environment on AWS (§6.5). Those figures, not this machine's, are the ones to size production from.

---

## 10. Load test at 50 Plants, 8 Oct 2026

Run with the harness in [`solarcms-backend/tools/scale/`](../solarcms-backend/tools/scale/README.md), on the development machine described at the top, against a database of its own (`solarcms_scale`, dropped afterwards). Every figure here was measured unless it says otherwise.

### 10.1 What was tested

**The fleet.** 10 Clients × 5 Plants, each shaped like KULAR_GREEN:

- seventeen Inverters in an MCR, plus MFM, ABT meter, Transformer, VCB, WMS and PPC;
- every Device publishing every 30 s;
- each Inverter's 28 PV strings on two topics of their own, as the client's broker has sent them since 6 Oct.

That is 2,850 topics and **95 messages/s**. Payloads are the fleet simulator's, so they use the client's own short keys.

**Onboarding through the real path.** `commission-from-broker` planned 1,150 Devices to register and 1,700 string topics to attach, with 0 blocked and 0 unmatched. Applied, it registered 1,200 Devices (with the Plant KPI Devices), 1,700 extra topics and 66,600 bindings.

**History.** 8 days for 3 of the Plants, each on a different clock (Bangkok, Los Angeles, Lagos), so "today" was 1.8 h, 12.2 h and 20.4 h long when measured. It was generated by running the simulator's messages through ingest's own `resolve` and `decode`, so the throttling and quality flags are ingest's. The result: ⚠ That first run's three foreign clocks were dropped on 9 Oct 2026: from now on every load-test Plant is in India (§11.2).

| What | Measured |
|---|---|
| Per Plant, 8 days | 15.2M readings and 887k raw messages |
| Per Plant per day | **~1.9M readings** (11.6 per message) |
| Database | 15 GB in total: `readings` 6.9 GB, `mqtt_raw` 1.5 GB, `agg_1m` 3.6 GB |
| Readings | 44.7M |

**Re-materialising** that history took **24 minutes for `agg_1m`** and **12 for `agg_15m`** (47 s and 1 s for the hourly and daily tiers). Production never re-materialises a week at once, but `backfill-device` after a late registration does the same work for the Device's quarantined days.

### 10.2 What each request and periodic task costs

Median of 2–3 runs, in-process, with nothing else running. "h" is how far into its own day the Plant was. LT05_P1 had only about an hour of data of its own.

| Request | LT01_P1, 1.8 h | LT01_P2, 12.2 h | LT01_P3, 20.4 h | LT05_P1, live only |
|---|---|---|---|---|
| `kpis?period=today` | 6.1 s | 56.3 s | 77.0 s | 0.08 s |
| `kpis?period=today&compare=true` | 53.0 s | 102.6 s | 160.9 s | 0.07 s |
| `kpis?period=month` | 11.8 s | 9.9 s | 10.4 s | 2.1 s |
| `kpis?period=lifetime` | 11.8 s | 4.9 s | 5.1 s | 0.03 s |
| `dashboard` | 0.3 s | 22.0 s | 34.6 s | 0.05 s |
| `operating-status` | 4.3 s | 6.1 s | 2.2 s | 0.04 s |
| `sld-stages` | 0.3 s | 14.7 s | 24.9 s | 0.04 s |
| `strings` | 0.08 s | 1.3 s | 1.6 s | 0.02 s |
| `forecast` (cached) | 0.005 s | 0.013 s | 0.014 s | 0.012 s |
| `data-issues` | 0.5 s | 0.7 s | 0.6 s | 0.3 s |
| Daily report, last 7 days | 3.3 s | 3.6 s | 3.8 s | 1.7 s |
| Inverter report, yesterday | 28.0 s | 47.3 s | 58.5 s | **30.4 s** |
| Custom report: 10 series, 7 days, 15 min | 0.08 s | 0.15 s | 0.11 s | 0.18 s |

| Fleet-wide request or worker task | Time | SQL statements |
|---|---|---|
| `GET /plants` | 0.012 s | 6 |
| `GET /data-issues/summary` | **13.6 s** | 607 |
| `GET /health/system` | **4.6 s** | 8 |
| `GET /discovery/clients` | 0.7 s | 8 |
| `GET /alarms?limit=100` | 0.010 s | 6 |
| One health sweep pass | **119.6 s** (first 127.7 s) | 2,646 |
| One scheduler KPI pass over all 50 Plants | 0.37 s | 154 |

**How to read it.** The cost of a Plant's request follows the **whole fleet's** rows since that Plant's midnight, not the Plant's own:

- the live-only Plant's day began at 18:30 UTC, when little of anything had been written, so it is fast;
- its inverter report for *yesterday* reads a full day of the three history Plants' rows, and takes 30 s.

That is §4.9. The requests that pass explicit Device ids are fast on every Plant: the custom report, the forecast and `strings` (whose ids are few). Expect the per-request costs to be higher still with all 50 Plants carrying history; this test gave history to 3.

### 10.3 Ingest with network delay

`tools/scale/ingest_bench.py` feeds the real 57-topic message mix to `IngestWorker.handle()`, flushing to the database as the worker does. `latency.sh` routes its Postgres and Redis connections through Toxiproxy.

**Calibrated first,** because the proxy's setting is not the round trip it produces:

| Path | Redis round trip | Postgres round trip |
|---|---|---|
| Direct | 0.157 ms | 0.142 ms |
| Through the proxy, no delay | 0.220 ms | 0.218 ms |
| Through the proxy, "+1 ms" | **2.048 ms** | **2.158 ms** |

| Delay | Throttled path | Unthrottled path (24.3 readings per message) |
|---|---|---|
| None (direct) | 3.25 ms per message → **307/s** | 4.43 ms → 226/s |
| "+1 ms" on both (≈2.1 ms round trips) | 32.4 ms → **31/s** | 36.3 ms → 28/s |
| "+2 ms" Postgres, "+1 ms" Redis | 41.0 ms → 24/s | 45.0 ms → 22/s |
| "+1 ms" on Postgres only | 22.2 ms → 45/s | 22.9 ms → 44/s |
| "+1 ms" on Redis only | 19.3 ms → 52/s | 25.0 ms → 40/s |

From the combined run, a message costs about 3.3 ms plus **~15 round trips**. Assuming the time grows in step with the round-trip time, which these measurements support, that gives ~60 messages/s at 1 ms round trips (typical cross-AZ) and ~180/s at 0.3 ms (same AZ). These two are interpolated. 50 Plants publish 95/s.

### 10.4 The live stack at 95 messages/s

All five processes ran under the supervisor for 10 minutes, with all 50 Plants publishing (`--daylight`), sampled every 15 s by `monitor.py`:

| Process | Kept up? | Measured |
|---|---|---|
| Ingest | **Yes** | Handled 95.1 messages/s against 95.0 published; resident memory steady at 37–79 MB, so nothing was queuing inside it; ~45% of one core. |
| Alarm worker | **Yes** | Stream backlog mostly 0, peaks of 2,504. It began with 87,130 entries left over from the benchmark and drained them in ~45 s. |
| Scheduler | **Yes** | Cycles 60.7–61.7 s apart: each pass takes under 2 s. |
| Health sweep | **No** | Cycles 166–168 s apart: **~107 s per pass** against a 60 s interval. Postgres alternated between ~60–69% CPU while it ran and ~1–5% between passes. |
| API | — | Not under user load in this run (§10.5). |

No process logged an error. **System Health reported every process, including the overrunning sweep, as `working`** (§4.10).

### 10.5 What this test did not cover

- **History on 3 Plants, not 50, and 8 days, not 30.** Per-request costs read the whole fleet's rows (§4.9) and the sweep reads every Device's retention (§4.2), so both would be higher with full history everywhere. These results understate the problem; they do not overstate it.
- **People on screens.** `tools/scale/viewers.py` exists but was not run: with single requests taking 6–160 s, it could only show requests queuing. Run it after §4.9.
- **AWS itself:** Fargate's CPU speed, the managed database's speed, real network latency. §10.3 emulates the network only.
- **Failure behaviour:** killing ingest mid-batch, database or Redis failover, losing an AZ. Message loss from §4.1 was found by reading the code, not by test.
- **Alarm raising under load.** No faults were injected, so the alarm worker evaluated readings but raised almost nothing; the absence Alarms came from the health sweep.

### 10.6 Verdict

**At 50 Plants, as built,** three things fail:

- the screens (tens of seconds per request, worse with each Plant and each hour);
- the health sweep (it can't finish within its interval);
- on AWS's network, ingest (31–60 messages/s against 95).

**What holds:** the database's write path, the alarm worker, the scheduler and, on a fast network, ingest; commissioning registered 1,150 Devices in one run with nothing blocked.

**Every failure traced to a specific query or loop, not to the architecture.** The one fix tested directly, passing ids into the view, took the worst query from 31 s to 0.04 s.

Re-run §10.2 and §10.4 after each fix in §1.1. The fixes are proven when today's KPIs stay flat from 1.8 h to 20.4 h, the sweep's cycles sit near 60 s, and ingest holds 95/s through `latency.sh`.

---

## 11. Running the load test on your own machine

For a developer running the §10 test on their own machine, against their own version of the code. It needs nothing beyond this document and `solarcms-backend/tools/scale/`.

### 11.1 What the test does, and what it found

It builds a **separate** test database holding 50 Plants shaped like KULAR_GREEN, **all in India** (`Asia/Kolkata`): 10 Clients, 1,200 Devices, each Inverter's PV strings on their own topics, as the client's broker sends them. It publishes to the local broker at the rate those Plants would, 95 messages/s. It gives three of the Plants 8 days of history, then:

- times every screen request and background job;
- runs the whole stack live for 10 minutes;
- re-measures ingest with network delay added, to imitate AWS.

On the first machine (§10), the database writes, the alarm worker and the scheduler kept up, and three things did not:

| What | Measured |
|---|---|
| Today's KPIs | 6 s at 1.8 h into the Plant's day, 56 s at 12.2 h, 77 s at 20.4 h |
| Dashboard | up to 35 s |
| Inverter report for yesterday | 30–58 s |
| Health sweep | 107–120 s per pass, against a 60 s interval |
| Ingest with AWS-like latency | 31 messages/s at ~2 ms round trips, against the 95/s needed |

**The main cause, in plain terms.** When a screen asks for one Plant's data, the query effectively says "give me every Device's 1-minute data since midnight, *then* keep this Plant's". The protective views that keep each Client's data separate stop the database from applying "this Plant" early. So it reads every Plant's rows and throws most away, and the request slows with every Plant added and every hour of the day (§4.9).

**The fix, which is not done yet, is "the query rewrite".** Look up the Plant's Device ids first, which is an instant lookup, then ask for exactly those:

```sql
-- now
FROM agg_1m_v a JOIN devices d ON d.id = a.device_id
WHERE d.plant_id = 2 AND a.bucket >= '…midnight…'

-- rewritten
FROM agg_1m_v a
WHERE a.device_id = ANY(:this_plants_device_ids)
  AND a.tag_id    = ANY(:the_tags_needed)
  AND a.bucket   >= '…midnight…'
```

An index on Device id already exists, so the database then reads only the rows it needs. Tried by hand on the test data, the worst query went from **31 s to 0.04 s**. The rewrite changes how data is fetched, not any calculation, so every figure stays the same.

**Why run it on your machine:**
- it shows whether your changes affect any of these numbers;
- it gives a second set of figures from different hardware;
- it is the same harness that will prove the rewrite works, once it is made.

### 11.2 Before you start

- ⚠ **Every test Plant is in India, on `Asia/Kolkata`, and must stay there**, as the client's Plants are. It is set once, in `tools/scale/fleet.py` (`TIMEZONE`). Do not give any Plant another clock: a Plant abroad starts its day at another hour, so its "today" figures cannot be compared with an Indian Plant's, or with another run's.
- **Get the files.** `solarcms-backend/tools/scale/` and this document must be on your branch. Pull them before anything else.
- **Docker Desktop running**, with the backend's Python 3.12 environment installed as the backend README describes (`python3.12 -m venv .venv`, then `.venv/bin/pip install -e ".[dev]"`).
- **About 25 GB of free disk and about 2 hours** with the machine awake. Keep the lid open: closing it stops Docker and the test with it. `caffeinate` (step 2) stops idle sleep, not lid-close sleep.
- **Ports:** the test uses the Docker services from `solarcms-backend/docker-compose.yml`:
  - Postgres on **5433**, in a container named `solarcms-postgres`;
  - Redis on **6379**;
  - EMQX on **1883**.

  If a native Redis or MQTT broker already holds one of those ports, stop it first. A native Postgres on 5432 is fine; nothing here uses it.
- **Stop your own SolarCMS processes and any simulator**: from the repo root, `scripts/dev-down.sh`, then `pgrep -fl solarcms`, which should print nothing. The live run starts its own set under the supervisor, and the supervisor refuses to start while any SolarCMS process is running.
- **What the test touches, and what it doesn't:**

  | The test uses | Untouched |
  |---|---|
  | Its own database, `solarcms_scale`, in the Docker Postgres | Your development database |
  | Redis database **1** | Your Redis keys (database 0) |
  | MQTT topics under `loadtest/v1`, with its own broker session | Your ingest's broker session |

  Every script that writes refuses to run unless `DATABASE_URL` names `solarcms_scale`.
- **Use a separate terminal for the test.** `source tools/scale/env.sh` sets that terminal's `DATABASE_URL`, Redis and broker settings to the test's. Do your normal work in another terminal, or open a fresh one afterwards.
- **zsh:** paste the commands one line at a time, exactly as written. zsh does not treat `#` as a comment, so none of the commands carry one.

### 11.3 Steps

All from `solarcms-backend/`, in the terminal you sourced `env.sh` in. Times are from the first machine (Apple M2, Docker Desktop with 8 CPUs and 8 GB).

**Step 1: the Docker services, and the database roles** (once; both commands are safe to repeat):

```
cd solarcms-backend
docker compose up -d
docker exec -i solarcms-postgres psql -U solarcms -d postgres < scripts/bootstrap_roles.sql
```

**Step 2: this terminal's environment** (again in every new terminal you use for the test):

```
source tools/scale/env.sh
export SCALE_RUN_DIR="$HOME/solarcms-scale-run"
caffeinate -dims &
```

`SCALE_RUN_DIR` is where every log and result goes. The `caffeinate` line is macOS only; skip it elsewhere.

**Step 3: create the test database** (~2 minutes):

```
.venv/bin/python tools/scale/setup.py
.venv/bin/python -m solarcms.cli create-superadmin --email admin@loadtest.example.com --password admin12345
```

Check: the setup ends with `seeded 10 Clients and 50 Plants`. If it says the database already exists, a previous run was not cleaned up: run `.venv/bin/python tools/scale/setup.py --drop` and start this step again.

**Step 4: register the Devices through commissioning** (~5 minutes). Commissioning listens to the broker, so the publisher runs while it does:

```
.venv/bin/python tools/scale/publish.py --minutes 6 > "$SCALE_RUN_DIR/publish-commission.log" 2>&1 &
sleep 35
.venv/bin/python -m solarcms.cli commission-from-broker --topic 'loadtest/v1/#' --seconds 75 > "$SCALE_RUN_DIR/commission-dry.log" 2>&1
tail -3 "$SCALE_RUN_DIR/commission-dry.log"
```

Check the dry run's summary. It should read `2850 topics: 1150 to register, 1700 to attach to their Device, 0 already registered, 0 blocked; 0 unmatched by any pattern`. If it does, apply it straight away, while the publisher is still running:

```
.venv/bin/python -m solarcms.cli commission-from-broker --topic 'loadtest/v1/#' --seconds 75 --apply > "$SCALE_RUN_DIR/commission-apply.log" 2>&1
docker exec solarcms-postgres psql -U solarcms -d solarcms_scale -At -c "select count(*) from devices"
```

Check: `1200`. The apply log ends with a long list of Inverters "with no string count". That is expected and harmless here.

**Step 5: generate the history** (~5–10 minutes), **then finish it** (~40 minutes):

```
.venv/bin/python tools/scale/history.py --plant LT01_P1 --days 8 > "$SCALE_RUN_DIR/history-LT01_P1.log" 2>&1 &
.venv/bin/python tools/scale/history.py --plant LT01_P2 --days 8 > "$SCALE_RUN_DIR/history-LT01_P2.log" 2>&1 &
.venv/bin/python tools/scale/history.py --plant LT01_P3 --days 8 > "$SCALE_RUN_DIR/history-LT01_P3.log" 2>&1 &
wait
tail -n 1 "$SCALE_RUN_DIR"/history-*.log
.venv/bin/python tools/scale/finish_history.py
```

Check: each history log's last line shows about 1.31 million messages and 15.2 million readings. `finish_history.py` prints each aggregate refresh as it completes. The 1-minute one took 24 minutes on the first machine and the 15-minute one 12, and that is normal. If you look in Postgres meanwhile, a "Refresh Continuous Aggregate Policy … waiting" process is also normal: it is the built-in background refresh, queued behind this one.

**Step 6: close the gap the finishing step left** (a few minutes). History stops when step 5's generation ended, and the finishing step takes ~40 minutes after that. Fill each Plant up to now, then refresh the new part:

```
.venv/bin/python tools/scale/history.py --plant LT01_P1 --resume
.venv/bin/python tools/scale/history.py --plant LT01_P2 --resume
.venv/bin/python tools/scale/history.py --plant LT01_P3 --resume
.venv/bin/python tools/scale/finish_history.py
```

**Step 7: measure every request and background job** (45–60 minutes with the current code):

```
.venv/bin/python -W ignore tools/scale/measure.py --repeat 2 --label yourname-baseline > "$SCALE_RUN_DIR/measure.txt" 2>&1
grep -E "^(LT|fleet|worker)" "$SCALE_RUN_DIR/measure.txt"
```

Each line gives the median time, the time of the first (cold) run, the number of SQL statements, their summed time and the HTTP status. Compare the median, and **treat any status other than 200 as a failed request, not a fast one**.

All three history Plants are on Indian time, so all three are at the same hour of their day: the `h` column, hours since midnight IST. Today's figures cost more as the day goes on (§4.9), so **the hour you measure at decides the result**:

- **For the worst case, measure in the evening IST**, when "today" is longest. Generation is not needed: the cost follows the number of rows, which flow at night too.
- **To see the growth through the day, run steps 6 and 7 again later**, with a new `--label` each time: for example morning, afternoon and late evening IST. Re-running needs no new history, only step 6 to fill up to the present.
- **Write down the IST time of each run** with its results.

While the health sweep runs, `measure.txt` fills with "absence alarm opened" warnings. That is expected: nothing is publishing during this step, so the sweep finds every Plant silent.

**Step 8: ingest with network delay** (~5 minutes; downloads the Toxiproxy image the first time):

```
.venv/bin/python -W ignore tools/scale/ingest_bench.py
tools/scale/latency.sh 1
tools/scale/latency.sh 1 0
tools/scale/latency.sh 0 1
```

The arguments are the delay, in milliseconds, added to Postgres and then to Redis. Each run first prints the **round trip it actually measured**, direct and through the proxy. The proxy's setting is not the delay it produces: "+1" measured about 2 ms on the first machine. Report the results against those printed round-trip figures.

**Step 9: the live run** (~12 minutes):

```
.venv/bin/python -m solarcms.supervisor --log-dir "$SCALE_RUN_DIR/logs" > "$SCALE_RUN_DIR/supervisor.out" 2>&1 &
sleep 15
curl -s localhost:8000/healthz
.venv/bin/python tools/scale/publish.py --daylight --minutes 11 > "$SCALE_RUN_DIR/publish-live.log" 2>&1 &
.venv/bin/python -W ignore tools/scale/monitor.py --minutes 10 --publish-log "$SCALE_RUN_DIR/publish-live.log" | tee "$SCALE_RUN_DIR/monitor-live.txt"
pkill -TERM -f solarcms.supervisor
```

`curl` should print `{"status":"ok"}` before you go on. The API runs on port 8000, where the Vite dev server would also look, so leave your own API stopped. How to read the monitor's lines:

| Monitor field | Kept up if… |
|---|---|
| `handled` | Averages the `published` rate (95/s) over the run. It alternates between about 64 and 126 per sample because of when ingest reports, so read the average. |
| Ingest memory | Stays level. Climbing memory means messages are queuing inside ingest. |
| `backlog` | Stays near 0 (the alarm worker). |
| `gaps`, scheduler | Near 61 s. |
| `gaps`, health_sweeper | Each worker sleeps 60 s after its work, so the gap minus 60 is one pass. The first machine's sweep gap was 166–168 s: ~107 s per pass. |

**Step 10: clean up**, then go back to normal work in a fresh terminal:

```
.venv/bin/python tools/scale/setup.py --drop
docker exec solarcms-redis redis-cli -n 1 flushdb
docker rmi ghcr.io/shopify/toxiproxy:2.9.0
pkill caffeinate
```

Check `pgrep -fl solarcms` prints nothing before restarting your own stack (`scripts/dev-up.sh` from the repo root). Docker Desktop returns the freed disk space to macOS gradually, not immediately.

### 11.4 Comparing with §10

Absolute times depend on the machine: CPU, disk, and above all how much memory Docker has (`docker info` shows its CPUs and memory). What should match is the **shape**:

| Figure | First machine | Same shape if… |
|---|---|---|
| Today's KPIs | 6.1 s, 56.3 s, 77.0 s at 1.8, 12.2, 20.4 h into the day | Compare with our figure at the hour nearest yours. Across runs at different IST hours, it grows with the hour. |
| Dashboard; single-line diagram stages | 0.3 → 34.6 s; 0.3 → 24.9 s | Both grow with the hour. |
| Inverter report, yesterday | 28–58 s, including the live-only Plant | Slow on every Plant. |
| Custom report: 10 series, 7 days | 0.08–0.18 s | Fast on every Plant. This is the control: it already passes Device ids. |
| One health sweep pass | 119.6 s | Over 60 s. |
| One scheduler KPI pass | 0.37 s | Well under 60 s. |
| Ingest, no added delay | 307 messages/s | Hundreds per second. |
| Ingest, ~2 ms round trips | 31 messages/s | Under 95. |
| Live run | handled 95.1/s against 95.0 published; sweep gap ~167 s | Ingest keeps up; the sweep doesn't. |

If one of your figures is far better than ours, check whether your changes touched that query or job. That would be worth knowing. Then check the status column, since a failed request can look fast.

### 11.5 What to send back

- From `$SCALE_RUN_DIR`: `measure.txt`, every `measure-*.json`, `monitor-live.txt`, every `monitor-*.jsonl`, and the step 8 output (copy it from the terminal);
- the machine (model, CPU, memory) and `docker info`'s CPUs and total memory;
- `git log -1 --oneline` of the code you tested, and a line on what your changes touch.

### 11.6 Known quirks

| Symptom | What it means |
|---|---|
| `Exception ignored … RuntimeError: Event loop is closed` at the end of a script | The Redis client tidying up after the script finished. Harmless. |
| A request takes minutes | Expected with the current code (§10.2). `measure.py` logs in again by itself when a slow run outlives the 15-minute session token. |
| The first time of each request is much slower than the median | A cold cache. Compare medians. |
| `docker compose up -d` fails on a port | A native service holds 5433, 6379 or 1883. Stop it, or stop it for the test. |
| The supervisor says SolarCMS processes are already running | Something from your own stack is still up. `scripts/dev-down.sh` from the repo root, then `pgrep -fl solarcms`. |

---

## 12. Results after the fixes (Tushar branch, 9 Oct 2026)

*Added by the Tushar branch; §1–§11 above are the original findings, kept as written.* Every code item of §6.4 (1–18) is built — see CLAUDE.md "Scale" and MASTER v4.1. Measured with this harness on the client-broker machine (Apple Silicon, Docker Desktop 10 CPUs / 7.75 GB) against the same 50-Plant fleet, **all Plants on Asia/Kolkata** (the harness now refuses any other clock), with the history Plants ~19 h into their day. "Before" is the code at `c569bf1`, "after" at `3104020`+. Both ran beside the live development stack.

| What | Before | After, computed (scheduler stopped) | After, served (scheduler running) |
|---|---|---|---|
| Today's KPIs | 3.9–4.3 s | 0.5 s | **4 ms** |
| Today's KPIs with comparison | 7.2 s | 0.6 s | **4 ms** |
| Dashboard | 2.0–2.1 s | 33 ms | **5 ms** |
| SLD stages | 2.0 s | 25 ms | **4 ms** |
| Report, daily, last 7 days | 2.5 s | 0.47 s | 0.21 s |
| Report, Inverter, yesterday | 3.2–3.3 s | 0.18 s | 0.05–0.08 s |
| Data Issues summary (fleet) | 7.6 s, 607 statements | 1.4 s cold | **6 ms** (cached) |
| System Health processes | 3 ms | 0.5 s (a SCAN; fixed) | 1 ms after the fix |
| Health sweep, one pass | **74 s** against a 60 s interval | **1.6 s** | — |
| Scheduler snapshot pass, 50 Plants | — | 3.1 s with all four KPI periods; 0.5–0.6 s dashboards only | (budget: 60 s / 15 s) |

Ingest, `ingest_bench.py` and `latency.sh 1` (measured round trips ~2 ms on both):

| | Before | After |
|---|---|---|
| Direct, throttled / unthrottled | 442 / 344 messages/s | **7,157 / 1,239** messages/s |
| ~2 ms round trips, throttled / unthrottled | **32 / 30** messages/s | **932 / 322** messages/s |

50 Plants publish 95 messages/s.

Live run (`publish.py --daylight`, all five processes, 10 minutes):

| | Before | After |
|---|---|---|
| Health sweep cycle | **~171 s** (falling behind) | **60 s** |
| Scheduler cycle | ~61 s | 60 s |
| Alarm backlog | 0–222 | 0 |
| Postgres CPU | 3–78%, mostly 45–78% | 1–10% |
| Ingest memory | 24–50 MB | 90–181 MB (per-Device state held in memory, §4.5) |

What is **not** shown by this: AWS itself (§10.5 — Fargate CPU, the managed database, real cross-AZ latency), failure drills (§6.5), and anything past ~1,200 Devices (§7). Data Issues for one Plant (~0.3–0.9 s) and operating status (~0.1–0.7 s) were not rewritten beyond passing ids and remain the slowest per-Plant requests. ⚠ The original `finish_history.py` refreshes eight days per tier in one call; on a 7.75 GB Docker VM shared with a live stack the kernel killed Postgres backends twice — refresh in slices (6 h for `agg_1m`), which also took 4.5 minutes instead of ~40.
