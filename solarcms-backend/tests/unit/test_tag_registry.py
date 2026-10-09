"""The Tag defaults `cli seed` writes, and that `reset_fields` returns to."""

from __future__ import annotations

from solarcms.domain.assumptions import TAG_SPECS
from solarcms.services.tag_registry import BINDING_COPIES, TRACKED_FIELDS, default_tag_rows


def test_every_catalogued_tag_has_a_default_for_every_tracked_field() -> None:
    rows = default_tag_rows()
    assert set(rows) == set(TAG_SPECS)
    for row in rows.values():
        assert set(TRACKED_FIELDS) <= set(row)


def test_a_status_tag_is_never_throttled() -> None:
    # Guardrail 11: a trip contact that opened and re-closed inside a throttle
    # window would be discarded.
    for row in default_tag_rows().values():
        if row["category"] == "status":
            assert row["min_interval_s"] == 0


def test_device_status_accepts_a_whole_register() -> None:
    assert default_tag_rows()["DEVICE_STATUS"]["valid_max"] == 65535.0


def test_only_range_and_scale_have_per_device_copies() -> None:
    assert set(BINDING_COPIES) == {"valid_min", "valid_max", "scale_default"}
    assert set(BINDING_COPIES) <= set(TRACKED_FIELDS)
