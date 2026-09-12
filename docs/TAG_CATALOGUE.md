# Tag Catalogue — Client-Supplied Signal List

**Version:** 1.1 · **Date:** 11 September 2026 · **Status:** Evidence — client-supplied, partially authoritative

Transcribed from the client's Device List and signal schedule, received 10 September 2026;
**second revision of the same sheet received 11 September 2026** (§8). The second revision
adds six Device Types' signal lists, fills the `Range` column for the WMS rows only, and
corrects two units. Where the two revisions differ, the second is taken and the first is
noted.

**What this closes and what it does not.** OPEN-15 asks two questions: *what unit* and *what
scaling factor* applies to each Tag. This document answers the **unit** question for the
Device Types it covers. It does **not** answer scaling — the sheet's `Range` column is blank
except for the WMS — and it still does not cover 4 of the 17 Device Types. OPEN-15 is
therefore **narrowed, not resolved**; see §5.

Units below are the client's own. Where a unit is self-evidently wrong it is transcribed
faithfully and flagged in §4 rather than silently corrected — a corrected transcription
would destroy the evidence that the question needs asking.

---

## 1. Device List

The client's list confirms the 17 Device Types in MASTER §2.3, with no additions and no
removals:

`VCB` · `WMS` · `INVERTER` · `SMB` · `TRANSFORMER` · `ISOLATER` · `FIRE SYSTEM` · `UPS` ·
`DC POWER BANK` · `MFM` · `ABT METER` · `SLDC TELEMETRY` · `PPC` · `MODULE TRACKER` ·
`ANNUNCIATOR` · `MCR SECTION` · `ICR SECTION`

Two notes:

- The client spells it **ISOLATER**; the canonical term stays `ISOLATOR`, which is the
  correct spelling and already in the schema. A spelling difference in a supplier's
  spreadsheet is not a vocabulary decision.
- **`MCR SECTION` and `ICR SECTION` appear in a *Device* List.** That is direct evidence for
  **OPEN-12**: they are Devices, not rooms. §3 strengthens this further.

---

## 2. Signals by Device Type

`DI` denotes a Digital Input — a two-state contact, not a measurement. Every DI signal maps
to a Tag of category `status` with `rollup_method = 'last'`; averaging a contact is
meaningless.

### 2.1 VCB — section `IC-1/OG-2/-/-/-`

All twelve signals are DI. **The VCB reports no analogue value at all.**

| Signal | Type |
|---|---|
| ON FEEDBACK | DI |
| VCB TRIP FEEDBACK | DI |
| VCB IN TEST MODE | DI |
| VCB IN SERVICE | DI |
| VCB SPRING CHARGE | DI |
| VCB OC RLAY *(overcurrent relay)* | DI |
| AC FAIL | DI |
| DC FAIL | DI |
| VCB TC HEALTHY *(trip coil)* | DI |
| VCB EMERGRNCY PB *(emergency pushbutton)* | DI |
| VCB RELAY UNHEALTHY | DI |
| VCB REMOTE SELECTION | DI |

### 2.2 WMS — section `SELECT SECTION`

The only Device Type whose `Range` column is filled (second revision). These ranges are
**client-supplied** and are the values in `tags.valid_min` / `valid_max` for these Tags —
the sole rows of the registry whose bounds are not assumed.

| Signal | Range | Unit |
|---|---|---|
| AMBINT TEMP. *(ambient)* | −40 to +60 | °C |
| WIND SPEED | 0 to 60 | m/s |
| GTI IRRADIATION | 0 to 1,500 | W/m² |
| GHI IRRADIATION | 0 to 1,500 | W/m² |
| CUMMULATIVE GTI | 0 to 15 | kWh/m² |
| CUMMULATIVE GHI | 0 to 15 | kWh/m² |
| YEST. CUMMULATIVE GTI | 0 to 15 | kWh/m² |
| YEST. CUMMULATIVE GHI | 0 to 15 | kWh/m² |
| INVERTER MODULE TEMP. *(first revision: MODULE TEMP.)* | −40 to +100 | °C |
| HUMIDITY | 0 to 100 | % |
| RAIN GAUGE | 0 to 200 | mm/h |
| WIND DIRECTION | REAL *(no bounds stated)* | ° |
| DIFFUSED RADIATION | 0 to 1,500 | W/m² |
| DIFFUSED RADIATION AVERAGE | 0 to 1,500 | W/m² |
| DIRECT RADIATION | 0 to 1,500 | W/m² |
| DIRECT RADIATION AVERAGE | 0 to 1,500 | W/m² |
| CLOUD COVER | 0 to 100 | % |

The second revision renames `MODULE TEMP.` to **`INVERTER MODULE TEMP.`** on the WMS —
which reads as a PV-module temperature sensor mounted at the inverter, not the inverter's
internal temperature. It stays bound to `MODULE_TEMPERATURE` (environmental); the
Inverter's own `MODULE TEMP.` (§2.4) is bound to `DEVICE_TEMPERATURE`. T-11 remains open.

### 2.3 MFM — section `IC-1/OG-2/-/-/-`

| Signal | Unit |
|---|---|
| RY VOLTAGE · YB VOLTAGE · BR VOLTAGE · AVG VOLTAGE | **kV** |
| R CURRENT · Y CURRENT · B CURRENT | A |
| R POWER FACTOR · Y POWER FACTOR · B POWER FACTOR | *(blank — ratio)* |
| ACTIVE POWER | kW |
| REACTIVE POWER | kVar |
| FREQUENCY | Hz |
| EXPORT | kWh |
| IMPORT | kWh |

### 2.4 INVERTER — section `SELECT SECTION`

| Signal | Unit |
|---|---|
| AVG VOLTAGE | kV |
| AVG CURRENT | A *(first revision: kV — §4.1, resolved)* |
| ACTIVE POWER | kW |
| DC POWER | kW |
| REACTIVE POWER | kVar |
| POWER FACTOR | *(blank)* |
| FREQUENCY | Hz |
| EFFICIENCY | % |
| MODULE TEMP. | °C |
| DAILY ENERGY | kWh |
| SPECIFIC YIELD | *(blank — kWh/kWp)* |
| MONTHLY ENERGY | kWh |
| CUMULATIVE ENERGY | **MWh** ⚠ see §4.2 |
| DEVICE STATUS | *(blank)* |
| PV VOLTAGE | kV ⚠ see §4.3 |
| PV CURRENT | A |
| TODAY PEAK | **kWh** ⚠ see §4.4 |

### 2.5 TRANSFORMER — section `2 WINDING/3 WINDING`

Nine DI contacts **and, in the second revision, three analogue temperatures.** The first
revision's "no analogue temperature" is withdrawn: OTI (oil temperature indicator) and WTI-1
/ WTI-2 (winding temperature indicators) are published in °C. OPEN-18 is therefore answered
for the Transformer — see §5.2 — and stands for the VCB, which is still entirely DI.

| Signal | Type / Unit |
|---|---|
| OIL TEMP. ALARM | DI |
| OIL TEMP. TRIP | DI |
| WINDING TEMP.1 ALARM | DI |
| WINDING TEMP.1 TRIP | DI |
| WINDING TEMP.2 ALARM | DI |
| WINDING TEMP.2 TRIP | DI |
| BUCHHOLZ RELAY ALARM | DI |
| BUCHHOLZ RELAY TRIP | DI |
| MOG ALARM *(magnetic oil gauge)* | DI |
| OTI TEMP | °C |
| WTI-1 TEMP | °C |
| WTI-2 TEMP | °C |

The section header **`2 WINDING/3 WINDING`** confirms the Model-level variants recorded in
MASTER §2.3, and confirms the term is *winding* — the earlier "2 binding / 3 binding" was a
transcription slip on the client's side, now corrected in their own document.

### 2.6 BATTERY CHARGER

All DI. ⚠ **This heading is not one of the 17 Device Types** — see §4.5.

| Signal | Type |
|---|---|
| OVER CURRENT · CHARGER FAILURE · DC OVER VOLTAGE · DC EARTH FAULT | DI |
| RECT. FUSE FAILURE · BATTERY OVER TEMP. | DI |
| SOURCE1 MCB TRIP · SOURCE2 MCB TRIP · DC UNDER VOLTAGE | DI |

### 2.7 PPC

Ten signals in the second revision (four in the first): five setpoint / control-enable
pairs.

| Signal | Unit / Type |
|---|---|
| ACTIVE POWER PETPOINT *(setpoint)* | Kw |
| ACTIVE POWER CONTROL ENABLE | DI |
| REACTIVE POWER SETPOINT | kVar |
| REACIVE POWER CONTROL ENABLE *(reactive)* | DI |
| VOLTAGE SETPOINT | Kv |
| VOLTAGE CONTROL ENABLE | DI |
| POWER FECTOR SETPOINT *(factor)* | *(blank — ratio)* |
| POWER FECTOR CONTROL ENABLE | DI |
| FREQUENCY SETPOINT | Hz |
| FREQUENCY CONTROL ENABLE | DI |

This is exactly what MASTER §2.3 predicted the PPC would carry, and it makes **Curtailment a
buildable loss category** (tender §18): a setpoint plus a control-enable flag distinguishes a
*commanded* reduction from a fault. Nothing else in the plant can make that distinction.

### 2.8 SLDC TELEMETRY

Only one signal is legible at the crop boundary in either revision: **SLDC TELEMETRY
HEALTHY**. Treated as incomplete.

### 2.9 ISOLATOR *(sheet: ISOLATER)* — second revision

| Signal | Type |
|---|---|
| ISOLATER FEEDBACK | DI |

### 2.10 FIRE SYSTEM — section `ZONE AND AREA` — second revision

| Signal | Type |
|---|---|
| STATUS | DI |
| FAULT | *(blank — read as DI; a fire panel's fault output is a contact)* |

The section header `ZONE AND AREA` is the fire panel's own addressing (detection zones),
not a Block — a fire zone and a generation Block are different partitions of the same site
and must not be conflated.

### 2.11 UPS — second revision

| Signal | Unit |
|---|---|
| INPUT VOLTAGE | V |
| INPUT FREQUENCY | Hz |
| OUTPUT VOLTAGE | V |
| OUTPUT FREQUENCY | Hz |
| OUTPUT AMP. | A |
| BATTERY VOLTAGE | V |
| TEMP. | °C |

Note **V, not kV** — an auxiliary LV supply, unlike every other voltage on the sheet. Bound
to their own `UPS_*` Tags rather than the HV family so the unit cannot be confused.

### 2.12 ABT METER — section `IC-1/OG-2/-/-/-` — second revision

**Identical to the MFM list (§2.3), row for row**: RY / YB / BR / AVG VOLTAGE (kV); R / Y / B
CURRENT (A); R / Y / B POWER FACTOR; ACTIVE POWER (kW); REACTIVE POWER (kVar); FREQUENCY
(Hz); EXPORT and IMPORT (kWh).

This closes the ABT Meter half of OPEN-17. The two Types share a Tag set; what makes one the
settlement instrument (I-11) is its Device Type, not a different signal — Financial Reports
select by `device_types.code = 'ABT_METER'`, never by which Tags a Device happens to carry.

### 2.13 MODULE TRACKER — second revision

| Signal | Unit / Type |
|---|---|
| TARGETED ANGLE | ° |
| ACTUAL ANGLE | ° |
| DEVIATION | ° |
| CLEANING MODE | DI |
| TRACKING MODE | DI |
| ZERO ANGLE MODE | DI |
| BACK TRACKING MODE | DI |

### 2.14 ANNUNCIATOR — second revision

Present, with **four blank rows**. No signal names, types, or units. Still missing (§6).

---

## 3. What the section headers reveal

Two section labels recur: **`IC-1/OG-2/-/-/-`** (VCB, MFM) and **`SELECT SECTION`** (WMS,
INVERTER).

`IC` and `OG` are standard switchgear notation for **Incomer** and **Outgoing** feeder
positions in a panel. The signal schedule therefore instantiates VCBs and MFMs *per feeder
position within a switchboard section*, and `SELECT SECTION` is a picker for which section a
given Device sits in.

That is a second, independent line of evidence for **OPEN-12**: MCR and ICR Sections are
switchboard sections carrying feeders, so they are **Devices in the power path**, not rooms
and not a hierarchy level. The design already accommodates this — a Section becomes a Device
with `in_power_path = true`, and its VCBs and MFMs hang beneath it via `parent_device_id`,
which is precisely the electrical containment the Single Line Diagram needs.

It also means Device *codes* must encode feeder position (`VCB-IC-1`, `MFM-OG-2`), because a
Plant will hold many VCBs distinguished only by where they sit.

---

## 4. Problems in the sheet, transcribed rather than corrected

### 4.1 `AVG CURRENT` on the Inverter is given in **kV** — *resolved in the second revision*

The first revision gave kV; the second gives **A**, matching `PV CURRENT` and the MFM's own
current signals. Taken as a corrected transcription error on the client's side. T-4 closed.

### 4.2 The Inverter mixes **kWh and MWh** on one Device

`DAILY ENERGY` and `MONTHLY ENERGY` are kWh; `CUMULATIVE ENERGY` is **MWh**. This may well
be deliberate — a lifetime counter in kWh gets unwieldy — but it is a 1000× trap sitting
inside a single Device's Tag set, and it is exactly the failure mode OPEN-15 exists to
prevent. Both must be bound with their own scale, and any code summing "energy" across these
Tags without converting is wrong.

### 4.3 `PV VOLTAGE` in kV

A PV string runs at roughly 600–1500 V, so kV would render as 0.6–1.5. Possible, but
unusual; **V** is more likely. Needs confirmation.

### 4.4 `TODAY PEAK` in kWh

A *peak* is an instantaneous maximum, which is a power, so the unit should be **kW**. As
given, it is indistinguishable from another energy counter. If it is genuinely energy, the
name is misleading; if it is power, the unit is.

### 4.5 `BATTERY CHARGER` is not a Device Type

It appears as a signal group but not in the Device List. Three readings are possible and they
are not equivalent:

- a sub-assembly of `DC POWER BANK` or `UPS`, whose signals belong to that Device;
- an 18th Device Type the list omitted;
- a Device Model of an existing Type.

The middle reading is the only one that changes the catalogue, and F-12 already establishes
that Device Types are extensible, so none of this is structurally difficult — but the signals
cannot be bound to anything until it is settled.

### 4.6 The `Range` column is blank on every row *except the WMS*

The first revision's `Range` column was empty throughout; the second fills it **for the WMS
rows only** (§2.2). Range is what supplies `tags.valid_min` / `valid_max`, which is how a
denormalised float like `3.29151E-41` gets caught (MASTER §9.5). The WMS bounds are now
client-supplied; every other Type's bounds remain **assumed**.

---

## 5. Effect on the specifications

### 5.1 OPEN-15 is narrowed, not closed

| Half of OPEN-15 | Status |
|---|---|
| **Unit** per Tag | **Supplied** for 13 of 17 Device Types (§2). Three units are questionable (§4.2–§4.4); §4.1 resolved. |
| **Scaling factor** per Tag | **Still unknown.** No scale is stated anywhere. |
| Valid range per Tag | **Supplied for the WMS only** (§2.2). Every other Type's `Range` column is blank. |

Scaling remains the dangerous half. A unit tells you what `11.37` *means*; a scale tells you
whether the register holds `11.37`, `1137`, or `11370`. The client's test broker publishes
values already in engineering units (`VoltageRY: "11.366865"` against MFM's kV), which
suggests scaling happens upstream and our factors are 1.0 — but that is an inference from one
Plant, and MASTER §3.5 is explicit that binding scale is per-Device precisely because it
varies.

### 5.2 Two assumed Alarm Rules have no input and cannot work

This is the most consequential finding, and it invalidates seed data rather than merely
refining it.

BACKEND_SPEC §12.3 assumes threshold rules on analogue values:

| Assumed rule | Assumed input | What the client actually publishes |
|---|---|---|
| Transformer Over-Temperature — `DEVICE_TEMPERATURE > 85 °C` | analogue temperature | *First revision:* nothing analogue. *Second revision:* **`OTI TEMP`, `WTI-1 TEMP`, `WTI-2 TEMP` in °C** (§2.5) — so a threshold rule is possible again, against `OTI_TEMPERATURE` / `WTI_*_TEMPERATURE`, not `DEVICE_TEMPERATURE`. The **setting** is still unknown; the DI `ALARM` / `TRIP` contacts fire at the transformer's own protection setting and remain the authoritative rule |
| Grid Voltage High/Low, Frequency Excursion — scoped to `MFM` | analogue, and these do exist on the MFM | ✓ valid, but voltages are **kV**, so thresholds of 440/380 **V** are wrong by 1000× |

The Transformer rule must be rebuilt as **DI state rules** — alarm when `OIL TEMP. ALARM`
goes true, critical when `OIL TEMP. TRIP` does. That is arguably better than a threshold: the
contact fires at the transformer's *own* protection setting, which the manufacturer chose and
which we would otherwise be guessing at.

The same applies to the VCB, which is entirely DI. Any rule that expects an analogue value
from a VCB or Transformer has nothing to evaluate.

**This makes a new rule operator necessary**: `is_true` / `is_false` on a status Tag, with no
threshold. The existing operator set (`gt`, `lt`, `outside`, `inside`, `eq`, `special`) can
express it as `eq` against 1.0, but a dedicated operator is clearer and prevents a DI rule
being written with a nonsensical range.

### 5.3 Digital Inputs are a large, previously unplanned Tag population

Roughly 30 of the ~75 signals here are DI. The model absorbs them without change — they are
rows in `tags` with `category='status'` and `rollup_method='last'` (I-2 doing exactly the job
it was designed for) — but two things follow:

- **Throttling must not apply to status Tags.** `min_interval_s = 60` on a DI would discard a
  trip contact that opened and re-closed inside a minute, which is the single most important
  event the Device will ever report. Status Tags need `min_interval_s = 0` and change-of-state
  capture, not periodic sampling.
- **Alarm dedup matters more, not less.** A chattering contact produces a burst; the partial
  unique index and the debounce window are what stop it becoming thousands of Alarms.

### 5.4 Corroboration for two open broker questions

The WMS list distinguishes **`GHI IRRADIATION` in W/m²** from **`CUMMULATIVE GHI` in
kWh/m²**. The test broker publishes `AverageGHI: "5.517306"`, which is implausible as W/m²
and ordinary as kWh/m² — so it belongs to the *cumulative* family. This corroborates the
hypothesis in `BROKER_OBSERVATIONS.md` §4.1 and, with it, the arithmetic that put the Plant
at roughly 5.6 MWp.

Likewise MFM `ACTIVE POWER` in **kW** corroborates §4.2 of that document: the broker's
`ActivePower: "-5.82"` is −5.82 kW of auxiliary import, not MW.

Neither is confirmed. Both are now supported by the client's own documentation rather than by
our inference alone.

---

## 6. What is still missing

Signals have been supplied for 13 of 17 Device Types. **No signal list exists for:**

`SMB` · `DC POWER BANK` · `ANNUNCIATOR` *(present, four blank rows)* · `MCR SECTION` ·
`ICR SECTION`

`SLDC TELEMETRY` is present but cropped to one legible signal. `ABT METER` was supplied in
the second revision (§2.12) and is no longer a gap.

One of those gaps blocks a confirmed requirement:

- **`SMB`** carries string-level current. Tender §10 requires String Box monitoring, and the
  String Current Deviation rule (§12.3) compares strings within a box. Neither is buildable.

`MCR SECTION` / `ICR SECTION` are expected to carry nothing of their own — they are
switchgear sections whose feeders are the VCBs and MFMs scheduled against `IC-1/OG-2` (§3)
— so their absence is probably not a gap. T-9 would confirm.

**Reference Models.** Until the client names manufacturers and model numbers, the seed
creates one Device Model per Device Type (`Reference` / `ref-<type>`) carrying exactly the
signal list above as its Tag set (BACKEND_SPEC — `services/seed.py`
`REFERENCE_MODEL_TAGS`). Types in the missing list get an empty Model so a Device can still
be registered against them; bindings for those are set by hand.

---

## 7. Questions for the client

| # | Question | Bears on |
|---|---|---|
| T-1 | What **scaling factor** applies to each Tag? Units are now known; scale is not. | OPEN-15 |
| T-2 | The `Range` column is filled for the WMS only. What are valid minimum and maximum for every other Tag? | OPEN-15, data quality |
| T-3 | Signal lists for `SMB` **(first — blocks tender §10)**, `DC POWER BANK`, `ANNUNCIATOR`, and the rest of `SLDC TELEMETRY`. *(`ABT METER` answered 11 Sep.)* | tender §10 |
| ~~T-4~~ | ~~Inverter `AVG CURRENT` is given in kV. Should this be A?~~ **Answered:** A (second revision). | §4.1 |
| T-5 | Inverter `CUMULATIVE ENERGY` is MWh while `DAILY`/`MONTHLY` are kWh. Deliberate? | §4.2 |
| T-6 | Inverter `PV VOLTAGE` in kV — or V? | §4.3 |
| T-7 | Inverter `TODAY PEAK` in kWh — is this peak power (kW) or an energy figure? | §4.4 |
| T-8 | Is `BATTERY CHARGER` a Device Type, or a sub-assembly of `UPS` / `DC POWER BANK`? | §4.5, catalogue |
| T-9 | Confirm `MCR SECTION` / `ICR SECTION` are switchgear sections and therefore Devices in the power path. | OPEN-12 |
| T-10 | ~~Do Transformer and VCB expose **any** analogue values?~~ **Transformer: yes** — OTI / WTI-1 / WTI-2 in °C (second revision). **VCB: still entirely DI.** Remaining question: what is the Transformer's alarm and trip setting, so a threshold rule matches the protection? | §5.2, alarm design |
| T-13 | The Fire System's `FAULT` row has no type. DI, or a fault code? | §2.10 |
| T-14 | The WMS row renamed to `INVERTER MODULE TEMP.` — a PV-module sensor at the inverter, or the inverter's internal temperature (which the Inverter list also carries as `MODULE TEMP.`)? | §2.2, T-11 |
| T-11 | Inverter `MODULE TEMP.` — is this the PV module temperature (a WMS quantity) or the inverter's own internal temperature? | Alarm scoping |
| T-12 | Does every Device of a Type carry every listed signal, or does it vary by Model? | Binding strategy |

---

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 1.1 | 11 Sep 2026 | **Second revision of the client's sheet.** Added §2.9–§2.14 (ISOLATOR, FIRE SYSTEM, UPS, ABT METER, MODULE TRACKER, ANNUNCIATOR); PPC extended from four signals to ten (§2.7). Transformer gains three analogue temperatures (§2.5) — the first revision's "no analogue temperature" withdrawn, OPEN-18 answered for the Transformer. WMS `Range` column filled (§2.2, §4.6) — the only client-supplied bounds in the registry. Inverter `AVG CURRENT` corrected to A (§4.1 resolved, T-4 closed). ABT METER signal list received (§2.12) — identical to MFM; OPEN-17 narrowed to SMB. Missing list reduced from 10 Types to 4 (§6). Reference Models per Type recorded (§6). Added T-13, T-14. |
| 1.0 | 10 Sep 2026 | Initial transcription of the client's Device List and signal schedule. Units supplied for 7 Device Types; scaling and ranges still open. Recorded the DI population, the two invalidated Alarm Rule seeds, and the switchgear-section evidence for OPEN-12. |
