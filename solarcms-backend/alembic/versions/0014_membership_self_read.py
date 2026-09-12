"""Let a session read its own memberships, replacing the 0013 bootstrap function.

0013 tried to solve the authentication circularity with a SECURITY DEFINER
function. That does not work here: `memberships` is FORCE ROW LEVEL SECURITY, so
even the table owner — which is who SECURITY DEFINER runs as — is subject to the
policy. The function returned nothing and every login still failed.

The insight that resolves it: by the time login needs the membership list, the
password has already been verified, so the session *does* know who it is. It only
lacks a Client. Setting `app.user_id` at that point and permitting a User to read
their **own** membership rows closes the loop with no elevated privilege
anywhere:

    verify password → SET app.user_id → read own memberships → SET app.client_id

The new predicate is strictly narrower than the function it replaces. A caller
can see only rows where `user_id` is their own; the function, had it worked,
would have run with the owner's rights.

Revision ID: 0014
Revises: 0013
"""

from __future__ import annotations

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS auth_memberships_for(BIGINT)")

    op.execute("DROP POLICY IF EXISTS memberships_client_isolation ON memberships")
    op.execute("""
        CREATE POLICY memberships_read ON memberships FOR SELECT
            USING (
                client_id = app_client_id()
                OR app_is_platform_admin()
                -- Own memberships, readable once the password is verified and
                -- app.user_id is set but before a Client is chosen. This is the
                -- authentication bootstrap and nothing else reaches it: without a
                -- verified app.user_id the predicate matches no rows.
                OR user_id = app_user_id()
            )
    """)
    # Writes stay Client-scoped: reading one's own memberships is not permission
    # to create one.
    for command in ("INSERT", "UPDATE", "DELETE"):
        clause = "WITH CHECK" if command == "INSERT" else "USING"
        op.execute(f"""
            CREATE POLICY memberships_{command.lower()} ON memberships FOR {command}
                {clause} (client_id = app_client_id() OR app_is_platform_admin())
        """)


def downgrade() -> None:
    for suffix in ("read", "insert", "update", "delete"):
        op.execute(f"DROP POLICY IF EXISTS memberships_{suffix} ON memberships")
    op.execute("""
        CREATE POLICY memberships_client_isolation ON memberships
            USING (client_id = app_client_id() OR app_is_platform_admin())
            WITH CHECK (client_id = app_client_id() OR app_is_platform_admin())
    """)
