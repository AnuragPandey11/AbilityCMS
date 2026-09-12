"""Policies for hybrid and child tables missed by 0008.

Migration 0008 sorted tables into two groups: Client-owned (RLS on `client_id`)
and global catalogue (readable by all). Three tables fit neither, so they got no
grant at all and every route touching them returned 500:

**Hybrid tables** — `alarm_rules` and `report_definitions` carry a *nullable*
`client_id`, where NULL means "platform default, inherited by every Client"
(BACKEND_SPEC §10.1). They are readable by everyone but writable only for one's
own rows: a Client may add or tune a rule, and must not be able to edit the
platform default that every other Client inherits. That asymmetry needs separate
SELECT and write policies, which the single blanket policy could not express.

**Child tables** — `escalation_steps` has no `client_id` of its own; it belongs
to a Client through `escalation_policies`. Rather than denormalise a column onto
it, visibility rides on the parent's RLS: the subquery returns only policies the
caller can already see, so a step is reachable exactly when its policy is.

Revision ID: 0012
Revises: 0011
"""

from __future__ import annotations

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

API_ROLE = "solarcms_api"
HYBRID = ("alarm_rules", "report_definitions")


def upgrade() -> None:
    for table in HYBRID:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        # Readable: own rows plus the platform defaults inherited from NULL.
        op.execute(f"""
            CREATE POLICY {table}_read ON {table} FOR SELECT
                USING (client_id IS NULL
                       OR client_id = app_client_id()
                       OR app_is_platform_admin())
        """)
        # Writable: own rows only. A NULL-Client default belongs to the platform,
        # and letting one Client edit it would silently change every other
        # Client's alarming.
        for command in ("INSERT", "UPDATE", "DELETE"):
            clause = "WITH CHECK" if command == "INSERT" else "USING"
            op.execute(f"""
                CREATE POLICY {table}_{command.lower()} ON {table} FOR {command}
                    {clause} (client_id = app_client_id() OR app_is_platform_admin())
            """)
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO {API_ROLE}")

    op.execute("COMMENT ON COLUMN alarm_rules.client_id IS "
               "'NULL is a platform default inherited by every Client and is read-only "
               "to them; a Client overrides it with a more specific row rather than by "
               "editing it. Scope resolution is most-specific-wins: device -> plant -> "
               "device_type -> global.'")

    # ── Child table: visibility inherited from the parent ───────────────────
    op.execute("ALTER TABLE escalation_steps ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE escalation_steps FORCE ROW LEVEL SECURITY")
    op.execute("""
        CREATE POLICY escalation_steps_via_policy ON escalation_steps
            USING (policy_id IN (SELECT id FROM escalation_policies))
            WITH CHECK (policy_id IN (SELECT id FROM escalation_policies))
    """)
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON escalation_steps TO {API_ROLE}")
    op.execute("COMMENT ON TABLE escalation_steps IS "
               "'Belongs to a Client through escalation_policies rather than by its own "
               "column. Visibility rides on the parent RLS: the subquery returns only "
               "policies the caller can already see.'")

    # Join tables reached only through an already-scoped parent, but still needing
    # an explicit grant for the API to read them.
    op.execute(f"GRANT SELECT ON device_model_tags TO {API_ROLE}")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS escalation_steps_via_policy ON escalation_steps")
    op.execute("ALTER TABLE escalation_steps NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE escalation_steps DISABLE ROW LEVEL SECURITY")
    for table in HYBRID:
        for suffix in ("read", "insert", "update", "delete"):
            op.execute(f"DROP POLICY IF EXISTS {table}_{suffix} ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
