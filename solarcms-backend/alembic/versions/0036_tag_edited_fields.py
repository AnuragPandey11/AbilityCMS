"""Remember which of a Tag's fields a person edited, so `cli seed` leaves them alone.

`cli seed` rewrites every Tag from `domain/assumptions.py` — unit, range, scale,
formula — and the documented upgrade steps run it. So a correction made through
`PATCH /catalog/tags/{id}` (how OPEN-15 is meant to close without a release)
was silently undone by the next upgrade.

`edited_fields` lists the fields a person changed. The seed keeps those and
still updates every other field, so a fix made in the code — the 0..65535
status range of 0034, say — still reaches a Tag nobody has touched. Asking for
a field's default again (`reset_fields`) takes it off the list.

Decided by the user on 8 Oct 2026: "edited fields win".

⚠ `tags` is in 0008's CATALOG group (no RLS), so no `set_config` is needed.

Status: AGREED / BUILT.

Revision ID: 0036
Revises: 0035
"""

from __future__ import annotations

from alembic import op

revision = "0036"
down_revision = "0035"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE tags ADD COLUMN edited_fields TEXT[] NOT NULL DEFAULT '{}'")
    op.execute("COMMENT ON COLUMN tags.edited_fields IS "
               "'Fields a person edited; cli seed keeps these and rewrites the rest.'")


def downgrade() -> None:
    op.execute("ALTER TABLE tags DROP COLUMN edited_fields")
