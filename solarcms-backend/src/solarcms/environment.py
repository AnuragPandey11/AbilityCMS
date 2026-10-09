"""Which kind of deployment this is, and what that forbids.

docs/CAPACITY_AND_DEPLOYMENT.md §6.4, item 18: no fabricated fleet and no demo
Clients in production. The scripts that fabricate one call `refuse_in_production`
before doing anything, so a script run against the wrong environment stops
before it writes, instead of a monitoring platform's customers seeing invented
Plants beside their own.
"""

from __future__ import annotations

import sys

from solarcms.config import get_settings


def is_production() -> bool:
    return get_settings().environment.strip().lower() == "production"


def refuse_in_production(what: str) -> None:
    """Exit with a reason when ENVIRONMENT=production."""
    if is_production():
        sys.exit(f"refusing: {what} fabricates data, and ENVIRONMENT=production")
