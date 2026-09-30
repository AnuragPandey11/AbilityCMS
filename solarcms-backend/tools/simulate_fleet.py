"""Fleet simulator: three fabricated Clients and five Plants, publishing to the
Docker broker so multi-tenancy can be tested against equipment that behaves.

    python tools/simulate_fleet.py --list
    python tools/simulate_fleet.py
    python tools/simulate_fleet.py --fault SF_NORTH:INVERTER_5:silent
    python tools/simulate_fleet.py --fault SF_NORTH:MCR_B:silent
    python tools/simulate_fleet.py --fault WH2:*:silent
    python tools/simulate_fleet.py --clock-offset -9      (it is night here; make it noon)

The client's test broker carries one Plant, so it cannot show whether a second
Client sees the first's data, whether a Plant with no Transformer renders its
stage as "not instrumented", or whether a Collector going dark raises one
Alarm rather than six. This publishes a fleet that differs on exactly the axes
those questions turn on, to the broker in docker-compose.yml, which is otherwise
idle. Point ingest at it with `MQTT_HOST=localhost` in `.env`.

── What is faithful, and what is not ────────────────────────────────────────
Every payload uses the **same short keys the client's broker sends** (`PAC`,
`VRY`, `DE`, `CE`; `"ON": "TRUE"` on a VCB), as observed in `mqtt_raw` on
21 Sep 2026, and every value is a string, because theirs are. The point is
that commissioning binds exactly the Tags it would bind for real equipment,
via the same `alias_for`, and that nothing here exercises a code path the
client's data would not.

The *values* are fabricated. They follow a solar curve in the Plant's own
timezone, they sit inside each Tag's `valid_min`/`valid_max` so quality flags
mean something, and a meter reads slightly below the sum of its Inverters so
"measured" and "summed" provenance differ visibly. None of that is evidence
about units, scaling or formulas — OPEN-14/15/16 stay open, and a PR this
produces is a PR of invented numbers.

── Strings: the one set of keys nobody has observed ─────────────────────────
SF_NORTH's Inverters publish sixteen PV inputs each, WH1's and VF_LUDHIANA's twelve, as
`PVn CURRENT`, `PVn VOLTAGE` and `PVn ACTIVE POWER` — added 30 Sep 2026 so the
String Analysis screen has something to draw. ⚠ These are the names on the
client's *signal schedule* (TAG_CATALOGUE §2.4a), **not** keys seen on their
broker: no Inverter there publishes per-string values yet, so the real keys
may well be short ones like `PAC`. SF_SOUTH and WH2 publish none, and have no
string count, which is the state the client's own Plant is in today.

Two faults are built in, because they are what the screen is for: SF_NORTH
INVERTER_4's PV7 is dead and INVERTER_11's PV12 is shaded to 60%. At 400 kW
and ~720 V each input carries 30-odd amps at noon — several strings in
parallel on one MPPT input, realistically, which is itself a question for the
client (is PVn a string or an input?). ⚠ The aggregate `PVI` is left as it
was, about 1000x smaller than the inputs sum to: scaling it to amps would put
a 400 kW Inverter's ~560 A above DC_CURRENT's 500 A range and flag it.

── The fleet, and why it is shaped this way ─────────────────────────────────
SUNFIELD  (utility-scale, Asia/Kolkata)
  SF_NORTH  4.8 MW  two Collectors (MCR_A, MCR_B) of six Inverters each, and
            MFM + ABT_METER + TRANSFORMER + VCB + WMS + PPC outside any box.
            Lower-case topic root. The "full" Plant: every stage populated,
            two enclosures, both settlement and check meters present.
  SF_SOUTH  2.0 MW  one Collector (ICR) of four Inverters; MFM, TRANSFORMER,
            VCB, WMS, no ABT meter, no PPC. UPPER-CASE topic root, so the
            second `topic_patterns` row is exercised. The dashboard's
            settlement-power slot must fall back to the MFM here.
ROOFCO    (rooftop, Asia/Dubai — a different day boundary)
  WH1       450 kW  three Inverters with **no Collector** (five-segment
            topics), one MFM as the net meter, WMS. No Transformer, no VCB:
            the Transformer stage renders "not instrumented" and that is
            correct here.
  WH2       200 kW  two Inverters, one MFM, nothing else, on a slow 120 s
            cycle. The smallest Plant that can exist; liveness against a
            fixed clock would call it late.
VARDHMAN  (textile mill, captive rooftop, Asia/Kolkata; added 30 Sep 2026)
  VF_LUDHIANA  2.0 MW  sixteen 125 kW string Inverters on two mill roofs, each
            roof a Collector (WEAVING_SHED ten, PROCESS_HOUSE six), stepped up
            to 11 kV through the mill's own Transformer and VCB, with MFM,
            ABT_METER, WMS and a PPC outside both. UPPER-CASE root, as the
            client's broker uses. The one Client that also has an operator —
            a Client Employee — so an Employee's view of a whole Client can
            be checked here without granting one on another Client. Twelve PV
            inputs per Inverter, and one fault: INVERTER_14's PV9 shaded to
            70%.

Regions differ on purpose too, because CO₂ avoided is energy times the Region's
grid factor: with one factor everywhere its per-Plant split *is* the energy
split, and the fleet's CO₂ donut can never show anything the energy donut does
not. SF_NORTH, SF_SOUTH, WH1 and VF_LUDHIANA each sit in a different Region; WH2 has none
and falls back to the national default, so the tile's "no Region factor"
wording has a case to render. The factors are invented — chosen only to differ
from each other and from that default, not a statement about any real grid.

Plant codes are distinct across Clients on purpose; `services/onboarding`
matches a Plant under its Client now, but a fleet that would only work
because of that fix is a poor test of anything else.

── Counters survive a restart ───────────────────────────────────────────────
A real meter's export register does not change when the datalogger reboots.
This one used to: every lifetime counter (`CE`, `ME`, `EXP`, `IMP`) started at
a fresh random value on each run, and the daily ones (`DE`, `AGHI`) went back
to zero mid-day. Each restart was therefore a jump of up to 2.5 GWh in a
counter the KPI endpoint subtracts, and a 240 kWp rooftop reported 1.6 GWh
"today" — a PR of 76,000%. Every register is now saved to `--state` after each
cycle (default `.artifacts/simulate_fleet_state.json`, keyed by topic) and
resumed from on the next run, so a restart looks like what it is: the Plant
went quiet for a while and nothing accrued. A Device with no saved entry still
starts at a random lifetime value, once. `--fresh` ignores the file.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import random
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import aiomqtt

# ── Fleet definition ─────────────────────────────────────────────────────────
# `scripts/seed_fleet.py` imports FLEET to create the Clients and Plants, so the
# codes here are the only place they are spelled.


@dataclass(frozen=True)
class DeviceSpec:
    code: str
    kind: str                       # a device_types.code
    collector: str | None = None    # {collector_code}, or None for a 5-segment topic
    capacity_kw: float = 0.0        # Inverters only
    derate: float = 1.0             # 0.6 = runs 40% below its siblings, always
    # PV inputs published as PVn CURRENT / VOLTAGE / ACTIVE POWER (Inverters
    # only; 0 = none, as the client's broker sends today). See "Strings" above.
    strings: int = 0
    # (string, factor): 0.0 is a dead string, 0.6 one shaded to 60% of its
    # neighbours. Every other string is 1.0.
    string_factors: tuple[tuple[int, float], ...] = ()

    def string_factor(self, n: int) -> float:
        return dict(self.string_factors).get(n, 1.0)

    @property
    def mean_string_factor(self) -> float:
        """How much of its nameplate the strings deliver: a dead string costs the
        Inverter its share of output, exactly as it would on a real machine."""
        if not self.strings:
            return 1.0
        return sum(self.string_factor(n) for n in range(1, self.strings + 1)) / self.strings


@dataclass(frozen=True)
class RegionSpec:
    code: str                       # ISO 3166-2, as RegionSelect expects
    name: str
    country: str                    # ISO 3166-1 alpha-2
    grid_factor: float              # kg CO₂ / kWh — invented, see the docstring


@dataclass(frozen=True)
class PlantSpec:
    code: str
    name: str
    timezone: str
    ac_capacity_kw: float
    dc_capacity_kwp: float
    interval_s: float
    topic_root: str                 # "scms/v1" or "SCMS/V1"
    devices: tuple[DeviceSpec, ...]
    region: RegionSpec | None = None  # None = the national default factor

    @property
    def inverters(self) -> tuple[DeviceSpec, ...]:
        return tuple(d for d in self.devices if d.kind == "INVERTER")


@dataclass(frozen=True)
class ClientSpec:
    code: str
    name: str
    admin_email: str
    plants: tuple[PlantSpec, ...]
    # A Client Employee over every Plant of the Client, created by
    # `scripts/seed_fleet.py`; None = the Client has only its admin.
    operator_email: str | None = None
    # Every login of this Client, unless `seed_fleet.py --password` overrides
    # it. Dev only — these are fabricated tenants.
    password: str = "fleet12345"


def _inverters(n: int, kw: float, collector: str | None, start: int = 1,
               derate: dict[int, float] | None = None, strings: int = 0,
               string_faults: dict[int, dict[int, float]] | None = None) -> list[DeviceSpec]:
    return [DeviceSpec(f"INVERTER_{i}", "INVERTER", collector, kw,
                       (derate or {}).get(i, 1.0), strings,
                       tuple(sorted((string_faults or {}).get(i, {}).items())))
            for i in range(start, start + n)]


# "(demo)" in the name because `regions` is shared by every Client and has no
# `is_demo` of its own, and these factors must never be mistaken for sourced ones.
_RAJASTHAN = RegionSpec("IN-RJ", "Rajasthan (demo)", "IN", 0.91)
_KARNATAKA = RegionSpec("IN-KA", "Karnataka (demo)", "IN", 0.64)
_DUBAI = RegionSpec("AE-DU", "Dubai (demo)", "AE", 0.42)
_PUNJAB = RegionSpec("IN-PB", "Punjab (demo)", "IN", 0.76)


FLEET: tuple[ClientSpec, ...] = (
    ClientSpec("SUNFIELD", "Sunfield Energy", "sunfield@example.com", (
        PlantSpec("SF_NORTH", "Sunfield North", "Asia/Kolkata",
                  4800.0, 5760.0, 30.0, "scms/v1", (
            # Sixteen PV inputs each, as the client's reference String Analysis
            # screen draws. INVERTER_4's PV7 is dead (a blown fuse) and
            # INVERTER_11's PV12 is shaded to 60% of its neighbours: the two
            # faults that screen exists to show.
            *_inverters(6, 400.0, "MCR_A", strings=16, string_faults={4: {7: 0.0}}),
            # INVERTER_9 is permanently 40% down: what a relative
            # underperformance rule catches and an absolute threshold cannot.
            # Its strings are down together, so none of them reads low against
            # its own neighbours — a whole-Inverter loss is not a string fault.
            *_inverters(6, 400.0, "MCR_B", start=7, derate={9: 0.6}, strings=16,
                        string_faults={11: {12: 0.6}}),
            DeviceSpec("MFM", "MFM"),
            DeviceSpec("ABT_METER", "ABT_METER"),
            DeviceSpec("TRANSFORMER", "TRANSFORMER"),
            DeviceSpec("VCB", "VCB"),
            DeviceSpec("WMS", "WMS"),
            DeviceSpec("PPC", "PPC"),
        ), region=_RAJASTHAN),
        PlantSpec("SF_SOUTH", "Sunfield South", "Asia/Kolkata",
                  2000.0, 2400.0, 60.0, "SCMS/V1", (
            *_inverters(4, 500.0, "ICR"),
            DeviceSpec("MFM", "MFM"),
            DeviceSpec("TRANSFORMER", "TRANSFORMER"),
            DeviceSpec("VCB", "VCB"),
            DeviceSpec("WMS", "WMS"),
        ), region=_KARNATAKA),
    )),
    ClientSpec("ROOFCO", "Roofco Logistics", "roofco@example.com", (
        PlantSpec("WH1", "Warehouse 1 Rooftop", "Asia/Dubai",
                  450.0, 540.0, 15.0, "scms/v1", (
            *_inverters(3, 150.0, None, strings=12),
            DeviceSpec("MFM", "MFM"),
            DeviceSpec("WMS", "WMS"),
        ), region=_DUBAI),
        PlantSpec("WH2", "Warehouse 2 Rooftop", "Asia/Dubai",
                  200.0, 240.0, 120.0, "scms/v1", (
            *_inverters(2, 100.0, None),
            DeviceSpec("MFM", "MFM"),
        )),
    )),
    ClientSpec("VARDHMAN", "Vardhman Fabrics", "vardhman@example.com", (
        PlantSpec("VF_LUDHIANA", "Ludhiana Mill Rooftop", "Asia/Kolkata",
                  2000.0, 2400.0, 60.0, "SCMS/V1", (
            # 125 kW string Inverters on two mill roofs, twelve PV inputs
            # each. INVERTER_14's PV9 is shaded to 70% by the process house's
            # boiler stack — the one fault on an otherwise healthy Plant.
            *_inverters(10, 125.0, "WEAVING_SHED", strings=12),
            *_inverters(6, 125.0, "PROCESS_HOUSE", start=11, strings=12,
                        string_faults={14: {9: 0.7}}),
            DeviceSpec("MFM", "MFM"),
            DeviceSpec("ABT_METER", "ABT_METER"),
            DeviceSpec("TRANSFORMER", "TRANSFORMER"),
            DeviceSpec("VCB", "VCB"),
            DeviceSpec("WMS", "WMS"),
            DeviceSpec("PPC", "PPC"),
        ), region=_PUNJAB),
    ), operator_email="operator@example.com", password="admin12345"),
)


# ── Signal generation ────────────────────────────────────────────────────────

def solar_curve(now_local: datetime) -> float:
    """0 at night, 1 at solar noon, in the Plant's own clock."""
    hour = now_local.hour + now_local.minute / 60 + now_local.second / 3600
    if not 6 <= hour <= 18:
        return 0.0
    return math.sin((hour - 6) / 12 * math.pi)


def _b(flag: bool) -> str:
    # The client's contacts arrive as the strings "TRUE"/"FALSE", not JSON
    # booleans — the shape that once decoded every VCB signal to nothing.
    return "TRUE" if flag else "FALSE"


@dataclass
class DeviceState:
    spec: DeviceSpec
    energy_total_kwh: float = field(default_factory=lambda: random.uniform(50_000, 400_000))
    energy_today_kwh: float = 0.0
    energy_month_kwh: float = field(default_factory=lambda: random.uniform(5_000, 40_000))
    export_total_kwh: float = field(default_factory=lambda: random.uniform(500_000, 3_000_000))
    import_total_kwh: float = field(default_factory=lambda: random.uniform(1_000, 9_000))
    ghi_cumulative: float = 0.0
    last_power_kw: float = 0.0
    # The local date and month the daily and monthly registers belong to, as
    # ISO strings, so a saved state resumed on another day still rolls over.
    last_day: str = ""
    last_month: str = ""
    silent: bool = False
    frozen: bool = False
    frozen_payload: dict[str, str] | None = None

    def _roll_day(self, now_local: datetime) -> None:
        day = now_local.date().isoformat()
        if self.last_day != day:
            self.last_day = day
            self.energy_today_kwh = 0.0
            self.ghi_cumulative = 0.0
        month = now_local.strftime("%Y-%m")
        if self.last_month != month:
            # A fresh Device (no month recorded) keeps its fabricated
            # month-to-date; only a real change of month resets it.
            if self.last_month:
                self.energy_month_kwh = 0.0
            self.last_month = month


# ── Persistence ──────────────────────────────────────────────────────────────

DEFAULT_STATE_PATH = (
    Path(__file__).resolve().parent.parent / ".artifacts" / "simulate_fleet_state.json"
)

# The registers a real Device keeps through a reboot. Everything else in
# `DeviceState` is either configuration or a fault flag set per run.
PERSISTED_FIELDS = (
    "energy_total_kwh", "energy_today_kwh", "energy_month_kwh",
    "export_total_kwh", "import_total_kwh", "ghi_cumulative",
    "last_day", "last_month",
)


class StateStore:
    """Counters by topic, read once at start and rewritten after every cycle.

    Saved *after* sampling and before publishing, so what is on disk is never
    behind what was sent: a crash can lose at most one interval of accrual,
    which reads as a short silence, and can never make a counter go backwards.
    """

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.sims: list[PlantSim] = []

    def load(self) -> dict[str, dict[str, Any]]:
        if self.path is None or not self.path.exists():
            return {}
        try:
            data = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            sys.exit(f"cannot read simulator state {self.path}: {exc} (use --fresh to start over)")
        return data if isinstance(data, dict) else {}

    def save(self) -> None:
        if self.path is None:
            return
        snapshot = {
            sim.topic(spec): {
                name: getattr(sim.state[spec.code], name) for name in PERSISTED_FIELDS
            }
            for sim in self.sims
            for spec in sim.plant.devices
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # Written aside and renamed, so an interrupted write leaves the last
        # good file rather than half of one.
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, indent=1, sort_keys=True))
        os.replace(tmp, self.path)


class PlantSim:
    """One Plant's Devices, sampled together so the meter can see the Inverters."""

    def __init__(self, client: ClientSpec, plant: PlantSpec,
                 clock_offset_h: float = 0.0,
                 saved: dict[str, dict[str, Any]] | None = None) -> None:
        self.client = client
        self.plant = plant
        self.tz = ZoneInfo(plant.timezone)
        # Shifts only the clock the *sun* follows. Messages are still received
        # and stamped now, so a Plant can be made to generate at 21:00 local
        # for a test that cannot wait for morning — and its Readings land in
        # the evening, which is what an offset means and not something to hide.
        self.clock_offset = timedelta(hours=clock_offset_h)
        self.state = {d.code: DeviceState(d) for d in plant.devices}
        for spec in plant.devices:
            for name, value in (saved or {}).get(self.topic(spec), {}).items():
                if name in PERSISTED_FIELDS:
                    setattr(self.state[spec.code], name, value)
        self.cloud = 0.0

    def topic(self, device: DeviceSpec) -> str:
        parts = [self.plant.topic_root, self.client.code, self.plant.code]
        if device.collector is not None:
            parts.append(device.collector)
        parts.append(device.code)
        return "/".join(parts)

    def sample_all(self, now: datetime, interval_s: float) -> dict[str, dict[str, str]]:
        now_local = (now + self.clock_offset).astimezone(self.tz)
        curve = solar_curve(now_local)
        # A slow-moving cloud factor shared by the whole Plant, so Inverters
        # move together (as they do) and a per-Device deviation stands out.
        self.cloud = max(0.55, min(1.0, self.cloud + random.uniform(-0.04, 0.04))) \
            if curve > 0 else 1.0
        irradiance = 1000.0 * curve * self.cloud            # W/m2
        hours = interval_s / 3600

        payloads: dict[str, dict[str, str]] = {}
        inverter_kw = 0.0
        for spec in self.plant.devices:
            st = self.state[spec.code]
            st._roll_day(now_local)
            if spec.kind == "INVERTER":
                power = spec.capacity_kw * spec.derate * curve * self.cloud \
                    * spec.mean_string_factor * random.uniform(0.985, 1.015)
                st.last_power_kw = power
                st.energy_today_kwh += power * hours
                st.energy_total_kwh += power * hours
                st.energy_month_kwh += power * hours
                inverter_kw += power
                payloads[spec.code] = self._inverter(st, power, now_local)
            elif spec.kind == "WMS":
                st.ghi_cumulative += irradiance * hours / 1000
                payloads[spec.code] = self._wms(st, irradiance, curve)

        # Meters see the Plant after ~2% of losses; the ABT meter and the MFM
        # disagree by a few tenths of a percent, as sealed and check meters do.
        for spec in self.plant.devices:
            st = self.state[spec.code]
            if spec.kind in ("MFM", "ABT_METER"):
                bias = 0.98 if spec.kind == "MFM" else 0.977
                payloads[spec.code] = self._meter(st, inverter_kw * bias, hours)
            elif spec.kind == "TRANSFORMER":
                payloads[spec.code] = self._transformer(inverter_kw, self.plant.ac_capacity_kw)
            elif spec.kind == "VCB":
                payloads[spec.code] = self._vcb()
            elif spec.kind == "PPC":
                payloads[spec.code] = self._ppc(self.plant.ac_capacity_kw)

        for code, st in self.state.items():
            if st.frozen:
                if st.frozen_payload is None:
                    st.frozen_payload = payloads[code]
                payloads[code] = st.frozen_payload
        return payloads

    # Each sampler returns the key set the client's Device of that Type sends.

    @staticmethod
    def _inverter(st: DeviceState, power: float, now_local: datetime) -> dict[str, str]:
        running = power > 1.0
        v = random.uniform(795, 805) if running else 0.0     # 800 V LT bus
        i = power / (math.sqrt(3) * 0.8) if running else 0.0  # per phase
        pvv = random.uniform(700, 740) if running else 0.0
        return {
            **PlantSim._strings(st.spec, power, pvv),
            "F": f"{random.uniform(49.92, 50.08):.3f}" if running else "0.0",
            "Q": f"{power * random.uniform(0.02, 0.06):.2f}",
            "CE": f"{st.energy_total_kwh:.2f}",
            "DE": f"{st.energy_today_kwh:.2f}",
            "IB": f"{i * random.uniform(0.99, 1.01):.2f}",
            "IR": f"{i * random.uniform(0.99, 1.01):.2f}",
            "IY": f"{i * random.uniform(0.99, 1.01):.2f}",
            "ME": f"{st.energy_month_kwh:.2f}",
            "MT": f"{28 + 25 * (power / max(st.spec.capacity_kw, 1)):.1f}",
            "PF": f"{random.uniform(0.97, 0.995):.3f}" if running else "0.0",
            "EFF": f"{random.uniform(97.5, 98.8):.2f}" if running else "0.0",
            "PAC": f"{power:.2f}",
            "PVI": f"{power / 0.98 / 720:.2f}" if running else "0.0",
            "PVV": f"{pvv:.1f}",
            # 40960 is what the client's Inverters report at night (observed).
            "STS": "1024" if running else "40960",
            "VBR": f"{v * random.uniform(0.998, 1.002):.1f}",
            "VRY": f"{v * random.uniform(0.998, 1.002):.1f}",
            "VYB": f"{v * random.uniform(0.998, 1.002):.1f}",
        }

    @staticmethod
    def _strings(spec: DeviceSpec, power: float, pvv: float) -> dict[str, str]:
        """Each PV input's current, voltage and power, summing to the DC side.

        A healthy input carries its share of the DC current the Inverter's AC
        output implies (at 98% efficiency), ±3% — well inside the 20% the String
        Analysis rule tolerates, so only the configured faults read as faults.
        A dead input carries nothing but still reads the MPPT's voltage, as an
        input with a blown fuse does. At night every input reads zero.
        """
        if not spec.strings:
            return {}
        running = power > 1.0 and pvv > 0
        # The DC current a fully healthy set of inputs would carry, per input.
        per_input = (power / 0.98 / spec.mean_string_factor * 1000.0 / pvv / spec.strings
                     if running and spec.mean_string_factor > 0 else 0.0)
        out: dict[str, str] = {}
        for n in range(1, spec.strings + 1):
            current = per_input * spec.string_factor(n) * random.uniform(0.97, 1.03)
            voltage = pvv * random.uniform(0.995, 1.005) if running else 0.0
            out[f"PV{n} CURRENT"] = f"{current:.2f}"
            out[f"PV{n} VOLTAGE"] = f"{voltage:.1f}"
            out[f"PV{n} ACTIVE POWER"] = f"{current * voltage / 1000.0:.2f}"
        return out

    @staticmethod
    def _meter(st: DeviceState, power_kw: float, hours: float) -> dict[str, str]:
        # At night the Plant draws auxiliary load: a small negative P and
        # the import register creeping, exactly as the client's MFM shows.
        p = power_kw if power_kw > 1.0 else -random.uniform(4.0, 8.0)
        if p > 0:
            st.export_total_kwh += p * hours
        else:
            st.import_total_kwh += -p * hours
        i = abs(p) / (math.sqrt(3) * 11.0 * 0.95)                  # 11 kV feeder
        pf = random.uniform(0.96, 0.99) if p > 0 else random.uniform(0.45, 0.9)
        return {
            "F": f"{random.uniform(49.9, 50.1):.3f}",
            "P": f"{p:.2f}",
            "Q": f"{p * random.uniform(0.05, 0.12):.2f}",
            "IB": f"{i * random.uniform(0.98, 1.02):.4f}",
            "IR": f"{i * random.uniform(0.98, 1.02):.4f}",
            "IY": f"{i * random.uniform(0.98, 1.02):.4f}",
            "EXP": f"{st.export_total_kwh:.1f}",
            "IMP": f"{st.import_total_kwh:.3f}",
            "PFB": f"{pf * random.uniform(0.98, 1.0):.3f}",
            "PFR": f"{pf * random.uniform(0.98, 1.0):.3f}",
            "PFY": f"{pf * random.uniform(0.98, 1.0):.3f}",
            "VBR": f"{random.uniform(11.25, 11.55):.6f}",
            "VRY": f"{random.uniform(11.25, 11.55):.6f}",
            "VYB": f"{random.uniform(11.25, 11.55):.6f}",
        }

    @staticmethod
    def _transformer(load_kw: float, capacity_kw: float) -> dict[str, str]:
        load = load_kw / max(capacity_kw, 1.0)
        return {
            "BRA": _b(False), "BRT": _b(False),
            "OTA": _b(False), "OTT": _b(False),
            "OTI": f"{24 + 38 * load + random.uniform(-0.5, 0.5):.5f}",
            "WTI": f"{25 + 45 * load + random.uniform(-0.5, 0.5):.5f}",
            "MOGA": _b(False),
            "WT1A": _b(False), "WT1T": _b(False),
            "WT2A": _b(False), "WT2T": _b(False),
        }

    @staticmethod
    def _vcb() -> dict[str, str]:
        return {
            "ON": _b(True), "ACF": _b(False), "DCF": _b(False), "EPB": _b(False),
            "OCR": _b(False), "REM": _b(False), "SPR": _b(True), "TCH": _b(True),
            "RLYF": _b(False), "SERV": _b(True), "TEST": _b(False), "TRIP": _b(False),
        }

    @staticmethod
    def _wms(st: DeviceState, irradiance: float, curve: float) -> dict[str, str]:
        gti = irradiance * 1.08
        return {
            "AT": f"{24 + 14 * curve + random.uniform(-0.3, 0.3):.1f}",
            "CC": f"{random.uniform(0, 30):.1f}",
            "DA": f"{irradiance * 0.8:.1f}",
            "MT": f"{24 + 30 * curve + random.uniform(-0.5, 0.5):.1f}",
            "WD": f"{random.uniform(0, 359):.0f}",
            "WS": f"{random.uniform(0, 5):.1f}",
            "DIF": f"{irradiance * 0.2:.1f}",
            "DIR": f"{irradiance * 0.8:.1f}",
            "GHI": f"{irradiance:.1f}",
            "GTI": f"{gti:.1f}",
            "AGHI": f"{st.ghi_cumulative:.2f}",
            "AGTI": f"{st.ghi_cumulative * 1.08:.2f}",
            "DIFA": f"{irradiance * 0.2:.1f}",
        }

    @staticmethod
    def _ppc(capacity_kw: float) -> dict[str, str]:
        return {
            "FS": "0.0", "VS": "0.0",
            "APS": f"{capacity_kw:.1f}",
            "FCE": _b(False), "PFS": "0.0", "RPS": "0.0", "VCE": _b(False),
            "APCE": _b(True), "PFCE": _b(False), "RPCE": _b(False),
        }


# ── Faults ───────────────────────────────────────────────────────────────────

FAULTS = ("silent", "frozen")


def apply_faults(sims: list[PlantSim], faults: list[str]) -> None:
    """`PLANT:DEVICE:kind`. DEVICE may be `*`, or a Collector code, so one flag
    can take a whole room dark — the case COLLECTOR_OFFLINE exists for."""
    for raw in faults:
        try:
            plant_code, target, kind = raw.split(":")
        except ValueError:
            sys.exit(f"--fault expects PLANT:DEVICE:{{{'|'.join(FAULTS)}}}, got {raw!r}")
        if kind not in FAULTS:
            sys.exit(f"unknown fault {kind!r}; choose from {', '.join(FAULTS)}")
        sim = next((s for s in sims if s.plant.code == plant_code), None)
        if sim is None:
            sys.exit(f"no Plant {plant_code!r} in the fleet (see --list)")
        hit = [st for st in sim.state.values()
               if target == "*" or st.spec.code == target or st.spec.collector == target]
        if not hit:
            sys.exit(f"nothing in {plant_code} matches {target!r}")
        for st in hit:
            setattr(st, kind, True)
        print(f"fault: {plant_code} {', '.join(st.spec.code for st in hit)} → {kind}",
              file=sys.stderr)


# ── Publishing ───────────────────────────────────────────────────────────────

async def run_plant(client: aiomqtt.Client, sim: PlantSim, args: argparse.Namespace,
                    counter: dict[str, int], store: StateStore) -> None:
    interval = sim.plant.interval_s / args.speed
    # Stagger the first cycle so four Plants do not all fire on the same tick.
    await asyncio.sleep(random.uniform(0, min(interval, 3.0)))
    while args.count == 0 or counter["published"] < args.count:
        now = datetime.now(UTC)
        payloads = sim.sample_all(now, sim.plant.interval_s)
        store.save()
        for spec in sim.plant.devices:
            st = sim.state[spec.code]
            if st.silent:
                continue
            payload = payloads[spec.code]
            if args.shape == "envelope":
                body: object = {
                    "device": spec.code,
                    "timestamp": now.isoformat(),
                    "readings": [{"tag": k, "value": v} for k, v in payload.items()],
                }
            else:
                body = payload      # flat, exactly as the client's broker sends
            await client.publish(sim.topic(spec), json.dumps(body).encode(), qos=1)
            counter["published"] += 1
        await asyncio.sleep(interval)


async def publish_loop(args: argparse.Namespace) -> None:
    store = StateStore(None if args.state == "" else Path(args.state))
    saved = {} if args.fresh else store.load()
    sims = [PlantSim(c, p, args.clock_offset, saved) for c in FLEET for p in c.plants
            if not args.plant or p.code in args.plant]
    if not sims:
        sys.exit("no Plant selected; see --list")
    store.sims = sims
    apply_faults(sims, args.fault)

    counter = {"published": 0}
    async with aiomqtt.Client(
        hostname=args.host, port=args.port,
        username=args.username, password=args.password,
        identifier=f"solarcms-fleet-{random.randint(1000, 9999)}",
    ) as client:
        print(f"publishing {len(sims)} Plants to {args.host}:{args.port} "
              f"({args.shape} payloads, speed x{args.speed}, "
              f"clock offset {args.clock_offset:+g}h)", file=sys.stderr)
        resumed = sum(1 for sim in sims for spec in sim.plant.devices if sim.topic(spec) in saved)
        print(f"  counters: {resumed} Devices resumed from {store.path}"
              if store.path and resumed else
              f"  counters: starting fresh{f', saving to {store.path}' if store.path else ''}",
              file=sys.stderr)
        now = datetime.now(UTC)
        for sim in sims:
            sun = (now + sim.clock_offset).astimezone(sim.tz)
            print(f"  {sim.client.code}/{sim.plant.code}: {len(sim.plant.devices)} "
                  f"Devices every {sim.plant.interval_s:g}s, sun at "
                  f"{sun:%H:%M} local ({solar_curve(sun):.0%} of peak)", file=sys.stderr)
        await asyncio.gather(*(run_plant(client, s, args, counter, store) for s in sims))
    print(f"published {counter['published']} messages", file=sys.stderr)


def print_fleet() -> None:
    for client in FLEET:
        operator = f", operator: {client.operator_email}" if client.operator_email else ""
        print(f"{client.code}  {client.name}  (admin: {client.admin_email}{operator})")
        for plant in client.plants:
            print(f"  {plant.code:<10} {plant.name:<22} {plant.ac_capacity_kw:>7.0f} kW  "
                  f"{plant.timezone:<13} every {plant.interval_s:g}s  root={plant.topic_root}")
            sim = PlantSim(client, plant)
            for d in plant.devices:
                extra = f"  {d.capacity_kw:g} kW" if d.capacity_kw else ""
                extra += f"  derate {d.derate:g}" if d.derate != 1.0 else ""
                extra += f"  {d.strings} strings" if d.strings else ""
                extra += "".join(f"  PV{n}x{f:g}" for n, f in d.string_factors)
                print(f"      {sim.topic(d):<44} {d.kind:<12}{extra}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--username", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--plant", action="append", default=[],
                        help="publish only this Plant code (repeatable)")
    parser.add_argument("--fault", action="append", default=[],
                        help="PLANT:DEVICE:silent|frozen; DEVICE may be * or a Collector code")
    parser.add_argument("--shape", choices=("flat", "envelope"), default="flat",
                        help="flat = the client's broker's body; envelope = the §6.2 contract")
    parser.add_argument("--speed", type=float, default=1.0,
                        help="divide every Plant's interval by this (2 = twice as fast)")
    parser.add_argument("--clock-offset", type=float, default=0.0, metavar="HOURS",
                        help="shift the sun's clock, e.g. -9 to make 21:00 local into noon; "
                             "messages are still stamped with the real time")
    parser.add_argument("--count", type=int, default=0,
                        help="stop after this many messages in total; 0 = run forever")
    parser.add_argument("--state", default=str(DEFAULT_STATE_PATH), metavar="PATH",
                        help="where counters are saved between runs; '' to keep nothing")
    parser.add_argument("--fresh", action="store_true",
                        help="ignore saved counters and start new ones (overwrites --state)")
    parser.add_argument("--list", action="store_true", help="print the fleet and exit")
    args = parser.parse_args()
    if args.list:
        print_fleet()
        return 0
    try:
        asyncio.run(publish_loop(args))
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
