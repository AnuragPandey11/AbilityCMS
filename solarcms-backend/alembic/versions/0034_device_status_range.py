"""Widen DEVICE_STATUS's valid range to a 16-bit register: 0..65535.

`DEVICE_STATUS` is a code, not a measurement, and its range was an assumed
0..1000. The client's Inverters send 512, 1024 and 40960 (0xA000), so most of
their status readings were stored flagged out of range, and Data Issues listed
"DEVICE_STATUS: n of n recent values rejected" on every Inverter. A code is a
label; the only bound it honestly has is what the register can hold.

`domain/assumptions.py` now says 0..65535, and `cli seed` would correct the
Tag. But every binding keeps its own copy of the range, copied from the Tag
when the Device was registered, and ingest checks the binding's — so the
Devices already registered would go on rejecting until each was edited by
hand. This raises those copies too.

Only ever *raised*: a binding whose maximum is already 65535 or more is left
alone, and `valid_min` is not touched. A limit somebody raised by hand (to
1024, say) is raised again, since it is still below what the register holds.

⚠ `device_tag_bindings` is under FORCE ROW LEVEL SECURITY, which subjects the
owner too, so without `app.is_platform_admin` this UPDATE matches nothing.

⚠ Readings already stored flagged stay flagged; this changes what ingest
accepts from now on (within ingest's 5-minute binding cache).

⚠ The downgrade is a no-op: narrowing the range again would only start
rejecting real codes, and a widened range loses nothing.

Status: PROPOSED (a range for a code is ours, not the client's) / BUILT.

Revision ID: 0034
Revises: 0033
"""

from __future__ import annotations

from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None

STATUS_MAX = 65535.0


def upgrade() -> None:
    op.execute("SELECT set_config('app.is_platform_admin', 'true', true)")
    op.execute(f"""
        UPDATE tags
           SET valid_max = {STATUS_MAX}
         WHERE code = 'DEVICE_STATUS'
           AND valid_max IS NOT NULL
           AND valid_max < {STATUS_MAX}
    """)
    op.execute(f"""
        UPDATE device_tag_bindings b
           SET valid_max = {STATUS_MAX}
          FROM tags t
         WHERE t.id = b.tag_id
           AND t.code = 'DEVICE_STATUS'
           AND b.valid_max IS NOT NULL
           AND b.valid_max < {STATUS_MAX}
    """)


def downgrade() -> None:
    # Deliberately nothing — see the module docstring.
    pass
