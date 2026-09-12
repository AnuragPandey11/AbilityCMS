"""Request bodies for Alarm Rules."""

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
