"""Split the audit_log policy: readable per Client, writable without one, immutable.

Two defects in the blanket policy from 0008, both found by running the system.

**1. A failed login could not be recorded.** Tender §33 requires login, logout and
*failed login* in the audit trail. A failed login has no Client context by
definition — the caller is not authenticated, and the email may match no User at
all — so `audit_log.client_id` is NULL for those rows. The 0008 policy used one
predicate for USING and WITH CHECK, so inserting a NULL-Client row was refused and
`POST /auth/login` returned 500 on every bad password. The audit requirement and
I-4 were in direct conflict; this resolves it by separating the two questions:

* *Who may read a row?* Its Client, or a platform admin. Rows with no Client are
  platform events and only a platform admin sees them.
* *Who may write one?* Anyone, for their own Client or for no Client. An audit
  trail that can refuse a write is worse than useless — the events it drops are
  exactly the ones someone wanted dropped.

**2. The trail was not immutable.** `CREATE POLICY ... USING (...)` with no
command qualifier covers ALL, so a Client could UPDATE or DELETE its own audit
rows. Granting only SELECT and INSERT here makes "immutable" true rather than
merely documented; with no policy for UPDATE or DELETE, both are denied outright.

Revision ID: 0011
Revises: 0010
"""

from __future__ import annotations

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP POLICY IF EXISTS audit_log_client_isolation ON audit_log")

    op.execute("""
        CREATE POLICY audit_log_read ON audit_log FOR SELECT
            USING (client_id = app_client_id() OR app_is_platform_admin())
    """)
    op.execute("""
        CREATE POLICY audit_log_write ON audit_log FOR INSERT
            WITH CHECK (
                client_id IS NULL
                OR client_id = app_client_id()
                OR app_is_platform_admin()
            )
    """)
    # No UPDATE or DELETE policy exists, deliberately. With RLS enabled and
    # forced, the absence of a policy denies the command outright.
    op.execute("REVOKE UPDATE, DELETE ON audit_log FROM solarcms_api")
    op.execute("COMMENT ON TABLE audit_log IS "
               "'Immutable. Every mutation writes a row here in the SAME transaction as "
               "the change (BACKEND_SPEC 8.3). Readable only by the owning Client or a "
               "platform admin; writable with a NULL client_id so that a failed login, "
               "which has no Client context, can still be recorded (tender 33). No "
               "UPDATE or DELETE policy exists, so neither is permitted.'")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS audit_log_read ON audit_log")
    op.execute("DROP POLICY IF EXISTS audit_log_write ON audit_log")
    op.execute("GRANT UPDATE, DELETE ON audit_log TO solarcms_api")
    op.execute("""
        CREATE POLICY audit_log_client_isolation ON audit_log
            USING (client_id = app_client_id() OR app_is_platform_admin())
            WITH CHECK (client_id = app_client_id() OR app_is_platform_admin())
    """)
