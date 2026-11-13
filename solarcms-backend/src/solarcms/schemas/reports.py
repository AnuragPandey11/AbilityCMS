"""Request bodies for custom reports and status-code meanings."""

from __future__ import annotations

from datetime import date, time
from typing import Literal

from pydantic import BaseModel, Field, model_validator

Aggregation = Literal["auto", "avg", "min", "max", "last", "change"]


class SeriesRef(BaseModel):
    """One column of a custom report: a Device and one Tag it sends."""

    device_id: int = Field(ge=1)
    tag_code: str = Field(min_length=1, max_length=64)


class CustomReportDefinition(BaseModel):
    """What a custom report reads: which series, over which period, at which interval.

    `series` names Device and Tag pairs explicitly, so a saved report reopens as it
    was built even after a Device gains a Tag. `period` takes the same names as
    the standard reports (today, yesterday, last_7_days, last_30_days, any
    last_N_days, custom).
    """

    name: str | None = Field(default=None, max_length=120)
    # The Plants the builder had chosen, so a saved report reopens on them. It
    # decides nothing: the series name their Devices, and visibility is checked
    # on those.
    plant_ids: list[int] = Field(default_factory=list, max_length=50)
    series: list[SeriesRef] = Field(min_length=1, max_length=60)
    interval_minutes: int = Field(ge=1, le=7 * 24 * 60)
    aggregation: Aggregation = "auto"
    period: str = Field(default="today", max_length=32)
    from_date: date | None = None
    to_date: date | None = None
    from_time: time | None = None
    to_time: time | None = None

    @model_validator(mode="after")
    def _distinct(self) -> CustomReportDefinition:
        seen = {(s.device_id, s.tag_code) for s in self.series}
        if len(seen) != len(self.series):
            raise ValueError("each Device and reading may appear once")
        return self


class CustomReportSave(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    definition: CustomReportDefinition


#: How many saved reports one User may keep as quick reports (migration 0049).
#: The user's choice of 13 Nov 2026; mirrored by the Reports screen
#: (`dashboards/reports/quickReportRules.ts`), and the server enforces it regardless.
CUSTOM_REPORT_PIN_LIMIT = 5


class CustomReportPins(BaseModel):
    """A User's quick reports, in the order they are shown — the whole list.

    The cap is checked by the route, so a request over it gets a sentence
    rather than a validation error; the bound here only stops a silly body.
    """

    report_ids: list[int] = Field(max_length=50)

    @model_validator(mode="after")
    def _distinct(self) -> CustomReportPins:
        if len(set(self.report_ids)) != len(self.report_ids):
            raise ValueError("each report may be pinned once")
        return self


class StatusCodeIn(BaseModel):
    """What one status code means at one Plant."""

    device_type_code: str = Field(min_length=1, max_length=64)
    tag_code: str = Field(min_length=1, max_length=64)
    code: int
    label: str = Field(min_length=1, max_length=80)
    kind: Literal["normal", "standby", "warning", "fault"] = "normal"
    note: str | None = Field(default=None, max_length=500)
