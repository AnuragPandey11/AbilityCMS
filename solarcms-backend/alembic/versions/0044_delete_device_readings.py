"""Let the API delete one visible Device's Readings, and nothing else on `readings`.

`DELETE /devices/{id}?force=true` deletes a Device together with its stored
Readings — the route the Plant screen offers, after asking twice, for a Device
registered on the wrong topic. It has never worked: the route ran
`DELETE FROM readings` as `solarcms_api`, which holds no privilege at all on
the base relation (0008, 0010), so every confirmed removal ended in "permission
denied for table readings" and a 500 (found 20 Oct 2026, when a Client tried to
remove Devices whose topics were wrong).

Granting DELETE on `readings` would undo the design that keeps it safe:
`readings` carries no RLS (TimescaleDB refuses it on a compressed hypertable),
so its isolation is the absence of a grant, and a table-wide DELETE would let
one forgotten predicate erase another Client's generation history. So this is
the write-side twin of `readings_v`: one SECURITY DEFINER function that deletes
the rows of exactly one Device, and only a Device the caller can see — checked
inside the function with the same predicates the policies on `devices` use,
spelled out rather than inherited, because an owner that is a superuser (as on
a development machine) bypasses RLS even when it is FORCEd.

Revision ID: 0044
Revises: 0043
"""

from __future__ import annotations

from alembic import op

revision = "0044"
down_revision = "0043"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE FUNCTION app_delete_device_readings(p_device_id BIGINT) RETURNS BIGINT
        LANGUAGE plpgsql VOLATILE SECURITY DEFINER
        SET search_path = public, pg_temp AS $$
        DECLARE
            v_client_id BIGINT;
            v_plant_id  BIGINT;
            v_deleted   BIGINT;
        BEGIN
            SELECT client_id, plant_id INTO v_client_id, v_plant_id
              FROM devices WHERE id = p_device_id;
            -- coalesce: with no session set, app_client_id() is NULL and the
            -- test is NULL, which IF would read as "not refused".
            IF NOT coalesce(
                   (v_client_id = app_client_id() OR app_is_platform_admin())
                   AND app_can_see_plant(v_plant_id), false) THEN
                RAISE EXCEPTION 'no Device % visible to this session', p_device_id
                      USING ERRCODE = 'insufficient_privilege';
            END IF;
            DELETE FROM readings
             WHERE device_id = p_device_id AND client_id = v_client_id;
            GET DIAGNOSTICS v_deleted = ROW_COUNT;
            RETURN v_deleted;
        END
        $$
    """)
    op.execute("COMMENT ON FUNCTION app_delete_device_readings(BIGINT) IS "
               "'Deletes the Readings of ONE Device the session can see, for "
               "DELETE /devices/{id}?force=true. The API holds no privilege on "
               "readings itself; this is the only write it may make there.'")
    # Revoked from PUBLIC then granted explicitly, as auth_memberships_for is.
    op.execute("REVOKE ALL ON FUNCTION app_delete_device_readings(BIGINT) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION app_delete_device_readings(BIGINT) "
               "TO solarcms_api")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS app_delete_device_readings(BIGINT)")
