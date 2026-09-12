"""Request and response bodies for Plants, Blocks and Devices.

Creates take a JSON body rather than query parameters: a Device carries a dozen
fields, several optional, and query strings make required-vs-optional invisible
to a caller reading the OpenAPI schema.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field

# Planned Device counts, keyed on Device Type code ('INVERTER', 'MFM', ...).
#
# ⚠ A mapping rather than named fields, for the reason migration 0019 gives: a
# field per Device Type would mean a schema change every time the catalogue
# grows, and the onboarding form could only ever offer the Types someone
# remembered to add here. Unknown codes are rejected by the route against
# `device_types`, so this stays validated without being hardcoded.
DeviceCounts = dict[str, int]


class PlantCreate(BaseModel):
    code: str = Field(max_length=64)
    name: str
    region_code: str | None = None
    ac_capacity_kw: float | None = Field(default=None, ge=0)
    dc_capacity_kwp: float | None = Field(default=None, ge=0)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    timezone: str = "Asia/Kolkata"
    commissioned_on: date | None = None

    # The *planned* count from the contract or design sheet — how many Devices
    # this Plant is meant to have, recorded before any are registered. Never the
    # live count, which is count(*) on `devices`; the gap between them is what
    # remains to be commissioned.
    device_counts: DeviceCounts | None = None


class PlantUpdate(BaseModel):
    name: str | None = None
    # Status is deliberately settable: the onboarding flow moves a Plant through
    # draft → commissioning → active, and only `active` counts toward Portfolio
    # aggregates (MASTER §6.5).
    status: str | None = Field(
        default=None, pattern="^(draft|commissioning|active|decommissioned)$")
    region_code: str | None = None
    ac_capacity_kw: float | None = Field(default=None, ge=0)
    dc_capacity_kwp: float | None = Field(default=None, ge=0)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    commissioned_on: date | None = None
    # Replaces the whole set when present, rather than merging: a Type dropped
    # from the design sheet must disappear, and a merge would leave it behind
    # with no way to remove it.
    device_counts: DeviceCounts | None = None


class BlockCreate(BaseModel):
    code: str = Field(max_length=64)
    name: str
    # NOT NULL in the schema and required here: without it, per-Block PR, CUF and
    # specific yield are not computable, which is the entire reason a Block
    # carries capacity (MASTER §2.2).
    capacity_kwp: float = Field(gt=0)


class BlockUpdate(BaseModel):
    name: str | None = None
    capacity_kwp: float | None = Field(default=None, gt=0)


class DeviceCreate(BaseModel):
    code: str = Field(max_length=64)
    name: str
    device_model_id: int
    serial_number: str | None = None
    # The three groupings (MASTER §3.4). Independent by design: where it is, what
    # it is wired into, what transmits it.
    block_id: int | None = None
    parent_device_id: int | None = None
    reports_via_device_id: int | None = None
    source_address: str | None = Field(
        default=None,
        description="The MQTT topic this Device publishes on. Must be unique.",
    )
    # ⚠ Set from observation at commissioning, never left at the default: health
    # detection multiplies this column, and the client's broker publishes ~21x
    # faster than the assumed 60s.
    expected_interval_s: int = Field(default=60, ge=1)
    rated_capacity_kw: float | None = Field(default=None, ge=0)
    installed_on: date | None = None

    # Note: "parent must share the Plant" (I-3) is enforced by a composite foreign
    # key in the schema, not here. A structural constraint cannot be bypassed by a
    # code path that forgets to call the validator.


class DeviceBulkImport(BaseModel):
    """CSV-equivalent bulk create. Applied atomically.

    All-or-nothing deliberately: a half-imported Plant leaves an SLD with missing
    parents, and the failure mode of "some Devices exist" is harder to diagnose
    than "none do".
    """

    devices: list[DeviceCreate] = Field(min_length=1, max_length=500)


class BindingUpsert(BaseModel):
    source_key: str
    tag_code: str
    # ⚠ scale and offset are the per-Device truth (MASTER §3.5). The Tag's
    # default is only a seed; field wiring never matches the datasheet.
    scale: float = 1.0
    value_offset: float = 0.0
    valid_min: float | None = None
    valid_max: float | None = None
    enabled: bool = True


class BindingsReplace(BaseModel):
    bindings: list[BindingUpsert]
