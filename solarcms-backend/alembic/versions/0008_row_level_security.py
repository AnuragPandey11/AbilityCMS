"""Isolation: runtime roles, RLS policies, and barrier views over telemetry.

Why the database and not application code (MASTER §3.5): a developer who forgets
a `WHERE client_id = …` clause must get zero rows, not another Client's
generation data. That claim is the product's core promise and cannot be made
about application-layer filtering.

⚠ **A conflict the specifications did not anticipate.** TimescaleDB refuses
`ENABLE ROW LEVEL SECURITY` on a hypertable with compression enabled, and refuses
compression on a table with row security — in either order:

    ERROR: columnstore cannot be used on table with row security

That pits BACKEND_SPEC §5.3 (compression; the 30-day raw tier is sized at "10 GB
compressed") against §5.4 ("Client isolation on every Client-owned table,
including `readings`"). Both are load-bearing, so neither is traded away.

The resolution: `readings`, `mqtt_raw` and the aggregate tiers keep compression
and carry **no** RLS. The API never reaches them. It holds no privilege on the
base tables at all and reads only through `security_barrier` views that apply the
same Client predicate the policies would have. The defensibility argument
survives intact — a forgotten WHERE clause returns zero rows because the role
genuinely cannot see the table — and the storage sizing survives with it.

Two runtime roles make this enforceable:

* ``solarcms_api`` — what the API acts as. Subject to RLS on ordinary tables;
  view-only on telemetry. The API assumes it per transaction with
  ``SET LOCAL ROLE``, so the migration owner's privileges are never used to serve
  a request.
* ``solarcms_ingest`` — what the ingest worker acts as. Writes telemetry
  directly: it is trusted because it derives `client_id` from the topic before
  any row exists, and it serves no user request.

⚠ PgBouncer must run in **transaction** mode. Statement mode leaks the session
variables and `SET LOCAL ROLE` between Clients and defeats all of this.

Revision ID: 0008
Revises: 0007
"""

from __future__ import annotations

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"
INGEST_ROLE = "solarcms_ingest"

# Client-owned tables that are NOT hypertables, and so can carry RLS directly.
CLIENT_SCOPED = (
    "plants", "blocks", "devices", "device_tag_bindings", "broker_credentials",
    "alarms", "device_health", "device_health_events", "escalation_policies",
    "notification_subscriptions", "notification_log", "incident_snapshots",
    "report_runs", "report_schedules", "audit_log",
)

# Of those, the ones carrying plant_id and so also needing Plant visibility.
PLANT_SCOPED = ("plants", "blocks", "devices", "alarms", "device_health",
                "device_health_events")

# Compressed hypertables and aggregates: isolation by barrier view, not RLS.
TELEMETRY = ("readings", "mqtt_raw")
AGGREGATES = ("agg_1m", "agg_15m", "agg_1h", "agg_1d")

# Global, platform-owned catalogue. No client_id, deliberately readable by every
# Client: these describe equipment categories and metric definitions, not data.
CATALOG = ("device_types", "device_models", "tags", "device_model_tags",
           "dashboards", "roles", "permissions", "role_permissions", "regions",
           "topic_patterns")


def upgrade() -> None:
    # ── Runtime roles: verified, not created ────────────────────────────────
    # Roles are cluster infrastructure. The migration role usually has no
    # CREATEROLE, and granting it that privilege to save a setup step would be
    # the wrong trade — so this asserts and explains instead of creating.
    for role in (API_ROLE, INGEST_ROLE):
        op.execute(f"""
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
                    RAISE EXCEPTION
                        'role "{role}" does not exist. Run scripts/bootstrap_roles.sql '
                        'as a superuser before migrating: '
                        'psql -d <db> -f scripts/bootstrap_roles.sql';
                END IF;
            END $$
        """)
        op.execute(f"GRANT USAGE ON SCHEMA public TO {role}")

    # ── Session accessors ───────────────────────────────────────────────────
    # STABLE + PARALLEL SAFE so the planner treats them as constants within a
    # statement. current_setting(..., true) yields NULL rather than raising when
    # unset, so an unconfigured session sees nothing: deny by default.
    op.execute("""
        CREATE FUNCTION app_user_id() RETURNS BIGINT
        LANGUAGE sql STABLE PARALLEL SAFE AS
        $$ SELECT NULLIF(current_setting('app.user_id', true), '')::BIGINT $$
    """)
    op.execute("""
        CREATE FUNCTION app_client_id() RETURNS BIGINT
        LANGUAGE sql STABLE PARALLEL SAFE AS
        $$ SELECT NULLIF(current_setting('app.client_id', true), '')::BIGINT $$
    """)
    op.execute("""
        CREATE FUNCTION app_role_code() RETURNS TEXT
        LANGUAGE sql STABLE PARALLEL SAFE AS
        $$ SELECT NULLIF(current_setting('app.role_code', true), '') $$
    """)
    op.execute("""
        CREATE FUNCTION app_is_platform_admin() RETURNS BOOLEAN
        LANGUAGE sql STABLE PARALLEL SAFE AS
        $$ SELECT coalesce(
               NULLIF(current_setting('app.is_platform_admin', true), '')::BOOLEAN,
               false) $$
    """)

    # SECURITY DEFINER so the predicate can read user_plant_access without that
    # table needing a policy that would recurse through this function.
    op.execute("""
        CREATE FUNCTION app_visible_plant_ids() RETURNS SETOF BIGINT
        LANGUAGE sql STABLE SECURITY DEFINER AS $$
            SELECT upa.plant_id
              FROM user_plant_access upa
              JOIN memberships m ON m.id = upa.membership_id
             WHERE m.user_id = app_user_id()
               AND m.client_id = app_client_id()
        $$
    """)

    # One predicate shared by every policy. An Admin sees all Plants of their
    # Client automatically (F-8). Anyone else sees only assigned Plants, and zero
    # assignments means zero Plants (I-5) — never full access.
    op.execute("""
        CREATE FUNCTION app_can_see_plant(p_plant_id BIGINT) RETURNS BOOLEAN
        LANGUAGE sql STABLE AS $$
            SELECT app_is_platform_admin()
                OR app_role_code() = 'admin'
                OR (p_plant_id IS NOT NULL
                    AND p_plant_id IN (SELECT app_visible_plant_ids()))
        $$
    """)

    # ── RLS on ordinary Client-owned tables ─────────────────────────────────
    for table in CLIENT_SCOPED:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        # FORCE so the table's owner is subject to the policies too. Without it,
        # the owner bypasses RLS entirely — the commonest way this protection is
        # silently lost.
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")

        if table in PLANT_SCOPED:
            plant_column = "id" if table == "plants" else "plant_id"
            predicate = (
                f"(client_id = app_client_id() OR app_is_platform_admin()) "
                f"AND app_can_see_plant({plant_column})"
            )
        else:
            predicate = "client_id = app_client_id() OR app_is_platform_admin()"

        op.execute(f"""
            CREATE POLICY {table}_client_isolation ON {table}
                USING ({predicate}) WITH CHECK ({predicate})
        """)
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {API_ROLE}")

    op.execute("ALTER TABLE memberships ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE memberships FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY memberships_client_isolation ON memberships
            USING (client_id = app_client_id() OR app_is_platform_admin())
            WITH CHECK (client_id = app_client_id() OR app_is_platform_admin())
    """)

    # I-6 / OPEN-4: a Guest may only reach a Client flagged for demonstration,
    # enforced here rather than trusted to the API. Granting a Guest real Client
    # access would expose generation and financial data to a third party.
    op.execute("ALTER TABLE clients ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE clients FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY clients_visibility ON clients
            USING (
                app_is_platform_admin()
                OR (id = app_client_id()
                    AND (app_role_code() <> 'guest' OR is_demo))
            )
            WITH CHECK (app_is_platform_admin())
    """)

    # users is not Client-scoped (a User may belong to several Clients), so it is
    # reachable only through memberships, which is scoped. The API needs to read
    # it to authenticate and to render names.
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON users TO {API_ROLE}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, clients, "
               f"user_plant_access, user_dashboard_access TO {API_ROLE}")
    op.execute(f"GRANT SELECT ON {', '.join(CATALOG)} TO {API_ROLE}")
    # Catalog writes are system.admin only and go through the owner connection.

    # ── Telemetry: barrier views instead of RLS ──────────────────────────────
    for table in (*TELEMETRY, *AGGREGATES):
        # The API holds no privilege whatsoever on the base relation. This, not a
        # policy, is what makes a forgotten WHERE clause return nothing.
        op.execute(f"REVOKE ALL ON {table} FROM PUBLIC")
        op.execute(f"REVOKE ALL ON {table} FROM {API_ROLE}")

        # security_barrier stops the planner pushing a user-supplied function
        # below the Client predicate, which would otherwise be able to observe
        # rows from other Clients through a side channel.
        op.execute(f"""
            CREATE VIEW {table}_v WITH (security_barrier = true) AS
                SELECT * FROM {table}
                 WHERE client_id = app_client_id() OR app_is_platform_admin()
        """)
        op.execute(f"GRANT SELECT ON {table}_v TO {API_ROLE}")
        op.execute(
            f"COMMENT ON VIEW {table}_v IS "
            f"'Client-scoped read path for {table}. The API has no privilege on the "
            f"base relation: TimescaleDB forbids RLS on a compressed hypertable, so "
            f"isolation is enforced by this barrier view plus the absence of a grant "
            f"(migration 0008). Never query {table} directly from request-serving code.'"
        )

    # The ingest worker writes telemetry directly. It resolves client_id from the
    # topic before any row exists and serves no user request, so a Client
    # predicate would have nothing to filter.
    op.execute(f"GRANT SELECT, INSERT ON {', '.join(TELEMETRY)} TO {INGEST_ROLE}")
    op.execute(f"GRANT SELECT ON {', '.join(CATALOG)} TO {INGEST_ROLE}")
    op.execute(f"GRANT SELECT ON plants, devices, device_tag_bindings TO {INGEST_ROLE}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE ON device_health, device_health_events, "
               f"alarms TO {INGEST_ROLE}")
    op.execute(f"GRANT SELECT ON alarm_rules TO {INGEST_ROLE}")
    # Sequences behind IDENTITY columns, for the rows the worker inserts.
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {INGEST_ROLE}")
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {API_ROLE}")

    # The ingest worker bypasses the policies on the tables it writes; it is a
    # trusted process, not a user session. BYPASSRLS is deliberately NOT granted
    # — instead the worker is exempted per table below, so the blast radius of a
    # mistake stays bounded to telemetry and health.
    for table in ("device_health", "device_health_events", "alarms"):
        op.execute(f"""
            CREATE POLICY {table}_ingest_writer ON {table}
                TO {INGEST_ROLE} USING (true) WITH CHECK (true)
        """)


def downgrade() -> None:
    for table in ("device_health", "device_health_events", "alarms"):
        op.execute(f"DROP POLICY IF EXISTS {table}_ingest_writer ON {table}")
    for table in (*TELEMETRY, *AGGREGATES):
        op.execute(f"DROP VIEW IF EXISTS {table}_v")
    for table in (*CLIENT_SCOPED, "memberships"):
        op.execute(f"DROP POLICY IF EXISTS {table}_client_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute("DROP POLICY IF EXISTS clients_visibility ON clients")
    op.execute("ALTER TABLE clients NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE clients DISABLE ROW LEVEL SECURITY")
    for fn in (
        "app_can_see_plant(BIGINT)", "app_visible_plant_ids()",
        "app_is_platform_admin()", "app_role_code()", "app_client_id()", "app_user_id()",
    ):
        op.execute(f"DROP FUNCTION IF EXISTS {fn}")
    # Roles are cluster-wide and may own objects elsewhere; dropping them is not
    # this migration's business.
