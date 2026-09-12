# SolarCMS Frontend

React + TypeScript frontend for the SolarCMS multi-tenant solar plant monitoring
platform, built against `docs/FRONTEND_SPEC.md` v1.0 and the running backend.

## Running it

The backend is not mocked (FRONTEND_SPEC §0.2). Start it first:

```bash
# from solarcms-backend/
uvicorn solarcms.api.main:app --port 8000
python -m solarcms.workers.ingest          # for live data
python tools/simulate.py                   # per-Device data for development
```

Then:

```bash
npm install
cp .env.example .env
npm run dev            # http://localhost:5173
```

The dev server proxies `/api` and `/ws` to `http://localhost:8000`, so no CORS
configuration or absolute origin is needed. Point elsewhere with
`VITE_API_TARGET`.

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with the API proxy |
| `npm run build` | Typecheck and production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint, including the "never gate on role" rule |
| `npm test` | Unit and render tests (no backend needed) |
| `SOLARCMS_LIVE=1 npx vitest run tests/live` | Contract tests against a running API |

The live contract tests parse real responses with the application's own zod
schemas. They fail loudly if the API is unreachable rather than passing empty.
Credentials come from `SOLARCMS_TEST_EMAIL` / `SOLARCMS_TEST_PASSWORD`.

## Layout

```
src/
├── api/          fetch wrapper, zod schemas, one module per router, React Query hooks
├── auth/         token lifecycle, Client switching, A-3 and A-4 hooks
├── live/         the one WebSocket, and per-Device subscription
├── format/       datetime · value · quality — every display rule lives here
├── theme/        light/dark tokens, the provider, and runtime token access
├── components/   charts · sld · tables · state · layout · ui
├── dashboards/   ONE component per dashboard code, never per Plant
├── admin/        onboarding, bindings, alarm rules, users, system
├── state/        the little client state that is not server state
└── routes/       dashboard routes generated from /auth/me
```

## The rules this code is built around

These are the ones most likely to be broken by an ordinary-looking change.

**Dashboards are configuration-driven (F-14).** No component branches on a
Client, Plant or Device name or id. Which Tags a Device shows comes from
`GET /devices/{id}/bindings` joined against `GET /catalog/tags`. A new Device
Type renders with no frontend change. Routes are generated from `/auth/me` →
`dashboards[]`, so a User without a dashboard has no route for it.

**Units are never hard-coded and never converted.** `unit` is rendered verbatim
from the API. The client's own schedule mixes kWh and MWh inside one Device and
labels an Inverter current in kV; converting client-side would turn a documented
oddity into a silent factor-of-1000 error. Conversion is a backend decision that
has not been made (OPEN-15).

**Undefined is not zero.** A KPI's `value: null` renders as `—` with its
`undefined_reason`, never as 0. PR is undefined at night, and 0% drags every
average down and tells an operator their plant failed. `variant` names the
provisional formula and is surfaced, because every figure will be recomputed when
the client supplies theirs (OPEN-16) and a UI that presents them as settled makes
that correction look like a defect.

**Bad-quality Readings are marked, not plotted.** Quality ≠ 0 is cut out of the
line and re-drawn as marked scatter in the quality's colour with the reason on
hover. A silently-plotted denormalised float looks like a real excursion.

**A Client switch clears the entire cache.** `queryClient.clear()`, not
invalidation — invalidation leaves the previous Client's data resident and
renderable while a refetch is in flight.

**One WebSocket per application.** Rooms are Client+Plant scoped and assigned by
the server; there is no client-side subscribe. The socket is a supplement, not a
source: state loads over REST first, and staleness is judged at
`expected_interval_s × 2`, the same threshold the health sweeper uses, so the UI
and the Alarm agree.

**Timestamps render in the Plant's timezone**, formatted `DD-MM-YYYY HH:MM:SS`.
A generation curve shifted by five and a half hours does not look shifted.

**Digital Inputs are state, not numbers.** Roughly a third of Tags are DI, and
all of `VCB` and `TRANSFORMER` is. They render as indicators and a transition
timeline — a trip contact plotted as a line hides when it changed.

**Errors.** A 500's `detail` is deliberately opaque and never shown. A 404 says
"not found, or not accessible" — the backend cannot distinguish an absent Plant
from another Client's without leaking the latter, and neither may the UI. A 422
on `/readings` may be the point cap, which means narrow the range, not retry.

**Gate on permissions, never on `role`.** A custom role is data rather than a
schema change (tender §29). An ESLint rule enforces this. Hidden controls are not
access control — the server refuses regardless.

## Theming

Light is the default ground and follows the client's mockups; dark is available
from the toggle in the header (and on the login card). Three states, not two:
**system** is the default and follows the OS, while an explicit choice writes
`data-theme` onto `<html>` and is remembered in `localStorage`.

Every colour is defined once, in `src/index.css`, as **space-separated RGB
channels** on a CSS custom property. `tailwind.config.js` wraps each as
`rgb(var(--c-x) / <alpha-value>)`, which is what keeps the alpha modifiers
(`bg-ok/10`, `border-accent/30`) working through a variable — a hex there would
silently break every `/nn` opacity in the codebase.

Two consequences worth knowing before editing:

- **No component may hardcode a colour.** `src/` contains no hex literals; the
  charts and the SLD read theme tokens at render time through
  `src/theme/tokens.ts`, because a canvas or an SVG attribute cannot inherit a
  CSS variable. Those helpers are functions rather than constants — a constant is
  evaluated once at module load and freezes whichever theme was active then.
- **The fallback palette in `tokens.ts` must stay complete.** It is what renders
  when the stylesheet has not applied (jsdom in the tests, and the first paint).
  A missing entry resolves to black, which for the quality codes would merge
  "out of range" with "unparseable" and defeat Guardrail 4 without erroring.
  `tests/theme.test.tsx` asserts the four stay distinct.

An inline script in `index.html` applies the stored choice before first paint, so
a dark-theme user does not get a white flash on load.

## Known gap

`FRONTEND_SPEC §7.2` asks the bindings screen to show each binding beside a live
sample of the **raw payload key**. No endpoint exposes `mqtt_raw`, so the screen
shows the live **decoded** value instead and says so. Confirming what the
publisher actually called a key needs a backend read route over `mqtt_raw_v`.

## Build status

All eleven phases of FRONTEND_SPEC §10 are implemented. Typecheck, lint, 59 unit
and render tests, and 12 live contract tests against the running API all pass.
