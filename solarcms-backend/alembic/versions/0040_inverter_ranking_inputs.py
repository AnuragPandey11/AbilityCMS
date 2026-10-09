"""The two facts the Inverter ranking needs that nothing recorded: each
Inverter's panel size, and what a Plant's energy is worth.

* `devices.dc_capacity_kwp` — the kWp of panels behind one Inverter. An
  Inverter's PR divides by it, and the energy its stops cost scales with it.
  `rated_capacity_kw` is the AC nameplate and is not the same thing: a 300 kW
  Inverter commonly carries 330 to 400 kWp. NULL means unknown, and then PR and
  the cost of its stops are undefined — **never estimated** from the Plant's
  total divided by its Inverters (the user's choice, 9 Oct 2026), because one
  Inverter carrying more strings than another is exactly what such an estimate
  would hide.
* `plants.energy_tariff_inr_per_kwh` — rupees per kWh, per Plant, since each
  Plant sells under its own agreement. Prices lost energy; NULL shows none.

Both editable by the routes that already own the row (`PATCH /devices/{id}`,
`PATCH /plants/{id}`), so they are permission-checked and audited as there. No
new grants: the API's table-level grants on both tables already cover them, and
the ingest and scheduler roles never read either column.

Status: PROPOSED (the client has supplied neither) / BUILT.

Revision ID: 0040
Revises: 0039
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0040"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("devices", sa.Column("dc_capacity_kwp", sa.Numeric(12, 2), nullable=True))
    # Bare names: `create_check_constraint` applies the
    # `ck_%(table_name)s_%(constraint_name)s` convention itself (0022).
    op.create_check_constraint(
        "device_dc_capacity_positive", "devices", "dc_capacity_kwp > 0")
    op.execute(
        "COMMENT ON COLUMN devices.dc_capacity_kwp IS "
        "'kWp of panels behind this Device (an Inverter), from its design. PR and "
        "the energy its stops cost divide or scale by it; NULL is unknown and is "
        "never estimated from the Plant total.'"
    )

    op.add_column(
        "plants", sa.Column("energy_tariff_inr_per_kwh", sa.Numeric(10, 4), nullable=True))
    op.create_check_constraint(
        "plant_tariff_not_negative", "plants", "energy_tariff_inr_per_kwh >= 0")
    op.execute(
        "COMMENT ON COLUMN plants.energy_tariff_inr_per_kwh IS "
        "'Rupees per kWh this Plant''s energy is worth. Prices the energy lost "
        "while an Inverter stood still; NULL shows no loss in rupees.'"
    )


def downgrade() -> None:
    op.drop_constraint("plant_tariff_not_negative", "plants", type_="check")
    op.drop_column("plants", "energy_tariff_inr_per_kwh")
    op.drop_constraint("device_dc_capacity_positive", "devices", type_="check")
    op.drop_column("devices", "dc_capacity_kwp")
