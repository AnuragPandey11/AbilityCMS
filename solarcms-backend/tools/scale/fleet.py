"""A load-test fleet: many Plants shaped like the client's real one.

Imported by every script in `tools/scale/`. Built on `tools/simulate_fleet.py`
(its Device specs, payload generator and short keys), so the load test publishes
exactly what the fleet simulator does — and therefore what the client's broker
does — only more of it.

── Shape of each Plant ──────────────────────────────────────────────────────
Modelled on KULAR_GREEN, the one real Plant: seventeen Inverters in one MCR,
plus MFM, ABT meter, Transformer, VCB, WMS and PPC outside it, every Device
publishing every 30 s. Each Inverter's 28 PV strings are split off onto two
topics of their own, `…/INVERTER_n_STRING16` (`I1..I16`, `P1..P16`) and
`…_STRING28` (`I17..I28`, `P17..P28`), as the client's broker has done since
6 Oct 2026 (BROKER_OBSERVATIONS §8) — so a Plant is 23 Devices and 57 topics,
and 50 Plants publish ~95 messages/s, the rate the capacity plan sizes for.

── Isolation ────────────────────────────────────────────────────────────────
Topics live under `loadtest/v1`, which no `topic_patterns` row in a normal
database matches and no ingest subscription covers, so a load test can never
leak into a development database through a persistent broker session. The
setup script adds the two `loadtest/v1` patterns to the load-test database only.
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
for path in (BACKEND, BACKEND / "src"):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

from tools import simulate_fleet as sf  # noqa: E402

TOPIC_ROOT = "loadtest/v1"
INTERVAL_S = 30.0
INVERTERS_PER_PLANT = 17
INVERTER_KW = 330.0
STRINGS_PER_INVERTER = 28
CLIENTS = 10
PLANTS_PER_CLIENT = 5
PASSWORD = "fleet12345"

#: ⚠ Every load-test Plant is in India, on Asia/Kolkata — decided 9 Oct 2026,
#: because the client's Plants all are. Do not give a Plant another clock: a
#: Plant abroad changes where its day begins and so what "today" reads, and a
#: result from such a fleet is not comparable with one from an Indian fleet.
#: (The first run, 8 Oct 2026, put the three history Plants in Bangkok, Los
#: Angeles and Lagos to measure "today" at three hours in one sitting; with one
#: clock, measure at different times of day instead — CAPACITY_AND_DEPLOYMENT.md §11.)
TIMEZONE = "Asia/Kolkata"

#: The Plants that get generated history.
HISTORY_PLANTS: tuple[str, ...] = ("LT01_P1", "LT01_P2", "LT01_P3")

TOPIC_PATTERNS = (
    (f"{TOPIC_ROOT}/{{client_code}}/{{plant_code}}/{{collector_code}}/{{device_code}}", 20),
    (f"{TOPIC_ROOT}/{{client_code}}/{{plant_code}}/{{device_code}}", 21),
)


def plant_spec(code: str, name: str, timezone: str) -> sf.PlantSpec:
    ac_kw = INVERTERS_PER_PLANT * INVERTER_KW
    devices = (
        *sf._inverters(INVERTERS_PER_PLANT, INVERTER_KW, "MCR",
                       strings=STRINGS_PER_INVERTER),
        sf.DeviceSpec("MFM", "MFM"),
        sf.DeviceSpec("ABT_METER", "ABT_METER"),
        sf.DeviceSpec("TRANSFORMER", "TRANSFORMER"),
        sf.DeviceSpec("VCB", "VCB"),
        sf.DeviceSpec("WMS", "WMS"),
        sf.DeviceSpec("PPC", "PPC"),
    )
    return sf.PlantSpec(code, name, timezone, ac_kw, round(ac_kw * 1.2), INTERVAL_S,
                        TOPIC_ROOT, devices)


def build_fleet(clients: int = CLIENTS,
                plants_per_client: int = PLANTS_PER_CLIENT) -> tuple[sf.ClientSpec, ...]:
    fleet = []
    for c in range(1, clients + 1):
        client_code = f"LT{c:02d}"
        plants = tuple(
            plant_spec(f"{client_code}_P{p}", f"Load test {client_code} Plant {p}", TIMEZONE)
            for p in range(1, plants_per_client + 1)
        )
        fleet.append(sf.ClientSpec(client_code, f"Load test Client {c:02d}",
                                   f"{client_code.lower()}@loadtest.example.com",
                                   plants, password=PASSWORD))
    return tuple(fleet)


FLEET = build_fleet()

_PV_KEY = re.compile(r"^PV(\d+) (CURRENT|VOLTAGE|ACTIVE POWER)$")


def messages(sim: sf.PlantSim, now: datetime) -> list[tuple[str, dict[str, str]]]:
    """One publishing cycle of a Plant, as the client's broker would carry it.

    The simulator puts every PV input in the Inverter's own payload; the client's
    broker carries them on two string topics per Inverter, current and power
    only. This moves them there, and changes nothing else.
    """
    payloads = sim.sample_all(now, sim.plant.interval_s)
    out: list[tuple[str, dict[str, str]]] = []
    for spec in sim.plant.devices:
        if sim.state[spec.code].silent:
            continue
        topic = sim.topic(spec)
        body = dict(payloads[spec.code])
        if spec.kind == "INVERTER" and spec.strings:
            low: dict[str, str] = {}
            high: dict[str, str] = {}
            for key in list(body):
                match = _PV_KEY.match(key)
                if match is None:
                    continue
                value = body.pop(key)
                n, what = int(match.group(1)), match.group(2)
                letter = {"CURRENT": "I", "ACTIVE POWER": "P"}.get(what)
                if letter is not None:
                    (low if n <= 16 else high)[f"{letter}{n}"] = value
            out.append((topic, body))
            out.append((f"{topic}_STRING16", low))
            out.append((f"{topic}_STRING28", high))
        else:
            out.append((topic, body))
    return out


def all_sims(clock_offset_h: float = 0.0,
             saved: dict | None = None) -> list[sf.PlantSim]:
    return [sf.PlantSim(c, p, clock_offset_h, saved) for c in FLEET for p in c.plants]
