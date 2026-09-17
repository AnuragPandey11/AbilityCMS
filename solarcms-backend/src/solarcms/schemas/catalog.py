"""Request bodies for the platform catalogue."""

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator

from solarcms.domain.derived import InvalidFormula, compile_formula


def _check_formula(formula: str | None, scope: str | None) -> None:
    """Reject a formula here, where a person is watching.

    A malformed formula is never a runtime error — `domain/derived.py` treats
    anything it cannot evaluate as undefined — so an unparseable one would simply
    produce a Tag that stays empty forever, with no error anywhere. Parsing at
    the boundary is the only place that failure is visible.
    """
    if formula is None:
        return
    if scope is None:
        raise ValueError("a formula needs a derived_scope of 'device' or 'plant'")
    try:
        compile_formula(formula, scope=scope)
    except InvalidFormula as exc:
        raise ValueError(str(exc)) from exc


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
    # A calculated Tag. Arithmetic over other Tag codes — "(A + B + C) / 3" — plus
    # the constants INV_CAPACITY, DC_CAPACITY and AC_CAPACITY. A plant-scope
    # formula may also read aggregates: SUM.ENERGY_TODAY, AVG.GHI_CUMULATIVE.
    formula: str | None = None
    derived_scope: str | None = Field(default=None, pattern="^(device|plant)$")

    @model_validator(mode="after")
    def _coherent(self) -> TagCreate:
        if self.valid_min is not None and self.valid_max is not None:
            if self.valid_min > self.valid_max:
                raise ValueError("valid_min cannot exceed valid_max")
        if self.is_cumulative and self.rollup_method == "avg":
            # Averaging a cumulative counter is meaningless (MASTER §3.5).
            raise ValueError(
                "a cumulative counter cannot use rollup_method 'avg'; use 'last'")
        _check_formula(self.formula, self.derived_scope)
        return self


class TagUpdate(BaseModel):
    """Edit a Tag in the registry — its unit, its bounds, or its formula.

    This is how OPEN-15 finally closes without a release: when the client sends
    the real unit and scale table, a Super Admin edits the rows. The same route
    is how a "Need to Calculate" row gets its arithmetic.
    """

    name: str | None = None
    unit: str | None = Field(default=None, max_length=32)
    category: str | None = Field(
        default=None,
        pattern="^(performance|electrical|diagnostic|environmental|status)$")
    rollup_method: str | None = Field(default=None, pattern="^(avg|last|max)$")
    scale_default: float | None = None
    valid_min: float | None = None
    valid_max: float | None = None
    min_interval_s: int | None = Field(default=None, ge=0)
    is_cumulative: bool | None = None
    formula: str | None = None
    derived_scope: str | None = Field(default=None, pattern="^(device|plant)$")
    # A formula is removed by asking, not by sending null — which is
    # indistinguishable from "unchanged" in a PATCH body.
    clear_formula: bool = False

    @model_validator(mode="after")
    def _coherent(self) -> TagUpdate:
        _check_formula(self.formula, self.derived_scope)
        if self.clear_formula and self.formula is not None:
            raise ValueError("cannot set and clear a formula in the same request")
        return self


class DeviceModelCreate(BaseModel):
    device_type_code: str
    manufacturer: str
    model_code: str
    # The variant is what decides the signal set — a 3-winding Transformer has a
    # winding temperature a 2-winding one does not (MASTER §2.3).
    variant: str | None = Field(default=None, max_length=32)
    rated_capacity_kw: float | None = Field(default=None, ge=0)


class ModelTagEntry(BaseModel):
    tag_code: str
    # The key this Model's Devices usually publish this Tag under. A default for
    # the binding, never its authority.
    default_source_key: str | None = None
    # Position in a repeating group: PV1..PV28. NULL for a signal appearing once.
    repeat_index: int | None = Field(default=None, ge=1)
    sort_order: int | None = None


class ModelTagsReplace(BaseModel):
    tags: list[ModelTagEntry] = Field(max_length=2000)
