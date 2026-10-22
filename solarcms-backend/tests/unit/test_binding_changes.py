"""A Tag Mapping save is audited by what it changed, not by how many rows it left."""

from __future__ import annotations

from solarcms.domain.binding_changes import binding_changes


def row(source_key: str, tag_code: str, **kw: object) -> dict[str, object]:
    base: dict[str, object] = {"source_key": source_key, "tag_code": tag_code, "scale": 1.0,
                               "value_offset": 0.0, "valid_min": 0.0, "valid_max": 1500.0,
                               "enabled": True}
    return base | kw


def test_a_changed_scale_is_recorded_with_its_old_and_new_value() -> None:
    # SPINNING_AND_GENERAL_MILLS's weather stations, saved on 20 Oct 2026.
    before = [row("GHI", "GHI"), row("GTI", "GTI")]
    after = [row("GHI", "GHI", scale=10), row("GTI", "GTI")]
    assert binding_changes(before, after) == {
        "added": [], "removed": [],
        "changed": [{"source_key": "GHI", "tag_code": "GHI", "fields": {"scale": [1.0, 10]}}],
    }


def test_the_same_number_written_differently_is_not_a_change() -> None:
    assert binding_changes([row("GHI", "GHI", scale=1.0)], [row("GHI", "GHI", scale=1)]) == {
        "added": [], "removed": [], "changed": [],
    }


def test_added_and_removed_keys_are_listed_whole() -> None:
    changes = binding_changes([row("LV4_WT", "LV4_WTI")], [row("LV4_WTI", "LV4_WTI")])
    assert [r["source_key"] for r in changes["added"]] == ["LV4_WTI"]
    assert [r["source_key"] for r in changes["removed"]] == ["LV4_WT"]
    assert changes["changed"] == []


def test_a_key_remapped_to_another_tag_says_which_way() -> None:
    changes = binding_changes([row("EXP", "ENERGY_EXPORT_TOTAL")],
                              [row("EXP", "ENERGY_IMPORT_TOTAL")])
    assert changes["changed"] == [{
        "source_key": "EXP", "tag_code": "ENERGY_IMPORT_TOTAL",
        "fields": {"tag_code": ["ENERGY_EXPORT_TOTAL", "ENERGY_IMPORT_TOTAL"]},
    }]
