"""Whether a meter measures the Plant's solar generation.

Every Plant figure that comes from a meter — PR, Current Power, today's and the
month's energy, the Grid stage, the Daily and Monthly Plant reports, the Plant
KPI panel — took *every* Device of the meter's Type: summed for energy, the
first by code for a single reading. A Plant with a second meter of the same
Type on another line had that line added to its generation. VARDHMAN_GROUP's
SPINNING_AND_GENERAL_MILLS has `MFM` on the solar output and `MAIN_MFM` on the
mill's own (the user, 19 Oct 2026, answering B-16): ~200 kW and ~660 kW at
noon, both Type MFM, and `MAIN_MFM` sorts first.

`devices.measures_generation` says which. TRUE for every existing Device — the
behaviour until now — and set FALSE on a meter that is on some other line, by
the route that already owns the row (`PATCH /devices/{id}`), so it is
permission-checked and audited as there. The API refuses FALSE on anything but
a meter. A FALSE meter keeps its own screens, readings and Alarms; only the
Plant's figures pass it over. No new grants: the API's table-level grants
cover it, and the scheduler already reads `devices`.

Status: CONFIRMED for that Plant (the user, 19 Oct 2026) / BUILT.

Revision ID: 0043
Revises: 0042
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0043"
down_revision = "0042"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("devices", sa.Column(
        "measures_generation", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.execute(
        "COMMENT ON COLUMN devices.measures_generation IS "
        "'FALSE on a meter that is on a line other than the Plant''s solar output "
        "(the site''s own supply, say): its readings are kept and shown, but no "
        "Plant figure — PR, energy, Current Power, the Grid stage, the reports — "
        "adds or picks it. TRUE otherwise.'"
    )


def downgrade() -> None:
    op.drop_column("devices", "measures_generation")
