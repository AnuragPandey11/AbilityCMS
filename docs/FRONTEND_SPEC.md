# SolarCMS Frontend — Build Specification

**Version:** 1.1 · **Date:** 17 September 2026
**Audience:** an engineering agent implementing the frontend from scratch.

---

## 0. Read This First

### 0.1 Authority

This document tells you **how to build the frontend**. It is subordinate to:

| Rank | Document | Authority |
|---|---|---|
| 1 | `MASTER_SPECIFICATION.md` | Vocabulary, confirmed decisions, scope, open questions |
| 2 | `BACKEND_SPEC.md` | The API you consume — endpoints, auth, error format |
| 3 | `TAG_CATALOGUE.md` | Units per Tag, for the 7 Device Types the client has supplied |
| 4 | `BROKER_OBSERVATIONS.md` | What data actually arrives today, as opposed to what is contracted |
| 5 | **This document** | Frontend structure, state, routing, components |

Where this conflicts with any of them on a fact, they win.

### 0.2 The backend already exists

All 50 endpoints in BACKEND_SPEC §8.2 are built and running. **Read
`GET /openapi.json` — it is generated from the running code and is therefore
more current than any table in this document.** `/docs` serves Swagger UI.

Do not mock the API. Point at a local instance:

```bash
uvicorn solarcms.api.main:app --port 8000     # from solarcms-backend/
```

### 0.3 The rule that governs every screen

**F-14: dashboards are configuration-driven. Separate dashboards must not be
developed per Plant.**

This is the constraint most likely to be violated by accident, because the
natural way to satisfy a client demo is to special-case their Plant. Concretely:

- No component may branch on a Client, Plant, or Device name or id.
- Which Tags a Device shows comes from `GET /devices/{id}/bindings` and
  `GET /catalog/tags`, never from a hard-coded list per Device Type.
- A new Device Type — and F-12 promises more — must render with **no frontend
  change**. If adding one requires a code change, the design is wrong.

The corollary: a "chart of AC Active Power" is really "a chart of whichever Tags
this Device is bound to, of category `electrical`". Build the second.

### 0.4 What data actually exists today

⚠ Read `BROKER_OBSERVATIONS.md` before designing screens around per-Device data.

The client's broker currently publishes **Plant-level totals only** — three
topics, no Device segment. F-18 says this changes, but until it does:

| Screen | Status today |
|---|---|
| Portfolio, Plant Overview, Plant List, Single Plant | Have data |
| **Inverter Monitoring / comparison / ranking** (tender §8) | **No data.** One meter and one weather station per Plant, no Inverters |
| **Single Line Diagram** | Renders, but the tree is two meters — there is no equipment hierarchy to draw yet |

Build these screens anyway; they are contracted. But build them so an empty state
reads as *"per-Device data has not started arriving"* rather than as a bug or a
blank panel, and use `tools/simulate.py` (which does publish per-Device) for
development.

---

## 1. Stack

```jsonc
{
  "react": "18.3.1",
  "typescript": "5.6.x",
  "vite": "5.4.x",
  "@tanstack/react-query": "5.x",   // server state, caching, refetch
  "@tanstack/react-router": "1.x",  // typed routes; React Router 6 is fine too
  "zustand": "4.x",                 // the little client state that is not server state
  "echarts": "5.5.x",               // time series at 10k+ points
  "d3-hierarchy": "3.x",            // SLD layout only, not rendering
  "tailwindcss": "3.4.x",
  "zod": "3.x"                      // parse API responses at the boundary
}
```

**Why these, where the choice is not obvious:**

- **React Query, not Redux.** Almost everything on screen is server state with a
  freshness requirement — live values every few seconds, KPIs every 30s, a
  catalogue that changes monthly. Caching and invalidation are the whole problem;
  a reducer layer over it adds a copy to keep in sync.
- **ECharts, not Recharts.** A day of 1-minute data for eight Tags is ~11,500
  points, and the raw tier can return 20,000. ECharts renders that with
  downsampling built in; SVG-per-point libraries do not.
- **zod at the boundary.** The API returns numeric fields that are `null` when a
  KPI is undefined (§4.3). Parsing rather than casting turns that into a typed
  union you must handle, instead of `NaN` reaching a chart axis.
- **d3-hierarchy for layout only.** The SLD is a tree the backend already built;
  d3 computes positions, React renders SVG. Do not use d3 to mutate the DOM.

---

## 2. Directory Structure

```
solarcms-frontend/
├── index.html
├── vite.config.ts
├── src/
│   ├── main.tsx
│   ├── api/
│   │   ├── client.ts          # fetch wrapper: auth header, refresh, problem+json
│   │   ├── schemas.ts         # zod schemas mirroring API responses
│   │   └── endpoints/         # one module per router: plants.ts, alarms.ts, …
│   ├── auth/
│   │   ├── AuthProvider.tsx   # token lifecycle, refresh, client switching
│   │   ├── usePermission.ts   # A-4 checks
│   │   └── useDashboard.ts    # A-3 checks
│   ├── live/
│   │   ├── LiveSocket.tsx     # one WebSocket for the app; reconnect + backoff
│   │   └── useLiveDevice.ts   # subscribe a component to one Device's values
│   ├── format/
│   │   ├── datetime.ts        # DD-MM-YYYY HH:MM:SS — tender §28
│   │   ├── value.ts           # unit-aware value formatting
│   │   └── quality.ts         # quality code → label and styling
│   ├── components/
│   │   ├── charts/            # TimeSeriesChart, KpiTile, Sparkline, Gauge
│   │   ├── sld/               # SldTree, SldNode
│   │   ├── tables/            # DataTable with sort/filter/export
│   │   └── state/             # EmptyState, ErrorState, LoadingState
│   ├── dashboards/            # ONE component per dashboard CODE, not per Plant
│   │   ├── PortfolioDashboard.tsx
│   │   ├── PlantOverviewDashboard.tsx
│   │   ├── PlantListDashboard.tsx
│   │   ├── usePlantFleet.ts
│   │   ├── SinglePlantDashboard.tsx
│   │   ├── SldDashboard.tsx
│   │   ├── InverterMonitoringDashboard.tsx
│   │   ├── AlarmsDashboard.tsx
│   │   └── ReportsDashboard.tsx
│   ├── admin/                 # onboarding, users, bindings, alarm rules
│   └── routes/
└── tests/
```

**`dashboards/` has one file per dashboard `code`, and the codes come from the
database.** `GET /auth/me` returns `dashboards: string[]`; the router maps each
code to a component. Adding a dashboard is a row plus a component, and a User who
lacks it never sees the route.

---

## 3. Authentication

### 3.1 The token model

`POST /auth/login` with `{email, password}` returns:

```json
{ "access_token": "...", "refresh_token": "...", "token_type": "bearer",
  "expires_at": "2026-09-11T12:15:00+00:00" }
```

Access tokens last **15 minutes**, refresh tokens **7 days**.

**A token carries exactly one active `client_id`.** A User may belong to several
Clients; `POST /auth/switch-client?client_id=N` reissues against another
membership. Treat switching as a **full state reset** — clear the React Query
cache entirely. Every cached Plant, Device and Reading belonged to the previous
Client, and showing one of them after a switch is the single worst bug this
frontend can have.

### 3.2 Refresh

Refresh on a 401, once, then retry the original request. If the refresh also
fails, clear tokens and route to login.

Do not refresh pre-emptively on a timer. `expires_at` is advisory: the server
also revokes on deactivation, and a User disabled mid-session must be ejected on
their next request, not fifteen minutes later.

### 3.3 Login errors, and what they must not reveal

| Response | Meaning | What to show |
|---|---|---|
| 401 | Wrong password, unknown user, **or** deactivated account | "Invalid email or password." — nothing more |
| 403 `no Client membership` | Valid credentials, no Client | "Your account is not attached to a Client. Contact your administrator." |
| 409 | Belongs to several Clients | A Client picker, then retry with `client_id` |

The backend deliberately returns an identical 401 for the first three. **Do not
try to be more helpful** — distinguishing them in the UI reintroduces the account
enumerator the backend was careful to avoid.

### 3.4 The four access dimensions

MASTER §4.2. All four are enforced server-side; the frontend mirrors them so the
UI is coherent, **not** as a security control. Hiding a menu item is not access
control and never was.

| # | Dimension | Source | Frontend use |
|---|---|---|---|
| A-1 | Client | token `client_id` | Header context, switcher |
| A-2 | Plant | `/auth/me` → `plants[]` | Plant pickers list only these |
| A-3 | Dashboard | `/auth/me` → `dashboards[]` | Which routes exist at all |
| A-4 | Action | `/auth/me` → `permissions[]` | Which buttons render |

```tsx
// A-4. Absence hides the control; the server refuses it regardless.
const canAcknowledge = usePermission("alarm.acknowledge");
```

⚠ **Never gate on `role`.** Permissions are composable rows in
`role_permissions`, and a custom role is data rather than a schema change
(tender §29). Code that says `role === "admin"` breaks the moment a client
defines their own role — which the backend explicitly supports.

---

## 4. Displaying values

This section exists because the most likely defect in this frontend is a number
that is confidently, plausibly wrong.

### 4.1 Never hard-code a unit

Units come from `GET /catalog/tags` (`unit` per Tag) or from a Device's bindings.
They are **not** what you would guess:

| Tag | Unit | Naive guess |
|---|---|---|
| `HV_VOLTAGE_RY` | **kV** | V — wrong by 1000 |
| `AC_ACTIVE_POWER` | kW | — |
| `GHI` | W/m² | — |
| `GHI_CUMULATIVE` | **kWh/m²** | W/m² — a different quantity entirely |
| `ENERGY_CUMULATIVE_MWH` | **MWh** | kWh, like every other energy Tag |

The client's own schedule mixes kWh and MWh **within one Device** and labels an
Inverter current in kV (`TAG_CATALOGUE.md` §4). Render `unit` verbatim from the
API and never convert client-side; conversion is a backend decision that has not
been made yet.

### 4.2 Show data quality

`readings.quality` is `0` good, `1` out of range, `2` stale, `3` unparseable.
Out-of-range values are **stored and flagged, never discarded** — the backend
keeps `3.29151E-41` deliberately, because it is diagnostic.

So a chart must not plot bad points as if they were data. Render quality ≠ 0 in a
muted colour with a marker, and say why on hover. A silently-plotted denormalised
float looks like a real excursion and will be reported as one.

### 4.3 A KPI can be undefined, and undefined is not zero

`GET /plants/{id}/kpis` returns each figure as an object:

```json
"performance_ratio": {
  "value": null,
  "variant": "poa_uncorrected",
  "undefined_reason": "no irradiation in period"
}
```

**Render `null` as "—" with the reason on hover. Never as 0.** PR is undefined at
night; showing 0% drags every average down and tells an operator their plant
failed.

`variant` names the formula that produced the number. **Surface it** — a tooltip
or an info icon reading *"PR, POA-uncorrected (provisional — OPEN-16)"*. Every
formula is provisional until the client supplies theirs, and figures will be
recomputed. A UI that presents them as settled makes that correction look like a
defect.

### 4.4 Dates

Tender §28: display **`DD-MM-YYYY HH:MM:SS`**. The API sends and accepts ISO 8601
with offset. Convert at the edge only — `format/datetime.ts` — and never store a
formatted string.

Render in the **Plant's** timezone (`plants.timezone`, default `Asia/Kolkata`),
not the browser's. An operator in another country reading a plant's generation
curve shifted by five and a half hours will not notice it is shifted.

### 4.5 Digital Inputs are not numbers

Roughly a third of Tags are Digital Inputs — `category: "status"`, values 0 or 1.
The whole of `VCB` and `TRANSFORMER` is DI (`TAG_CATALOGUE.md` §2.1, §2.5).

Render them as state, not as a line chart: a labelled indicator, and a timeline of
transitions for history. A trip contact plotted as a numeric series is unreadable,
and the thing that matters — *when did it change* — is exactly what a line hides.

---

## 5. Live data

### 5.1 The socket

`WS /ws/live?token=<access_token>`. On connect the server sends:

```json
{ "type": "subscribed", "rooms": ["7:15", "7:16"] }
```

or, when the User can see no Plants:

```json
{ "type": "no_rooms", "detail": "no Plants are visible to this user" }
```

Then, per batch of Readings:

```json
{ "client_id": 7, "plant_id": 15, "device_id": 42,
  "values": { "12": 198.5, "13": 11.37 }, "at": "2026-09-11T12:00:03+00:00" }
```

`values` is keyed by **`tag_id` as a string**. Join against `/catalog/tags` to get
code and unit; cache that catalogue aggressively, since it changes rarely.

### 5.2 Rules

- **One socket per application**, not per component. Fan out through a context.
  Nine Inverter tiles must not open nine sockets.
- **Rooms are Client+Plant scoped and assigned by the server** (I-8). There is no
  client-side subscribe message, and you cannot request a room. If you are not
  receiving a Plant's data, the User is not assigned to it.
- **Reconnect with exponential backoff**, capped around 30s, with jitter. A
  restarting API must not be met by every open tab at once.
- **The socket is a supplement, not a source.** Load current state over REST
  first, then let the socket update it. A tab opened during a broker outage must
  still show the last known values with their age, not an empty dashboard.
- **Show staleness.** Each live tile carries `at`; when it exceeds the Device's
  `expected_interval_s × 2`, mark it stale. That threshold is the same one the
  health sweeper uses, so the UI and the Alarm agree.

⚠ The token is in the query string, so it lands in server logs. Reconnect with a
fresh access token rather than a long-lived one, and never put the refresh token
there.

---

## 6. Dashboards

Tender §7. One component per code; each reads its data from generic endpoints.

### 6.1 `portfolio` — the fleet

Aggregate across every visible Plant. **Portfolio is computed, never stored**
(MASTER §1.1) — there is no `/portfolio` endpoint, and there should not be: sum
what `/plants` returns.

⚠ **Exclude Plants in `draft` or `commissioning` from totals** (MASTER §6.5) — a
half-mapped Plant would otherwise drag fleet PR down. Show them in a separate
"Onboarding" group so they are visible without polluting the numbers.

Tiles: total capacity, current power, today's energy, fleet PR, availability,
CO₂ avoided, active alarms by severity.

### 6.2 `plant_overview` and `plant_list`

Two screens over one data set. The tender (§7) names both and defines neither,
so the split is ⚠ PROPOSED (MASTER OPEN-23): three altitudes, with `portfolio`
above them.

| Code | Question it answers | Form |
|---|---|---|
| `portfolio` | How is the fleet doing? | Totals; no per-Plant rows (§6.1) |
| `plant_overview` | Which Plant needs me right now? | One card per Plant, ordered by need for attention |
| `plant_list` | Working through the Plants systematically | Sortable, filterable, exportable table |

Both read through `usePlantFleet(period)`, which pages `GET /plants`, fans out
`GET /plants/{id}/kpis` per Plant, and joins `/health/devices` and active
`/alarms` by `plant_id` once per render. Fetching lives there and nowhere else:
a User granted both codes must not double the request volume.

**Overview ordering is by Alarm severity, then offline Devices, never by a
KPI.** An undefined PR is the normal night-time state of every Plant in the
fleet; ranking on it would float the whole estate to the top at dusk. Ties are
broken by open-Alarm count, then name, so the order is stable between polls.
The left border carries the only colour with meaning: red for critical/high,
amber for any other open Alarm or an offline Device, grey for no Devices.

**No figure appears on a card that the table lacks.** Overview changes the
shape of the presentation, not what the platform claims to know — OPEN-14, 15
and 16 gate the same numbers on both. `null` renders as "—" with its reason on
both (§4.3).

**No map yet.** `latitude`/`longitude` are on `GET /plants/{id}`, not on the
list item. Adding a map means adding them to the list projection first; N
detail fetches to fake it would be worse than no map.

Table columns: code, name, region, status, DC capacity, live Devices, energy
for the selected period, PR, device health summary, open alarms.

`GET /plants` is cursor-paginated (`?limit=&cursor=`). Follow `next_cursor`;
never construct an offset.

### 6.3 `single_plant`

Header (capacity, status, region, timezone), KPI row from
`GET /plants/{id}/kpis?period=today|month|year|lifetime`, a device-health strip,
a time-series panel, and Blocks **if the Plant has any**.

⚠ **Blocks are optional.** A Plant with zero Blocks is valid and normal
(MASTER §2.2). Render the Block section only when `GET /plants/{id}/blocks`
returns rows — no "Unassigned" pseudo-Block, no empty grouping level.

### 6.4 `sld` — Single Line Diagram

`GET /plants/{id}/sld` returns a ready-built tree:

```json
{ "plant_id": 1, "device_count": 10,
  "roots": [ { "device_id": 3, "code": "MFM-01", "name": "Main Meter",
               "type": "MFM", "variant": null, "children": [ … ] } ],
  "excluded_not_in_power_path": [ { "device_id": 5, "code": "WMS-01", "type": "WMS" } ],
  "orphaned": [] }
```

Three rules, each protecting something confirmed:

1. **Blocks never appear** (Guardrail 11). A Block says *where* a Device is;
   `parent_device_id` says *what it is wired into*. Putting a geographic grouping
   in an electrical diagram makes the diagram wrong.
2. **`excluded_not_in_power_path` is not an error.** A Weather Station and a PPC
   are real, monitored Devices that carry no current. Render them in a side panel
   — visible, outside the tree.
3. **`orphaned` is a data problem worth surfacing.** Show a warning naming the
   Devices; silently dropping them makes the diagram claim the Plant has less
   equipment than it does.

Layout with `d3-hierarchy`, render as SVG. Colour each node by
`comm_status` from `GET /plants/{id}/devices`, and overlay live power from the
socket.

### 6.5 `inverter_monitoring`

Per-Inverter comparison and ranking (tender §8).

⚠ **Rank only within an Inverter variant** (OPEN-13). `device_models.variant` is
`central` or `string`; a central Inverter and a string Inverter have different
Tag sets and different expected outputs, and ranking across them is meaningless.
Group by variant, rank inside each group, and label the grouping.

⚠ **There are no Inverters in the live data yet.** Empty-state this screen with
an explanation, not a spinner.

### 6.6 `alarms`

`GET /alarms?state=&severity=&plant_id=&since=&limit=`.

- One breach produces **exactly one** Alarm, not one per Reading. If the UI
  appears to show duplicates, that is a real bug worth reporting, not something
  to de-duplicate client-side.
- `classification` distinguishes `communication` from `equipment` — tender §18
  keeps them separate, so the filter must too.
- A **Collector failure surfaces as one Alarm covering many Devices**. Show which
  Devices it absorbed; nine "Inverter offline" rows would be the wrong picture.
- Acknowledge with `POST /alarms/{id}/acknowledge`, gated on
  `alarm.acknowledge`. Show `escalation_level` — an Alarm at L2 has already
  woken somebody.

### 6.7 `reports`

List definitions, request a run, poll it, download.

`POST /reports/runs` returns `202` with a `run_id`; poll
`GET /reports/runs/{run_id}` until `state` is `succeeded` or `failed`. Then
`artifact_urls` carries **signed, expiring URLs** — use them directly, do not
re-sign or cache them past their expiry.

Two failures to render specifically rather than as generic errors:

- **`409` on requesting a Financial Report**: no ABT Meter is registered. I-11
  forbids computing one from an MFM — the ABT Meter is the sealed settlement
  instrument. Say that, because "report failed" invites someone to retry forever.
- **`artifact_urls.pdf_unavailable`**: the run succeeded and the XLSX is there;
  PDF rendering is not installed. Offer the XLSX rather than showing a failure.

---

## 7. Administration

Behind `plant.manage`, `config.modify`, `user.manage`, `system.admin`.

### 7.1 Onboarding wizard

Mirrors MASTER §6.5: Client → Plant (`draft`) → Blocks *(optional)* → Devices →
bindings → `commissioning` → `active`.

⚠ **Make `expected_interval_s` a required, prominent field** with a note that it
must come from observation, not the default. The 60s default is an assumption and
the client's broker publishes every ~2.78s; a Device registered at 60s can sit
silent for ten minutes while reading as healthy, because health thresholds
multiply this column.

⚠ **Do not offer a "skip Blocks" toggle that defaults to creating one.** Zero
Blocks is the normal case.

### 7.2 Device bindings

`GET/PUT /devices/{id}/bindings`. This is the most dangerous screen in the
application: a binding decides how every future Reading from that Device is
decoded.

- Show the current binding beside a **live sample** of the raw payload key, so the
  operator can see what they are mapping.
- `PUT` **replaces** the whole set. Make that explicit; a form that looks like a
  merge will silently drop bindings.
- Warn on save that existing Readings are **not** retroactively re-decoded.
  `mqtt_raw` retains payloads for 90 days and is the only route back
  (MASTER §5.3) — but that is a backend replay, not something this screen does.

### 7.3 Alarm rules

Platform defaults (`client_id: null`) are **read-only** to a Client. Render them
distinctly and disable editing; to change one, a Client creates a more specific
rule and scope resolution prefers it (device → plant → device_type → global).

Rules with operator `is_true` / `is_false` carry **no threshold** — the contact is
the condition. Hide the threshold fields entirely for those, rather than showing
disabled inputs that imply a value belongs there.

---

## 8. Errors

Every error is RFC 7807 `application/problem+json`:

```json
{ "type": "about:blank", "title": "Forbidden", "status": 403,
  "detail": "permission alarm.acknowledge required", "instance": "/alarms/5/acknowledge" }
```

`detail` is written for a person and is generally safe to show. The one exception
is **500**, whose detail is deliberately opaque (`"internal server error"`) —
the real message can carry SQL or another Client's identifiers, and it stays in
the server log.

| Status | Meaning here | Handling |
|---|---|---|
| 401 | Missing, expired, wrong-type token, or deactivated user | Refresh once, then log out |
| 403 | Authenticated, lacks the permission | Show `detail`; the control should not have rendered |
| 404 | Absent **or invisible** — RLS returned nothing | Never say "does not exist"; say "not found or not accessible" |
| 409 | A real conflict: duplicate code, no ABT Meter, Block still in use | Show `detail` verbatim; these are actionable |
| 422 | Validation, including "query would return too many points" | Field errors inline; for the point cap, offer a narrower range |

**404 deserves care.** The backend cannot distinguish "no such Plant" from
"another Client's Plant" without leaking the latter's existence. Phrase the UI so
it does not either.

---

## 9. Performance

- **Let the server pick the tier.** `GET /readings?...&resolution=auto` returns
  the tier it used. Never request `readings` for a month — the backend will refuse
  with 422 rather than scan billions of rows.
- **Surface the tier.** A chart of a year is daily averages; label it, or an
  operator will read a smoothed line as a measurement.
- **Respect the point cap.** 422 with a point estimate means narrow the range,
  the Device list, or the Tag list — not retry.
- Cache `/catalog/*` for the session; cache `/plants` for ~60s; do not cache
  `/readings` beyond a few seconds.
- Virtualise any table over ~200 rows. At the F-2 ceiling of 150+ Devices, a
  Device list with live values is a real render cost.

---

## 10. Build Order

| Phase | Deliverable | Done when |
|---|---|---|
| **0** | Scaffold, API client, zod schemas, problem+json handling | A typed call to `/healthz` and `/auth/login` round-trips |
| **1** | Auth: login, refresh, client switch, permission and dashboard hooks | Switching Client clears every cached query |
| **2** | Layout, navigation driven by `/auth/me` dashboards | A User with two dashboards sees exactly two routes |
| **3** | `plant_list`, `single_plant`, KPI tiles with undefined handling | A null PR renders "—" with its reason, never 0 |
| **4** | Time-series charts with tier labelling and quality marking | A year query renders from `agg_1d` and says so |
| **5** | Live socket, staleness indicators | Killing the ingest worker greys tiles within `expected_interval_s × 2` |
| **6** | `sld` | Blocks absent from the tree; non-power-path Devices in a side panel |
| **7** | `alarms`, acknowledge, escalation display | A collector failure shows as one Alarm, not nine |
| **8** | `portfolio` | Draft and commissioning Plants excluded from totals |
| **9** | `reports` | A Financial Report 409 explains the ABT Meter rule |
| **10** | Admin: onboarding, bindings, users, alarm rules | A Plant with 9 Devices can be onboarded through the UI, with and without Blocks |

Develop against `tools/simulate.py`, not the client's broker: it publishes
per-Device data on the canonical topics, and `--fault silent|frozen|underperform`
induces the states the health and alarm screens exist to show.

---

## 11. Guardrails

1. **Never** branch on a Client, Plant, or Device name or id. F-14, I-1.
2. **Never** hard-code a unit, a scale, or a Tag list per Device Type. Read them
   from the API.
3. **Never** render an undefined KPI as 0.
4. **Never** plot a bad-quality Reading as if it were good.
5. **Never** gate UI on `role`; gate on `permissions`.
6. **Never** treat hidden controls as access control — the server enforces it.
7. **Never** show a raw 500 `detail`; it is deliberately opaque.
8. **Never** put a Block in the Single Line Diagram.
9. **Never** rank Inverters across variants.
10. **Never** keep cached data across a Client switch.
11. **Never** display a timestamp in the browser's timezone; use the Plant's.
12. **Never** open more than one live WebSocket per application.

---

## 12. Change Log

| Version | Date | Change |
|---|---|---|
| 1.1 | 17 Sep 2026 | §6.2 rewritten: `plant_overview` is a card grid ordered by need for attention, `plant_list` the table, both over `usePlantFleet`. Previously one component with two headings. MASTER OPEN-23. |
| 1.0 | 11 Sep 2026 | Initial specification, written against the running backend: 50 endpoints, the live WebSocket contract, and the response shapes as generated rather than as designed. |
