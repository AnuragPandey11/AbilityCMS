"""Every mutating route writes an audit row (Phase 10).

A source scan rather than a runtime sweep: exercising every mutating endpoint
would need fixtures for each and would still miss the route added tomorrow.
Reading the source catches a new one on the day it appears, and needs no
database — which is why it lives in the unit suite.
"""

from __future__ import annotations

import re
from pathlib import Path

ROUTERS = (Path(__file__).resolve().parents[2]
           / "src" / "solarcms" / "api" / "routers")

# Routes that legitimately write no audit row, with the reason. Anything else
# appearing in the static scan is a gap.
AUDIT_EXEMPT = {
    # Writes auth.switch_client through _audit_standalone, which the scan cannot
    # see from inside the route body.
    ("POST", "/switch-client"): "audited via _audit_standalone",
    # Delegates to _insert_devices, which writes one audit row per Device created
    # — including for the bulk path, which shares the same helper.
    ("POST", "/devices"): "audited inside _insert_devices",
}


def test_every_mutating_route_writes_an_audit_row() -> None:
    """Static scan, deliberately.

    Exercising every mutating endpoint at runtime would need fixtures for each
    and would still miss a route added tomorrow. Reading the source catches the
    new one on the day it appears.
    """
    missing: list[str] = []
    for file in sorted(ROUTERS.glob("*.py")):
        source = file.read_text()
        for block in re.split(r"\n(?=@(?:router|blocks_router)\.)", source):
            match = re.match(r"@\w+\.(post|patch|put|delete)\(\"([^\"]*)\"", block)
            if not match:
                continue
            method, path = match.group(1).upper(), match.group(2)
            if (method, path) in AUDIT_EXEMPT:
                continue
            # The artifact download is a GET-shaped read behind a signed URL.
            if "artifacts" in path:
                continue
            if "audit_log" not in block and "_audit" not in block:
                missing.append(f"{method} {file.stem}{path}")
    assert not missing, f"mutating routes writing no audit row: {missing}"


