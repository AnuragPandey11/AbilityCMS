"""A narrow SECURITY DEFINER function for the authentication bootstrap.

Authentication has a circularity: to set `app.client_id` the login flow must
first discover which Clients the User belongs to, but `memberships` is protected
by a policy that filters on `app.client_id`. Pre-authentication, that value does
not exist, so the lookup returns nothing and every login fails with "no Client
membership".

Two ways out, and the difference matters:

* Run the whole login path with platform privileges. One mistake anywhere in that
  path then reads across every Client.
* Expose exactly the one lookup that needs to cross the boundary, as a function
  that takes a user id and returns nothing else.

This is the second. `auth_memberships_for(user_id)` returns only
`(client_id, role_code, client_is_demo)` for one User — no names, no other
Clients' rows, nothing that is not needed to mint a token. It is the only
SECURITY DEFINER in the schema besides `app_visible_plant_ids`, and both exist
for the same reason: a policy that would otherwise have to recurse through the
table it is protecting.

Revision ID: 0013
Revises: 0012
"""

from __future__ import annotations

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE FUNCTION auth_memberships_for(p_user_id BIGINT)
        RETURNS TABLE (client_id BIGINT, role_code TEXT, client_is_demo BOOLEAN)
        LANGUAGE sql STABLE SECURITY DEFINER AS $$
            SELECT m.client_id, r.code, c.is_demo
              FROM memberships m
              JOIN roles r   ON r.id = m.role_id
              JOIN clients c ON c.id = m.client_id
             WHERE m.user_id = p_user_id
               AND c.status <> 'decommissioned'
        $$
    """)
    op.execute("COMMENT ON FUNCTION auth_memberships_for(BIGINT) IS "
               "'Authentication bootstrap only. Returns the Client memberships of ONE "
               "User so a token can be minted; RLS on memberships cannot serve this "
               "because it filters on the app.client_id that login is trying to "
               "establish. Deliberately returns no names or other identifying data.'")
    # Revoked from PUBLIC then granted explicitly, so the grant is a decision
    # rather than a default.
    op.execute("REVOKE ALL ON FUNCTION auth_memberships_for(BIGINT) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION auth_memberships_for(BIGINT) TO solarcms_api")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS auth_memberships_for(BIGINT)")
