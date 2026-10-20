"""Let the API add a Tag to the catalogue.

`POST /catalog/tags` — the "A new kind of reading" form on Data Issues, offered
beside a key nobody has mapped — has never worked: the API role holds SELECT on
`tags` (0008's catalogue grant) and UPDATE (0020, for editing a Tag's formula
and range), but never INSERT, so every Tag a Super Admin tried to add ended in
"permission denied for table tags" and a 500 (found 20 Oct 2026, when a
Transformer sent more winding temperatures than the catalogue names).

The route is `system.admin` only, and `tags` has no `client_id` and no RLS — it
is the platform's, shared by every Client — so the permission is the route's to
enforce, as it already is for UPDATE. The id is an identity column, so no
sequence grant is needed.

Revision ID: 0045
Revises: 0044
"""

from __future__ import annotations

from alembic import op

revision = "0045"
down_revision = "0044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("GRANT INSERT ON tags TO solarcms_api")


def downgrade() -> None:
    op.execute("REVOKE INSERT ON tags FROM solarcms_api")
