# SolarCMS — What The System Does Today

**Status of this document:** written on 20 September 2026, from reading the actual
source code and the actual running database, not from the design documents. Everything
described here exists and runs. Where something is only partly finished, it says so.

This document is self-contained. You do not need to open any other file to understand it.

---

## Table of contents

1. [What the system is, in plain words](#1-what-the-system-is-in-plain-words)
2. [The words this system uses, and what each one means](#2-the-words-this-system-uses-and-what-each-one-means)
3. [The technology used, part by part](#3-the-technology-used-part-by-part)
4. [The running processes, and what each one does](#4-the-running-processes-and-what-each-one-does)
5. [The journey of one measurement, from the plant to the screen](#5-the-journey-of-one-measurement-from-the-plant-to-the-screen)
6. [The screens that exist today](#6-the-screens-that-exist-today)
7. [The web service endpoints that exist today](#7-the-web-service-endpoints-that-exist-today)
8. [Client onboarding, step by step](#8-client-onboarding-step-by-step)
9. [How the two Single Line Diagrams are drawn](#9-how-the-two-single-line-diagrams-are-drawn)
10. [How data is stored and how long it is kept](#10-how-data-is-stored-and-how-long-it-is-kept)
11. [Security: how one customer is kept away from another customer's data](#11-security-how-one-customer-is-kept-away-from-another-customers-data)
12. [Alarms and equipment health](#12-alarms-and-equipment-health)
13. [Reports](#13-reports)
14. [Live updating on the screen](#14-live-updating-on-the-screen)
15. [What the system deliberately does not do yet](#15-what-the-system-deliberately-does-not-do-yet)
16. [The state of the live installation right now](#16-the-state-of-the-live-installation-right-now)
17. [How to run the whole thing on a laptop](#17-how-to-run-the-whole-thing-on-a-laptop)

---

## 1. What the system is, in plain words

SolarCMS is a monitoring platform for solar power plants. It serves many customers from
one installation, and each customer sees only their own plants.

Equipment at a solar plant — inverters, meters, transformers, weather stations —
publishes its readings onto a message broker using a protocol called Message Queuing
Telemetry Transport, usually shortened to MQTT. SolarCMS listens to that broker, works
out which piece of equipment each message came from, decodes the numbers inside it,
stores them in a time-series database, and shows them on a set of web screens. Along the
way it watches for equipment that has stopped talking, opens alarms when a value crosses
a limit, computes plant-level performance figures, and produces reports.

Four things shape almost every design decision in the system, and they are worth stating
up front because they explain why parts of it look the way they do:

1. **The message topic is the only thing that says who the data belongs to.** The system
   never looks inside a message to guess which customer or which plant it came from. If
   the topic is not recognised, the message is put aside in a quarantine area, and nobody
   is charged with owning it.
2. **A missing number is shown as "unknown", never as zero.** A performance ratio of zero
   and an unknown performance ratio mean opposite things to an operator.
3. **Configuration is data, not code.** Adding a new measurement type, a new piece of
   equipment, a new report or a new topic shape is a row in a table, not a software
   release.
4. **The database enforces customer separation, not the application.** If a query forgets
   to filter by customer, it returns nothing at all rather than returning somebody else's
   generation figures.

---

## 2. The words this system uses, and what each one means

The system uses one word per concept, everywhere: in table names, in variable names, in
screen labels and in log messages. The alternatives are deliberately never used, because
each of them had been used for two different things at once.

| The word used | What it means | Words never used for it |
|---|---|---|
| **Client** | A customer company that owns plants | tenant, company, organisation |
| **Plant** | One solar power plant | site, facility, project |
| **Block** | A geographic area inside a plant. Optional; most plants have none | zone, section, array |
| **Device** | One piece of equipment that publishes readings | equipment, asset, unit |
| **Device Type** | The kind of equipment, for example Inverter or Transformer | — |
| **Device Model** | A specific model of equipment, which decides what signals it publishes | — |
| **Tag** | One measurable quantity, for example "phase R voltage" | parameter, metric, point, signal |
| **Reading** | One value of one Tag from one Device at one moment | — |
| **Binding** | The rule that says "the key `VRY` from this Device means this Tag, multiply it by this number" | — |
| **Alarm** | A condition that has been detected and needs attention | alert, event, incident |
| **Collector** | An enclosure — a control room, a panel, a cabinet — that *holds* devices. It is not a device | — |

The word "location" is retired entirely and is used for nothing.

---

## 3. The technology used, part by part

### The back end (the server side)

| Part | Technology | Why |
|---|---|---|
| Programming language | Python, version 3.12 exactly | One of the database drivers has no prepared package for version 3.13 or newer |
| Web framework | FastAPI 0.115 | Handles the web requests and the live socket, and generates the interface documentation automatically |
| Web server | Uvicorn 0.30 | Runs the FastAPI application |
| Data validation | Pydantic 2.9 and Pydantic Settings 2.5 | Checks every incoming request body and every environment setting |
| Database toolkit | SQLAlchemy 2.0, asynchronous mode | Talks to the database without blocking |
| Database driver | asyncpg 0.29 | The fast PostgreSQL driver, also used directly for bulk loading |
| Database schema changes | Alembic 1.13 | Every schema change is a numbered migration file |
| Message broker client | aiomqtt 2.3 | Subscribes to the MQTT broker |
| Cache and message stream | redis-py 5.0 | Holds the latest value of every Tag, and carries the stream of readings to the alarm process |
| Login tokens | PyJWT 2.9 | Signs and verifies the access tokens |
| Password storage | argon2-cffi 23.1 | Hashes passwords with the Argon2 algorithm |
| Spreadsheet generation | openpyxl 3.1 | Writes the Excel files for reports |
| Portable document generation | WeasyPrint 62.3, optional | Writes the PDF files for reports. Optional because it needs extra system libraries; when it is missing the Excel file is still produced |
| Outgoing web calls | httpx 0.27 | Used for notification delivery |
| Logging | structlog 24.4 | Logs are structured records, not sentences |
| Code style checking | Ruff 0.6 | Must pass with no findings |
| Type checking | mypy 1.11 in strict mode | Must pass with no findings |
| Tests | pytest 8.3 with pytest-asyncio | Two suites: one needs nothing running, one needs the database |

### The database

| Part | Technology | Why |
|---|---|---|
| Database | PostgreSQL 16 | The main relational database |
| Time-series extension | TimescaleDB 2.17 | Turns the readings table into a hypertable, which is automatically split by time, compressed, and rolled up into summaries |

### The front end (what runs in the browser)

| Part | Technology | Why |
|---|---|---|
| Language | TypeScript 5.6 | Catches mistakes before the browser sees them |
| User interface library | React 18.3 | Builds the screens |
| Build tool | Vite 5.4 | Development server and production build |
| Routing | React Router 6.27 | Decides which screen a web address shows |
| Server data fetching | TanStack React Query 5.59 | Fetches, caches and refreshes everything that comes from the server |
| Local state | Zustand 4.5 | Small pieces of screen state, such as the selected plant |
| Response checking | Zod 3.23 | Every server response is checked against a described shape before use |
| Styling | Tailwind CSS 3.4 with PostCSS and Autoprefixer | All styling, in one consistent set of design tokens with a light and a dark theme |
| Charts | Apache ECharts 5.5 | The time-series charts and gauges |
| Diagram layout | d3-hierarchy 3.1 | Works out where each box goes in the Single Line Diagram. It only calculates positions; React draws the actual picture |
| Tests | Vitest 2.1 with Testing Library and jsdom | Component and behaviour tests |

### The local infrastructure

Everything local runs in Docker containers, started with one command:

| Container | Image | Port |
|---|---|---|
| Database | `timescale/timescaledb:2.17.2-pg16` | 5433 |
| Cache and stream | `redis:7.4-alpine` | 6379 |
| Development message broker | `emqx/emqx:5.8.0` | 1883 for plain, 8883 for encrypted, 18083 for its own web console |

A warning that has caught people before: there is also a separate PostgreSQL 18 installed
directly on the machine, listening on port 5432, holding an empty database with the same
name. Connecting to that one by mistake makes every table appear to be missing, which
looks exactly like a wiped database. Port **5433** is the right one.

---

## 4. The running processes, and what each one does

The system runs as **five separate processes**. They share only the database and the
cache. None of them calls another one directly. This separation is deliberate: the part
that receives data from the field must keep running while the web service is being
redeployed, and the part that sends notifications must never be able to slow down the
part that stores readings.

### 4.1 The web service — `uvicorn solarcms.api.main:app`

This is the only process a browser ever talks to. It serves the web service endpoints
described in section 7, and it holds the live socket connections.

What it does:

- Verifies the login token on every request, reads the user's identity, customer,
  role and permissions out of it, and sets them as database session variables so the
  database itself can enforce access.
- Serves every screen's data: plants, devices, readings, alarms, health, reports,
  catalogue, users, audit trail, and the broker discovery screens.
- Holds the live WebSocket connections and delivers reading frames into the correct
  rooms. A room is one customer and one plant; nothing is ever broadcast to everybody.
- Builds the Single Line Diagram structures and the dashboard values on demand.

What it deliberately does **not** do: it never connects to the message broker, and it
never reads the raw readings table directly. It reads through protected views instead,
and it holds no database privilege at all on the raw tables — so a query written against
them fails loudly rather than quietly returning the wrong customer's data.

### 4.2 The ingestion worker — `python -m solarcms.workers.ingest`

The process that listens to the field. It runs on its own so that it survives web service
deployments and keeps its broker session.

What it does, for every message that arrives:

1. Takes the topic the message arrived on.
2. Matches that topic against the registered topic shapes to find which Device it is.
   The lookup result is cached in Redis, because this is the only database call on the
   hot path.
3. If no Device matches, the message is **quarantined** — stored whole, with its payload,
   marked as unattributed and owned by nobody. It is never guessed at.
4. If a Device matches, it normalises the payload. Two shapes are accepted: the formal
   envelope shape (`{device, timestamp, readings:[{tag, value}]}`) and the flat shape the
   client's broker actually sends (a plain object of key and value). The `device` field
   inside the envelope is deliberately ignored — the topic is the only authority.
5. For each key in the payload, it finds the binding for that Device, applies the scale
   factor and the offset, and classifies the quality of the value: good, out of range,
   stale, or unparseable. Nothing is ever discarded — a nonsense value is stored and
   flagged, because a nonsense value is diagnostic information.
6. It applies throttling: a Tag with a minimum interval only stores a new value once that
   interval has passed. Status contacts are never throttled, so a breaker that opened and
   closed within a minute is not lost.
7. It writes the latest value into Redis so the screens can read it instantly, records a
   "this Device was heard from" marker in Redis (separately from whether anything was
   stored — otherwise a heavily throttled Device would look silent), pushes an entry onto
   the Redis stream for the alarm process, and adds rows to a buffer.
8. The buffer is flushed into the database with a bulk copy when it reaches 5,000 rows or
   2 seconds, whichever comes first. The message is only acknowledged to the broker
   **after** the database transaction commits, so a crash causes the broker to resend
   rather than losing the data.

### 4.3 The alarm worker — `python -m solarcms.workers.alarm`

Reads the Redis stream that ingestion writes to. It never queries the readings table,
which is what keeps alarm detection independent of how the database writes are batched.

What it does:

- Loads the alarm rules that apply to each Device, most specific rule winning.
- Evaluates each rule: comparison operators (greater than, less than, outside a band,
  inside a band, equal to) plus two operators for on-or-off contacts, because some
  equipment publishes nothing but digital contacts and has no number to compare.
- Applies **debounce**: the condition must persist for a configured duration before an
  alarm opens, so a single spike does not raise one.
- Applies **hysteresis**: the value must return past a separate clearing threshold before
  the alarm closes, so a value hovering on the limit does not flap.
- Guarantees one alarm per rule per Device. A condition that breaches continuously for an
  hour produces exactly one alarm, not one per reading. This is enforced twice: in the
  worker's own memory, and by a unique index in the database which is the real authority.
- Sends the notifications for newly opened alarms.

### 4.4 The health sweeper — `python -m solarcms.workers.health_sweeper`

Runs every 60 seconds. **This is the only thing in the system that can detect a Device
that has gone silent** — every other check is triggered by data arriving, and a silent
Device sends nothing to trigger anything.

What it does:

- For every active Device, works out when it was last heard from. It takes the later of
  two signals: the "heard from" marker in Redis, and the newest stored reading. Using
  stored readings alone was a real bug — a Device whose Tags were throttled to five
  minutes appeared to go offline and online again every minute.
- Compares that against the Device's own expected publishing interval multiplied by
  configured factors, and sets its communication status to online, degraded, offline or
  unknown. The factors today are two times the expected interval for degraded and ten
  times for offline.
- Counts **frozen values**: a Tag reporting the identical number sixty times in a row,
  which usually means a sensor has failed in place rather than stopped.
- Computes completeness over the last 24 hours — how much of the data that should have
  arrived actually did.
- **Correlates failures by Collector.** If nine Devices in the same control room all go
  silent at once, that is one communication failure of the room, not nine equipment
  failures. It raises one alarm covering all of them.

### 4.5 The scheduler — `python -m solarcms.workers.scheduler`

Runs on a 60-second tick. Everything it does is time-driven rather than data-driven,
which is exactly why it cannot live inside the other two workers.

What it does:

- **Fires escalations.** An alarm left unacknowledged past a configured delay is escalated
  to the next level and the next person, subject to a minimum severity, so a low-severity
  alarm never wakes anybody.
- **Runs queued reports**, generates the Excel and PDF files, stores them and signs the
  download links.
- **Verifies the rollup summaries** are still being refreshed, so a stalled summary is
  noticed rather than quietly serving stale data to the week and month views.
- **Computes plant-level figures** every tick, and writes them to a special Device on each
  plant: performance ratio, capacity utilisation factor, today's peak power and the time
  it occurred, plant start and stop times, and the count of working inverters. These need
  a whole plant at once, which is why they cannot be computed during ingestion, where a
  message only ever belongs to one Device.
- **Rolls the day over at 23:55 plant-local time** — not in universal time. A plant in
  India whose day rolled at midnight universal time would attribute five and a half hours
  of generation to the wrong day. Today's figures are copied into the "yesterday" family
  of Tags and today's counters are reset.

---

## 5. The journey of one measurement, from the plant to the screen

```
  Equipment at the plant
        │  publishes
        ▼
  MQTT broker            topic: SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_7
        │                payload: {"VRY": 799.9, "IR": 120.4, ...}
        ▼
  Ingestion worker
        ├─ match the topic against the registered shapes   → which Device is this?
        ├─ no match → quarantine, whole payload kept, owned by nobody, alarm raised
        ├─ normalise the payload (both shapes understood)
        ├─ for each key: find the binding, scale it, offset it, judge its quality
        ├─ throttle if this Tag was stored too recently
        ├─ write latest value → Redis      (screens read this instantly)
        ├─ write "heard from" marker → Redis  (health sweeper reads this)
        ├─ push entry → Redis stream       (alarm worker reads this)
        └─ buffer the row, bulk-copy to the database every 5,000 rows or 2 seconds
                │                                    │
                ▼                                    ▼
        readings table                        alarm worker
        (compressed, split by time)           ├─ debounce, hysteresis
                │                             ├─ open or clear an alarm
                ▼                             └─ notify
        automatic rollups
        1 minute → 15 minutes → 1 hour → 1 day
                │
                ▼
        Web service reads through protected views
                │
                ▼
        Browser screens
```

Separately and in parallel: the health sweeper looks for silence every 60 seconds, and
the scheduler computes plant-level figures every 60 seconds and writes them back as
readings against a plant-level Device.

---

## 6. The screens that exist today

There are two groups of screens. **Dashboards** are for watching the plants. **Admin
screens** are for setting the system up. Which dashboards a user can open is decided
per user in the database: a user who has not been granted a dashboard has no web address
for it at all, not merely a hidden menu item.

### 6.1 Dashboards

**Portfolio** — the whole fleet at once. Total capacity, total generation, combined
performance figures, open alarms, and equipment health across every plant the user can
see. Plants still being set up (status "draft" or "commissioning") are deliberately
excluded from every total and shown in a separate group, so a half-configured plant
cannot drag the fleet's performance figures down. There is no stored portfolio: it is
computed by summing what the plants report.

**Plant Overview** — one card per plant, ordered by which plant needs attention most
rather than alphabetically. Status, alarms and health are shown first, figures second.
For a fleet of eighty plants the ordering is the entire value of the screen.

**Plant List** — the same information as a sortable, filterable, exportable table: code,
name, region, capacity, status, live device count, energy, performance ratio, health
summary, open alarms. This is the screen for working through plants systematically.

**Single Plant** — everything about one plant. A header, a row of headline figures, an
equipment health strip, a four-stage schematic (described in section 9), time-series
charts, and a Blocks section that only appears if the plant actually has Blocks. There
is no invented "unassigned" Block.

**Single Line Diagram** — the electrical picture of one plant. Described in full in
section 9. Clicking any box opens everything recorded about that Device.

**Inverter Monitoring** — compares and ranks the inverters at a plant. Ranking happens
strictly **within an inverter variant**: central inverters and string inverters have
different signal sets and different expected outputs, and ranking across them would be
meaningless. The groups are labelled so the ranking cannot be misread as plant-wide.

**Alarms** — the alarm list, filterable by severity, by state, and by classification
(communication failure versus equipment failure). Acknowledging is permission-gated. The
escalation level is shown, because an alarm at level two has already woken somebody. A
Collector failure appears as one alarm listing the devices it absorbed, rather than as
nine separate "inverter offline" rows.

**Reports** — lists the report definitions, requests a run, polls its progress, and offers
the finished files. Two failures are explained specifically rather than shown as generic
errors: a financial report requested where no settlement meter is registered, and a run
that succeeded but could not produce a PDF because the optional rendering library is not
installed (the Excel file is still offered).

### 6.2 Administration screens

**Plant onboarding** (`/admin/onboarding`) — the five-step wizard. Described in full in
section 8.

**Clients** (`/admin/clients`) — create and edit customers. Creating a customer creates
its first login in the same database transaction, so a customer that nobody can sign into
cannot exist.

**Plants and Devices** (`/admin/plant-setup`) — one screen for one plant. It shows
registered Devices and not-yet-registered Devices that are publishing, **in one list**,
matched on the topic. A row expands into everything about that Device: its topic, its
enclosure, its measured publishing interval, how many Tags it has bound, the payload keys
actually arriving with what each one maps to, and the raw payload itself. This replaced an
earlier arrangement that split the work across three screens by database table, which was
the schema showing through the interface — nobody thinks "I need to edit device tag
bindings", they think "what is wrong with inverter 7".

**Wiring and Diagram** (`/admin/hierarchy`) — set what each Device feeds into, with the
diagram redrawing beside you as you do it. Described in section 9.

**Tag Mapping** (`/admin/bindings`) — the screen that decides how every future reading
from a Device is decoded. Three things are stated plainly on it: saving **replaces** the
whole set rather than merging into it; existing stored readings are **not** re-decoded
retroactively; and the scale factor is per Device on purpose, because field wiring never
matches the datasheet.

**Alarm Rules** (`/admin/alarm-rules`) — create and edit the threshold rules.

**Users** (`/admin/users`) — create users, assign roles, grant plant access and dashboard
access. Both grants are explicit: a user with no plant assignments sees **zero** plants,
never all of them.

**System** (`/admin/system`) — platform-level diagnostics for the operator: how far behind
ingestion is, whether the rollup summaries are still refreshing, and how many messages
have been quarantined in the last hour.

---

## 7. The web service endpoints that exist today

All of these speak JavaScript Object Notation (JSON) over HTTP. Times go in and come out
as full timestamps with a time zone offset; the browser decides how to display them.

**Authentication**
- `POST /auth/login` — email and password in, an access token and a refresh token out
- `POST /auth/refresh` — a new pair of tokens
- `POST /auth/switch-client` — for a platform administrator, move the session into one customer
- `POST /auth/logout`
- `GET /auth/me` — who am I, which customer, which role, which plants, which dashboards

**Clients**
- `GET /clients`, `POST /clients` (optionally creating the first user in the same transaction), `PATCH /clients/{id}`

**Regions**
- `GET /regions`, `POST /regions`, `PATCH /regions/{id}` — regions carry the local grid emission factor used for carbon figures

**Plants**
- `GET /plants` (paged), `POST /plants`, `GET /plants/{id}`, `PATCH /plants/{id}`
- `GET /plants/{id}/kpis` — performance ratio, capacity utilisation factor, availability and carbon avoided, each returned together with the name of the formula variant that produced it
- `GET /plants/{id}/dashboard` — the resolved dashboard values for the fixed screen
- `GET /plants/{id}/sld` — the detailed electrical tree
- `GET /plants/{id}/sld-stages` — the four-stage schematic
- `GET /plants/{id}/parse-topic` — read a pasted topic the way ingestion will read it
- `GET /plants/{id}/collectors`, `PUT /plants/{id}/collectors/{code}` — the enclosures and the one outward connection each owns
- `GET /plants/{id}/commissioning` — the readiness report
- `POST /plants/{id}/status` — move between draft, commissioning and active
- `GET /plants/{id}/blocks`, `POST /plants/{id}/blocks`, `PATCH`, `DELETE`, and block-level figures

**Devices**
- `GET /plants/{id}/devices`, `GET /devices/{id}`, `POST /devices`, `PATCH /devices/{id}`, `DELETE /devices/{id}`
- `POST /devices/bulk-import` — register many at once, all or nothing
- `GET /devices/{id}/bindings`, `PUT /devices/{id}/bindings` — replaces the whole set
- `POST /devices/{id}/bindings/from-model` — seed the bindings from the Device Model's signal list
- `GET /devices/{id}/unmapped-keys`, `DELETE /devices/{id}/unmapped-keys` — payload keys arriving that nothing is mapped to
- `POST /devices/{id}/credential` — issue broker credentials for a Device

**Catalogue**
- `GET /catalog/device-types`, `GET /catalog/device-models`, `GET /catalog/device-models/{id}/tags`, `POST /catalog/device-models`, `PUT /catalog/device-models/{id}/tags`
- `GET /catalog/tags`, `POST /catalog/tags`, `PATCH /catalog/tags/{id}`
- `GET /catalog/device-table-columns` — which columns a given Device Type's table should show

**Readings**
- `GET /readings` — history for chosen devices and tags over a time range, automatically routed to the right summary level
- `GET /readings/export` — the same as a comma-separated file

**Alarms**
- `GET /alarms`, `POST /alarms/{id}/acknowledge`
- `GET /alarm-rules`, `POST /alarm-rules`, `PATCH /alarm-rules/{id}`

**Health**
- `GET /health/devices` — communication status, last seen, frozen tag count, completeness
- `GET /health/system` — platform diagnostics, platform administrator only

**Reports**
- `GET /reports/definitions`, `POST /reports/runs`, `GET /reports/runs/{id}`, `GET /reports/artifacts/{key}`

**Discovery** (platform administrator only — explained in section 8)
- `GET /discovery/clients`, `GET /discovery/plants`, `GET /discovery/topic`

**Users and audit**
- `GET /users`, `POST /users`, `PATCH /users/{id}`, `DELETE /users/{id}`, `PUT /users/{id}/plants`, `PUT /users/{id}/dashboards`
- `GET /audit` — the audit trail

**Live socket**
- A WebSocket endpoint that delivers reading frames into customer-and-plant rooms. Rooms
  are assigned by the server from the token. There is no way for a browser to ask to join
  a room; if data is not arriving, the user was not granted that plant.

---

## 8. Client onboarding, step by step

This is the flow the question asked about: adding a Client, then its Plants, then mapping
the MQTT topics, then mapping the Devices based on what is actually arriving at the broker.

The design principle behind the whole flow is: **the engineers on site publish before we
onboard.** That means the customer codes, the plant codes, the enclosure names, the device
codes and even the payload keys are all observable facts before anybody fills in a form.
So onboarding is arranged as *confirming what is already arriving* rather than *typing
what we hope will arrive*. A single wrong character in a typed topic produces a Device
that looks correctly registered and silently decodes nothing forever — that is the exact
failure this flow is built to prevent.

### Step 1 — Add the Client

Screen: the first step of the onboarding wizard, or the Clients screen.

A Client is a customer company. It has a code, a name, and optionally commercial details.

**The code matters more than it looks.** The Client's code must be spelled exactly as the
publisher spells it in the topic. This was a real, nearly invisible problem: the Client
row once read `kular-green` while every topic said `KULAR_GREEN`, and nothing broke for
weeks, because the first way the system resolves a topic is an exact match on the Device's
stored topic — which never compares the Client code at all. Only the *pattern* route
compares it, and that is the route a newly appeared Device takes. So the first new Device
the customer added would have been quarantined as unknown, while its topic was perfectly
valid. Note also that this is not a letter-case problem that could be solved by
lower-casing: the codes differed by a hyphen against an underscore as well, and folding
letter case is forbidden anyway, because it would make two customers whose codes differ
only by case into the same origin.

**A Client is never created without a login.** The create-client request takes an optional
first user, and creates both in **one database transaction**. A Client that nobody can
sign into looks finished on every screen and only its creator knows otherwise. That first
user defaults to the Client Administrator role deliberately: a Client Administrator
automatically sees every plant of their own Client, so plants added later are visible with
no extra grant. Any other role starts with zero plants, and zero means none.

A platform administrator can also discover which Client codes are publishing:
`GET /discovery/clients` lists every customer code seen on the broker in the last seven
days, how many topics and messages each has, and — crucially — whether that code is
already registered, so the same customer is never created twice under two spellings.

**Who can do this:** creating a Client is platform-administrator work.

### Step 2 — Add the Plant or Plants

Screen: step two of the wizard. A Client may have many Plants; the wizard runs once per
Plant and the chosen Client stays visible in the header throughout.

Fields: plant code, name, region, alternating-current capacity, direct-current capacity,
time zone, latitude and longitude, and the commissioning date.

Several details are load-bearing:

- **The Client travels in the request, not in the session.** This used to work the other
  way: the request took the Client from the login token alone, so a platform administrator
  — who belongs to no Client — had to *switch their session into* a customer first, and the
  Plant landed under whichever Client the session happened to hold. That was a silent way
  to file a Plant under the wrong company. Now the Client is a required field for a
  platform administrator and an ignored field for a Client Administrator, whose own Client
  is always used.
- **Direct-current capacity is needed for the performance ratio** and alternating-current
  capacity for the capacity utilisation factor. Without them those figures are unknown,
  not zero.
- **The time zone is per Plant** and is used for the 23:55 daily rollover.
- The Plant is created in **draft** status. A draft Plant is excluded from every fleet
  total, so a half-configured Plant never pollutes the numbers.

**Blocks are an optional third step.** A Block is a geographic area within a Plant. Most
plants have none, and zero Blocks is the normal case, so the step is opt-in and skipping
it is unremarkable. If Blocks are created, each must carry a capacity, because block-level
performance is meaningless without one to divide by.

### Step 3 — Map the MQTT topic

This is where a Device gets its identity. **The topic is the sole authority for where a
message came from.** Nothing else is allowed to decide it.

#### The shape of a topic

Five registered shapes exist today, stored as rows in a table rather than as code, so a
customer publishing a different shape is an insert, not a deployment:

| Shape | Priority | Note |
|---|---|---|
| `scms/v1/{client}/{plant}/{collector}/{device}` | 10 | The formal contract |
| `SCMS/V1/{client}/{plant}/{collector}/{device}` | 11 | The same, in capitals — what the customer's broker actually publishes today |
| `scms/v1/{client}/{plant}/{device}` | 12 | No enclosure. A rooftop plant's meter publishes straight under the plant |
| `SCMS/V1/{client}/{plant}/{device}` | 13 | The same, in capitals |
| `{plant}/{category}` | 90 | A legacy two-segment shape from the customer's test broker, to be retired |

**Topic levels are case-sensitive and stay that way.** The capitalised shapes are separate
rows, not a lower-casing step in the code, because folding letter case would merge two
customers whose codes differ only by case, and the topic is the sole authority for origin.

**Six segments versus five is a real distinction, not an optional field.** Six segments
name an enclosure. Five segments state that there is no enclosure — which is a real
answer, not a gap.

#### How a topic is mapped, in practice

There are two routes, and the order matters.

**Route one — paste the topic (the main route).** `GET /plants/{id}/parse-topic` takes the
exact topic string a person pastes and returns what it means: the Client code, the Plant
code, the enclosure name and the Device code, read out by the **live registry**, never by
a second parser written in the browser. A parser in the browser would be free to drift
from the one ingestion actually uses, and the drift would show up as a Device that looks
registered and decodes nothing.

It also returns the problems it found, in plain sentences:

- the topic matches no registered shape, so ingestion would quarantine it;
- the topic names a different Plant than the one being edited;
- the topic names a different Client than the one this Plant belongs to;
- this shape carries no device code at all;
- another Device is already registered on this exact topic — two Devices cannot share
  one, because the topic is what decides which Device a message belongs to.

This endpoint needs only the plant-management permission, not platform administration,
because it returns nothing but the structure of a string the caller already typed. That
matters: **getting this backwards was a real failure worth not repeating.** For a period,
registering a Device was only possible by picking one out of broker discovery — so the
Client Administrator who actually runs the plant could add nothing at all, and equipment
that had not started publishing yet could be registered by nobody. A related symptom was
that every Device read "not publishing" for those users, which asserted something there
was no basis for. Silence only means something when you could have heard.

**Route two — discovery (the convenience on top).** `GET /discovery/plants?client_code=…`
shows what is actually arriving, arranged in the shape of the topic itself — Plant, then
enclosure, then Device — because that is the structure the site engineers configured and
the one the operator is checking their work against. For each Device it gives the topic,
the message count, when it was last seen, whether it has ever been quarantined, and
whether a Device is registered for that topic right now.

Two things about discovery are worth understanding:

1. **It reads what ingestion has received, not the broker.** The web service never opens a
   broker connection: running ingestion inside the web service is forbidden, and a second
   subscriber would compete for the same messages. So discovery reads the stored raw
   message table. The consequence is honest — if ingestion is stopped or cannot reach the
   broker, discovery goes quiet too, because in that state we genuinely do not know what
   is being published.
2. **It is platform-administrator only, and not by choice.** An unregistered topic is
   quarantined with no owner, because attributing it by reading the topic is exactly the
   guess that is forbidden. So those rows are visible to a platform administrator alone.

Also worth keeping straight: "is a Device registered for this topic now" and "what
happened to one particular message when it arrived" are different questions. Reporting the
second as the first tells an operator to fix something that is already fixed.

### Step 4 — Map the Device, based on what is coming to the broker

Now the Device itself is registered. This is step four of the wizard, or the "Plants and
Devices" screen for an existing plant.

**What is asked for:**

| Field | Why |
|---|---|
| Code and name | What operators call this machine |
| Device Model | Decides which signals it publishes, and therefore which Tags get bound |
| Topic | From step 3 |
| Expected publishing interval, in seconds | Required and prominent — see below |
| Rated capacity | Needed for specific yield on inverters |
| String count | How many photovoltaic strings *this* machine has |
| Block | Optional; only if the plant has Blocks |

**The expected interval is required, and deliberately left blank rather than pre-filled.**
The health thresholds multiply this number, so a Device registered at sixty seconds can
sit silent for ten minutes and still read as perfectly healthy. The customer's broker
publishes roughly every 2.78 seconds. A default that is really an assumption should not
arrive on screen looking like a decision.

**The string count is asked per Device, never per Model.** The inverter signal schedule
covers strings one to twenty-eight. How many a given machine actually has is a property of
that machine, because one datasheet covers both a twelve-string and a twenty-four-string
inverter. The binding then takes the first *n* of the repeating group. If no count is
recorded, **none** of the repeating group is bound — twenty-eight Tags that never report
look exactly like a broken Device.

**What is deliberately not asked for at registration:**

- **"What does this Device feed into"** (its place in the electrical chain). It is routinely
  corrected after the first day of real data, and a guess drawn into the Single Line
  Diagram is indistinguishable from a fact. It is set later, in the wiring screen, with
  the diagram visible beside you.
- **"What transmits this Device"** — already stated by its topic.
- **The enclosure**, in almost every case. The topic decides it: six segments name the
  room, five state there is none, and either way a hand-typed value is a contradiction
  rather than an override. The server refuses any create or update that disagrees with the
  topic. The one editable case is a Device registered before it has a topic. The wiring
  screen renders the field as a read-only chip wherever the topic decides it, so it never
  offers an edit the server will refuse.
- **A planned Device count.** This used to be asked for during onboarding and was removed:
  a count typed from a contract before any Device existed began drifting from reality the
  moment one was registered, and nothing depended on it enough to catch it being wrong.
  The screen now shows the count that matters — the actual number of registered Devices,
  grouped by type, which is derived and therefore cannot drift.

**Tag binding — connecting payload keys to meanings.** When Devices are registered in bulk,
each one's bindings are seeded from its Device Model's signal list, so it decodes something
from its very first message instead of looking broken. After that:

- `GET /devices/{id}/unmapped-keys` lists payload keys that are arriving and that nothing
  is mapped to. Those values are being discarded, and the screen says so.
- `GET /discovery/topic?topic=…&device_type_code=…` returns the latest payload for one
  topic, both as published and reduced to the flat key-and-value form ingestion would
  actually decode, plus a **suggested** Tag for each key.
- The Tag Mapping screen lets an administrator confirm or change each mapping, with a
  per-Device scale factor and offset.

**One trap that is worth stating explicitly: a payload key's meaning depends on the Device
Type.** The key `VRY` is 11.037 coming from the customer's multi-function meter (an eleven
thousand volt feeder, in kilovolts) and 799.9 coming from their inverter (an eight hundred
volt bus, in volts). A lookup by key alone resolves both to the same Tag, and one of them
would be stored as "799.9 kilovolts" — with two of the three phases quietly passing the
range check while doing it. The suggestion is therefore always made with the Device Type
taken into account, and the binding an operator confirms is the authority, never the
suggestion.

### Step 5 — Set the wiring and the enclosures

Screen: "Wiring and Diagram" (`/admin/hierarchy`).

This is where "what does this Device feed into" is set, one Device at a time, either by
dragging a Device onto its parent or by picking the parent from a list on the row. Both do
exactly the same thing. The diagram redraws beside you from the server's own tree builder
— there is no second layout implementation in the browser that could disagree with the
real one.

Two rules are enforced here:

- **No loops.** Pointing A at B when B already feeds A is caught at the moment of the
  gesture and refused with "that would make A feed into itself", rather than producing a
  diagram with pieces mysteriously missing.
- **No crossing an enclosure wall.** A Device inside a control room may not be wired to one
  outside it. The room owns exactly one outgoing connection of its own; seventeen inverters
  in a control room do not each run a separate cable to the transformer. The list of
  possible parents only offers Devices on the same side of the wall, so the screen never
  proposes an edit the server would refuse.

### Step 6 — Check readiness and activate

Screen: the final step of the wizard, and available any time from
`GET /plants/{id}/commissioning`.

Onboarding fails quietly rather than loudly, and that is the problem this step exists for.
A Device registered without a topic never reports. A Device with no bindings decodes
nothing. An inverter with no rated capacity has no specific yield. Every one of those looks
on every other screen exactly like equipment that has not been switched on yet — so the
plant gets activated, the gaps ship, and the numbers are quietly wrong for a month.

Each check is therefore named, counted, and attributed to a specific Device:

| Check | Severity | Meaning |
|---|---|---|
| `no_devices` | Blocking | The plant has no equipment registered |
| `no_dc_capacity` | Blocking | Performance ratio divides by it |
| `device_without_topic` | Blocking | It will never report |
| `device_without_bindings` | Blocking | It will decode nothing |
| `no_ac_capacity` | Warning | Capacity utilisation factor divides by it |
| `no_region` | Warning | Carbon figures need the local grid factor |
| `no_kpi_panel` | Warning | The plant-level figures Device is missing |
| `device_partially_bound` | Warning | Some of the model's signals are unbound — usually a missing string count |
| `device_never_heard` | Warning | Nothing has arrived from it yet |
| `inverter_without_capacity` | Warning | Specific yield is energy divided by capacity |
| `device_unmapped_keys` | Warning | It is publishing signals nothing is mapped to; they are being discarded |
| `multiple_sld_roots` | Warning | More than one Device feeds into nothing, so the diagram will render as separate trees |
| `device_without_parent` | Information | Its place in the chain is not set |

Activation is refused while any blocking check stands. It can be overridden — the operator
may know something the checks do not — but never by accident: the override is a separate,
labelled action. The status path is `draft` → `commissioning` → `active`. A plant in
"commissioning" has data flowing and being validated, and is excluded from fleet totals.

### Step 7 — Command-line alternatives

For bulk and recovery work, the same operations exist as commands:

| Command | What it does |
|---|---|
| `python -m solarcms.cli seed` | Loads the platform catalogue: device types, tags, roles, permissions, dashboards, topic shapes, default alarm rules. Safe to run repeatedly |
| `python -m solarcms.cli create-superadmin` | Creates the first platform administrator |
| `python -m solarcms.cli create-client-user` | Creates a user inside one customer, with a role and plant access |
| `python -m solarcms.cli commission-from-broker` | Listens to the broker for a while, compares what is publishing against what is registered, and proposes registrations. Dry run by default; writes only with `--apply` |
| `python -m solarcms.cli collectors-from-topics` | Backfills each Device's enclosure name from its topic. Dry run by default |
| `python -m solarcms.cli onboard-test-plant` | Registers the customer's test broker as a Client, a Plant and Devices |

Two of these carry a lesson worth repeating. `commission-from-broker` once turned a *room*
into a piece of switchgear: the enclosure segment of the topic became a Device that
seventeen inverters pointed at as both their parent and their transmitter, so the
operator's diagram showed the plant wired *through the control room* between the inverters
and the meter. Nothing errored; the shape was simply a lie. And the broker probe once read
the wrapper of the formal envelope as if it were the Device's three signals — meaning a
Device registered from an envelope publisher would have been created with **zero** bindings:
equipment that exists, appears on every screen, and decodes nothing. Both now call the same
normalising function that ingestion uses, never a second copy of the rule.

---

## 9. How the two Single Line Diagrams are drawn

The system draws the electrical picture of a plant in more than one way, on purpose,
because two different questions need two different pictures. Neither is a saved drawing.
**Nothing is ever positioned by hand and nothing is stored as a layout.** Every picture is
recomputed from one field per Device — "what do I feed into" — and from the catalogue,
every single time it is requested.

Before the details, the rules that apply to every drawing:

- **Blocks never appear in any electrical diagram.** A Block says *where* a Device is; the
  parent pointer says *what it is wired into*. Putting a geographic grouping into an
  electrical diagram makes the diagram wrong.
- **Devices that carry no current are never part of the electrical model.** A weather
  station and a plant controller are real, monitored Devices, but electricity does not
  flow through them.
- **A Collector is never drawn as a box in the chain.** A control room is an enclosure. No
  current flows *through* a room. It is drawn as a dashed outline *around* the Devices
  inside it.
- **No wire is ever drawn from an enclosure to the Devices inside it.** Containment is what
  the outline says. Seventeen wires would claim seventeen cables, where the entire point is
  that there is one.

### 9.1 Diagram one — the four-stage schematic

Where it appears: the **Single Plant** dashboard.
Server endpoint: `GET /plants/{id}/sld-stages`.
Server code: `domain/sld_stages.py`. Browser component: `SldSpine.tsx`.

**The question it answers:** is this plant healthy, and how does it compare with the next
plant?

**How it is built.** Every Device that carries current is folded into exactly one of four
stages, and the folding is decided **by Device Type**, never by Device, Plant or Client:

```
   PV Array    ──►   Inverters    ──►   Transformer   ──►    Grid
   ▦                 ⌁                  ⊜                    ⌸

   PV_ARRAY          INVERTER           TRANSFORMER          MCR_SECTION
   SMB               ACDB               VCB                  MFM
   DCDB              ICR_SECTION        ISOLATOR             ABT_METER
```

In words: direct-current generation and collection go into **PV Array**; conversion from
direct to alternating current and the low-tension collection that follows it go into
**Inverters**; the step-up to high tension and its switching go into **Transformer**; and
the evacuation point and its metering go into **Grid**.

The mapping shown above is the **default**. What is actually read at run time is a column
on the device type table. So moving, for example, the vacuum circuit breakers that sit in a
main control room from the Transformer stage to the Grid stage is a single database update,
not a code change and not an argument. The circuit breaker is the one genuinely ambiguous
type — the customer's schedule places them both at transformer bays and at main control
room feeder positions, and a type can only fold one way.

**Always four stages, always in that order, on every plant.** Left to right, generation to
grid — the direction every engineer reads a single line diagram in, even though the
underlying pointer runs the other way ("what do I feed into").

**A stage with no Devices still renders**, marked "not instrumented". This is deliberate.
On a rooftop plant an empty Transformer stage is completely normal; on an eight megawatt
plant it means somebody forgot to register a transformer. Hiding the box would conceal the
second case in order to tidy up the first. And dropping empty stages would make the diagram
a different shape on every plant, which is precisely the thing this view exists to prevent.

**Each stage box shows:**
- its name and a symbol;
- a health dot: green when every Device in the stage is reporting, amber when some are not,
  red when none are, and grey when no Device is registered there at all;
- "how many online out of how many registered";
- a small list of figures resolved for that stage.

Partial loss is shown as amber, not red, deliberately: eleven of twelve inverters running
is not an outage, and colouring it the same as a dead stage trains operators to ignore the
colour.

**The figures inside each box** come from the slot system described below, and each stage
resolves **only against its own Devices**. So a figure written as "the sum of the inverters'
alternating-current active power" inside the Inverters stage cannot accidentally pick up a
meter sitting in the Grid stage.

**If a Device carries current but its type maps to no stage**, it is reported in a warning
line under the diagram rather than silently vanishing — that means somebody added a device
type to the catalogue without giving it a stage, and the alternative is a diagram quietly
missing a switchyard.

**Where the numbers in the boxes come from — the slot system.** The dashboard is one fixed
screen on every plant, and what varies is not *which* figures matter but *which Device is
in a position to report them*. So a **slot** is a *position on the screen* — for example
"current power" — not a Tag. Each slot carries an ordered list of candidates, each naming a
Device **Type**, a Tag, and how to combine several Devices' values. The first candidate the
plant is actually equipped for wins.

Three rules govern this:
- Resolution is **planned against what the plant is bound to, and only then read against
  actual values**. That is what separates "there is no settlement meter here" from "the
  meter has gone quiet".
- **Provenance travels with every value.** 6.32 megawatts read from a settlement meter and
  6.32 megawatts summed from twelve inverters are different claims, and the screen says
  which one it is making.
- **A missing source yields unknown, never zero.**

A plant that genuinely deviates gets one row in an overrides table, carrying a note. That
table is expected to be empty, and the fact that it usually is empty is what keeps this on
the right side of the rule against per-plant dashboards. A drag-and-drop dashboard canvas
was considered and rejected: it makes every plant a bespoke artefact that somebody has to
build and nobody can compare with another.

### 9.2 Diagram two — the detailed tree, built from the plant hierarchy

Where it appears: the **Single Line Diagram** dashboard, and the **Wiring and Diagram**
editor, which show the identical component side by side with the editing controls.
Server endpoint: `GET /plants/{id}/sld` plus `GET /plants/{id}/collectors`.
Server code: `domain/sld.py`. Browser component: `SldTree.tsx`.

**The question it answers:** which inverter is the broken one, and what is this plant
actually wired like?

**How it is built, on the server.** The server takes every Device at the plant and:

1. Keeps only the Devices that carry current. The rest are returned in a separate list
   called "excluded, not in the power path" — returned, not dropped, because the caller
   still has to show them somewhere.
2. Builds the tree purely from each Device's parent pointer. Nothing else is used. No
   Blocks, no enclosures, no device types.
3. A Device whose parent is absent from the tree becomes a **root** rather than being
   discarded. An inverter wired through a Device that carries no current is still part of
   the electrical story, and silently dropping it would make the diagram claim the plant
   has less equipment than it does.
4. Loops are detected by counting reachable nodes in one pass, not by recursion, so
   malformed data can never hang the request. Anything caught in a loop is detached and
   reported in an "orphaned" list, which the screen shows as a warning rather than hiding.
5. Siblings are sorted so that Devices sharing an enclosure stay **adjacent**, and only then
   by code. This changes no relationship — the tree is still the parent pointers and
   nothing else — but it is what lets the renderer draw one unbroken outline per enclosure
   instead of an outline with somebody else's inverter sitting inside it. Devices in no
   enclosure sort first, so unenclosed equipment does not end up wedged between two boxes.

The server also returns the list of enclosures at the plant: each one's name, how many
Devices it holds, how many of those carry current, and the single Device it feeds into.

**How it is drawn, in the browser.**

The browser folds the server's two answers — the electrical tree, and the enclosures with
their one edge each — into a single layout tree, because only the renderer needs them
joined:

- An enclosure becomes a node in the **layout** only. It is not a Device: it has no
  identity, no type, no status, no reading, and clicking it selects nothing. Its members
  are nested inside it, and the enclosure node hangs under whatever Device the room feeds.
  This is what stops seventeen now-parentless inverters from fanning out across the diagram
  as seventeen separate roots: they sit in the control room, and the control room has one
  line to the meter.
- Devices that carry no current are added as leaves, drawn dashed and unwired, and they
  keep their place **inside** their enclosure when they have one. A weather station in the
  main control room should look like it is in the main control room. The distinction worth
  holding: the *model* excludes them, the *picture* shows them.
- The layout library `d3-hierarchy` computes every position. React draws the actual
  picture. The library never touches the page directly — mixing two things that both want
  to own part of the page is how a chart ends up with orphaned nodes after a redraw.

**The enclosure outline** is then simply the extent of that enclosure node's descendants,
because the layout placed them contiguously by construction. It is drawn:

- **behind** everything, because a room contains equipment rather than covering it;
- **dashed**, because a solid outline at that weight reads as a component, and an enclosure
  is not one;
- labelled with the room's name on the left and the literal word "collector" plus the
  Device count on the right — an unlabelled dashed box gets read as a selection, a group,
  or a fault region by three different people.

**The connecting lines** are drawn orthogonally — straight segments with right angles,
never curves — because a single line diagram is a schematic and a curve reads as a
data-flow arrow rather than a conductor. A line running into an enclosure **stops at the
outline's border**, not at a Device inside it: the connection belongs to the room, and
running it to one of the Devices would say the cable lands on that Device.

**Live state is overlaid** on each box: communication status from the health table, a live
electrical value from the socket, and a staleness marker computed with the same threshold
the health sweeper uses — so the diagram and the alarm agree rather than disagreeing by a
few seconds. Clicking any box opens a panel with everything recorded about that Device: its
three groupings, its enclosure, its topic, its health and its model.

**The earlier approach, and why it changed.** The enclosure outline used to be computed by
measuring where each member happened to land and drawing one rectangle around the extremes.
Because members were positioned by the *electrical* tree, nothing guaranteed they landed
next to each other — a control room can hold an inverter at one end of the chain and the
meter at the other — so one rectangle could also enclose equipment that was not in that
room. A diagram that says a Device is somewhere it is not is worse than one that says
nothing. That version tried one rectangle, checked it for intruders, and split the group
into several same-named outlines when it found any. Making the enclosure a node in the
layout removed the problem entirely rather than checking for it, which is a better
guarantee than a check.

**When there is nothing to draw**, the screen says so in words — no Devices carry current
at this plant, so there is no electrical tree — instead of showing an empty frame. And when
the tree is very small, it explains that per-Device publishing has not started yet and the
tree will fill out on its own. That is a data state, not a fault, and saying so plainly
stops a small diagram from being read as a broken one.

### 9.3 A third drawing, worth knowing about — the rolled-up chain

Where it appears: at the top of the **Single Line Diagram** dashboard, above the detailed
tree. Browser component: `PlantFlow.tsx`. It is computed entirely in the browser from the
Device list.

**The question it answers:** what is this plant's actual chain of equipment, at a glance?

It is a middle ground between the two diagrams above. It collapses every Device of the same
type at the same distance from the grid into one box: twelve inverters become one box
reading "12 / 12 online". Unlike the four-stage schematic, **nothing about the sequence is
fixed** — the stages are derived from the same parent pointers the real diagram uses, so a
plant with two transformers, a meter in the middle of the chain, or a control room section
between the transformer and the grid produces a different row of boxes with no code change.

Depth is measured from the grid end: a Device that feeds into nothing is depth zero, and
larger depths are drawn further left. Photovoltaic arrays are pinned leftmost regardless,
because before anybody sets the wiring every Device is its own root at depth zero, and an
array would otherwise be ordered alphabetically and land beside the grid — the exact
opposite of where generation begins.

A box shows the enclosure name only when **every** Device in it agrees on one. A stage split
across two rooms shows none, because claiming a stage is "in the main control room" when
half of it is elsewhere would be worse than saying nothing.

Values inside a box are combined according to the **Tag's own unit**, not the device type:
units that add up across machines (power, energy, current, counts) are summed, and
everything else is averaged. Twelve inverters produce twelve lots of power, which sum, but
they each sit at roughly the same voltage, which does not.

### 9.4 The three pictures side by side

| | **Four-stage schematic** | **Detailed tree** | **Rolled-up chain** |
|---|---|---|---|
| Answers | Is this plant healthy, and how does it compare? | Which inverter is broken? | What is this plant actually wired like? |
| Shape | Always the same four boxes | Whatever the wiring is | Whatever the wiring is, rolled up |
| Built from | Device **Type** → stage column | Parent pointers only | Parent pointers, grouped by depth and type |
| Built where | Server | Server builds, browser draws | Browser |
| Appears on | Single Plant dashboard | Single Line Diagram dashboard, and the wiring editor | Single Line Diagram dashboard |
| Enclosures | Not shown | Dashed outline around members | Named on a box when all members agree |

---

## 10. How data is stored and how long it is kept

**Readings are narrow rows, never columns.** One row is: time, client, device, tag, value,
quality, source time. There is no column per measurement. Different device models publish
different signal sets, so a wide table would be mostly empty and every new model would be a
schema change.

The customer identifier is deliberately repeated onto every reading row, even though it
could be looked up through the Device. That is what lets the security rules and the storage
pruning work without a three-table join on every query.

**Storage is a cascade of four automatic summaries**, each reading from the one below it:

| Level | Resolution | Kept for |
|---|---|---|
| Raw readings | every value as received | 30 days |
| One-minute summary | 1 minute | 1 year |
| Fifteen-minute summary | 15 minutes | 3 years |
| One-hour summary | 1 hour | 10 years |
| One-day summary | 1 day | 10 years |

Each summary stores the average, the minimum, the maximum, the last value and the count,
because a summary cannot branch on how a particular Tag ought to be rolled up. The reading
path picks the right column: averaging a cumulative energy counter would be meaningless.

Because the cascade is hierarchical, delay compounds down it. Every level therefore runs
with real-time aggregation switched on, meaning a query sees both the materialised buckets
and the not-yet-materialised recent data. **This was a real and subtle bug.** The helper
that creates these summaries expressed "real time, yes" by *omitting* the setting, and the
database's default for that setting flipped in a later version — so every level was created
the opposite of what was asked for. Each level inherited the delay of the one below and
added its own, the hourly level ended up about two and a half hours behind, and the plant
figures endpoint read the hourly level, so today's energy, performance ratio and capacity
factor were computed from data hours old on a screen whose entire purpose is *now*. The
general lesson: **a helper must never express intent by omitting a setting**, because an
omission is indistinguishable from a default that later changes underneath it.

Anything that reads history **asks which level to use** rather than naming one. The rule is:
pick the coarsest level that both covers the requested time range and still retains it. A
year of one-minute rows is 525,600 points per Tag, which no chart can draw and no browser
should be asked to receive. Requests estimated to exceed twenty thousand points are refused
before the query runs.

Raw message payloads are also kept, for ninety days, including the quarantined ones. That
store is the only route back if a binding turns out to have been wrong.

---

## 11. Security: how one customer is kept away from another customer's data

**The database enforces it, not the application code.** Every request, after verifying its
login token, sets four session variables — the user, their customer, their role, and
whether they are a platform administrator — and switches to a restricted database role.
Row-level security policies then filter every query. A query that forgets to filter by
customer returns **zero rows**, not somebody else's generation data.

Four independent dimensions of access:

1. **Customer** — which company's data exists for you at all.
2. **Plant** — which plants you were granted. **An empty grant means zero plants, never
   all of them.** A Client Administrator is the exception: they automatically get every
   plant of their own Client, which is why the first user of a new Client defaults to that
   role.
3. **Dashboard** — which screens you may open. A user without a dashboard has no web
   address for it, not a hidden menu item.
4. **Action** — what you may do: view dashboards, acknowledge alarms, export data, generate
   reports, modify configuration, manage users, manage plants, administer the platform.
   Permissions are read from the database on every single request rather than carried in
   the token, so revoking one takes effect immediately instead of in fifteen minutes.

Four roles exist: Super Administrator, Client Administrator, Client Employee, and Guest.
Roles are rows in a table, so changing the model is data, not a schema change.

**Telemetry is protected differently, and the reason is not obvious.** TimescaleDB refuses
to apply row-level security to a compressed table. That pits the storage sizing against the
security rule. Both are kept: the readings tables and the summary levels stay compressed
with no row-level security, and **the web service holds no database privilege at all on
them**. It reads only through protected views. So a query written against the raw table
fails loudly — which is the design working, not a bug.

Three separate database roles exist at run time — one for the web service, one for
ingestion, one for the scheduler — because the scheduler reads alarms, escalations and
users, none of which ingestion has any business seeing.

**One place is genuinely different and must be treated carefully:** the scheduler runs with
platform privileges, so the protected views do not scope it. Report generation has to
filter by customer itself. This is the single place where isolation is not inherited from
the database, and a missing filter once leaked another customer's meter into a financial
report before the check was added.

Three groupings are kept separate on every Device, and collapsing any two makes both
unanswerable:

- **Block** — where it physically is (geographic).
- **Parent** — what it feeds into (electrical; this is the diagram).
- **Reports via** — what transmits it (communication).

The third is what separates "communication loss" from "equipment downtime". Without it, a
failed data collector is recorded as generation downtime and corrupts the availability
figures.

---

## 12. Alarms and equipment health

**Alarm rules** are rows. Each names a Tag, an operator, a threshold, optionally a second
threshold and a clearing threshold, a duration before it fires, a severity, and a scope
(the whole customer, or one plant). Rules can use the usual comparisons, plus two operators
for on-or-off contacts — because some of the customer's equipment, such as transformers and
vacuum circuit breakers, publishes nothing but digital contacts and has no number to
compare against. Writing a threshold rule against such equipment is therefore forbidden.

**Alarm classification** separates communication failures from equipment failures, so the
list can be filtered by which kind of problem it is.

**Escalation** is time-based: an alarm left unacknowledged past a configured delay moves to
the next level and notifies the next person, with a minimum severity so a low-severity
alarm never escalates at all. Notifications can go by electronic mail, and there are
adapters for messaging and short message service, though the messaging provider is not yet
confirmed.

**Detection latency is known and measured**: the pipeline throttles before publishing to
the alarm stream, so the delay is the Tag's minimum interval plus the rule's debounce
duration. A sixty second throttle plus a sixty second debounce opens an alarm one hundred
and twenty seconds after the condition began.

**Health** is described in section 4.4. Worth repeating here: a permissive security policy
is not the same as a permission grant. The health sweeper once had a policy that allowed it
to write, but no actual grant to insert or update — so every sweep failed with "permission
denied", logged it, and went back to sleep. Communication status stayed empty across the
entire fleet and nothing else noticed. The rule learned from that: **a worker that catches
and logs errors in its main loop needs a test that asserts a row was actually written.**

---

## 13. Reports

Four report definitions exist, and they are rows rather than code, so adding one is an
insert:

| Report | What it contains | Financial |
|---|---|---|
| Daily Generation | Per-Device export over a day, with performance ratio, capacity factor and carbon avoided | No |
| Monthly Performance | Per-Plant monthly summary, from the daily summary level | No |
| Monthly Settlement | Revenue-grade export for invoicing | **Yes** |
| Device Availability | Time-weighted availability per Device, from health transitions | No |

Two rules shape all of them:

1. **Reports read the summary levels, never the raw readings.** A monthly all-plant report
   is a query over daily buckets, not a scan of billions of rows.
2. **A financial report is computed from the settlement meter only, never from an
   operational meter.** The settlement meter is the sealed, revenue-grade instrument; an
   operational multi-function meter has no commercial standing. A financial report
   requested where no settlement meter is available **fails**, and says why, rather than
   quietly falling back — producing an invoice figure from the wrong instrument is worse
   than producing none at all.

Output is an Excel workbook always, and a PDF when the optional rendering library is
installed. When it is not, the run still succeeds and reports the PDF as unavailable,
because a report that arrives in one format beats a report that does not arrive. Download
links are signed and expire.

---

## 14. Live updating on the screen

The browser holds **one** WebSocket connection for the whole application. Nine inverter
tiles must not open nine sockets, so it lives in one place and components subscribe through
it. Rooms are assigned by the server from the login token; there is no way for the browser
to ask to join one.

**The socket is a trigger, not a source, for the headline figures.** A dashboard value is
resolved on the server against what the plant is actually bound to, and its provenance
travels with it. Summing device frames in the browser would produce a number with no
provenance at all, and a second implementation of an aggregation rule that already exists.
So when a reading for a plant arrives, the browser marks the relevant queries stale and
refetches; the figure still comes from the server.

Frames arrive per Device, so a plant with twenty Devices produces twenty frames per
publishing round. They are gathered for one second and refetched once, which keeps the
request count near one per round however many Devices report. The background polling timer
relaxes to thirty seconds while the socket is open and tightens back to five or ten seconds
when it closes, so this is a net **reduction** in requests rather than an addition.
Measured: six seconds of silence produces zero requests; one frame causes both tiles to
refetch about one second later; forty idle seconds went from twelve requests down to two.

This cannot make a tile fresher than the equipment. If the customer publishes once a
minute, the number is still up to a minute old. It removes only the delay *we* were adding.

One trap worth naming: a "stale time" setting is **not** a refresh interval, and reads
exactly like one. The portfolio figures carried a thirty-second stale time and no refresh
interval, which means no refresh at all — the figures were frozen at page load, silently
and correctly-looking.

---

## 15. What the system deliberately does not do yet

Some things are not built because the customer has not yet supplied the information they
depend on. Building them anyway would mean inventing answers, and an invented answer in a
performance figure is indistinguishable from a measured one.

Specifically still open:

- **The unit and scale of each Tag.** Units are known for seven of the seventeen device
  types, from the customer's own signal schedule. **Scaling is not known for anything** —
  the schedule's range column is blank throughout. This is the dangerous half: a unit says
  what 11.37 means; a scale says whether the register holds 11.37 or 11370, and a
  factor-of-one-thousand voltage error looks entirely plausible in the data.
- **The customer's own formulas** for performance ratio, capacity utilisation factor and
  availability. The system uses standards-based defaults, and **every computed figure is
  returned together with the name of the formula variant that produced it**, so that when
  the real definitions arrive, historical figures can be identified and recomputed rather
  than silently superseded.
- **Whether particular signals are running counters or instantaneous values**, what the
  counter maximum is before it rolls over, and which meter takes precedence over which.

Because of this, **every assumed value in the entire system lives in one file** and nowhere
else: `domain/assumptions.py`. Replacing an assumption is a single-file edit followed by a
re-seed, never a search across the project. The one exception, added on 16 September 2026:
the arithmetic for the calculated Tags is **supplied by the customer**, transcribed from
their own sheet, and marked as supplied rather than assumed — except the capacity
utilisation factor, which they left blank.

Also worth knowing:

- Alarm rule changes require an alarm worker restart, because rules are cached for the
  worker's lifetime. This is recorded as a limitation rather than pretended otherwise.
- The Tag Mapping screen cannot yet show the live **raw payload key** beside a binding — it
  shows the live decoded value instead, which confirms that a binding is producing
  something but not what the publisher called the key.
- The integration test suite runs against the development database and leaves its fixtures
  behind, so that database accumulates test plants and test clients over time.

---

## 16. The state of the live installation right now

Checked directly against the running database on 20 September 2026.

**Platform catalogue** (global reference data, loaded by the seed command):

| Thing | Count |
|---|---|
| Device Types | 21 |
| Tags | 238 |
| Device Models | 33 |
| Model-to-Tag rows | 364 |
| Dashboard slots | 51 |
| Default alarm rules | 27 |
| Registered topic shapes | 5 |

**Customer data:**

| Thing | Count |
|---|---|
| Clients | 1 (`KULAR_GREEN`) |
| Plants | 1 (`KULAR_GREEN`) |
| Devices | 21 |

The 21 Devices are: 17 inverters, 1 multi-function meter, 1 weather monitoring station,
1 plant controller, and 1 plant figures panel.

**This single-customer state is deliberate.** Every other plant was a test fixture and was
removed on 19 September 2026, along with three Devices still publishing on the retired
two-segment topic shape.

**Two logins exist:** one platform Super Administrator belonging to no customer, and one
Client Administrator on `KULAR_GREEN` with access to all its plants and dashboards. Either
can be recreated with the command-line tools.

**Database schema:** migrations 0001 through 0024, all applied.

**Build status:** all eleven planned build phases are complete. Every specified endpoint
exists, all five processes run, and the unit test suite passes.

---

## 17. How to run the whole thing on a laptop

Python 3.12 specifically — one of the database drivers has no prepared package for 3.13 or
newer. Every server command below is run from the `solarcms-backend` directory, and every
browser command from `solarcms-frontend`. There are also convenience scripts at the top
level — `scripts/dev-up.sh`, `scripts/dev-status.sh` and `scripts/dev-down.sh`.

**First, start the infrastructure.** If Docker Desktop is not running, the database, the
cache and the development broker are all down at once, and the visible symptom is that the
entire user interface is blank.

```
docker compose up -d
```

**Then create the database roles**, as a database superuser. Roles are created outside the
migrations, because the migration account normally has no permission to create roles.

```
psql -f scripts/bootstrap_roles.sql
```

**Then apply the schema and load the catalogue.**

```
.venv/bin/alembic upgrade head
.venv/bin/python -m solarcms.cli seed
```

**Then start the five processes**, each in its own terminal:

```
uvicorn solarcms.api.main:app
python -m solarcms.workers.ingest
python -m solarcms.workers.alarm
python -m solarcms.workers.health_sweeper
python -m solarcms.workers.scheduler
```

**And the browser side:**

```
npm install
npm run dev
```

**Checks that must stay clean:**

```
ruff check .
mypy src/solarcms
pytest tests/unit          needs nothing running
pytest tests/integration   needs the migrated database
npm run typecheck
npm run lint
npm test
```

**A tool worth knowing about:** `tools/simulate.py` publishes either topic shape into the
broker and can deliberately induce faults — a silent device, a frozen value, an
underperforming device — which are otherwise impossible to sit and wait for.

**One warning about the shell.** The shell here is zsh, which does **not** treat the hash
character as a comment when typed interactively. Never put an explanatory comment on the
same line as a command somebody will paste: it will fail with an "unrecognised arguments"
error. Put the explanation on its own line.
