"""Set a Plant's stored figures aside when the Plant or one of its Devices is edited.

The API serves the scheduler's stored copy of a Plant's dashboard for up to
45 s and its KPIs for up to 150 s (0039). Edit the Plant's capacity, a
Device's size or its bindings, and the screens went on showing figures worked
out from the old settings until the scheduler happened to pass again — while
the page itself had re-read everything straight after the save.

`plant_edited_at` records when an edit last changed what a copy was worked out
from. A copy is fresh only if the scheduler *began* it after that moment, so
the request after an edit computes the figures afresh (as it does for a Plant
with no copy) until the scheduler's next pass stores one that saw the edit. A
column rather than a DELETE because a pass already under way when the edit
lands would otherwise store its result, worked out from the old settings, just
after the delete — and it would be served as current for a full cycle.

The API sets it after the edit's own transaction commits
(`services/snapshots.plant_edited`), so it may update that column and no
other: the policy `plant_snapshots_via_plant` already admits the caller's own
Plants for every command, and a permissive policy is not a GRANT (CLAUDE.md,
three times over). Without it every edit would log "permission denied" and
the screens would wait for the scheduler as before — never worse, but the fix
would be a no-op nobody saw.

Status: PROPOSED (14 Oct 2026, the user's request) / BUILT.

Revision ID: 0042
Revises: 0041
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "0042"
down_revision = "0041"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"


def upgrade() -> None:
    op.add_column(
        "plant_snapshots",
        sa.Column("plant_edited_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(f"GRANT UPDATE (plant_edited_at) ON plant_snapshots TO {API_ROLE}")
    op.execute("COMMENT ON COLUMN plant_snapshots.plant_edited_at IS "
               "'When an edit last changed what this copy was worked out from. "
               "A copy is served only if computed_at is later.'")


def downgrade() -> None:
    op.execute(f"REVOKE UPDATE (plant_edited_at) ON plant_snapshots FROM {API_ROLE}")
    op.drop_column("plant_snapshots", "plant_edited_at")
