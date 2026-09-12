"""Extensions, identity and RBAC.

Revision ID: 0001
Revises:
"""

from __future__ import annotations

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    # timescaledb must already be in shared_preload_libraries; CREATE EXTENSION
    # fails loudly otherwise, which is the correct outcome — a silent fallback
    # would leave production without the retention cascade (MASTER F-4).
    op.execute("CREATE EXTENSION IF NOT EXISTS timescaledb")
    op.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    op.execute("""
        CREATE TABLE clients (
            id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code       VARCHAR(64)  NOT NULL UNIQUE,
            name       TEXT         NOT NULL,
            status     VARCHAR(32)  NOT NULL DEFAULT 'onboarding',
            is_demo    BOOLEAN      NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
            CONSTRAINT ck_clients_client_status
                CHECK (status IN ('onboarding','active','suspended','decommissioned'))
        )
    """)
    op.execute("COMMENT ON TABLE clients IS "
               "'A customer company owning one or more Plants. The unit of data isolation. "
               "Canonically a Client, never a tenant (MASTER 1.1).'")

    op.execute("""
        CREATE TABLE users (
            id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            email         CITEXT      NOT NULL UNIQUE,
            password_hash TEXT        NOT NULL,
            full_name     TEXT        NOT NULL,
            platform_role VARCHAR(32) NOT NULL DEFAULT 'none',
            is_active     BOOLEAN     NOT NULL DEFAULT true,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_login_at TIMESTAMPTZ,
            CONSTRAINT ck_users_user_platform_role
                CHECK (platform_role IN ('super_admin','none'))
        )
    """)
    op.execute("COMMENT ON COLUMN users.platform_role IS "
               "'Super Admin sits outside memberships entirely (MASTER 3.5): access is "
               "granted by an RLS policy predicate, not by membership rows.'")

    op.execute("""
        CREATE TABLE roles (
            id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code      VARCHAR(32) NOT NULL UNIQUE,
            name      TEXT        NOT NULL,
            is_system BOOLEAN     NOT NULL DEFAULT false
        )
    """)
    op.execute("COMMENT ON TABLE roles IS "
               "'A table, not an enum — a custom role is data, not a schema change "
               "(tender 29).'")

    op.execute("""
        CREATE TABLE permissions (
            id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code        VARCHAR(64) NOT NULL UNIQUE,
            description TEXT        NOT NULL
        )
    """)
    op.execute("""
        CREATE TABLE role_permissions (
            role_id       BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
            permission_id BIGINT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
            PRIMARY KEY (role_id, permission_id)
        )
    """)
    op.execute("""
        CREATE TABLE memberships (
            id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            user_id    BIGINT      NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
            client_id  BIGINT      NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
            role_id    BIGINT      NOT NULL REFERENCES roles(id),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_memberships_user_id_client_id UNIQUE (user_id, client_id)
        )
    """)
    op.execute("""
        CREATE TABLE dashboards (
            id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            code       VARCHAR(64) NOT NULL UNIQUE,
            name       TEXT        NOT NULL,
            sort_order INTEGER     NOT NULL DEFAULT 0
        )
    """)
    op.execute("""
        CREATE TABLE user_dashboard_access (
            membership_id BIGINT NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
            dashboard_id  BIGINT NOT NULL REFERENCES dashboards(id)  ON DELETE CASCADE,
            PRIMARY KEY (membership_id, dashboard_id)
        )
    """)
    op.execute("COMMENT ON TABLE user_dashboard_access IS "
               "'Dimension A-3. No rows + role admin means all dashboards; no rows "
               "otherwise means none. Deny by default, cf. I-5.'")


def downgrade() -> None:
    for table in (
        "user_dashboard_access", "dashboards", "memberships",
        "role_permissions", "permissions", "roles", "users", "clients",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    # Extensions are deliberately left in place: other databases in the cluster
    # may rely on them, and dropping timescaledb would be destructive well
    # beyond this migration's scope.
