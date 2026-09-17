"""Derived Tags: values the platform computes rather than receives. Pure — no I/O.

The client's signal schedule marks a number of rows **"Need to Calculate"** and
supplies the arithmetic for them (`docs/TAG_CATALOGUE.md` §2.15):

    AVG VOLTAGE     (VOLTAGE RY + VOLTAGE YB + VOLTAGE BR)/3
    TOTAL CURRENT   (R PHASE CURRENT + Y PHASE CURRENT + B PHASE CURRENT)
    DC POWER        ACTIVE_POWER / (EFFICIENCY/100)
    SPECIFIC YIELD  DAILY_ENERGY / INV_CAPACITY
    PR              (TODAY_ENERGY/(CUMMULATIVE GHI * DC CAPACITY)) * 100.0

The formula is **data, not code**: it lives in `tags.formula` as a string, so a
new calculated metric is an INSERT, exactly as I-2 requires of measured ones. A
formula can therefore never name a Client, Plant or Device (Guardrail 2) — it
names Tag codes, which are the same for every Plant that ever reports them.

Two scopes, because the two have different inputs:

* **device** — every name resolves against one Device's own Tags. Evaluated in
  the ingest path, where that Device's values are already in hand.
* **plant** — names are dotted aggregates across a Plant, `SUM.ENERGY_TODAY` or
  `AVG.GHI_CUMULATIVE`. Evaluated by the scheduler, which is the only process
  that sees a whole Plant at once.

The evaluator is deliberately small. It parses with `ast` and walks a whitelist,
so a formula typed by an administrator cannot call a function, read a name out of
this module, or import anything. Anything it cannot evaluate returns None —
"undefined", never 0.0, because a PR of zero and an unknown PR mean opposite
things to an operator (the same reason `FormulaResult` exists in `formulas.py`).
"""

from __future__ import annotations

import ast
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

# Aggregate prefixes a plant-scope formula may use: `SUM.ENERGY_TODAY`. Kept
# explicit so a typo is a load-time error rather than a silently missing input.
PLANT_AGGREGATES: Final[frozenset[str]] = frozenset({"SUM", "AVG", "MIN", "MAX", "COUNT"})

DERIVED_SCOPES: Final[tuple[str, ...]] = ("device", "plant")

# The maximum number of evaluation passes over a set of formulas. A formula may
# depend on another formula's output (TOTAL_CURRENT feeds nothing today, but
# SPECIFIC_YIELD could be fed by a derived ENERGY_TODAY tomorrow), so evaluation
# repeats until it stops producing new values. The cap turns a dependency cycle
# into "these stayed undefined" instead of a hang.
MAX_PASSES: Final = 8

_ALLOWED_BINOPS: Final = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.Mod)
_ALLOWED_UNARYOPS: Final = (ast.UAdd, ast.USub)


class InvalidFormula(ValueError):
    """A formula is malformed or uses something outside the whitelist.

    Raised when the formula is *parsed* — at seed time, at catalogue edit time,
    or in the unit tests — never per Reading. A bad formula must be rejected
    where a human is watching, not swallowed a million times a day in ingest.
    """


@dataclass(frozen=True, slots=True)
class DerivedTag:
    """One computed Tag: which Tag it produces and the arithmetic that makes it."""

    tag_code: str
    expression: str
    scope: str = "device"

    def __post_init__(self) -> None:
        if self.scope not in DERIVED_SCOPES:
            raise InvalidFormula(
                f"{self.tag_code}: scope {self.scope!r} is not one of {DERIVED_SCOPES}"
            )
        # Parse on construction so an unusable formula cannot reach the database.
        compile_formula(self.expression, scope=self.scope)

    @property
    def inputs(self) -> frozenset[str]:
        return referenced_names(self.expression, scope=self.scope)


def _walk(node: ast.AST, *, scope: str, names: set[str]) -> None:
    """Validate one node against the whitelist, collecting the names it reads."""
    if isinstance(node, ast.Expression):
        _walk(node.body, scope=scope, names=names)
    elif isinstance(node, ast.BinOp):
        if not isinstance(node.op, _ALLOWED_BINOPS):
            raise InvalidFormula(f"operator {type(node.op).__name__} is not permitted")
        _walk(node.left, scope=scope, names=names)
        _walk(node.right, scope=scope, names=names)
    elif isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, _ALLOWED_UNARYOPS):
            raise InvalidFormula(f"operator {type(node.op).__name__} is not permitted")
        _walk(node.operand, scope=scope, names=names)
    elif isinstance(node, ast.Constant):
        if not isinstance(node.value, int | float) or isinstance(node.value, bool):
            raise InvalidFormula(f"constant {node.value!r} is not a number")
    elif isinstance(node, ast.Name):
        names.add(node.id)
    elif isinstance(node, ast.Attribute):
        # `SUM.ENERGY_TODAY` — one dotted level only, and only in a plant formula.
        if not isinstance(node.value, ast.Name):
            raise InvalidFormula("only one level of dotted name is supported")
        prefix = node.value.id
        if scope != "plant":
            raise InvalidFormula(
                f"dotted name {prefix}.{node.attr} is only valid in a plant-scope formula"
            )
        if prefix not in PLANT_AGGREGATES:
            raise InvalidFormula(
                f"unknown aggregate {prefix!r}; expected one of {sorted(PLANT_AGGREGATES)}"
            )
        names.add(f"{prefix}.{node.attr}")
    else:
        # Call, Subscript, Compare, comprehensions, lambdas, f-strings — all out.
        # A formula is arithmetic over named values and nothing else.
        raise InvalidFormula(f"{type(node).__name__} is not permitted in a formula")


def compile_formula(expression: str, *, scope: str = "device") -> ast.Expression:
    """Parse and validate a formula. Raises InvalidFormula; never returns None."""
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise InvalidFormula(f"{expression!r} is not a valid expression: {exc}") from exc
    _walk(tree, scope=scope, names=set())
    return tree


def referenced_names(expression: str, *, scope: str = "device") -> frozenset[str]:
    """Every name a formula reads — its inputs, for dependency ordering."""
    names: set[str] = set()
    _walk(compile_formula(expression, scope=scope), scope=scope, names=names)
    return frozenset(names)


def _eval(node: ast.AST, values: Mapping[str, float]) -> float | None:
    if isinstance(node, ast.Expression):
        return _eval(node.body, values)
    if isinstance(node, ast.Constant):
        # `_walk` has already rejected every non-numeric constant, so this is a
        # narrowing for the type checker rather than a second validation.
        return float(node.value) if isinstance(node.value, int | float) else None
    if isinstance(node, ast.Name):
        return values.get(node.id)
    if isinstance(node, ast.Attribute):
        assert isinstance(node.value, ast.Name)
        return values.get(f"{node.value.id}.{node.attr}")
    if isinstance(node, ast.UnaryOp):
        operand = _eval(node.operand, values)
        if operand is None:
            return None
        return -operand if isinstance(node.op, ast.USub) else operand
    if isinstance(node, ast.BinOp):
        left = _eval(node.left, values)
        right = _eval(node.right, values)
        # A missing input is not an error and not a zero: the result is simply
        # not computable this cycle. An Inverter that has not yet published
        # EFFICIENCY has no DC POWER, and inventing one would be worse than a gap.
        if left is None or right is None:
            return None
        return _apply(node.op, left, right)
    raise InvalidFormula(f"{type(node).__name__} is not permitted in a formula")


def _apply(op: ast.operator, left: float, right: float) -> float | None:
    if isinstance(op, ast.Add):
        return left + right
    if isinstance(op, ast.Sub):
        return left - right
    if isinstance(op, ast.Mult):
        return left * right
    if isinstance(op, ast.Div):
        # Division by zero is the normal night-time case for PR (no irradiation)
        # and for DC POWER (an idle Inverter reports 0% efficiency). Undefined,
        # not an exception and not infinity.
        return None if right == 0 else left / right
    if isinstance(op, ast.Mod):
        return None if right == 0 else left % right
    if isinstance(op, ast.Pow):
        try:
            result = float(left**right)
        except (OverflowError, ZeroDivisionError, ValueError):
            return None
        return None if result != result else result  # NaN is not a value
    raise InvalidFormula(f"operator {type(op).__name__} is not permitted")


def evaluate(
    expression: str, values: Mapping[str, float], *, scope: str = "device"
) -> float | None:
    """Evaluate one formula. Returns None when any input is missing or undefined."""
    result = _eval(compile_formula(expression, scope=scope), values)
    if result is None:
        return None
    if result != result or result in (float("inf"), float("-inf")):
        return None
    return result


def evaluate_all(
    derived: list[DerivedTag], values: Mapping[str, float]
) -> dict[str, float]:
    """Evaluate a set of formulas, resolving dependencies between them.

    Repeats until a pass produces nothing new, so the declaration order of
    formulas never matters and a Tag derived from another derived Tag works
    without the caller sorting anything. A cycle simply leaves both undefined.

    A name already present in `values` is **not** overwritten: a published value
    always beats a computed one. That is the rule that makes this safe to switch
    on for every Device — a meter that genuinely transmits AVG VOLTAGE keeps its
    own figure, and only one that does not gets ours.
    """
    computed: dict[str, float] = {}
    known: dict[str, float] = dict(values)
    pending = [d for d in derived if d.tag_code not in known]

    for _ in range(MAX_PASSES):
        progressed = False
        still_pending: list[DerivedTag] = []
        for spec in pending:
            result = evaluate(spec.expression, known, scope=spec.scope)
            if result is None:
                still_pending.append(spec)
                continue
            computed[spec.tag_code] = result
            known[spec.tag_code] = result
            progressed = True
        pending = still_pending
        if not pending or not progressed:
            break
    return computed
