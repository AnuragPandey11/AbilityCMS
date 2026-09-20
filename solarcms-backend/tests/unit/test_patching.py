"""PATCH must be able to clear a field, not only change it.

Every update route used `coalesce(:value, column)`, which keeps the old value
when the parameter is NULL. That is right for a field the request did not
mention and wrong for one it deliberately emptied — and both arrive as `None`,
so the two were indistinguishable. The symptom is the quiet kind: the field
empties on screen, the request returns 200, and the old value is still there on
the next read.

No database needed — this is the mapping from a Pydantic body to SQL fragments,
which is where the bug was.
"""

from __future__ import annotations

from datetime import date

from pydantic import BaseModel

from solarcms.api.patching import patch_assignments


class Body(BaseModel):
    name: str | None = None
    gst_number: str | None = None
    contract_valid_till: date | None = None
    region_code: str | None = None


COLUMNS = {
    "name": "name",
    "gst_number": "gst_number",
    "contract_valid_till": "contract_valid_till",
}


def test_an_omitted_field_is_not_written_at_all() -> None:
    sets, params = patch_assignments(Body.model_validate({"name": "Kular"}), COLUMNS)
    assert sets == ["name = :set_name"]
    assert params == {"set_name": "Kular"}


def test_an_explicit_null_clears_rather_than_being_ignored() -> None:
    """The whole reason this module exists."""
    sets, params = patch_assignments(
        Body.model_validate({"gst_number": None}), COLUMNS)
    assert sets == ["gst_number = :set_gst_number"]
    assert params == {"set_gst_number": None}


def test_a_null_and_an_omission_are_different_requests() -> None:
    cleared, _ = patch_assignments(Body.model_validate({"gst_number": None}), COLUMNS)
    omitted, _ = patch_assignments(Body.model_validate({}), COLUMNS)
    assert cleared != omitted
    assert omitted == []


def test_a_body_that_says_nothing_produces_no_assignments() -> None:
    """The route reads the row back rather than running an empty UPDATE."""
    sets, params = patch_assignments(Body.model_validate({}), COLUMNS)
    assert sets == []
    assert params == {}


def test_a_cast_wraps_the_parameter_where_asyncpg_cannot_infer_it() -> None:
    sets, params = patch_assignments(
        Body.model_validate({"contract_valid_till": "2027-01-01"}),
        COLUMNS,
        casts={"contract_valid_till": "date"},
    )
    assert sets == ["contract_valid_till = CAST(:set_contract_valid_till AS date)"]
    assert params == {"set_contract_valid_till": date(2027, 1, 1)}


def test_a_resolved_value_is_substituted_but_presence_still_decides() -> None:
    """`region_code` in, `region_id` out — and only when it was actually sent."""
    columns = {**COLUMNS, "region_code": "region_id"}

    sets, params = patch_assignments(
        Body.model_validate({"region_code": "IN-UP"}), columns,
        values={"region_code": 4})
    assert sets == ["region_id = :set_region_code"]
    assert params == {"set_region_code": 4}

    # Not mentioned: the Plant keeps whatever Region it had, and the resolved
    # value is never consulted.
    sets, params = patch_assignments(
        Body.model_validate({}), columns, values={"region_code": 4})
    assert sets == []


def test_clearing_a_region_sends_null_rather_than_leaving_it_alone() -> None:
    columns = {**COLUMNS, "region_code": "region_id"}
    sets, params = patch_assignments(
        Body.model_validate({"region_code": None}), columns,
        values={"region_code": None})
    assert sets == ["region_id = :set_region_code"]
    assert params == {"set_region_code": None}


def test_a_field_outside_the_mapping_is_left_to_the_route() -> None:
    """`device_counts` is a table of its own, not a column of `plants`."""
    sets, _ = patch_assignments(
        Body.model_validate({"name": "Kular", "region_code": "IN-UP"}), COLUMNS)
    assert sets == ["name = :set_name"]


def test_column_names_come_from_the_mapping_and_never_from_the_body() -> None:
    """Values are bound; identifiers are the caller's own literals."""
    sets, params = patch_assignments(
        Body.model_validate({"name": "'; DROP TABLE clients; --"}), COLUMNS)
    assert sets == ["name = :set_name"]
    assert params["set_name"] == "'; DROP TABLE clients; --"
