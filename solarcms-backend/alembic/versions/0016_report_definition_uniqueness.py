"""A unique key on report_definitions, so seeding is genuinely idempotent.

The seeder upserts with `ON CONFLICT DO NOTHING`, which needs something to
conflict *with*. `report_definitions` had no unique constraint, so every run
inserted the catalogue again — the failure was silent, produced no error, and
only showed up as duplicate rows in a listing.

`NULLS NOT DISTINCT` matters here: a platform default has `client_id IS NULL`,
and under default NULL semantics two such rows never collide, which is precisely
the case that was duplicating.

Revision ID: 0016
Revises: 0015
"""

from __future__ import annotations

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ⚠ `report_definitions` carries FORCE ROW LEVEL SECURITY (migration 0012),
    # which applies to the table owner too — so a migration running with no
    # session context matches **zero rows** and the DELETE below silently does
    # nothing. It is not an error; the statement simply has no effect, and the
    # CREATE UNIQUE INDEX then fails on duplicates that were never removed.
    #
    # Any migration that touches data in an RLS-protected table has to establish
    # a context first.
    op.execute("SELECT set_config('app.is_platform_admin', 'true', true)")

    # Collapse the duplicates the missing constraint allowed, keeping the oldest
    # of each — a later run may already be referenced by a report_run.
    op.execute("""
        DELETE FROM report_definitions a
         USING report_definitions b
         WHERE a.id > b.id
           AND a.code = b.code
           AND a.client_id IS NOT DISTINCT FROM b.client_id
    """)
    op.execute("""
        CREATE UNIQUE INDEX uq_report_definitions_client_code
            ON report_definitions (client_id, code) NULLS NOT DISTINCT
    """)
    op.execute("COMMENT ON INDEX uq_report_definitions_client_code IS "
               "'NULLS NOT DISTINCT so a platform default (client_id IS NULL) collides "
               "with another of the same code; without it the seeder duplicates the "
               "catalogue on every run.'")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_report_definitions_client_code")
