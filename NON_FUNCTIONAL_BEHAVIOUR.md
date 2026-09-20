# SolarCMS — Timings, Limits and Behaviour Under Load

**Status of this document:** written on 20 September 2026 by reading the source code and
the running system. Every number below was copied from the code, not remembered. Where a
number is an assumption waiting on the customer, it says so.

This document is about *how the system behaves*, not *what it does*. It covers throttling,
batching, buffering, caching, polling, refresh rates, message delivery guarantees, rollups,
compression, retention, connection pools, timeouts, backoff, restart behaviour, and every
interval and limit in the system.

It is self-contained. You do not need to open any other file.

---

## Table of contents

1. [How to read this document](#1-how-to-read-this-document)
2. [Every number in the system, in one table](#2-every-number-in-the-system-in-one-table)
3. [The end-to-end timing picture](#3-the-end-to-end-timing-picture)
4. [Throttling: why not every published value is stored](#4-throttling-why-not-every-published-value-is-stored)
5. [Batching and flushing: how readings reach the database](#5-batching-and-flushing-how-readings-reach-the-database)
6. [Message delivery: what happens when something crashes](#6-message-delivery-what-happens-when-something-crashes)
7. [The in-memory store: every key, every lifetime](#7-the-in-memory-store-every-key-every-lifetime)
8. [The alarm stream](#8-the-alarm-stream)
9. [Live sockets](#9-live-sockets)
10. [Browser polling and refresh rates](#10-browser-polling-and-refresh-rates)
11. [Rollups: how summaries are built and how fresh they are](#11-rollups-how-summaries-are-built-and-how-fresh-they-are)
12. [Chunking, compression and retention](#12-chunking-compression-and-retention)
13. [Reading history: which level answers, and the size caps](#13-reading-history-which-level-answers-and-the-size-caps)
14. [The health sweep](#14-the-health-sweep)
15. [Alarm timing: debounce, hysteresis, detection delay, escalation](#15-alarm-timing-debounce-hysteresis-detection-delay-escalation)
16. [The scheduler and the day boundary](#16-the-scheduler-and-the-day-boundary)
17. [Connection pools and concurrency](#17-connection-pools-and-concurrency)
18. [Login tokens and permission checks](#18-login-tokens-and-permission-checks)
19. [Every cache in the system, side by side](#19-every-cache-in-the-system-side-by-side)
20. [Pagination and payload limits](#20-pagination-and-payload-limits)
21. [Failure and restart behaviour, process by process](#21-failure-and-restart-behaviour-process-by-process)
22. [Traps worth knowing about](#22-traps-worth-knowing-about)
23. [What is not built yet on the non-functional side](#23-what-is-not-built-yet-on-the-non-functional-side)

---

## 1. How to read this document

Three ideas run through everything below, and they explain most of the choices.

**"Heard" and "stored" are different facts.** A message can arrive and correctly result in
nothing being written. The system records both separately, because confusing them makes a
healthy device look dead.

**Nothing durable lives in the in-memory store.** Everything kept in Redis is either a
current value that the next message replaces, a cache with an expiry, or a queue that can
be replayed. A complete flush of Redis costs at most one heartbeat cycle — no history, no
configuration and no alarm state is lost permanently.

**Every interval is written down in exactly one place.** All the assumed timings live in a
single file, `domain/assumptions.py`. Changing one is a single-file edit followed by a
re-seed, never a search across the project.

---

## 2. Every number in the system, in one table

### Ingestion and storage

| Setting | Value | Where it is set |
|---|---|---|
| Batch flush size | 5,000 rows | `INGEST_BATCH_MAX_ROWS` setting |
| Batch flush time | 2.0 seconds | `INGEST_BATCH_MAX_SECONDS` setting |
| Message delivery quality | Level 1 — at least once | Ingest worker subscribe call |
| Broker session | Persistent, fixed client identifier | Ingest worker |
| Broker reconnect wait | 5 seconds | Ingest worker main loop |
| Sequence counter wrap | 1,000,000 | Ingest worker |

### Throttling — the minimum gap between two stored values of the same measurement

| Measurement category | Minimum gap | Note |
|---|---|---|
| Performance | 60 seconds | Assumed |
| Electrical | 60 seconds | Assumed |
| Environmental | 60 seconds | Assumed |
| Diagnostic | 300 seconds (5 minutes) | Assumed |
| **Status (on/off contacts)** | **0 seconds — never throttled** | Enforced by a database constraint |
| Any running counter | 300 seconds (5 minutes) | Safe: a counter loses nothing by sampling |
| Default publishing interval for a new device | 60 seconds | Registration default only; the real value is per device |

### Health detection

| Setting | Value |
|---|---|
| Health sweep interval | 60 seconds |
| "Degraded" threshold | 2 × that device's expected interval |
| "Offline" threshold | 10 × that device's expected interval |
| Frozen-value threshold | 60 identical readings in a row |
| Stale-timestamp threshold (quality flag) | 2 × expected interval |

### Alarms

| Setting | Value |
|---|---|
| Stream read block time | 2,000 milliseconds |
| Stream read batch size | 200 entries |
| Stream maximum length | 100,000 entries (approximate trim) |
| Debounce on a protection trip contact | 0 seconds |
| Debounce on a health contact | 30–300 seconds depending on the rule |
| Debounce on grid voltage limits | 60 seconds |
| Debounce on frequency excursion | 30 seconds |
| Debounce on inverter direct-current over-voltage | 30 seconds |
| Debounce on inverter over-temperature | 300 seconds |
| Debounce on underperformance | 900 seconds (15 minutes) |
| Debounce on zero generation in daylight | 600 seconds (10 minutes) |
| Debounce on communication lost | 300 seconds |
| Escalation delays | 0, 10 and 20 minutes for levels 1, 2 and 3 |
| Minimum severity that escalates at all | "high" |

### Rollups and retention

| Level | Bucket | Refresh every | Leaves alone | Looks back | Kept for |
|---|---|---|---|---|---|
| Raw readings | — | — | — | — | 30 days |
| One-minute | 1 minute | 1 minute | last 1 minute | 2 hours | 1 year |
| Fifteen-minute | 15 minutes | 15 minutes | last 15 minutes | 1 day | 3 years |
| One-hour | 1 hour | 1 hour | last 1 hour | 7 days | 10 years |
| One-day | 1 day | 1 hour | last 1 hour | 30 days | 10 years |
| Raw message store | — | — | — | — | 90 days |

| Setting | Value |
|---|---|
| Chunk size (how the time-series table is split) | 1 day |
| Compress readings older than | 7 days |
| Compress raw messages older than | 7 days |
| Real-time aggregation | On, for every level |
| Stalled-rollup alarm threshold | 2 hours since last successful refresh |

### The browser

| Screen or query | Refresh | Considered fresh for |
|---|---|---|
| Plant dashboard values, socket open | 30 seconds | 30 seconds |
| Plant dashboard values, no socket | 5 seconds | 5 seconds |
| Plant performance figures, no socket | 10 seconds | 10 seconds |
| Alarms list | 30 seconds | 15 seconds |
| Device health | 30 seconds | 20 seconds |
| System health | 30 seconds | — |
| Report run progress | 2 seconds until finished | — |
| Plant list and most configuration | on demand | 60 seconds |
| Readings and history | on demand | 5 seconds |
| Catalogue (tags, models, types) | never | forever, for the session |
| Wiring editor re-read | 10 seconds | — |
| Live frame coalescing window | 1 second | — |
| Age counters on screen re-render | every 1 second | — |

| Socket setting | Value |
|---|---|
| First reconnect attempt | about 1 second |
| Maximum reconnect wait | 30 seconds |
| Backoff shape | Doubling, with random jitter between half and full |

### Connections, tokens and limits

| Setting | Value |
|---|---|
| Web service database pool | 10 connections |
| Ingest bulk-write pool | 1 to 4 connections |
| Access token lifetime | 900 seconds (15 minutes) |
| Refresh token lifetime | 604,800 seconds (7 days) |
| Report download link lifetime | 24 hours |
| Maximum points returned by a history query | 20,000 |
| Plant list page size | 50 by default, 200 maximum |
| Broker discovery look-back window | 7 days |
| Failed request retry policy | No retry below status 500; up to 2 retries otherwise |

---

## 3. The end-to-end timing picture

This is how long it takes for something happening at the plant to appear on a screen,
with each delay named. The example uses the customer's real publishing rate of roughly
2.8 seconds and the default 60-second throttle.

```
  t+0.0s   Equipment publishes a message to the broker

  t+~0s    Ingest receives it
           ├─ Redis "heard from" marker written immediately       ← health sees it now
           ├─ Throttle check: was this measurement stored recently?
           │     if yes → nothing more is stored for that measurement
           │     if no  → continue
           ├─ Redis current value written                         ← dashboards read this
           ├─ Live socket frame published                         ← browser sees it now
           └─ Row added to the write buffer

  t+0 to   Buffer flushes: whichever comes first,
  t+2.0s   5,000 rows or 2 seconds
           ├─ Readings and raw messages committed in ONE transaction
           ├─ Broker is acknowledged only AFTER that commit
           └─ Only then is the alarm stream written

  t+~2.0s  Alarm worker picks the entry off the stream
           └─ opens an alarm only after the rule's debounce has elapsed

  t+~3.0s  Browser: socket frame arrived at t+~0s, coalesced for 1 second,
           then the plant's dashboard and figures are refetched from the server
```

**Three separate freshness paths, deliberately:**

| Path | How fresh | Why it exists |
|---|---|---|
| Redis current value → dashboard | Sub-second | This is what makes a screen feel live |
| Committed row → history and charts | Up to 2 seconds | Durability requires a commit |
| Committed row → alarm evaluation | 2 seconds plus the rule's debounce | Alarms must never fire on uncommitted data |

**The alarm detection delay has a formula**, and it is worth stating plainly:

```
detection delay  =  the measurement's throttle interval  +  the rule's debounce
```

So a measurement throttled to 60 seconds with a 60-second debounce opens an alarm **120
seconds** after the condition actually began. This is measured, not estimated. It is the
direct cost of throttling happening *before* the alarm stream is written. Status contacts
are never throttled, which is why a protection trip is not subject to the first term.

---

## 4. Throttling: why not every published value is stored

The customer's equipment publishes roughly every 2.8 seconds. Storing every value of every
measurement at that rate would be twenty times more data than anyone needs for an
electrical trend, so each measurement carries a **minimum interval** — the shortest gap
allowed between two stored values of that measurement on that device.

### How it works, exactly

For each incoming message, the worker reads the last-write time of every measurement on
that device **in one bulk read**, not one read per measurement. This matters: a device
publishing seventeen signals every 2.8 seconds would otherwise cost seventeen round trips
per message, forever.

Then, for each key in the payload:

1. Look up the binding. If nothing is bound to that key, the key is recorded as
   **unmapped** and the value is discarded.
2. **Check the throttle first, before any other work.** If this measurement's minimum
   interval is greater than zero and less than that interval has passed since it was last
   stored, the key is dropped and counted as throttled.
3. Otherwise decode it, scale it, judge its quality, and keep it.

Throttle state is kept in Redis with a lifetime of 600 seconds — deliberately a little
longer than the longest throttle window in use, so that an expired key simply means
"write it", which is the safe answer.

### The categories, and why status contacts are exempt

| Category | Gap | Reasoning |
|---|---|---|
| Performance, electrical, environmental | 60 seconds | A smooth periodic measurement loses only resolution when sampled |
| Diagnostic | 300 seconds | Changes slowly; five-minute resolution is ample |
| Running counters | 300 seconds | A counter is monotonic — sampling it loses nothing at all, because the value is still the total |
| **Status contacts** | **0 — never throttled** | A 60-second window would silently discard a protection contact that opened and re-closed inside it |

The status exemption is not a convention that could be edited by accident. It is enforced
by a check constraint in the database: a status measurement with a non-zero minimum
interval cannot be stored.

### The trap this created, and the fix

Throttling once erased the liveness signal entirely. The accept path returned early —
before recording anything — whenever every measurement in a message was inside its throttle
window. So a device whose measurements were all throttled to 300 seconds was invisible for
57 of every 60 seconds, and the health sweep flipped it between online and offline every
single minute.

The fix separates the two facts. Ingest now writes a "heard from" marker into Redis on
**every accepted message**, before the throttle decides anything, and the health sweep
takes the later of that marker and the newest stored reading.

**The rule that came out of it: never work out whether a device is alive from the readings
table alone.**

### Computed measurements obey the same throttle

Values the platform calculates rather than receives are throttled by their own minimum
interval, exactly as received ones are. Without that, a device publishing every 2.8 seconds
would produce a calculated row per formula per message — the throttle on the inputs would
be quietly undone by the outputs.

---

## 5. Batching and flushing: how readings reach the database

Readings are **never** inserted one row at a time. They are buffered and written with a
bulk copy operation, which is roughly a hundred times faster than individual inserts.

### The buffer

The buffer holds three things: the reading rows, the raw message rows, and the entries
destined for the alarm stream.

**It flushes when either of two conditions is met:**

- 5,000 reading rows have accumulated, or
- 2.0 seconds have passed since the buffer was opened, and it is not empty.

The size check happens after every message is handled, and a separate timer loop wakes on
the same 2-second period so that a slow trickle of messages is never held indefinitely.

### Why 2 seconds and not 2 minutes

Because the broker is only acknowledged **after** the database transaction commits. A
larger window would mean more unacknowledged messages in flight, and therefore a bigger
replay after a crash. Two seconds is the balance between write efficiency and replay size.

### Readings and raw messages commit together

Both bulk copies happen inside **one transaction**. This is deliberate: the stored raw
messages are the only route back to correct history if a scale factor is later found to be
wrong. A reading that exists without its raw payload could never be repaired.

### The alarm stream is written after the commit, never before

```
    copy readings  ─┐
                    ├─ one transaction ─→ commit ─→ write to alarm stream
    copy raw       ─┘
```

The alarm worker must never see a reading that a rolled-back transaction means never
happened. An alarm raised from data that does not exist cannot be explained to anybody.

### On shutdown

Both interrupt and terminate signals set a stopping flag rather than killing the process.
The buffer is flushed before exit. Discarding it would not lose data — those messages were
never acknowledged, so the broker would resend them — but it would cost a needless replay.

---

## 6. Message delivery: what happens when something crashes

### The subscription

The ingest worker subscribes at **quality of service level 1**, which means each message is
delivered *at least once*. It uses a **persistent session with a fixed client identifier**,
so when the worker restarts, the broker replays whatever it held while the worker was away.

### The acknowledgement rule

**Acknowledge only after commit.** A crash therefore causes redelivery, never loss. The
system is designed to tolerate seeing the same message twice rather than to risk seeing it
zero times.

### Broker disconnection

A lost broker connection is treated as an expected condition, not a fault. The worker logs
a warning, waits 5 seconds, and reconnects. It does not exit.

### The failure mode that is genuinely dangerous

A subscription filter that matches nothing is completely invisible. When the customer's
broker moved to a different topic prefix while the configured filter still named the old
one, the subscription matched nothing at all. Because nothing was *delivered*, nothing was
quarantined either — the raw message store stayed empty and no alarm fired. **Twenty-seven
hours of silence looked exactly like a quiet plant.**

The lesson: an empty raw message store is not proof that nothing is being published. There
is a command, `commission-from-broker`, which listens directly and compares what is
publishing against what is registered, specifically so this question can be answered.

---

## 7. The in-memory store: every key, every lifetime

Everything Redis holds is listed here. Nothing else is stored there.

| Key | Holds | Lifetime | Why that lifetime |
|---|---|---|---|
| `live:device:{id}` | Current value of every measurement on one device, plus a timestamp | 900 seconds (15 min) | Long enough to survive a brief publisher outage without serving a stale dashboard |
| `seen:device:{id}` | When the device last *spoke*, regardless of whether anything was stored | 900 seconds | Matches the value hash; after an expiry, one sweep falls back to the readings table |
| `live:plant:{id}` | Plant-level summary figures | 30 seconds | Cheap to recompute; a stale figure is worse than a missing one |
| `live:portfolio:{id}` | Fleet summary figures | 30 seconds | Same reasoning |
| `resolve:topic:{topic}` | Which device a topic belongs to, and its bindings | 300 seconds | Cleared explicitly whenever a device or binding changes — the expiry is only a safety net |
| `cache:analytics:{hash}` | Memoised history query responses | 60 seconds | Repeat range queries within a minute |
| `alarm:state:{rule}:{device}` | Debounce state for one rule on one device | 3,600 seconds | Longer than any debounce in use |
| `throttle:{device}:{tag}` | When this measurement was last stored | 600 seconds | Just above the longest throttle window, so an expiry means "write it" |
| `counter:{device}:{tag}` | Last value of a running counter, to detect a decrease | 86,400 seconds (1 day) | A rollover must be detectable across a full day |
| `unmapped:device:{id}` | Payload keys the device sends that nothing is bound to | 86,400 seconds | So the list reflects what it is sending *now*, not what it once sent |
| `ws:fanout` | Publish/subscribe channel, not a stored key | — | Relays frames between web service processes |
| `stream:readings` | The alarm worker's input queue | Capped at 100,000 entries | Explained in section 8 |

### Two design choices worth noting

**Writes are pipelined, one pipeline per message rather than one call per measurement.** A
device publishing seventeen signals costs one round trip, not seventeen.

**Reads are batched the same way.** Throttle state and counter state for every measurement
on a device are fetched in single bulk reads.

### The unmapped key list is unique

An unmapped payload key never becomes a reading, so **no query over stored readings can
ever reveal one**. This Redis set is the only place that fact exists. It is the difference
between "this device sends nothing" and "this device sends three things nobody has named
yet", and it is the single most useful fact during commissioning.

---

## 8. The alarm stream

The alarm worker reads from a Redis stream rather than from the database. That is the whole
reason alarm detection is independent of how database writes are batched.

| Property | Value | Reason |
|---|---|---|
| Structure | A stream with a consumer group | A worker can restart and resume from where it stopped, rather than losing whatever was in flight |
| Group name | `alarm-workers` | Created idempotently at startup |
| Block time per read | 2,000 milliseconds | The worker waits up to 2 seconds for new entries rather than spinning |
| Entries per read | Up to 200 | Keeps one read useful without holding the loop too long |
| Maximum length | 100,000 entries, trimmed approximately | A stalled consumer must not exhaust memory, and a backlog deeper than that is no longer worth evaluating — alarm latency is the entire point of not reading from the database |

### Error handling in the loop

Every entry is acknowledged after handling, **including one that failed**. A malformed
entry is logged loudly and acknowledged, rather than being redelivered forever and stalling
alarm evaluation for every other device. If the stream read itself fails, the worker logs a
warning, waits 2 seconds, and tries again.

### Rule caching

Alarm rules are loaded per device on first use and cached for the worker's lifetime.
**A rule change therefore requires a worker restart.** This is a known limitation, recorded
as such rather than pretended otherwise.

---

## 9. Live sockets

### One socket per browser tab, not one per component

Nine inverter tiles must not open nine sockets. The socket lives in one place in the
application and components subscribe through it.

### Rooms

A room is one customer and one plant. A socket joins exactly the rooms its login token
entitles it to, and **there is no way for the browser to ask to join a room** — there is no
subscribe message in the protocol at all. The room list is computed on the server by
running a plant query under that user's own database security context, so an employee's
rooms are exactly their assignments and zero assignments means zero rooms.

If a token entitles the user to nothing, the server says so explicitly with a `no_rooms`
message rather than leaving a silent socket that never receives anything. That distinction
matters: "connected but entitled to nothing" and "connected and waiting for data" look
identical otherwise.

### Fan-out between web service processes

The ingest worker publishes each frame onto a Redis channel. Every web service process
subscribes to it and delivers into its own rooms.

**This is not optional.** With more than one web service process, a socket held by process A
would never see a reading received by the ingest worker without it. The published message
carries the customer and plant identifiers so the receiving process can route it, and the
room key is what enforces the boundary on delivery.

### Reconnection

| Property | Value |
|---|---|
| First retry | About 1 second |
| Growth | Doubles each attempt |
| Ceiling | 30 seconds |
| Jitter | Random, between half and the full computed delay |
| Counter reset | On a successful connection |

The jitter is there so that a restarting web service is not met by every open browser tab
at the same instant.

### Disconnect detection

The server sits in a receive loop even though the browser sends nothing meaningful. That
read is purely the disconnect detector. There is no application-level heartbeat message —
the transport's own keepalive handles liveness.

### One security note about the timing

The access token is passed as a query parameter on the socket address, which means it lands
in server logs. That is exactly why the socket always uses the **current access token** —
lifetime 15 minutes — and never the refresh token.

---

## 10. Browser polling and refresh rates

### The distinction that caused a real bug

Two settings look interchangeable and are not:

- **"Stale time"** says how long a cached value may be reused. It **never causes a fetch.**
- **"Refetch interval"** is a timer that actually re-asks.

The portfolio figures once carried a 30-second stale time and no refetch interval. Because
refetching on window focus is globally switched off, **nothing ever re-asked**. The energy,
performance ratio and carbon figures were frozen at page load — no error, no warning, and
the numbers were correct for the instant the page was opened. On a wall display that is
indistinguishable from a plant that has stopped generating.

Worse, the per-plant fan-out existed in **two** places with independently drifting settings,
so fixing one left the other frozen. It is now one shared piece of code, and there is a
test asserting the rule: a live cadence carries both settings, and they agree.

### The cadences

| What | Refetch every | Stale for | Reasoning |
|---|---|---|---|
| Plant dashboard values, socket open | 30 s | 30 s | The socket triggers the refetch when data actually arrives; this timer is only a safety net for a socket that is up but silent |
| Plant dashboard values, socket closed | 5 s | 5 s | The server resolves these from the Redis current values, which ingest writes on every accepted message — so the data behind it is already current and the only lag was how often it was asked for |
| Plant performance figures, socket closed | 10 s | 10 s | Measured at 5–10 milliseconds per plant against the real-time rollups, so a ten-second cadence across a fleet is not a load concern |
| Alarms | 30 s | 15 s | Deliberately **not** sped up: an alarm cannot appear faster than the pipeline raises one, so polling harder would only ask more often for the same answer |
| Device health | 30 s | 20 s | The sweeper rewrites this on its own 60-second cycle, so this already asks twice per change |
| System health | 30 s | — | Operator diagnostics |
| Report run progress | 2 s, stopping when the run succeeds or fails | — | There is no completion push to wait on |
| Wiring editor | 10 s | — | The diagram must follow edits made elsewhere |
| Plant list, users, alarm rules, report definitions | on demand | 60 s | Configuration, not live data |
| Readings and history | on demand | 5 s | Short, because a chart re-range should not serve a stale window |
| Catalogue — tags, models, device types | never | forever, for the session | Every unit and every measurement name in the application comes from here, and it changes monthly |

### Refetch on window return

Globally, refetching when a browser tab regains focus is **off**. That is right for the
catalogue and for configuration: refetching a measurement registry because someone switched
windows is pure noise.

It is switched **on** for three things — plant performance figures, alarms, and device
health — because a background tab has its timers throttled by the browser to roughly once a
minute and can be suspended outright. Without it, the first thing an operator sees on
returning to the tab is a number from some unknowable time in the past.

### Why the socket is a trigger and not a source

The headline figures are **not** drawn from socket frames. A dashboard value is resolved on
the server against what the plant is actually bound to, and its provenance travels with it
— 6.32 megawatts read from a settlement meter and 6.32 megawatts summed from twelve
inverters are different claims, and only the server knows which one it just made. Summing
frames in the browser would produce a number with no provenance and a second implementation
of an aggregation rule that already exists.

So when a frame for a plant arrives, the browser **marks the relevant queries stale** and
lets the normal fetching machinery refetch them. The figure still comes from the server.

### Coalescing

Frames arrive per device, so a plant with twenty devices produces twenty frames per
publishing round. Refetching on each would turn one round of data into twenty identical
requests.

- Frames are gathered for **1 second**, then one refetch fires.
- One second rather than zero: readings from one round do not arrive together, and a
  refetch fired on the first frame would read a half-updated plant and then need another.
- The pending timer is **not** reset by each new frame. If it were, a steady stream of
  frames would push the refetch out forever and it would never fire.
- The code marks queries stale rather than force-fetching them, so a screen that is not
  currently open is refreshed when it opens rather than fetched in the background for
  nobody.

### The measured effect

| Situation | Before | After |
|---|---|---|
| 6 seconds of silence | Polled anyway | 0 requests |
| One frame arrives | Waited up to a full interval | Both tiles refetch about 1.1 seconds later |
| 40 idle seconds | 12 requests | 2 requests |

This is a net **reduction** in requests, not an addition, because the background timer
relaxes from 5 or 10 seconds to 30 seconds while the socket is open, and tightens back when
it closes.

**It cannot make a tile fresher than the equipment.** If the customer publishes once a
minute, the number is still up to a minute old. It removes only the delay the platform was
adding on top.

### Retry policy

A failed request is retried up to twice, but **only** for server errors. Statuses below 500
— forbidden, not found, conflict, validation failure — are answers, not transient failures,
and retrying them repeats the same answer. A 401 is handled separately: exactly one token
refresh is attempted, and concurrent 401 responses share that single refresh rather than
each firing their own, which would rotate the refresh token out from under one another.

### Age counters

Anything showing "last seen 12 seconds ago" re-renders on a **1-second** tick so that ages
and staleness advance visibly even when no new frame has arrived. A frozen age counter
reads as a broken page.

### Staleness threshold in the browser

A tile is marked stale once its newest frame is older than **twice** that device's expected
publishing interval. That is deliberately the same multiplier the health sweeper uses, so
the diagram and the alarm agree rather than disagreeing by a few seconds and looking broken.

---

## 11. Rollups: how summaries are built and how fresh they are

### The cascade

Four automatic summary levels, and **each one reads the level below it**, not the raw table:

```
  readings  ──►  1 minute  ──►  15 minutes  ──►  1 hour  ──►  1 day
```

Each level stores five things per bucket — average, minimum, maximum, last value, and
count. All five, because a summary cannot branch on how a particular measurement ought to
be rolled up. The reading path picks the right column at query time: averaging a cumulative
energy counter would be meaningless, which is what the "last value" column exists for.

### The refresh policies

Each level has three separate settings, and they are easy to confuse:

| Level | **Looks back** (start offset) | **Leaves alone** (end offset) | **Runs every** (schedule) |
|---|---|---|---|
| 1 minute | 2 hours | 1 minute | 1 minute |
| 15 minutes | 1 day | 15 minutes | 15 minutes |
| 1 hour | 7 days | 1 hour | 1 hour |
| 1 day | 30 days | 1 hour | 1 hour |

- **Looks back** bounds how much work one refresh run does. It does not mean older data is
  wrong — it means a single run will not rescan a year.
- **Leaves alone** deliberately excludes the most recent bucket, because that bucket is
  still being written into and re-materialising it repeatedly would be wasted work.
- **Runs every** is the schedule.

### Real-time aggregation, and why it matters enormously

"Leaves alone" creates a gap: the most recent bucket is, by design, not materialised. If a
query only read materialised buckets, it would return nothing newer than the last refresh.

Every level therefore runs with **real-time aggregation switched on**, which means a query
returns the materialised buckets *unioned with a live calculation* over whatever the refresh
policy has not yet covered. The figure becomes current to the second while the policies keep
their conservative settings. The uncovered window is bounded by the "leaves alone" value
plus one schedule interval, so it does not grow with retention.

### The bug this fixed, because it explains why the whole thing is documented

The helper that creates these summaries has always accepted a "real time, yes or no"
parameter. But it only ever *wrote* the setting in the "no" branch — the "yes" case was left
to the database's own default.

**That default flipped.** Through TimescaleDB version 2.12 a summary was created as
real-time; from 2.13 it is created as materialised-only. Running on 2.30, every level was
created the exact opposite of what the parameter said.

Because the cascade is hierarchical, each level inherited the lag of the one below it and
added its own:

```
  1 minute    leaves alone 1 min   + refresh every 1 min    →  ~2 minutes behind
  15 minutes  inherits ~2 min      + 15 + 15                →  ~32 minutes behind
  1 hour      inherits ~32 min     + 60 + 60                →  ~2.5 HOURS behind
```

And the plant performance endpoint read the **hourly** level. So today's energy, performance
ratio and capacity factor were computed from data two and a half hours old, on a screen
whose entire purpose is *now*.

Nothing errored. Nothing looked wrong.

**The general lesson, which applies well beyond this one helper: never express intent by
omitting a setting.** An omission is indistinguishable from a default that later changes
underneath you. The helper now writes the flag in both directions.

### Watching for a stalled rollup

The scheduler checks, on every tick, when each summary last refreshed successfully. If any
of them is more than **2 hours** behind, it logs an error and reports it as stalled. Two
hours is comfortably beyond the slowest configured refresh (one hour), so a single missed
run does not raise a false alarm.

A stalled summary is invisible on every other screen — the raw data looks perfectly fine
while the levels serving week and month views quietly stop advancing.

### Anything reading history asks which level to use

No code names a level directly. Everything calls the selection function, precisely so that
a change to the retention or the cascade does not leave a hard-coded level behind.

---

## 12. Chunking, compression and retention

### Chunking

The readings table is a hypertable split into **1-day chunks**. Splitting by time is what
lets an old chunk be dropped outright when it ages out, and lets a query for last Tuesday
skip every other chunk without reading them.

### Compression

| Table | Compressed after | Grouped by | Ordered by |
|---|---|---|---|
| Readings | 7 days | device and measurement | time, newest first |
| Raw messages | 7 days | topic | time, newest first |

The grouping choice is not cosmetic. Readings are grouped by device and measurement because
**every history query filters on them**, which lets compressed chunks be skipped without
being decompressed first. Raw message payloads are highly repetitive across a 90-day window,
which is why compressing them is worth it at all.

### Retention

| Data | Kept |
|---|---|
| Raw readings | 30 days |
| One-minute summaries | 1 year |
| Fifteen-minute summaries | 3 years |
| Hourly summaries | 10 years |
| Daily summaries | 10 years |
| Raw messages, including quarantined ones | 90 days |

Retention is enforced by dropping whole chunks, which is close to instantaneous, rather than
by deleting rows.

### The security consequence of compression

TimescaleDB **refuses** to apply row-level security to a compressed table, in either order.
That pits the storage sizing against the rule that every customer-owned table carries
row-level security.

Both are kept, this way: the readings tables, the raw message table and every summary level
stay compressed with **no row-level security**, and the web service holds **no database
privilege at all** on them. It reads only through protected barrier views. A query written
against the raw table therefore fails loudly — which is the design working, not a bug.

### Running without the time-series extension

Every time-series construct has a plain-database fallback so the migrations can be applied
on a bare database:

| Construct | Fallback |
|---|---|
| Hypertable | Ordinary table with a time index |
| Continuous summary | Ordinary materialised view, refreshed by the scheduler |
| Retention policy | Recorded only; the scheduler deletes by age instead |

The fallback matches in *behaviour*, not in *performance*. It is a development switch, never
a deployment option, and the check reads the live database catalogue rather than trusting
the configuration — so a configuration claiming the extension against a database without it
fails at migration time rather than at first write.

---

## 13. Reading history: which level answers, and the size caps

### Level selection

The rule is: **pick the coarsest level that both covers the requested range and still
retains it.** Coarsest, not finest — a year of one-minute rows is 525,600 points per
measurement, which no chart can draw and no browser should be asked to receive.

| Requested range | And starts within | Answered from |
|---|---|---|
| Up to 6 hours | 30 days | Raw readings |
| Up to 2 days | 1 year | One-minute |
| Up to 14 days | 3 years | Fifteen-minute |
| Up to 1 year | 10 years | Hourly |
| Anything longer | — | Daily |

**Retention is checked against the start of the range, not the end.** A six-hour window from
two months ago is a short range, but raw data for it was dropped at thirty days, so it must
be served from a summary. Getting this backwards returns an empty chart for a period that
has perfectly good data.

### The point cap

A query is refused **before it runs** if the estimated number of points exceeds **20,000**.
The estimate is the range divided by that level's resolution. Refusing before running,
rather than after, is the difference between an instant clear error and a slow one.

### Which column is read

Each measurement carries a rollup method, and the read path selects the matching column:
average, last value, or maximum. Anything unrecognised falls back to average.

---

## 14. The health sweep

A device that stops transmitting generates no message and therefore triggers nothing. **This
sweep is the only mechanism in the entire system that can detect a silent device.**

| Property | Value |
|---|---|
| Runs every | 60 seconds |
| Scope | Every active device, fleet-wide, in one pass |
| Degraded when silent for | more than 2 × that device's expected interval |
| Offline when silent for | more than 10 × that device's expected interval |
| Frozen measurement threshold | 60 identical consecutive readings |
| Completeness window | Last 24 hours |

### How "last heard" is computed

The later of two signals:

1. The Redis "heard from" marker, which ingest writes on **every** accepted message — this
   is the primary signal.
2. The newest stored reading, which is the fallback for when the Redis key has expired.

Using stored readings alone was the bug described in section 4.

### Multipliers, not fixed times

The thresholds multiply **that device's own expected interval**, never a global constant.
This is why the expected interval is a required field at registration and is deliberately
left blank rather than pre-filled: a device registered at the assumed 60 seconds can sit
silent for ten minutes and still read as healthy, while the customer's equipment actually
publishes every 2.8 seconds.

### Correlating failures by enclosure

If several devices in the same enclosure go silent together, that is **one** communication
failure of the room, not several equipment failures. The sweep correlates on whichever
grouping is present — the transmitting device, or the enclosure name — and raises a single
alarm listing the devices it absorbed.

Without this, a failed data collector is recorded as generation downtime and corrupts the
availability figures.

### Error handling

A failed sweep is logged and the loop continues to the next cycle; it does not exit.

**And that is precisely why it needs a test that asserts a row was written.** A permissive
security policy is not the same thing as a permission grant: an early migration created a
policy allowing the sweeper to write but never granted it the ability to insert or update.
Every sweep failed with "permission denied", logged it, and went back to sleep.
Communication status stayed empty across the entire fleet and nothing else noticed.

**The rule: a worker that catches and logs errors in its own main loop needs a test that
asserts a row was actually written.**

---

## 15. Alarm timing: debounce, hysteresis, detection delay, escalation

### Debounce — how long a condition must persist

An alarm does not open the instant a threshold is crossed. The condition must hold for the
rule's configured duration.

| Rule | Debounce | Reasoning |
|---|---|---|
| Any protection **trip** contact | **0 seconds** | A protection trip is not a transient to wait out. Delaying a gas-relay trip by 120 seconds "to be sure" would be indefensible |
| Frequency excursion | 30 seconds | |
| Inverter direct-current over-voltage | 30 seconds | |
| Breaker supply failure | 30 seconds | |
| Grid voltage high or low | 60 seconds | |
| Breaker relay or trip-coil unhealthy | 60 seconds | A health contact may flicker momentarily without being a fault |
| Inverter over-temperature | 300 seconds | Thermal, so it moves slowly |
| Communication lost | 300 seconds | |
| Enclosure offline | 300 seconds | |
| Telemetry unit unhealthy | 300 seconds | |
| Zero generation in daylight | 600 seconds | |
| Inverter underperformance | 900 seconds | Comparative, so it needs a settled picture |
| Frozen sensor | 0 seconds | The sweep's 60-reading count is already the delay |

### Hysteresis — how a condition clears

A rule may carry a separate clearing threshold, different from the opening one. The value
must return past *that* before the alarm closes. Without it, a value hovering exactly on the
limit would open and close an alarm repeatedly.

### One alarm, not one per reading

A condition breaching continuously for an hour produces exactly **one** alarm. This is
enforced twice: in the worker's own memory, and by a partial unique index in the database
covering active and acknowledged alarms. The index is the authority; the in-memory state is
the optimisation.

### Detection delay

```
detection delay  =  the measurement's throttle interval  +  the rule's debounce
```

The pipeline throttles **before** writing to the alarm stream, so a throttled measurement
delays its own alarm. A 60-second throttle plus a 60-second debounce opens an alarm
**120 seconds** after onset. Status contacts are never throttled, so the first term is zero
for every trip and health contact — which is exactly why the exemption exists.

### Escalation

| Level | Delay after the alarm opened |
|---|---|
| 1 | 0 minutes — immediate |
| 2 | 10 minutes |
| 3 | 20 minutes |

Escalation is checked on the scheduler's 60-second tick, so the real delay is the configured
delay rounded up to the next tick.

**Only alarms of severity "high" or above escalate at all.** A low or medium alarm can sit
unacknowledged indefinitely without waking anybody, which is the intended behaviour.

Escalation notifies **named people** rather than roles. Three escalation levels cannot be
expressed by role under the confirmed four-role model, so a named recipient is the primary
mechanism with role as a coarse fallback.

### Comparative rules

Two of the most valuable rules cannot be expressed as a fixed threshold at all, because a
fixed threshold cannot detect a device merely doing worse than its neighbours:

| Rule | Trigger |
|---|---|
| Underperformance | More than 10% below the median of same-variant sibling devices, and only when irradiance is above 400 watts per square metre |
| Zero generation in daylight | Power below 1 kilowatt while irradiance is above 200 watts per square metre |
| String current deviation | More than 20% below the median of the other strings in the same string box |

The irradiance floors are what stop these firing every night.

### Counter decreases are flagged, never corrected

A running counter that decreases is either a rollover or a meter replacement. Those are
**indistinguishable in the data and opposite in meaning**, so neither is assumed. The
decrease is flagged and logged, and the rollover maximum is deliberately left unset until
the customer states it.

---

## 16. The scheduler and the day boundary

| Property | Value |
|---|---|
| Tick | 60 seconds |
| Work per tick | Escalations, queued reports, rollup verification, plant figures |
| Reports rendered per tick | Up to 5 |
| Error handling | A failed tick is logged; the loop continues |

Every tick does four things in sequence. If any of them raises, the whole tick is logged as
failed and the next one runs 60 seconds later.

### Plant figures

Performance ratio, capacity utilisation factor, today's peak power and the time it occurred,
plant start and stop times, and the count of working inverters are all computed every tick.

They need a **whole plant at once** — several devices' current values plus the plant's own
capacity — which is exactly why they cannot be computed during ingestion, where a message
only ever belongs to one device.

The inputs are read from the Redis current values rather than from the readings table. That
is not laziness: the values are already there, already keyed by device, and querying a
compressed time-series table on every tick to learn what a device said thirty seconds ago
would be indefensible.

### The day boundary

At **23:55 plant-local time** — not universal time — today's figures are copied into the
"yesterday" family of measurements, and today's standing values are cleared from the Redis
hash.

Two details matter:

- **Plant-local, not universal.** A plant in India whose day rolled at midnight universal
  time would attribute five and a half hours of generation to the wrong day.
- **The clearing is necessary, not tidiness.** If today's peak power kept standing after the
  copy, tomorrow's peak would be compared against yesterday's value and would never beat it.

Because the check runs on a 60-second tick, the rollover is detected within one tick of
23:55 local.

---

## 17. Connection pools and concurrency

| Pool | Size | Notes |
|---|---|---|
| Web service database pool | 10 connections | With a liveness ping before use, so a connection dropped by the network is replaced rather than handed out |
| Ingest bulk-write pool | 1 minimum, 4 maximum | A dedicated pool separate from the main toolkit, used only for the bulk copy path |

### Why ingest has its own pool

Readings are written with a bulk copy operation, which is roughly two orders of magnitude
faster than row-by-row inserts. That path needs a raw driver connection, not a toolkit
session. Every connection in that pool assumes the ingest database role, which is exempt
from the policies on the tables it writes but holds no privilege anywhere else.

### Session scoping

Every request opens a transaction, applies the four security variables and the restricted
role inside it, and then runs. The transaction is opened **first** and the context applied
inside it, because setting a local variable outside a transaction is silently a no-op —
which would leave a request running with no security context and no error to show for it.

### If a connection pooler is ever added

**It must run in transaction mode.** Statement mode would leak the per-transaction security
variables between customers and defeat the entire isolation model.

### Process independence

The five processes share only the database and the cache. None calls another directly. The
practical consequences:

- Redeploying the web service does not interrupt ingestion or drop the broker session.
- A slow notification cannot slow down the storing of readings.
- The ingest worker and the alarm worker have different database roles, so ingestion cannot
  read alarms, escalations or users at all.

---

## 18. Login tokens and permission checks

| Property | Value |
|---|---|
| Access token lifetime | 900 seconds (15 minutes) |
| Refresh token lifetime | 604,800 seconds (7 days) |
| Refresh behaviour | Exactly one attempt per failed request; concurrent failures share it |
| Permission lookup | On **every** request, from the database |

### Why permissions are not carried in the token

A revoked permission must take effect immediately, not in fifteen minutes when the access
token happens to expire. So the permission set is read from the database on every request
rather than baked into the token. Only identity, customer, role and platform-administrator
status travel in the token.

### The audit transaction subtlety

A failed login cannot share a transaction with the 401 response that records it — raising
the error rolls the audit row back, and failed logins must be recorded. The audit row is
therefore committed in its own separate transaction first.

### The authentication circularity

Memberships are needed to determine a user's customer, but the security policy on
memberships filters on that same customer. The resolution is to set the user identity as
soon as the password verifies, and let a session read its own memberships. Using an
owner-privileged function does **not** work here, because forced row-level security applies
to the owner too.

---

## 19. Every cache in the system, side by side

| Layer | What it holds | Lifetime | Invalidated by |
|---|---|---|---|
| Redis: device current values | Latest value per measurement | 15 min | Overwritten by the next message |
| Redis: device heard-from marker | Last time the device spoke | 15 min | Overwritten by the next message |
| Redis: topic resolution | Topic to device, plus its bindings | 5 min | **Explicitly**, whenever a device or binding changes — the expiry is only a backstop |
| Redis: plant and fleet summaries | Rolled-up figures | 30 s | Expiry |
| Redis: history query memo | Range query responses | 60 s | Expiry |
| Redis: throttle state | Last write time per measurement | 10 min | Expiry, which safely means "write it" |
| Redis: counter state | Last counter value | 24 h | Expiry |
| Redis: unmapped keys | Keys nothing is bound to | 24 h | Expiry, or cleared from the screen |
| Redis: alarm debounce state | Per rule, per device | 1 h | Expiry |
| Alarm worker memory | Rules per device | Process lifetime | **Restart only** — a known limitation |
| Ingest worker memory | Topic shapes | Process lifetime | Restart |
| Browser: catalogue | Measurements, models, device types | Session | Page reload |
| Browser: configuration data | Plants, users, rules | 60 s | Timer, or a change made on screen |
| Browser: live figures | Dashboard and performance values | 5–30 s | Timer, or a socket frame arriving |

---

## 20. Pagination and payload limits

| Limit | Value |
|---|---|
| Plant list page size | 50 by default, 200 maximum |
| Plant list paging style | Cursor-based, on the plant identifier |
| History query point cap | 20,000 points |
| Broker discovery look-back | 7 days |
| Discovery payload sample | Most recent 200 messages per topic |
| Report download link lifetime | 24 hours, signed |

### Cursor paging, not page numbers

The plant list returns a cursor pointing at the last row seen. **There is no offset
parameter, and inventing one silently repeats rows as the fleet grows** — because a row
inserted between two requests shifts everything after it. The browser follows the cursor.

### Why the discovery window is seven days

Generous on purpose. A plant commissioned on a Friday should still be discoverable on the
following Monday, and the alternative — showing nothing — reads as "the broker is silent"
when the truth is "nobody looked recently".

---

## 21. Failure and restart behaviour, process by process

| Process | On error in its loop | On shutdown signal | On restart |
|---|---|---|---|
| Web service | Returns an error response; the process stays up | Closes the cache and the database pool cleanly | Stateless — nothing to recover |
| Ingest | Broker loss: logs, waits 5 s, reconnects. Does not exit | Sets a flag, flushes the buffer, then exits | Persistent broker session replays what was missed |
| Alarm worker | Bad entry: logs, acknowledges it, continues. Stream read failure: waits 2 s, retries | Sets a flag and exits | Consumer group resumes from where it stopped |
| Health sweeper | Logs the failure, waits for the next 60-second cycle | Sets a flag and exits | Next sweep re-derives everything from current state |
| Scheduler | Logs the failed tick, waits for the next 60-second tick | Sets a flag and exits | Nothing in memory to recover |

### What survives a total Redis flush

Everything except the current values, which are rebuilt by the next round of messages.
Specifically:

- **History** is in the database, untouched.
- **Alarm state** is in the database; the in-memory debounce state simply restarts.
- **Throttle state** expiring means "write it", which is the safe direction.
- **Health** falls back to the newest stored reading for one sweep, then recovers.

The design target is stated plainly in the code: a full flush must cost at most one
heartbeat cycle.

### What survives a full stop of every process

All of it. Every durable fact is in the database. The broker holds unacknowledged messages
for the persistent session and replays them when ingest returns.

---

## 22. Traps worth knowing about

Each of these was found by running the system. Each cost real time to diagnose, and each
looks like nothing is wrong.

**A helper that expresses intent by omitting a setting.** The rollup helper only wrote the
real-time flag in the "off" branch. The database default flipped between versions, every
level was created the opposite of what was asked for, the lag compounded down the cascade to
two and a half hours, and the "now" screen showed data from mid-morning. No error anywhere.

**"Stale time" reads exactly like a refresh interval and is not one.** The portfolio figures
were frozen at page load with no error and correct-looking numbers.

**The same fan-out written twice.** Two copies of the per-plant figure fetch existed with
independently drifting settings. Fixing one left the other frozen.

**Throttling erased the liveness signal.** A device on 300-second throttles was invisible for
57 of every 60 seconds and flapped between online and offline every minute.

**A permissive security policy is not a permission grant.** Every health sweep failed
silently for weeks; the fleet's communication status stayed empty and nothing noticed.

**A subscription filter matching nothing is completely invisible.** Nothing is delivered, so
nothing is quarantined either, so no alarm fires. Twenty-seven hours of silence looked like
a quiet plant.

**A customer code that differs from the topic breaks only for *new* devices.** The first
resolution route is an exact match on the stored topic, which never compares the customer
code — so every already-registered device kept working perfectly while the next one added
would have been quarantined.

**A payload key means different things on different equipment.** The same key is 11.037 from
a meter on an eleven-kilovolt feeder and 799.9 from an inverter on an eight-hundred-volt
bus. Resolving by key alone would store one of them as "799.9 kilovolts", with two of three
phases passing the range check while doing it.

**Topic levels are case-sensitive, and folding them is forbidden.** A capitalised prefix is a
second registered shape, not a lowercase conversion in code — folding case would make two
customers whose codes differ only by case into the same origin.

**An uncontrolled input that commits when it loses focus will write stale values by itself.**
The enclosure field committed on blur. When the stored value changed underneath it, the
browser fired a blur event *as the old field was being removed*, carrying the pre-change
value, and the handler wrote it straight back — silently re-applying an old enclosure to two
devices that had just been moved out of it, from a page nobody was touching, and the audit
log recorded it as a deliberate edit. A blur now only commits if a keystroke preceded it.

**A table missing from the object model is one the schema comparison believes you deleted.**
Three tables had no model because the routes use explicit queries and none was needed at run
time. The automatic migration generator proposed dropping a table holding every plant's
enclosure wiring, and dropping five commercial columns from the customer table. The generated
migration would have looked entirely routine.

**The scheduler runs with platform privileges, so the barrier views do not scope it.** Report
generation must filter by customer itself. It is the one place isolation is not inherited
from the database, and it leaked another customer's meter into a financial report before the
filter was added.

---

## 23. What is not built yet on the non-functional side

Stated plainly rather than left to be discovered.

**No request rate limiting.** There is no per-user or per-address throttle on the web
service. The natural place for it is the reverse proxy in front of the service.

**Alarm rule changes need a worker restart.** Rules are cached for the alarm worker's
lifetime.

**No metrics endpoint.** The processes keep internal counters — messages received, stored,
quarantined, throttled, unmapped, suspect counters, flushes — and log them, but they are not
exposed for scraping by a monitoring system. The system-health endpoint covers the most
important ones: ingest lag, rollup freshness, and quarantine count in the last hour.

**No explicit request timeout on the web service.** Long queries are bounded by the point cap
rather than by a clock.

**No connection pooler in front of the database.** When one is added it **must** be in
transaction mode.

**Only one alarm worker consumer is configured.** The consumer group supports several, but a
single consumer name is used today.

**The measurement scaling is still unknown.** Units are known for seven of the seventeen
device types from the customer's signal schedule. Scale factors and valid ranges are known
for **nothing** — the schedule's range column is blank throughout. This is the dangerous half:
a unit says what 11.37 means, a scale says whether the register holds 11.37 or 11370, and a
factor-of-one-thousand voltage error looks entirely plausible in the data.

**The customer's own performance formulas are not yet supplied.** The system uses
standards-based defaults, and every computed figure is returned together with the name of the
formula variant that produced it, so that when the real definitions arrive, historical figures
can be identified and recomputed rather than silently superseded.

**The counter rollover maximum is unset**, deliberately, so a decrease is flagged rather than
silently interpreted.

**The integration test suite runs against the development database and leaves its fixtures
behind.** Every run adds roughly thirty plants and thirty-five customers, and an editor that
runs tests on save compounds it. Nothing removes them.
