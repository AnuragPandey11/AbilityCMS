"""Request bodies for the platform catalogue."""

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator


class TagCreate(BaseModel):
    code: str = Field(max_length=64)
    name: str
    unit: str = Field(max_length=32)
    category: str = Field(
        default="performance",
        pattern="^(performance|electrical|diagnostic|environmental|status)$")
    rollup_method: str = Field(default="avg", pattern="^(avg|last|max)$")
    # ⚠ ASSUMED until the client supplies real figures (OPEN-15 / T-1). The
    # authoritative scale for any specific Device is its binding, not this.
    scale_default: float = 1.0
    valid_min: float | None = None
    valid_max: float | None = None
    min_interval_s: int = Field(default=60, ge=0)
    is_cumulative: bool = False

    @model_validator(mode="after")
    def _coherent(self) -> TagCreate:
        if self.valid_min is not None and self.valid_max is not None:
            if self.valid_min > self.valid_max:
                raise ValueError("valid_min cannot exceed valid_max")
        if self.is_cumulative and self.rollup_method == "avg":
            # Averaging a cumulative counter is meaningless (MASTER §3.5).
            raise ValueError(
                "a cumulative counter cannot use rollup_method 'avg'; use 'last'")
        return self
