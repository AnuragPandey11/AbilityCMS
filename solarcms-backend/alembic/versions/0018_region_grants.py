"""Let the API create and edit Regions.

0008 grouped `regions` with the platform catalogue and granted `solarcms_api`
SELECT only — correct for `device_types` and `tags`, which change monthly and
are seeded, but a Region is created by a Super Admin during Plant onboarding
(MASTER §6.5: "Assign Region, create Plant"). With no INSERT the only Region a
Plant could ever reference was the one the onboarding script inserted as the
migration owner, and every real code (`IN-UP`, `IN-HP`) 422'd as unknown.

No RLS: Regions carry no client_id and are deliberately visible to every
Client (0008). Write access is gated by `system.admin` in the route, which is
the same posture `clients` takes. DELETE is withheld: `plants.region_id`
references the row, and retiring a Region is a data-migration decision.

Revision ID: 0018
Revises: 0017
"""

from __future__ import annotations

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

API = "solarcms_api"


def upgrade() -> None:
    op.execute(f"GRANT INSERT, UPDATE ON regions TO {API}")


def downgrade() -> None:
    op.execute(f"REVOKE INSERT, UPDATE ON regions FROM {API}")
