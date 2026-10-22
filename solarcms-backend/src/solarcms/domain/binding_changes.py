"""What a Tag Mapping save changed, for the audit log. Pure — no I/O.

A save replaces a Device's bindings wholesale, and was audited as
`{"count": 13}`: on 22 Oct 2026 nobody could tell from the log that two weather
stations' GHI had been saved with scale 10 two days before, which is what had
put SPINNING_AND_GENERAL_MILLS's irradiance at 5,030 W/m² and its PR at 4%.
Recorded per payload key — the identity a binding has on a Device — so a log
entry reads "GHI: scale 1 → 10".
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

# What a binding *is*, beyond its key. Its id is not: a save recreates every row.
FIELDS = ("tag_code", "scale", "value_offset", "valid_min", "valid_max", "enabled")


def binding_changes(
    before: Iterable[Mapping[str, Any]], after: Iterable[Mapping[str, Any]],
) -> dict[str, Any]:
    """Bindings added, removed and changed between two sets, keyed by source key.

    A changed binding lists only the fields that differ, each as `[old, new]`,
    under `fields` — apart from the Tag it now reads, which may itself be one
    of them. Numbers are compared as numbers, so a scale saved as `1` over
    `1.0` is not a change.
    """
    old = {str(row["source_key"]): row for row in before}
    new = {str(row["source_key"]): row for row in after}
    changed = []
    for key in sorted(old.keys() & new.keys()):
        fields = {
            name: [old[key].get(name), new[key].get(name)]
            for name in FIELDS if not _same(old[key].get(name), new[key].get(name))
        }
        if fields:
            changed.append({"source_key": key, "tag_code": new[key].get("tag_code"),
                            "fields": fields})
    return {
        "added": [_brief(new[key]) for key in sorted(new.keys() - old.keys())],
        "removed": [_brief(old[key]) for key in sorted(old.keys() - new.keys())],
        "changed": changed,
    }


def _same(a: object, b: object) -> bool:
    numbers = (int, float)
    if (isinstance(a, numbers) and isinstance(b, numbers)
            and not isinstance(a, bool) and not isinstance(b, bool)):
        return float(a) == float(b)
    return a == b


def _brief(row: Mapping[str, Any]) -> dict[str, Any]:
    return {"source_key": row["source_key"], **{name: row.get(name) for name in FIELDS}}
