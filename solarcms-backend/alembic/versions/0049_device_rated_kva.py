"""A Device's apparent-power rating, in kVA, beside its real-power rating in kW.

`devices.rated_capacity_kw` is real power. A Transformer's nameplate is in kVA
— it must carry the reactive part as well — and its kW depends on the power
factor of the load, so it has no fixed kW rating to record. Typing the kVA
figure into the kW column would make the column's unit depend on the Device
Type, the trap `VRY` already sprang (kV on one meter, V on another), and every
reader that later sums or caps by `rated_capacity_kw` would read it wrong.

* `devices.rated_apparent_power_kva` — the nameplate kVA. Edited by
  `PATCH /devices/{id}` (Tag Mapping → Device settings offers it on a
  Transformer), so permission-checked and audited as there. Nothing computes
  from it yet; it is the nameplate, shown as one.

No new grants: the API's table-level grants on `devices` already cover it, and
the ingest and scheduler roles never read it.

Status: PROPOSED (23 Nov 2026, the user's decision) / BUILT.

Revision ID: 0049
Revises: 0048
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0049"
down_revision = "0048"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "devices", sa.Column("rated_apparent_power_kva", sa.Numeric(12, 2), nullable=True))
    # Bare name: `create_check_constraint` applies the
    # `ck_%(table_name)s_%(constraint_name)s` convention itself (0022).
    op.create_check_constraint(
        "device_rated_kva_not_negative", "devices", "rated_apparent_power_kva >= 0")
    op.execute(
        "COMMENT ON COLUMN devices.rated_apparent_power_kva IS "
        "'Nameplate apparent power in kVA — a Transformer''s rating. Not "
        "rated_capacity_kw, which is real power: the two differ by the power "
        "factor, so neither is ever derived from the other.'"
    )


def downgrade() -> None:
    op.drop_constraint("device_rated_kva_not_negative", "devices", type_="check")
    op.drop_column("devices", "rated_apparent_power_kva")
