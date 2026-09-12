"""Plant visibility on the telemetry barrier views.

BACKEND_SPEC §5.4 scopes `readings` by Client only, arguing that Plant visibility
is inherited "because the caller reaches Readings only through an already-filtered
Device list". That is an *application-layer* argument, and it is the kind the
specification rejects everywhere else: the whole case for database enforcement
(MASTER §3.5) is that a developer who forgets a filter gets zero rows rather than
someone else's data.

Tested against the built system, the gap was real: an Employee with zero Plant
Assignments saw 0 Plants and 0 Devices — I-5 holding correctly — but all 22 of
their Client's Readings through `readings_v`.

The fix costs almost nothing. `devices` already carries full Plant-visibility RLS
and is small by design — F-2 caps the platform at 150+ Devices — so a semi-join
against it filters Readings by Plant without touching the large table. The join
the specification declined was against `plants` through `devices` on every
historical query; this is a hash of at most a few hundred ids.

Revision ID: 0010
Revises: 0009
"""

from __future__ import annotations

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

TELEMETRY = ("readings", "mqtt_raw")


def upgrade() -> None:
    for table in TELEMETRY:
        op.execute(f"DROP VIEW IF EXISTS {table}_v")
        # The subquery runs with the view owner's privileges but the *caller's*
        # session variables, so RLS on `devices` applies the caller's Plant
        # visibility — an Admin sees every Device of their Client, an Employee
        # only assigned ones, and zero assignments means zero (I-5).
        op.execute(f"""
            CREATE VIEW {table}_v WITH (security_barrier = true) AS
                SELECT * FROM {table}
                 WHERE (client_id = app_client_id() OR app_is_platform_admin())
                   AND (device_id IS NULL OR device_id IN (SELECT id FROM devices))
        """)
        op.execute(f"GRANT SELECT ON {table}_v TO solarcms_api")
        op.execute(
            f"COMMENT ON VIEW {table}_v IS "
            f"'Client- AND Plant-scoped read path for {table}. The API holds no "
            f"privilege on the base relation: TimescaleDB forbids RLS on a compressed "
            f"hypertable, so isolation is this view plus the absence of a grant. Plant "
            f"scoping rides on the RLS already enforced on devices, which is small by "
            f"design (F-2). Never query {table} directly from request-serving code.'"
        )

    # device_id IS NULL is deliberate above: a quarantined mqtt_raw row resolved to
    # no Device, and hiding it from its own Client would hide exactly the evidence
    # that something is misconfigured.


def downgrade() -> None:
    for table in TELEMETRY:
        op.execute(f"DROP VIEW IF EXISTS {table}_v")
        op.execute(f"""
            CREATE VIEW {table}_v WITH (security_barrier = true) AS
                SELECT * FROM {table}
                 WHERE client_id = app_client_id() OR app_is_platform_admin()
        """)
        op.execute(f"GRANT SELECT ON {table}_v TO solarcms_api")
