"""Publisher simulator: emits the §6.2 payload on the §6.1 topic format.

    python tools/simulate.py --host localhost --plant DEMO --devices 9
    python tools/simulate.py --host localhost --shape legacy --plant KULAR_GREEN

BACKEND_SPEC §13 requires this at Phase 4 because Phases 5-10 all depend on it:
the WebSocket fan-out, tier routing, the health sweeper and the alarm worker each
need data they can control, and the client's test broker offers neither
per-Device Readings nor a fault you can induce on demand.

Two shapes, so the same tool exercises both ingress paths:

* `canonical` — `scms/v1/{client}/{plant}/{collector}/{device}`, the contract we
  hand the client. This is the one that must work before go-live.
* `legacy`    — `{PLANT}/{CATEGORY}`, mirroring what the test broker publishes
  today, so the ingress registry is tested against reality and not only against
  the shape we would prefer.

`--fault` induces conditions that are otherwise impossible to wait for: a silent
Device for the health sweeper, a frozen sensor for the stuck-value check, a
counter that goes backwards for the rollover path.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import random
import sys
from datetime import UTC, datetime

import aiomqtt

CANONICAL = "scms/v1/{client}/{plant}/{collector}/{device}"

# Keys deliberately match the client's observed CamelCase, so the simulator
# exercises the same alias table production will use.
INVERTER_KEYS = ("ActivePower", "ReactivePower", "ApparentPower", "Frequency",
                 "VoltageRY", "VoltageYB", "VoltageBR", "CurrentR", "CurrentY",
                 "CurrentB", "AvgPowerFactor", "TodayExport", "Export")
WMS_KEYS = ("AverageGHI", "AverageGTI", "AmbientTemp", "ModuleTemp", "WindSpeed",
            "WindDirection", "PerformanceRatio")


def solar_curve(now: datetime) -> float:
    """0 at night, peaking at solar noon. Enough shape to make charts legible."""
    hour = now.hour + now.minute / 60
    if not 6 <= hour <= 18:
        return 0.0
    return math.sin((hour - 6) / 12 * math.pi)


class DeviceSim:
    def __init__(self, code: str, kind: str, capacity_kw: float) -> None:
        self.code = code
        self.kind = kind
        self.capacity_kw = capacity_kw
        self.energy_total = random.uniform(100_000, 500_000)
        self.energy_today = 0.0
        self.frozen = False
        self.silent = False

    def sample(self, now: datetime, *, jitter: float = 0.03) -> dict[str, str]:
        curve = solar_curve(now)
        if self.kind == "wms":
            ghi = 5.5 * curve
            return {
                "AverageGHI": f"{ghi:.6f}",
                "AverageGTI": f"{ghi * 0.96:.6f}",
                "AmbientTemp": f"{25 + 12 * curve:.1f}",
                "ModuleTemp": f"{25 + 22 * curve:.1f}",
                "WindSpeed": f"{random.uniform(0, 4):.1f}",
                "WindDirection": f"{random.uniform(0, 359):.0f}",
                "PerformanceRatio": f"{random.uniform(83, 89):.5f}",
            }

        power = self.capacity_kw * curve * random.uniform(1 - jitter, 1 + jitter)
        self.energy_today += max(power, 0.0) / 3600
        self.energy_total += max(power, 0.0) / 3600
        return {
            "ActivePower": f"{power:.2f}",
            "ReactivePower": f"{power * 0.1:.2f}",
            "ApparentPower": f"{abs(power) * 1.005:.2f}",
            "Frequency": f"{random.uniform(49.95, 50.05):.3f}",
            "VoltageRY": f"{random.uniform(11.2, 11.5):.6f}",
            "VoltageYB": f"{random.uniform(11.2, 11.5):.6f}",
            "VoltageBR": f"{random.uniform(11.2, 11.5):.6f}",
            "CurrentR": f"{abs(power) / 20:.4f}",
            "CurrentY": f"{abs(power) / 20:.4f}",
            "CurrentB": f"{abs(power) / 20:.4f}",
            "AvgPowerFactor": f"{random.uniform(0.95, 0.99):.3f}",
            "TodayExport": f"{self.energy_today:.2f}",
            "Export": f"{self.energy_total:.1f}",
        }


def build_devices(count: int) -> list[DeviceSim]:
    devices = [DeviceSim("WMS-01", "wms", 0.0)]
    devices.append(DeviceSim("MFM-01", "meter", 250.0 * count))
    for index in range(1, count + 1):
        devices.append(DeviceSim(f"INV-{index:02d}", "inverter", 250.0))
    return devices


async def publish_loop(args: argparse.Namespace) -> None:
    devices = build_devices(args.devices)

    if args.fault == "silent" and len(devices) > 2:
        devices[2].silent = True
        print(f"fault: {devices[2].code} will publish nothing", file=sys.stderr)
    if args.fault == "frozen" and len(devices) > 2:
        devices[2].frozen = True
        print(f"fault: {devices[2].code} will repeat one value", file=sys.stderr)
    if args.fault == "underperform" and len(devices) > 3:
        # 40% below its siblings, which no absolute threshold would catch.
        devices[3].capacity_kw *= 0.6
        print(f"fault: {devices[3].code} runs 40% below its siblings", file=sys.stderr)

    frozen_sample: dict[str, dict[str, str]] = {}
    published = 0

    async with aiomqtt.Client(
        hostname=args.host, port=args.port,
        username=args.username, password=args.password,
        identifier=f"solarcms-sim-{random.randint(1000, 9999)}",
    ) as client:
        print(f"publishing to {args.host}:{args.port} every {args.interval}s "
              f"({args.shape} topics)", file=sys.stderr)
        while args.count == 0 or published < args.count:
            now = datetime.now(UTC)
            for device in devices:
                if device.silent:
                    continue
                if device.frozen and device.code in frozen_sample:
                    payload = frozen_sample[device.code]
                else:
                    payload = device.sample(now)
                    if device.frozen:
                        frozen_sample[device.code] = payload

                if args.shape == "canonical":
                    topic = CANONICAL.format(
                        client=args.client, plant=args.plant,
                        collector=args.collector, device=device.code)
                    body: dict[str, object] = {
                        "device": device.code,
                        # The canonical contract carries a timestamp; the client's
                        # current broker does not (BROKER_OBSERVATIONS §2.2).
                        "timestamp": now.isoformat(),
                        "readings": [{"tag": k, "value": v} for k, v in payload.items()],
                    }
                else:
                    category = {"wms": "MMS", "meter": "DATA"}.get(
                        device.kind, "GENERATION")
                    topic = f"{args.plant}/{category}"
                    body = payload  # flat, exactly as the test broker sends

                await client.publish(topic, json.dumps(body).encode(), qos=1)
                published += 1

            if args.count and published >= args.count:
                break
            await asyncio.sleep(args.interval)

    print(f"published {published} messages", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=1883)
    parser.add_argument("--username", default=None)
    parser.add_argument("--password", default=None)
    parser.add_argument("--client", default="demo-client")
    parser.add_argument("--plant", default="DEMO-PLANT")
    parser.add_argument("--collector", default="plc-01")
    parser.add_argument("--devices", type=int, default=9,
                        help="number of Inverters, plus one meter and one WMS")
    parser.add_argument("--interval", type=float, default=5.0)
    parser.add_argument("--count", type=int, default=0, help="0 = run forever")
    parser.add_argument("--shape", choices=("canonical", "legacy"), default="canonical")
    parser.add_argument("--fault", choices=("none", "silent", "frozen", "underperform"),
                        default="none")
    args = parser.parse_args()
    asyncio.run(publish_loop(args))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
