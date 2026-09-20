"""Turning a PATCH body into assignments, without losing the ability to clear.

Every `PATCH` route here was written the same way::

    SET name = coalesce(:name, name), gst_number = coalesce(:gst, gst_number)

which is correct for the common case and wrong for one that matters: it makes
**omitting a field and clearing it indistinguishable**. Both arrive as `None`,
and `coalesce` keeps the old value either way. So a form offering an editable
GST number cannot un-set one — the field empties on screen, the request is
accepted, and the old value is still there on the next read. Nothing errors;
the change is simply not made, which is the worst shape a bug can take on a
screen whose whole job is correcting a record.

Pydantic already knows the difference. `model_fields_set` holds exactly the
fields the request *carried*, so a field that was sent as `null` is present and
a field that was never mentioned is not. Building the assignments from that set
gives PATCH its actual semantics: **what you send is written, what you omit is
left alone, and `null` means null.**

⚠ Column names come from the caller's own literal mapping and are never taken
from the request body. Values always travel as bound parameters.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from pydantic import BaseModel


def patch_assignments(
    body: BaseModel,
    columns: Mapping[str, str],
    *,
    casts: Mapping[str, str] | None = None,
    values: Mapping[str, Any] | None = None,
) -> tuple[list[str], dict[str, Any]]:
    """`SET` fragments and their parameters, for the fields actually supplied.

    `columns` maps a field name to its column; a field absent from the mapping
    is ignored here and handled by the route itself (`device_counts` is a table
    of its own, not a column).

    `casts` wraps a parameter in `CAST(... AS type)`. Needed wherever asyncpg
    cannot infer the type from context — a date compared against nothing, for
    instance — and harmless elsewhere.

    `values` substitutes a *resolved* value for a field: a route that turns
    `region_code` into a `region_id` records the lookup's result here, and the
    field's presence in the request still decides whether it is written at all.
    """
    casts = casts or {}
    values = values or {}

    sets: list[str] = []
    params: dict[str, Any] = {}
    for field, column in columns.items():
        # The whole point: presence in the request, not the value being non-null.
        if field not in body.model_fields_set:
            continue
        value = values[field] if field in values else getattr(body, field)
        placeholder = f"set_{field}"
        cast = casts.get(field)
        sets.append(
            f"{column} = CAST(:{placeholder} AS {cast})"
            if cast
            else f"{column} = :{placeholder}"
        )
        params[placeholder] = value
    return sets, params
