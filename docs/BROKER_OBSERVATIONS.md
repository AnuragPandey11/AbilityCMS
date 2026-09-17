# Broker Observations — Client Test Broker

**Version:** 1.2 · **Date:** 16 September 2026 · **Status:** Evidence, not decisions

> ⚠ **The broker changed between 10 and 16 September 2026.** Payload keys on
> `KULAR_GREEN/DATA` were replaced wholesale, and the weather topic was renamed.
> Everything in §1 below describes the *10 September* broker and is retained as
> the record of what it was; **§7 records what it does now.** Read §7 first.

Observations from the client's test broker at `122.180.254.239:1883`, topic filter
`KULAR_GREEN/#`, anonymous and plaintext. Two runs, 45 s and 75 s, using
[`tools/probe_broker.py`](../solarcms-backend/tools/probe_broker.py).

**These are observations of a system, not decisions about ours.** Per MASTER §5.4,
observation reveals the *shape* of data and never its *meaning*. Everything below that
looks like a conclusion about units, scaling, or commercial precedence is a **hypothesis
requiring client confirmation**, and is marked as such. Nothing here closes an OPEN item.

Reproduce with:

```
python tools/probe_broker.py --host 122.180.254.239 --port 1883 \
    --topic 'KULAR_GREEN/#' --seconds 75 --out probe.json
```

---

## 1. What is published

Three topics, each publishing every ~2.78 s (median; range 2.37–3.12 s).

| Topic | Keys | Content |
|---|---:|---|
| `KULAR_GREEN/DATA` | 8 | Three-phase voltages, three-phase currents, power factor, frequency |
| `KULAR_GREEN/GENERATION` | 10 | Active/reactive/apparent power, import/export energy counters, three time fields |
| `KULAR_GREEN/MMS` | 7 | Irradiance (GHI, GTI), wind, ambient and module temperature, **a pre-computed Performance Ratio** |

Sample payloads, verbatim:

```json
// KULAR_GREEN/DATA
{"VoltageRY":"11.366865","VoltageYB":"11.425509","VoltageBR":"11.308848",
 "CurrentR":"0.3535","CurrentY":"0.3741","CurrentB":"0.497",
 "AvgPowerFactor":"0.757","Frequency":"50.018"}

// KULAR_GREEN/GENERATION
{"ActivePower":"-5.82","ReactivePower":"-5.13","ApparentPower":"7.74",
 "TodayExport":"26913.12","TodayImport":"60.79272","StartTime":"0.0",
 "StopTime":"0.0","ShutdownTime":"0.0","Import":"3503.676","Export":"1074996.0"}

// KULAR_GREEN/MMS
{"PerformanceRatio":"87.10487","AverageGHI":"5.51739","AverageGTI":"5.316807",
 "WindDirection":"79.0","WindSpeed":"0.0","AmbientTemp":"40.0","ModuleTemp":"24.9"}
```

---

## 2. Divergences from the specification

### 2.1 The topic format does not match the contract — and carries no Device

**Observed:** `{PLANT}/{CATEGORY}` — two segments.
**Contract (MASTER §5.1):** `scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}` — six.

The observed topic has no `client_code`, no `collector_code`, and **no `device_code`**. The
second segment is a data *category*, not a Device.

This is the transition risk MASTER §2.0.1 flags, now confirmed as live:

> ⚠ The §5.1 topic format must be agreed and used on the test broker now, or development
> happens against one shape of data and is rewritten for another.

**It also means F-18 is not yet true in practice.** F-18 states the client publishes
per-Device Readings for every Device at every Plant. The test broker publishes
**Plant-level totals only** — exactly the pattern MASTER §9.4 recorded from the REST
sample, which F-18 was supposed to change. Until per-Device publishing arrives:

- Tender §8 (per-Inverter monitoring, comparison, ranking) has no input data.
- The two comparative Alarm Rules — Inverter Underperformance and String Current
  Deviation (§12.3) — cannot fire, because both compare siblings.
- The Single Line Diagram has no Devices to populate it.

This is a **client conversation, not an engineering problem**. It does not block the
build: see §3.

### 2.2 No timestamp in the payload

BACKEND_SPEC §6.2's assumed payload carries `"timestamp"`. **No topic here carries one.**

Consequence: `readings.source_time` is NULL for this source, and `readings.time` (receipt)
is the only time available. Tender §28 requires the source timestamp be retained where it
exists — it does not exist here. The `QUALITY_STALE` classification, which compares
`source_time` against `expected_interval_s`, is inert for this source and staleness falls
entirely to the health sweeper.

### 2.3 Publish interval is ~2.78 s, not 60 s

BACKEND_SPEC §12.4 assumes a 60 s publish interval on the basis of tender §14 capping
acquisition at 1 minute. The broker publishes **~21× faster**. Tender §14 is a ceiling on
the interval, so 2.78 s does not violate it, but two assumed values are affected:

- `devices.expected_interval_s` must be set per Device from observation at commissioning,
  never from the 60 s default. Health detection multiplies this column, so a wrong value
  makes a Device look offline (or hides that it is).
- `tags.min_interval_s` throttling at 60 s would **discard roughly 95% of arriving
  Readings**. That may well be correct — but it is a retention decision with an
  irreversible consequence, and it should be made deliberately rather than inherited from
  a placeholder.

### 2.4 Values are strings

Every value in every payload is a JSON string (`"11.366865"`, not `11.366865`), confirming
MASTER §9.5 and BACKEND_SPEC §6.2. Coercion is required; unparseable values are flagged
`QUALITY_UNPARSEABLE`, never dropped.

---

## 3. Consequences for the build

The topic mismatch does **not** justify building against the legacy shape. Guardrail 5 —
never infer a Client from payload contents; the topic is the sole authority — is satisfied
either way, because the origin is still carried by the topic. What changes is that the
topic must be *interpreted* rather than positionally split.

The design that holds under both shapes:

1. **Canonical internally.** Every Reading resolves to `(client_id, plant_id, device_id,
   tag_id)` before it reaches Redis, `readings`, or the alarm stream. Nothing downstream
   knows a legacy topic ever existed.
2. **An ingress pattern registry, as data.** Rows map a topic pattern to its origin
   fields. `scms/v1/{client_code}/{plant_code}/{collector_code}/{device_code}` is one row;
   the legacy two-segment shape is another. Adding a client with a different convention is
   an `INSERT`, not a deployment — and no Client, Plant, or Device name appears in code
   (I-1, Guardrail 2).
3. **Category topics map to Devices, because that is what they are.** Each category is one
   physical instrument reporting Plant-level totals: `DATA` and `GENERATION` are meters,
   `MMS` is the Weather Station. Registering them as three Devices is accurate, not a
   workaround, and it means the model needs no special case for "Plant-level" Readings.
   ⚠ **Which meter `GENERATION` is matters commercially** — I-11 forbids computing
   Financial Reports from an MFM. Whether it is the ABT Meter is OPEN-14, unresolved.
4. **Migration costs nothing later.** When the client adopts the canonical format, their
   Devices are already registered; a new pattern row points at the same Device rows and
   history is continuous across the change.

---

## 4. Hypotheses requiring client confirmation

### 4.1 The MMS figures are daily, not instantaneous — and imply a ~5.6 MWp Plant

> **Corroborated 10 Sep 2026.** The client's signal schedule lists **`GHI IRRADIATION` in
> W/m²** and **`CUMMULATIVE GHI` in kWh/m²** as *separate* WMS signals
> (`TAG_CATALOGUE.md` §2.2). The broker's `AverageGHI` of 5.517 is implausible as the former
> and ordinary as the latter, so it belongs to the cumulative family — which is what the
> arithmetic below assumed. Still not *confirmed*: which of the four cumulative signals it
> maps to, and over what window, is unstated (T-1, B-2).

`AverageGHI` is assumed in BACKEND_SPEC §12.1 to be W/m² in the range 0–1500. The observed
value is **5.517**, which as an instantaneous irradiance would be effectively darkness, yet
it arrives alongside `AmbientTemp` 40 °C. Read instead as **kWh/m²/day**, the three MMS
figures become mutually consistent:

```
Specific yield  = PR × GHI       = 0.871 × 5.517 kWh/m²/day = 4.805 kWh/kWp
Plant capacity  = TodayExport / specific yield
                = 26,913.12 kWh / 4.805 kWh/kWp             ≈ 5,600 kWp
```

A ~5.6 MWp Plant exporting 26.9 MWh in a day at 87% PR is an entirely ordinary figure. The
arithmetic closing to a plausible round number across three independently published values
is strong support — but it is **inference, and §5.4 is explicit that units are not
inferable**. It illustrates the OPEN-15 risk precisely: the same number is defensible as
either W/m² or kWh/m²/day, and the two differ by three orders of magnitude.

**Ask the client:** are `AverageGHI` / `AverageGTI` instantaneous irradiance or daily
insolation, and over what averaging window? Is the Plant's DC capacity ~5.6 MWp?

### 4.2 Power is in kW, and the Plant was importing when observed

> **Corroborated 10 Sep 2026.** The client's schedule gives MFM `ACTIVE POWER` in **kW** and
> MFM voltages in **kV** (`TAG_CATALOGUE.md` §2.3) — matching both the hypothesis below and
> the observed magnitudes. The scale factor is still unstated.

`ActivePower` −5.82, `ReactivePower` −5.13, `ApparentPower` 7.74. These are internally
coherent: √(5.82² + 5.13²) = 7.75 ≈ `ApparentPower`, and 5.82/7.74 = 0.752 ≈
`AvgPowerFactor` 0.757. So apparent power is an unsigned magnitude and the sign convention
on active power marks direction.

Negative active power with `TodayExport` frozen and `TodayImport` rising means the Plant
was **importing** — night or shutdown — which fits `WindSpeed` 0 and a module temperature
below ambient. Against a ~5.6 MWp Plant, an auxiliary load of ~5.8 **kW** is plausible;
5.8 MW is not. **Hypothesis: kW.** Confirmation still required (OPEN-15).

### 4.3 The client already computes Performance Ratio upstream

> **Note 10 Sep 2026.** The signal schedule lists `SPECIFIC YIELD` and `EFFICIENCY` on the
> Inverter but **no** Performance Ratio on any Device Type. The PR on `KULAR_GREEN/MMS` is
> therefore computed somewhere in the client's pipeline rather than read from an instrument,
> which makes T-4/B-4 — what formula produces it — more pressing, not less.

`PerformanceRatio` = 87.105, published on `MMS`, near-constant across the observation.

This is materially useful for **OPEN-16**, where the risk is that our PR and the client's
disagree and the difference is reported as a system defect. Their figure arrives in the
data stream, so the two can be reconciled continuously rather than discovered at
acceptance.

It is stored under its own Tag, `REPORTED_PERFORMANCE_RATIO`, and **is never treated as our
PR**. Conflating a supplier-computed KPI with one we calculate would erase the only signal
that the formulas differ.

**Ask the client:** what formula produces this figure, over what period, and with what
exclusions? This is the OPEN-16 answer arriving through the back door — worth asking
directly while it is concrete.

### 4.4 Three sensors appear frozen; one counter pair suggests night

Unchanged across all 27 messages of the 75 s run:

| Key | Value | Reading |
|---|---|---|
| `AmbientTemp` | exactly `40.0` | Suspicious — a round number, invariant |
| `ModuleTemp` | exactly `24.9` | Below ambient; plausible at night, but invariant |
| `WindSpeed` | `0.0` | MASTER §9.5 recorded dead wind sensors in the REST sample |
| `WindDirection` | `79.0` | Invariant |
| `StartTime` / `StopTime` / `ShutdownTime` | `0.0` | Meaning undeclared |

`Export` and `TodayExport` were also invariant while `Import` and `TodayImport` rose
steadily — consistent with the Plant being idle rather than with a frozen counter.

A 75 s window cannot distinguish a dead sensor from a genuinely static quantity. What it
does confirm is that the **frozen-value detection** in the health sweeper has real work to
do here: these are exactly the readings that every staleness check reads as healthy,
because the Device is transmitting perfectly on schedule.

**Ask the client:** what are `StartTime`, `StopTime`, and `ShutdownTime` — timestamps,
durations, or counters? And are the weather sensors known to be unserviceable?

---

## 5. Questions for the client, consolidated

| # | Question | Bears on |
|---|---|---|
| B-1 | When will publishing move to the canonical topic format, and to per-Device Readings? | F-18, tender §8, SLD, comparative Alarms |
| B-2 | Are `AverageGHI` / `AverageGTI` W/m² or kWh/m²/day, and over what window? | OPEN-15 |
| B-3 | Is `ActivePower` in kW or MW? What is the Plant's DC capacity? | OPEN-15 |
| B-4 | What formula, period and exclusions produce the published `PerformanceRatio`? | OPEN-16 |
| B-5 | Are `Import`/`Export` cumulative counters? Rollover maximum? Planned resets? | OPEN-14 |
| B-6 | Is `GENERATION` the ABT Meter or an MFM? Which register is commercially binding? | OPEN-14, I-11 |
| B-7 | What are `StartTime`, `StopTime`, `ShutdownTime`? | OPEN-15 |
| B-8 | Is `KULAR_GREEN` a Client or a Plant? What is the owning Client? | §2.1 hierarchy |
| B-9 | Are the weather sensors serviceable? Ambient 40.0 and wind 0.0 are invariant. | Data quality, tender §15 |
| B-10 | Will the production broker be reachable at a hostname with TLS, per F-17? | §5.1 credential model |
| B-11 | Which WMS signal is the broker's `AverageGHI` — `CUMMULATIVE GHI`, `YEST. CUMMULATIVE GHI`, or an average of `GHI IRRADIATION`? | OPEN-15 |
| B-12 | The broker publishes 25 keys across 3 topics; the schedule lists ~75 signals for 7 Device Types. When do the remaining signals start publishing? | Scope, tender §8–§11 |
| B-13 | At ~2.78 s, is per-Reading fidelity wanted, or is one Reading per minute sufficient? Throttling at 60 s discards ~95% and adds 60 s to alarm detection latency. | Retention volume, alarm latency (BACKEND_SPEC §12.4) |
| B-14 | Payload keys on `KULAR_GREEN/DATA` changed wholesale between 10 and 16 Sep, and the weather topic was renamed `MMS`→`WMS`. **Is there a change process for either?** Every Plant is one silent rename away from decoding nothing. | §7, commissioning |

---

## 7. The broker changed — 16 September 2026

A 22-second run of the ingest worker against the same broker, immediately after
migration 0020 was applied. Three findings, all of which were **invisible before
the unmapped-key tracking added in the same change**: an unmapped key never
becomes a Reading, so nothing in `readings` could ever have shown this.

### 7.1 `KULAR_GREEN/DATA` renamed every one of its keys

**Observed now:** `VRY`, `VYB`, `VBR`, `IR`, `IY`, `IB`, `PF`, `Hz`.
**Observed 10 Sep:** `VoltageRY`, `VoltageYB`, `VoltageBR`, `CurrentR`, `CurrentY`,
`CurrentB`, `AvgPowerFactor`, `Frequency`.

The Device `MFM-01` is bound to the old names, so **it is currently decoding
nothing** — all eight keys land in `unmapped_keys`. The Device still reads as
*online*, because it is publishing perfectly on schedule; only the content
changed. That is precisely the failure the health sweep cannot see and the
unmapped-key list can.

Both key families are now in `SOURCE_KEY_ALIASES`, so the binding screen suggests
the right Tag for each. **The bindings themselves are not rewritten
automatically** — an alias is a default for a *new* binding, and silently
re-pointing a live Device's existing bindings is exactly the kind of inference
MASTER §5.2 forbids. Rebinding is one action on the Device bindings screen.

⚠ **This is worth raising with the client as a process question, not a bug**
(B-14): if payload keys can change without notice, every Plant they publish is
one rename away from silently decoding nothing.

### 7.2 The weather topic moved: `MMS` → `WMS`

`KULAR_GREEN/WMS` now publishes and is **quarantined** — no Device is registered
for it. `WMS-01` is still registered on `KULAR_GREEN/MMS`, which did not appear
once in the observation window.

Consequence, and it is not small: **the Plant has no irradiance data**, so
`AVG.GHI_CUMULATIVE` is absent and **PR cannot be computed for it** — correctly
undefined rather than zero, but undefined all the same. Correcting the Device's
`source_address` to `KULAR_GREEN/WMS` restores it, and is one field on the Device
settings panel. Not done automatically: a 22-second window is evidence that WMS
publishes, not proof that MMS is retired.

### 7.3 What still decodes

`KULAR_GREEN/GENERATION` is unchanged and decoding normally — active, reactive
and apparent power, and the four energy counters. `StartTime`, `StopTime` and
`ShutdownTime` remain unmapped, as they were on 10 Sep, because their meaning is
still unstated (B-7).

---

## 6. Change log

| Version | Date | Change |
|---|---|---|
| 1.2 | 16 Sep 2026 | **§7: the broker changed.** `KULAR_GREEN/DATA` replaced all eight payload keys with short codes, so `MFM-01` decodes nothing while still reading as online. The weather topic moved from `MMS` to `WMS` and is being quarantined, leaving the Plant with no irradiance and therefore no computable PR. Both key families added to `SOURCE_KEY_ALIASES`; bindings and topics deliberately **not** rewritten automatically. Added B-14. |
| 1.1 | 10 Sep 2026 | Cross-referenced against the client's signal schedule (`TAG_CATALOGUE.md`). Hypotheses §4.1 (irradiance is daily kWh/m²) and §4.2 (power in kW) corroborated by the client's own units; neither confirmed. Noted that the published `PerformanceRatio` corresponds to no signal on any Device Type and is therefore pipeline-computed. Added B-11 and B-12. |
| 1.0 | 10 Sep 2026 | Initial observations from the `KULAR_GREEN` test broker: topic shape, payload keys, rates, and the ten questions above. |
