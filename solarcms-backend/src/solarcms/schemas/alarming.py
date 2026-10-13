"""Request bodies for Alarm Rules and Alarm email subscriptions."""

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator


class AlarmRuleWrite(BaseModel):
    code: str = Field(max_length=64)
    name: str
    scope_type: str = Field(default="global",
                            pattern="^(global|client|plant|device_type|device)$")
    scope_id: int | None = None
    tag_code: str | None = None
    operator: str = Field(pattern="^(gt|lt|outside|inside|eq|is_true|is_false|special)$")
    threshold: float | None = None
    threshold_high: float | None = None
    clear_threshold: float | None = None
    duration_s: int = Field(default=0, ge=0)
    severity: str = Field(default="medium", pattern="^(critical|high|medium|low)$")
    classification: str | None = None
    enabled: bool = True
    # The owner, honoured on create for a platform administrator only: a Client
    # id files the rule under that Client, an explicit null makes it a platform
    # default every Client inherits. Omitted, it falls back to the session's
    # Client. Ignored for everyone else, whose Client comes from the session.
    client_id: int | None = None

    @model_validator(mode="after")
    def _check_operator_arity(self) -> AlarmRuleWrite:
        """Reject rules the database would reject, with a readable reason.

        The same invariants exist as CHECK constraints (migration 0009); catching
        them here turns a 500 with a constraint name into a 422 that says which
        field is wrong.
        """
        if self.operator in ("is_true", "is_false"):
            if any(v is not None for v in
                   (self.threshold, self.threshold_high, self.clear_threshold)):
                raise ValueError(
                    "a Digital Input rule carries no threshold: there is nothing to "
                    "compare against. Drop threshold/threshold_high/clear_threshold."
                )
        elif self.operator in ("gt", "lt", "eq") and self.threshold is None:
            raise ValueError(f"operator {self.operator!r} requires a threshold")
        elif self.operator in ("outside", "inside") and (
            self.threshold is None or self.threshold_high is None
        ):
            raise ValueError(
                f"operator {self.operator!r} requires both threshold and threshold_high"
            )
        if self.scope_type != "global" and self.scope_id is None:
            raise ValueError(f"scope_type {self.scope_type!r} requires a scope_id")
        return self


class NotificationSubscriptionCreate(BaseModel):
    """Email one User about one Client's Alarms, for a Plant or every Plant."""

    user_id: int
    #: None: every Plant of the Client — a Client Admin only, since nobody else
    #: can see every Plant (`domain/notification_scope`).
    plant_id: int | None = None
    min_severity: str = Field(default="medium", pattern="^(critical|high|medium|low)$")
    channel: str = Field(default="email", pattern="^email$")
    #: Required of a platform administrator, who belongs to no Client; ignored
    #: for a Client Admin, whose Client comes from the session.
    client_id: int | None = None


class NotificationSubscriptionUpdate(BaseModel):
    min_severity: str | None = Field(default=None, pattern="^(critical|high|medium|low)$")
    enabled: bool | None = None
