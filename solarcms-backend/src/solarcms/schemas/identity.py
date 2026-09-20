"""Request bodies for Clients, Users and Regions."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field

# GSTIN: 2 state digits, a 10-character PAN, an entity digit, a literal 'Z',
# then a checksum character. Shape only — the checksum is not verified, because
# rejecting a real GSTIN over a checksum bug would block onboarding outright.
# The same pattern is a CHECK constraint in migration 0019, so a caller
# bypassing this schema still cannot store a malformed one.
GSTIN_PATTERN = r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$"

# Deliberately a pattern rather than pydantic's EmailStr: EmailStr needs the
# `email-validator` package, which is not among the pinned dependencies
# (BACKEND_SPEC §2), and adding a dependency to validate a contact field that
# nothing sends mail to is not a trade worth making.
EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class FirstUser(BaseModel):
    """The Client's own administrator, created with the Client itself.

    ⚠ Created in the **same transaction** as the Client, not afterwards. A
    Client that exists with nobody able to sign into it is a half-finished
    object that looks finished on every screen, and the operator who created it
    is the only person who knows a second step is outstanding.

    `role_code` defaults to `admin` because that is what a Client's first User
    must be — `app_can_see_plant` grants an admin every Plant of their own
    Client automatically, so Plants added later are visible without anyone
    remembering to grant access. An `employee` created first would see nothing
    and Guardrail 7 forbids reading an empty assignment as "everything".
    """

    email: str = Field(max_length=320, pattern=EMAIL_PATTERN)
    password: str = Field(min_length=8, max_length=200)
    full_name: str | None = None
    role_code: str = Field(default="admin", pattern="^(admin|employee|guest)$")


class ClientCreate(BaseModel):
    """⚠ PROPOSED, not client-confirmed (migration 0019).

    Every commercial field is optional: a Client can be registered from a code
    and a name alone, which is how the test broker's provisional Client exists.
    """

    code: str = Field(max_length=64)
    name: str
    # I-6: a Guest may only ever be granted access to a Client flagged for
    # demonstration. Enforced by the clients_visibility policy, not by the route.
    is_demo: bool = False

    # ── Commercial identity ─────────────────────────────────────────────────
    client_number: str | None = Field(default=None, max_length=64)
    gst_number: str | None = Field(default=None, pattern=GSTIN_PATTERN)
    # The Client organisation's commercial contact. NOT a login — a User signs
    # in through `users.email`, and this address has no account attached.
    contact_email: str | None = Field(default=None, max_length=320,
                                      pattern=EMAIL_PATTERN)

    # The contract is written as a duration, so that is what onboarding asks
    # for; the route adds it to the start date once and stores the resulting
    # date. A stored day count is stale the day after it is written.
    contract_start_date: date | None = None
    contract_valid_days: int | None = Field(default=None, ge=1, le=36525)

    # ── The Client's first User, created in the same transaction ────────────
    # Optional only so a script or an import can omit it. The UI always sends
    # it, because "create the Client now, the login later" is precisely the
    # split this was added to remove.
    first_user: FirstUser | None = None


class ClientUpdate(BaseModel):
    name: str | None = None
    status: str | None = Field(
        default=None, pattern="^(onboarding|active|suspended|decommissioned)$")
    is_demo: bool | None = None

    client_number: str | None = Field(default=None, max_length=64)
    gst_number: str | None = Field(default=None, pattern=GSTIN_PATTERN)
    contact_email: str | None = Field(default=None, max_length=320,
                                      pattern=EMAIL_PATTERN)
    contract_start_date: date | None = None
    # An update takes the end date directly rather than a duration: renewing a
    # contract means "it now runs to this date", and re-deriving that from a day
    # count would need a base date the caller has not supplied.
    contract_valid_till: date | None = None


class UserCreate(BaseModel):
    email: str
    password: str = Field(min_length=12)
    full_name: str
    # super_admin is deliberately absent: a Client Admin must not be able to mint
    # a platform administrator.
    role_code: str = Field(pattern="^(admin|employee|guest)$")


class UserUpdate(BaseModel):
    full_name: str | None = None
    is_active: bool | None = None
    role_code: str | None = Field(default=None, pattern="^(admin|employee|guest)$")
    password: str | None = Field(default=None, min_length=12)


class RegionCreate(BaseModel):
    # ISO 3166-2 style: 'IN-UP', 'IN-HP' (MASTER §3.6).
    code: str = Field(min_length=2, max_length=32, pattern=r"^[A-Z0-9][A-Z0-9_-]*$")
    name: str = Field(min_length=1)
    country: str = Field(default="IN", min_length=2, max_length=2, pattern=r"^[A-Z]{2}$")
    grid_emission_factor_kg_per_kwh: Decimal | None = Field(default=None, ge=0, le=99)


class RegionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    country: str | None = Field(default=None, min_length=2, max_length=2, pattern=r"^[A-Z]{2}$")
    grid_emission_factor_kg_per_kwh: Decimal | None = Field(default=None, ge=0, le=99)
