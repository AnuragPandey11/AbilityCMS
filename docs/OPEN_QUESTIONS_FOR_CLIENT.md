# SolarCMS — Open Questions and Working Assumptions

**Prepared for:** Ability Automation
**Prepared by:** the SolarCMS project team
**Date:** 9 October 2026
**Status:** Draft for review

---

## About this document

SolarCMS is now receiving live data from your broker, working out each Plant's figures, raising Alarms and producing reports. Wherever we needed a fact we did not have, we made a careful assumption so that the work could continue. This document lists every one of those assumptions and every question still open, so that you can confirm or correct them.

**How to answer.** Each question has a number and an answer box. Reply against the numbers in whatever form is easiest: in this document, in an email, or in a call. Partial answers help, and "we don't know yet" is a useful answer too, because it tells us which assumptions will stay in place for a while. Every assumed value is kept in one place in the platform, so your answer replaces ours in a single step. Nothing needs to be rebuilt.

**What the labels mean.**

| Label | Meaning |
|---|---|
| **Supplied** | You gave it to us in writing. |
| **Assumed** | Nobody has told us, so we chose a value. |
| **Proposed** | We designed this behaviour and it is working in the platform, but you have not agreed to it yet. |
| **High priority** | Other work is waiting on this answer, or figures on screen could be wrong until it arrives. |

---

## Already answered — thank you

Your signal sheets and replies have already settled a good deal:

- The **Performance Ratio formula**. Using your own figures it reproduces your published 87.105%, so we know it was copied correctly.
- The formulas for **average voltage, total current, direct-current power and specific yield**.
- **Units** for most of the signals in your sheet.
- The **11:55 PM copy** of today's figures into the "yesterday" figures.
- The Inverter's **average current** is in amperes.
- The Transformer sends its **oil and winding temperatures**.
- A **room named in the topic**, such as the Main Control Room, is an enclosure that holds equipment, not a piece of equipment itself (19 September).
- The **settlement meter's signal list** is the same as the multi-function meter's.
- The **Annunciator's** twenty contacts.
- **Power factor** is shown to two decimal places everywhere (8 October).

---

## The eight answers that would unblock the most

1. **The unit and scaling factor of every reading, per Client** (Question 1). Every number on every screen depends on this.
2. **The valid range of every reading** (Question 2).
3. **How you calculate Capacity Utilisation Factor** (Question 12).
4. **How you calculate Availability** (Question 13).
5. **Which meter is the official one for billing** (Question 18).
6. **Whether you accept our rule for Plant start and stop**, which differs from yours (Question 22).
7. **The two new Clients on your broker, `ISPL` and Vardhman Group**: should we bring them on board, and with what details (Question 40)?
8. **A way of telling us before topics or keys are renamed** (Question 45).

---

## Words we use in this document

Most of these will be familiar to you. We include them so that we both mean the same thing by each word, and so that anyone reading this document can follow it. The questions refer back to these terms by number.

**Term 1 — Client and Plant.** A *Client* is one of your customers whose Plants the platform monitors, such as Kular Green. A *Plant* is one generating installation.

**Term 2 — Device, Tag and Reading.** A *Device* is one physical piece of equipment, such as Inverter number 7. A *Tag* is one quantity a Device reports, such as its output power. A *Reading* is one value of one Tag at one moment.

**Term 3 — The equipment, in the order the electricity flows.**
- *Solar panels* are wired together in chains called *strings*.
- A *string monitoring box* measures the current in each string, so that one failing string can be found.
- An *Inverter* turns the panels' direct current into alternating current. It has a few independent input channels, and each channel can take one string or several strings joined together.
- A *Transformer* raises the voltage, for example from 800 volts to 11,000 volts. Its protection raises an *alarm* when it gets warm and *trips* (disconnects) when it gets dangerously hot.
- A *vacuum circuit breaker* is the main switch between the Plant and the grid.
- A *multi-function meter* measures voltage, current, power and energy.
- The *settlement meter* (the availability-based tariff meter) is the sealed meter the electricity buyer bills from.
- Alongside these there are:
  - a *weather monitoring station*, which measures sunlight, temperatures and wind;
  - a *power plant controller*, which tells the Inverters to reduce output when the grid operator asks;
  - a data link to the *State Load Despatch Centre*.
- Equipment sits in rooms such as the *Main Control Room* and the *Inverter Control Rooms*.

**Term 4 — Two kinds of capacity.** *Direct-current capacity* is the total rating of the panels, in kilowatt-peak. *Alternating-current capacity* is the total rating of the Inverters. Panels are usually sized larger than the Inverters, so a formula gives a different answer depending on which of the two it divides by.

**Term 5 — Power and energy.** *Power* is a rate at one moment, in kilowatts. *Energy* is the amount accumulated over time, in kilowatt-hours. One kilowatt kept up for one hour is one kilowatt-hour. A "peak" is always a power.

**Term 6 — Unit and scaling factor.** The *unit* says what a number is measured in. The *scaling factor* says what to multiply the raw number by. A meter may send `11370` to mean 11.37 kilovolts, which is a scaling factor of 0.001. If we know the unit but not the scaling factor, a value can be a thousand times wrong and still look believable on a chart.

**Term 7 — Valid range.** This is the lowest and highest value a reading can physically have. A value outside it is still kept, but it is marked as suspect rather than shown as fact.

**Term 8 — Instantaneous values and counters.** An *instantaneous* value is a snapshot, such as power right now. A *counter* is a running total that only goes up, like a car's odometer. A counter *rolls over* when it reaches its maximum and starts again at zero. A counter is *reset* when someone sets it to zero or the meter is replaced. In the data, a rollover and a replacement look exactly the same, because in both cases the number goes down.

**Term 9 — Sunlight.** *Irradiance* is the strength of sunlight at one moment, in watts per square metre. *Irradiation* is sunlight accumulated over a period, in kilowatt-hours per square metre. A *horizontal* sensor lies flat. A *tilted* (plane-of-array) sensor is angled like the panels. 1,000 watts per square metre is the standard condition at which panel ratings are defined.

**Term 10 — The headline figures.**
- *Performance Ratio* is the energy produced, divided by what the panels should have produced from the sunlight that actually fell on them.
- *Capacity Utilisation Factor* is the energy produced, divided by what the Plant would produce running at full rating for the whole period.
- *Availability* is the share of time, or of possible energy, during which the equipment was able to produce.
- *Specific yield* is the energy produced per kilowatt of panel capacity.

**Term 11 — Contacts and measured values.** A *contact* (digital input) is an on/off state, such as "breaker closed" or "tripped". A *measured value* is a number, such as a temperature.

**Term 12 — Topic and key.** Every Device sends its messages to the broker at an address called the *topic*, for example `SCMS/V1/KULAR_GREEN/KULAR_GREEN/MCR/INVERTER_1`. The message body is made of short *keys* with values, such as `PAC: 55.1`.

**Term 13 — Timing.** The *publish interval* is how often a Device sends a message. *Storage interval* means we keep at most one Reading per Tag every so many seconds. *Waiting time* means an Alarm opens only once a condition has lasted that long, so a one-second flicker does not wake anybody.

**Term 14 — Source order.** A figure can often come from more than one place. Today's energy, for example, can be read from the settlement meter, from a multi-function meter, or by adding up the Inverters. The *source order* is the order in which we try those places.

**Term 15 — Roles.** There are four kinds of login:
- *Super Admin*: runs the platform.
- *Client Admin*: runs one Client's Plants.
- *Client Employee*: views figures, exports data and acknowledges Alarms.
- *Guest*: views a dashboard only.

---

## Part 1 — Units and readings

### Question 1. What unit and scaling factor does each reading use, per Client? · High priority

**What we would like to know:** A sheet, for each Client or each make of equipment, giving every key's unit and scaling factor.

**Why it matters:** Your sheet gave us units but no scaling factors. Since 6 October we also have clear evidence that **the same key arrives in different units on different Clients**:
- The `VRY` voltage from Kular Green's meter reads about 11.04, meaning kilovolts.
- The same key from `ISPL`'s meter reads about 10,200, meaning volts.
- The same key from Vardhman Group's meters reads about 420, meaning a low-voltage connection.
- `ISPL`'s weather station sends its daily sunlight total in watt-hours per square metre, where your sheet says kilowatt-hours per square metre.

**What the platform does for now:** It assumes a scaling factor of 1, meaning values arrive already in real units. Where arithmetic proves otherwise, we have corrected that one Device by hand and recorded the evidence. Every one of those corrections is inferred, not confirmed.

**Background:** Terms 6 and 12.

> **Your answer:**
>

### Question 2. What is the valid minimum and maximum for each reading? · High priority

**What we would like to know:** The lowest and highest believable value for each reading.

**Why it matters:** The "Range" column in your sheet is filled in only for the weather monitoring station. Every other range is ours. For example, we allow active power from −5,000 to +5,000 kilowatts (negative because a Plant draws from the grid at night). On a Plant larger than 5 megawatts, the meter's readings would be marked suspect unless that range is widened.

**What the platform does for now:** It uses our own ranges, and keeps values outside them but marks them as suspect.

**Background:** Term 7.

> **Your answer:**
>

### Question 3. Is the Inverter's lifetime energy in megawatt-hours or kilowatt-hours?

**What we would like to know:** The unit of the Inverter's lifetime energy total.

**Why it matters:** Your sheet gives daily and monthly energy in kilowatt-hours but lifetime energy in megawatt-hours. The Inverters actually send `CE: 80476`. As megawatt-hours, that would be 80 million kilowatt-hours from a single Inverter of about 50 kilowatts, which is not possible.

**What the platform does for now:** It reads the live value as kilowatt-hours.

**Background:** Terms 5 and 6.

> **Your answer:**
>

### Question 4. Is the Inverter's panel-side voltage in kilovolts or volts?

**What we would like to know:** The unit of the Inverter's panel-side voltage.

**Why it matters:** Your sheet says kilovolts, which would show about 1,089 volts as 1.089. The live value is about 1,089, which only makes sense as volts.

**What the platform does for now:** It reads the value as volts.

> **Your answer:**
>

### Question 5. Is the Inverter's "TODAY PEAK" a power or an energy?

**What we would like to know:** Whether "TODAY PEAK" is in kilowatts or kilowatt-hours.

**Why it matters:** A peak is a power, measured in kilowatts. Your sheet gives kilowatt-hours, which would make it another energy total.

**What the platform does for now:** It records the value exactly as given, until you confirm.

**Background:** Term 5.

> **Your answer:**
>

### Question 6. Is the Inverter's "MODULE TEMP." the panels' temperature or the Inverter's own?

**What we would like to know:** What this temperature measures.

**Why it matters:**
- At the same moment, the Inverters reported 48.7 to 49.5 degrees Celsius while the weather monitoring station reported 34.5 degrees Celsius for the panels. Readings 15 degrees apart are not measuring the same thing.
- The weather station also has a row called "INVERTER MODULE TEMP.", which adds to the uncertainty.
- The answer decides which over-temperature Alarm applies.

**What the platform does for now:** It treats the value as the Inverter's own internal temperature.

> **Your answer:**
>

### Question 7. Could you send the list of keys each type of equipment sends?

**What we would like to know:** The key list for each type of equipment, with each key's meaning.

**Why it matters:** The live equipment sends short keys that do not appear in your signal sheet:
- Inverters and meters: `PAC`, `P`, `Q`, `EFF`, `CE`, `DE`, `ME`, `PVV`, `PVI`, `STS`, `EXP`, `IMP`.
- Power plant controller: `APS`, `RPS`, `VS` and others.

We worked out their meanings from arithmetic that agrees three ways. For example, an Inverter's voltage and current work out to 55.4 kilowatts, and it reports 55.1 as its power. That is strong evidence, but it is still our reading.

Three of these readings are weaker:
- We read `DA` as "average direct radiation" from its naming pattern only.
- The Transformer sends one winding temperature (`WTI`) where your sheet lists two. We have treated it as winding 1.
- We matched the breaker's keys (`ON`, `TRIP`, `SERV` and others) to your sheet by the order they appear in.

**Background:** Term 12.

> **Your answer:**
>

### Question 8. What do the Inverter status codes mean?

**What we would like to know:** The meaning of each status code, for each make of Inverter. A page from each manufacturer's manual would be ideal.

**Why it matters:** Each Inverter sends a status number (`STS`). We have seen 512 and 40960. Some manufacturers use one number per condition; others pack several on/off conditions into one number, where each binary digit means something different. Please also tell us which approach each make uses.

**What the platform does for now:** It shows the number exactly as sent. A **Status meanings** screen on Inverter Monitoring now lets you record each code's meaning, per Plant, and the screens show your label from then on. It lists the codes your equipment has actually sent, so you only need to label those.

> **Your answer:**
>

### Question 9. At what time does the weather station's daily sunlight total restart?

**What we would like to know:** The time the daily sunlight total resets to zero.

**Why it matters:** Your Performance Ratio formula divides by this total. If it restarts at a time other than the one we assume, every daily Performance Ratio is wrong.

**What the platform does for now:** It assumes midnight in the Plant's own time zone.

**Background:** Terms 8 and 9.

> **Your answer:**
>

### Question 10. Are "Accum. Diffuse" and "Accum. Direct" accumulated totals or averages?

**What we would like to know:** Which of the two these figures are.

**Why it matters:** Your reference weather screen labels them "Accum." (accumulated). Your signal sheet lists the same signals as averages in watts per square metre.

**What the platform does for now:** It follows the signal sheet and labels them as averages.

**Background:** Term 9.

> **Your answer:**
>

### Question 11. How should the overall power factor be calculated?

**What we would like to know:** Your formula for the overall power factor, or whether the meter will send it.

**Why it matters:** The meters send a power factor for each phase only. Your reference meter screen shows one overall power factor. Working it out ourselves would mean choosing a formula and a sign convention that you have not given us.

**What the platform does for now:** It shows "not reported" for the overall figure.

> **Your answer:**
>

---

## Part 2 — Calculations

### Question 12. How do you calculate Capacity Utilisation Factor? · High priority

**What we would like to know:** Your formula, and in particular:
- Should it divide by alternating-current capacity or direct-current capacity?
- Should it count all 24 hours, or daylight hours only?
- Should time when the grid was down be excluded?

**Why it matters:** Your sheet marks Capacity Utilisation Factor "Need to Calculate" but leaves the formula blank. It is the only headline formula we have not received.

**What the platform does for now:** Energy ÷ (alternating-current capacity × hours) × 100, with nothing excluded. There is one difference worth knowing:
- The Plant summary figures (your "DASHBOARD" row) divide by all 24 hours of the day.
- The dashboard dial divides by the hours that have passed so far, so that a morning figure is not compared against a whole day.

**Background:** Terms 4 and 10.

> **Your answer:**
>

### Question 13. How do you calculate Availability? · High priority

**What we would like to know:**
- Should Availability be measured by time, or by the energy lost?
- Does time when the grid was down count against the Plant?

**Why it matters:** Contracts usually guarantee this figure, and the two methods can give quite different results.

**What the platform does for now:** It measures by time: the share of time each Device was reporting. Time when we simply could not hear from the equipment is left out, because silence does not prove that the equipment was down.

**Background:** Term 10.

> **Your answer:**
>

### Question 14. Which Performance Ratio should be the official one?

**What we would like to know:**
- Which version reports and the dashboard should call "Performance Ratio".
- Whether either version should be corrected for panel temperature.

**Why it matters:** The platform calculates two versions, so that any difference between them is visible:
- **Your formula** (Supplied): today's energy ÷ (today's horizontal sunlight total × direct-current capacity) × 100. This is used for the Plant summary figures.
- **The international standard version** (International Electrotechnical Commission standard 61724): this uses the tilted sensor and is not corrected for temperature. The dashboard dial currently shows this one.

**Background:** Terms 9 and 10.

> **Your answer:**
>

### Question 15. What should count as a good, poor and bad Performance Ratio and Availability?

**What we would like to know:** Your thresholds, separately for Performance Ratio and for Availability. Please also say whether Capacity Utilisation Factor should have thresholds too.

**Why it matters:** At present the same thresholds apply to both figures. On a real Plant, an Availability of 87% would be a poor day, but these thresholds show it as fine.

**What the platform does for now:** The dashboard dials turn amber below 80% and red below 60%. These came with our first design and are not your judgement. Capacity Utilisation Factor has no colour bands.

> **Your answer:**
>

### Question 16. What does "expected power" mean to you?

**What we would like to know:** The basis you use for expected power: a simulation model, a contract figure, or something else. Your method would replace ours.

**Why it matters:** The power chart offers two "expected power" lines, and we have no basis from you for either.

**What the platform does for now (Proposed):**
- Expected direct-current power is tilted sunlight × direct-current capacity ÷ 1,000.
- Expected alternating-current power is that figure × the Inverters' own measured efficiency, capped at the alternating-current capacity.

Both lines ignore losses and temperature, so they are upper limits, not forecasts.

**Background:** Terms 4 and 9.

> **Your answer:**
>

### Question 17. Which carbon dioxide figure should we use?

**What we would like to know:** Whether to use one carbon dioxide figure everywhere, or a different figure for each state.

**What the platform does for now:** It uses 0.82 kilograms of carbon dioxide avoided per kilowatt-hour. This is an approximate all-India average from the Central Electricity Authority.

> **Your answer:**
>

---

## Part 3 — Meters, counters and storage

### Question 18. Which meter is the official one for billing? · High priority

**What we would like to know:** Which meter's figures are commercially binding, and whether that differs between Plants.

**What the platform does for now (Proposed):**
- **Energy exported:** the settlement meter first, then a multi-function meter, then the total of all the Inverters.
- **Energy imported:** the settlement meter, then a multi-function meter. Inverters cannot measure what the Plant draws from the grid, so a Plant without a meter shows no import figure rather than zero.
- **Financial Reports** read only the settlement meter, and never fall back to another source.

**Background:** Terms 3 and 14.

> **Your answer:**
>

### Question 19. What is each energy counter's maximum before it rolls over? · High priority

**What we would like to know:** The maximum value of each energy counter.

**What the platform does for now:** Whenever a counter goes down, it sets that step aside, does not count it, and reports it. It never guesses.

**Background:** Term 8.

> **Your answer:**
>

### Question 20. How will we hear about meter replacements and planned resets?

**What we would like to know:** How you would let us know when a meter is replaced or reset.

**Why it matters:** In the data, a replacement looks exactly like a rollover, but the two need opposite handling. A short note from you whenever a meter is replaced or reset would keep every energy total right.

**Background:** Term 8.

> **Your answer:**
>

### Question 21. Is one stored reading per minute enough?

**What we would like to know:** Whether one stored measured value per minute meets your needs, or whether you would prefer every value.

**Why it matters:** Since 6 October your equipment sends a message about every 30 seconds. We keep one measured value per Tag per minute (one per five minutes for diagnostic values and counters), and every contact message. Alarm checks see only the stored values, so a problem in a measured value can be noticed up to a minute later than it happens. Keeping every value is possible; it roughly doubles the storage used for measured values.

**Background:** Term 13.

> **Your answer:**
>

---

## Part 4 — How the Plant operates

### Question 22. Do you accept our rule for when the Plant starts and stops? · High priority

**What we would like to know:**
- Do you agree with our rule, or would you like your 0.1 megawatt rule back?
- Which "active power" did you mean: a meter, or the Inverters?

**Your rule (Supplied):** "When the active power is greater than 0.1 megawatt, that time shall be considered the Plant Start Time", and when it falls below, the Stop Time.

**Our rule, which is what runs now (Proposed):**
- The Plant starts when the Inverters' combined output rises above 0.5 kilowatts.
- It stops when that output falls back to 0.
- If it restarts later the same day, the last stop is the one that counts.

**Why we changed it:**
- Two thresholds instead of one stop the Plant from flipping between started and stopped at dawn, when output hovers around a single line.
- Read literally, a single threshold lets a passing cloud set the Stop Time in the middle of the morning.

**Background:** Term 5.

> **Your answer:**
>

### Question 23. How should we judge whether the Plant is connected to the grid?

**What we would like to know:** Whether the breaker's "ON" feedback contact is the right signal, or whether you would prefer another, such as voltage at the meter.

**What the platform does for now:** The Plant counts as connected while that contact is closed. A closed breaker cannot show a grid that has gone dead on the far side. A Plant with no breaker shows no grid status at all; it is never assumed to be connected.

**Background:** Terms 3 and 11.

> **Your answer:**
>

### Question 24. Is the "DASHBOARD" row in your Device List a real panel, or figures you expect us to calculate?

**What we would like to know:** Which of the two it is.

**Why it matters:** The row carries Performance Ratio, Capacity Utilisation Factor, peak power and its time, start and stop times, and the number of working Inverters.

**What the platform does for now:** It calculates all of these itself. If it is a real panel that sends these figures, it becomes an ordinary Device and our calculation stops for that Plant. Nothing needs to be rebuilt.

> **Your answer:**
>

### Question 25. Which time zone should stored times use?

**What we would like to know:** Please confirm that each Plant's own time zone is right, rather than India Standard Time everywhere.

**Why it matters:** This affects:
- the time of peak power;
- start and stop times;
- the 11:55 PM copy of today's figures into "yesterday".

It only makes a difference if a Plant is ever outside India, but then it affects every figure.

**What the platform does for now:** It uses each Plant's own time zone, and gives new Plants India Standard Time unless told otherwise.

> **Your answer:**
>

---

## Part 5 — Panel strings

Since 6 October your broker has sent each Inverter's string figures on topics of their own. They are working: on Kular Green, the string currents of every Inverter add up exactly to that Inverter's own panel-side current. The **String Analysis** screen draws every string of every Inverter. A few details still decide how it should judge them.

### Question 26. Is the string topic pattern permanent, and what do the keys mean?

**What we would like to know:**
- Will the string topics always follow the pattern we see now? Today it is the owning Device's code plus `_STRING`, followed by the number of the last string in that message. For example, `INVERTER_1_STRING16` carries strings 1 to 16, and `INVERTER_1_STRING28` carries strings 17 to 28.
- Are `I1` to `I28` string currents in amperes, and `P1` to `P28` string powers in kilowatts?
- Kular Green sends every string power (`P1` to `P28`) as 0. Is that expected?

**Background:** Term 12.

> **Your answer:**
>

### Question 27. How many strings does each Inverter really have?

**What we would like to know:**
- The number of strings connected to each Inverter.
- Whether each input carries one string or several strings joined together.

**Why it matters:** On Kular Green, between 2 and 12 inputs per Inverter read zero at midday. The data cannot tell an unused input from a dead string.

**What the platform does for now:** The number of strings is set by hand for each Inverter under Tag Mapping. Until it is set, no strings are shown, rather than empty inputs being shown as faults.

**Background:** Term 3.

> **Your answer:**
>

### Question 28. What makes a string "weak", and what counts as "no current"?

**What we would like to know:**
- Your rule for a weak string: what it is compared against (the same Inverter, the same input, the string monitoring box, or the sunlight), the threshold, and how long the condition must last.
- What reading counts as "no current", given that a current sensor may show a small offset.

**What the platform does for now (Proposed):** A string is **weak** when all three of these are true:
- its current is more than 20% below the middle value of the same Inverter's producing strings;
- the Inverter is generating;
- that middle value is at least 2 amperes.

A string has **no current** when it reads exactly zero while the Inverter is generating.

> **Your answer:**
>

### Question 29. Which strings should never be compared with each other?

**What we would like to know:** Which strings differ by design, for example in the direction they face or the number of panels.

**Why it matters:** Strings that differ by design will always read differently, and should not be judged against each other.

**What the platform does for now:** It compares every string with the others on the same Inverter.

> **Your answer:**
>

### Question 30. Should a weak or dead string raise an Alarm?

**What we would like to know:**
- Should a weak or dead string raise an Alarm?
- If so, should there be one Alarm per string, or one per Inverter?

**What the platform does for now:** String Analysis shows each string's condition, but raises no Alarm for it.

> **Your answer:**
>

---

## Part 6 — Equipment and signal lists

### Question 31. What does a string monitoring box send?

**What we would like to know:** The full signal list for a string monitoring box, for example any voltages, temperatures or fuse states besides the string currents and powers.

**Why it matters:**
- After three revisions, your signal sheet still has a heading for the string monitoring box with no rows under it.
- We now receive string currents from one box at `ISPL`, on the same pattern as the Inverters' strings, but nothing else from it.
- The tender's string monitoring clause depends on the full list.

> **Your answer:**
>

### Question 32. Could you send the remaining signal lists?

**What we would like to know:** The signal lists still missing:
- the direct-current power bank (the battery bank that keeps protection equipment powered);
- the rest of the State Load Despatch Centre link.

> **Your answer:**
>

### Question 33. What kind of equipment is the battery charger?

**What we would like to know:** Whether the battery charger is:
- part of the uninterruptible power supply or of the direct-current power bank;
- a type of equipment of its own; or
- one model of an existing type.

**Why it matters:** The battery charger has signals in your sheet but does not appear in your Device List.

**What the platform does for now:** It treats the battery charger as one model of the direct-current power bank, so its nine contacts have somewhere to go.

> **Your answer:**
>

### Question 34. Is the "MCR SECTION" row a switchboard, or the Main Control Room itself?

**What we would like to know:** Whether there is a switchboard inside the room that we should treat as its own piece of equipment.

**Why it matters:** On 19 September you confirmed that the room named in a topic is an enclosure, not a piece of equipment. Your Device List also has "MCR SECTION" and "ICR SECTION" rows, and your sheet places breakers and meters at feeder positions within them. Both can be true at once: the room is an enclosure, and the switchboard standing in it is equipment.

**Background:** Term 3.

> **Your answer:**
>

### Question 35. Is each Inverter a central Inverter or a string Inverter?

**What we would like to know:** Which kind each Inverter is, for each Plant.

**Why it matters:**
- Central Inverters usually have string monitoring boxes beneath them; string Inverters usually do not.
- Comparing an Inverter with its neighbours is only fair when they are the same kind.

**What the platform does for now:** Each Inverter can be recorded as one kind or the other. Until it is, the Inverter is not ranked against its neighbours.

> **Your answer:**
>

### Question 36. What are the Transformer's alarm and trip temperature settings?

**What we would like to know:** The temperatures at which each Transformer's protection alarms and trips.

**Why it matters:** The Transformer now sends its oil and winding temperatures. We can mark its alarm and trip settings on the temperature charts and add a temperature Alarm at the same settings as its own protection, but only once we know what those settings are.

**What the platform does for now:** It relies on the Transformer's own alarm and trip contacts, which fire at its real settings.

**Background:** Term 11.

> **Your answer:**
>

### Question 37. Is "PV221" in the Inverter list a typing error for PV21?

**What we would like to know:** Whether "PV221", which sits between PV20 and PV22, should read PV21.

**What the platform does for now:** It treats PV221 as PV21 and accepts both spellings.

> **Your answer:**
>

### Question 38. Is the fire system's "FAULT" a contact or a fault code?

**What we would like to know:** Whether "FAULT" is an on/off contact or a numeric fault code.

**Why it matters:** The row in your sheet has no type, and the two are stored and shown differently.

**Background:** Term 11.

> **Your answer:**
>

### Question 39. Who will tell us what each Annunciator lamp means?

**What we would like to know:** Who will supply the meaning of each Annunciator lamp at each Plant.

**Why it matters:** The Annunciator sends twenty contacts named `SIGNAL1` to `SIGNAL20`. Their meanings are written at each Plant, not by the manufacturer.

**What the platform does for now:** It can hold a separate meaning for each lamp at each Plant. Until then, the lamps appear only by number.

> **Your answer:**
>

---

## Part 7 — Particular Clients and Plants

### Question 40. Should we bring `ISPL` and Vardhman Group on board? · High priority

**What we would like to know:**
- Should both be set up as Clients?
- Their full names.
- Their Plants' names (see Question 41 for capacities and other details).
- Who should receive a login.

**Why it matters:** Since 6 October, two Clients we have not set up have been sending data to your broker:

| Client code on the broker | Plant code | Equipment seen |
|---|---|---|
| `ISPL` | `UNIT1` | a meter, one Inverter, a string monitoring box, a weather station |
| `VARDHMAN_GROUP` | `SPINNING_AND_GENERAL_MILLS` | two meters, four Inverters, two weather stations |

Data that arrives before a Client is set up is kept for a limited time and can be recovered afterwards.

> **Your answer:**
>

### Question 41. Could you give us these details for every Plant?

**What we would like to know:** For each Plant, including Kular Green:
- direct-current capacity;
- alternating-current capacity;
- the rating of each Inverter;
- location and time zone.

**Why it matters:**
- Performance Ratio, Capacity Utilisation Factor, specific yield and the expected-power lines all divide by capacity, so they cannot be calculated without it.
- The power chart's sunlight line also needs the direct-current capacity.

**Background:** Term 4.

> **Your answer:**
>

### Question 42. Vardhman Group's main meter: is the power or the current wrong?

**What we would like to know:**
- Which is right: the power reading, or the current reading (for example, a current transformer ratio not applied)?
- Does this meter measure the solar generation, or the mill's own consumption?

**Why it matters:** The meter `MAIN_MFM` reports a power of about 772 kilowatts. Its own voltage, current and power factor work out to about 76 kilowatts, roughly ten times less.

> **Your answer:**
>

### Question 43. `ISPL`'s Inverter: what do −1 and the zeros mean?

**What we would like to know:**
- Is −1 a "not available" marker?
- Will the energy and panel-side readings be filled in?

**Why it matters:** While producing about 390 kilowatts, `ISPL`'s Inverter sends:
- an efficiency of −1;
- zero for its lifetime, daily and monthly energy;
- zero for its panel-side voltage and current.

> **Your answer:**
>

### Question 44. Are Vardhman Group's weather sensors connected?

**What we would like to know:** Whether these sensors are connected and working.

**Why it matters:** Both of Vardhman Group's weather stations (`WMS` and `WMS_WEST`) send zero for most of their readings. Without sunlight readings, that Plant's Performance Ratio cannot be calculated.

> **Your answer:**
>

---

## Part 8 — Ways of working, access and business details

### Question 45. Could you tell us before topics or keys change? · High priority

**What we would like to know:** Whether you can agree a simple notice step: a short message to us before any topic, key, unit or sending rate changes.

**Why it matters:** Several changes have reached us without notice:
- In September, every key on one topic was renamed and the weather topic moved.
- Shortly after that, the whole topic layout changed.
- On 6 October, the sending rate went from 86 seconds to 30 seconds and the string topics appeared.

Each unannounced change can leave a Plant sending data the platform cannot read until someone notices. After one of them, a Plant's data went unrecorded for 27 hours. The platform now detects many of these changes by itself and lists them on a **Data Issues** screen with a fix, but advance notice is still far better.

> **Your answer:**
>

### Question 46. Four roles or five?

**What we would like to know:** Written confirmation that your four-role model replaces the tender's five roles.

**Why it matters:** The tender names five roles. You confirmed four, and the platform is built with four.

**What the platform does for now:** The tender's three escalation levels (operator, Plant manager, management) do not map onto four roles, so escalation notifies **named people** instead of roles.

**Background:** Term 15.

> **Your answer:**
>

### Question 47. Should Guests only ever see demonstration data?

**What we would like to know:** Whether you agree that Guests should be limited to demonstration data.

**Why it matters:** A Guest who could see a real Client would see that Client's generation and financial figures.

**Our recommendation:** Yes, and enforced by the database itself.

**Background:** Term 15.

> **Your answer:**
>

### Question 48. Do you approve the names we use?

**What we would like to know:** Approval of our vocabulary: "Tag" rather than "Parameter", and the other names used in this document (Client, Plant, Device, Alarm and so on).

**Why it matters:** Names cost nothing to change now and become permanent after go-live.

> **Your answer:**
>

### Question 49. Should we keep detailed data around serious faults for longer than 30 days?

**What we would like to know:** Whether we should keep the detailed data around serious faults beyond the usual 30 days.

**Why it matters:** Every stored reading is kept for 30 days; after that only one-minute and longer summaries remain. A warranty claim raised months later would have lost the detail around the fault.

**Our proposal:** Keep 15 minutes of full detail either side of every high or critical Alarm.

> **Your answer:**
>

### Question 50. What did the tender mean by "Plant Overview" as opposed to "Plant List"?

**What we would like to know:** What the tender intended each of these screens to show.

**Why it matters:** The tender names both screens but defines neither.

**What the platform does for now:** One screen, with a switch between a card view (ordered by which Plant needs attention first) and a sortable table.

> **Your answer:**
>

### Question 51. Which business details about a Client are required?

**What we would like to know:**
- Which of the business details below should be required.
- What should happen when a contract expires: nothing, a warning, or the account being switched off?

**What the platform does for now:** The Goods and Services Tax registration number, client account number, billing contact and contract dates are all optional.

> **Your answer:**
>

### Question 52. Are hydro-electric Plants in scope?

**What we would like to know:** Whether the platform should also cover hydro-electric Plants.

**Why it matters:** Your existing system also monitors hydro Plants. The platform would handle them without changes, but the name "SolarCMS" would no longer fit.

> **Your answer:**
>

### Question 53. What is the grouping `HP_S_SLDC` in your existing system?

**What we would like to know:** What this grouping represents.

**Why it matters:** It looks like a reporting group for a state grid operator, which does not match any level of our hierarchy. We would like to place it correctly.

> **Your answer:**
>

### Question 54. Which WhatsApp provider should we use?

**What we would like to know:** Which approved provider you would like to use for WhatsApp messages.

**Why it matters:** Sending WhatsApp messages needs an approved provider, and each message template takes some weeks to be reviewed. The platform is ready to send through whichever provider you choose.

> **Your answer:**
>

### Question 55. Do the tender's clauses about a web programming interface and a SQL Server database need a written "not applicable"?

**What we would like to know:** Whether these clauses need a formal written response.

**Why it matters:** This affects only the tender response, not what is built.

> **Your answer:**
>

---

## Part 9 — Values we have assumed

Please confirm each value or write in your own. Where you leave a row blank, we will keep our value.

### Alarm rules

The contacts on the Transformer and the breaker come from your sheet. Every threshold, waiting time and severity is our assumption.

| Alarm | Fires when | Waits | Severity | Your value |
|---|---|---|---|---|
| Grid voltage high | above 12.1 kilovolts | 60 seconds | high | |
| Grid voltage low | below 10.5 kilovolts | 60 seconds | high | |
| Frequency out of range | outside 49.0 to 51.0 hertz | 30 seconds | high | |
| Inverter panel-side voltage too high | above 1,450 volts | 30 seconds | critical | |
| Inverter too hot | above 75 degrees Celsius | 5 minutes | medium | |
| Inverter underperforming * | more than 10% below similar Inverters, while sunlight is above 400 watts per square metre | 15 minutes | medium | |
| No output in daylight * | under 1 kilowatt while sunlight is above 200 watts per square metre | 10 minutes | high | |
| Sensor stuck * | the same value 60 times in a row | none | low | |
| Weak string * | more than 20% below the middle string of its box | 10 minutes | medium | |
| Communication lost | a Device stops reporting | 5 minutes | medium | |
| Room offline | two or more Devices in one room go quiet together (one Alarm, not one per Device) | 5 minutes | high | |
| Unregistered equipment sending | equipment sends data that is not set up in the platform | 5 minutes | high | |
| Plant silent | nothing arrives from the whole Plant | 10 minutes | critical | |
| Transformer trip (oil temperature, winding temperature, Buchholz relay) | contact closes | immediately | critical | |
| Transformer alarm (oil temperature, winding temperature, Buchholz relay) | contact closes | immediately | high | |
| Transformer magnetic oil gauge | contact closes | immediately | medium | |
| Breaker trip | contact closes | immediately | high | |
| Breaker emergency push-button | contact closes | immediately | critical | |
| Breaker protection relay unhealthy | contact closes | 60 seconds | medium | |
| Breaker trip coil unhealthy | "healthy" contact opens | 60 seconds | high | |
| Breaker alternating- or direct-current supply failure | contact closes | 30 seconds | medium | |
| State Load Despatch Centre link unhealthy | "healthy" contact opens | 5 minutes | medium | |

\* Defined but not yet active. Your thresholds will be used when they are switched on.

Please note:
- **The grid voltage limits assume an 11-kilovolt connection.** Our upper limit is 10% above 11 kilovolts, and our lower limit is about 4.5% below it. Please give us both limits. A Plant connected at low voltage, such as Vardhman Group's mill at about 420 volts, needs limits of its own.
- **The Inverter temperature Alarm** depends on the answer to Question 6.

### Timing

| Setting | Our value | Your value |
|---|---|---|
| A Device counts as "degraded" | after twice its own publish interval of silence (1 minute at a 30-second interval) | |
| A Device counts as "offline" | after ten times its publish interval of silence (5 minutes at a 30-second interval) | |
| Publish interval assumed for new equipment until it is measured | 60 seconds | |
| Stored readings | one per minute for measured values; one per 5 minutes for diagnostic values and counters; every message for contacts (see Question 21) | |
| Escalation of high and critical Alarms | first person immediately; second after 10 minutes; third after 20 minutes | |

### Checks on incoming figures

| Check | Our value | Your value |
|---|---|---|
| Largest believable step in an energy counter | capacity × time elapsed × 1.5. Anything larger is set aside and reported. | |
| Most sunlight believable in one hour | 1.5 kilowatt-hours per square metre | |
| A ratio marked as impossible | above 120%. It is still shown as it is, but flagged as a fault rather than a result. | |

---

## Part 10 — Choices we have made

These are choices of ours that work well so far. Please tell us if you would prefer anything different.

- **Periods follow the calendar, in each Plant's own time zone.** "Today" runs from midnight, "this month" from the 1st, and "lifetime" from the Plant's first Reading.
- **The year runs from January to December**, not the Indian financial year (April to March). Switching to April is a small change.
- **Comparisons are made at the same point in time.** At 9:00 in the morning, today's figure is compared with yesterday up to 9:00, not with the whole of yesterday. Otherwise every morning would look like a collapse.
- **A value the equipment sends always takes priority over one we calculate.** If a meter sends its own average voltage, that is what we show.
- **Which Alarm rule applies when several could:** the most specific rule wins. A rule for one Device beats one for its Plant, which beats one for a type of equipment, which beats one for the whole Client. When two rules are equally specific, the Client's own rule beats the platform's default.
- **Contacts are shown exactly as sent: TRUE or FALSE.** A contact turns red only when an Alarm says that state is a fault. Your reference screens show every TRUE in red, which would make a closed breaker look like a fault and a failed trip coil look healthy.
- **The forecast is built from each Plant's own last 14 days, without a weather service.** It is honest about what it can do: it follows today's conditions for the next few hours and then the Plant's typical day, but it cannot foresee a cloudy tomorrow. A weather-service forecast could be added if you would like one.

---

## Appendix A — How our names match your signal sheet

The body of this document spells every name out in full. This table connects those names to the labels in your signal sheet.

| Name in this document | Label in your signal sheet |
|---|---|
| Multi-function meter | MFM |
| Settlement meter (availability-based tariff meter) | ABT METER |
| Vacuum circuit breaker | VCB |
| Weather monitoring station | WMS |
| Power plant controller | PPC |
| String monitoring box | SMB |
| State Load Despatch Centre link | SLDC TELEMETRY |
| Main Control Room section | MCR SECTION |
| Inverter Control Room section | ICR SECTION |
| Uninterruptible power supply | UPS |
| Direct-current power bank | DC POWER BANK |
| Oil temperature (Transformer) | OTI TEMP |
| Winding temperature (Transformer) | WTI-1 TEMP, WTI-2 TEMP |
| Performance Ratio | PR |
| Capacity Utilisation Factor | CUF |
| Horizontal sunlight | GHI |
| Tilted sunlight | GTI |

## Appendix B — Reference numbers

These are the numbers the questions carry in our project records. They help us keep track; you can ignore them.

| Question | Our reference |
|---|---|
| 1 | OPEN-15, T-1, B-18 |
| 2 | T-2 |
| 3 | T-5 |
| 4 | T-6 |
| 5 | T-7 |
| 6 | T-11, T-14 |
| 7 | OPEN-15 |
| 8 | Status meanings (8 October) |
| 9 | Irradiation reset assumption |
| 10 | Weather reference screen |
| 11 | Meter reference screen |
| 12 | OPEN-16, T-16 |
| 13 | OPEN-16 |
| 14 | OPEN-16 |
| 15 | Dial thresholds (29 September) |
| 16 | Expected power (24 September) |
| 17 | Carbon dioxide factor |
| 18 | OPEN-14, B-6 |
| 19 | OPEN-14, B-5 |
| 20 | OPEN-14 |
| 21 | B-13 |
| 22 | T-17, start and stop (24 September) |
| 23 | Grid status (24 September) |
| 24 | OPEN-22, T-18 |
| 25 | T-19 |
| 26 | OPEN-24 (a, c), B-15 |
| 27 | OPEN-24 (b) |
| 28 | OPEN-24 (d, e) |
| 29 | OPEN-24 (f) |
| 30 | OPEN-24 (g) |
| 31 | OPEN-17, T-3 |
| 32 | OPEN-17 |
| 33 | OPEN-19, T-8 |
| 34 | OPEN-12, T-9 |
| 35 | OPEN-13 |
| 36 | OPEN-18, T-10 |
| 37 | T-15 |
| 38 | T-13 |
| 39 | Annunciator labels |
| 40 | Broker, 6 October (section 8.3) |
| 41 | Plant details |
| 42 | B-16 |
| 43 | B-17 |
| 44 | Broker, 6 October (section 8.4) |
| 45 | B-14 |
| 46 | OPEN-2 |
| 47 | OPEN-4 |
| 48 | OPEN-1, OPEN-5 |
| 49 | OPEN-6 |
| 50 | OPEN-23 |
| 51 | OPEN-20 |
| 52 | OPEN-10 |
| 53 | OPEN-11 |
| 54 | WhatsApp provider |
| 55 | OPEN-7 |
