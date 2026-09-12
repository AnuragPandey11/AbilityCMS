-- Cluster-level bootstrap. Run ONCE as a superuser, before the first migration.
--
--   psql -d solarcms -f scripts/bootstrap_roles.sql
--
-- Roles are cluster infrastructure, not an application migration's business: in
-- most deployments the migration role has no CREATEROLE, and granting it that
-- privilege to save one setup step would be the wrong trade. Migration 0008
-- therefore verifies these exist and stops with an explanatory error if they do
-- not, rather than creating them itself.
--
-- Both are NOLOGIN. Nothing connects as them directly — the API and the workers
-- connect as the owner and assume the appropriate role per transaction with
-- SET LOCAL ROLE, which is what keeps the owner's privileges out of request
-- handling while needing only one connection pool.

\set owner solarcms

DO $$
BEGIN
    -- What the API acts as: subject to RLS on ordinary tables, and holding no
    -- privilege at all on the compressed telemetry hypertables, which it reads
    -- only through the barrier views created in migration 0008.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solarcms_api') THEN
        CREATE ROLE solarcms_api NOLOGIN;
    END IF;

    -- What the ingest worker acts as: writes telemetry directly. Trusted because
    -- it derives client_id from the MQTT topic before any row exists, and serves
    -- no user request — a Client predicate would have nothing to filter.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solarcms_ingest') THEN
        CREATE ROLE solarcms_ingest NOLOGIN;
    END IF;

    -- What the scheduler and health sweeper act as. Distinct from the ingest
    -- role because the work is different: escalation timers, report runs and
    -- aggregate verification touch alarms, notifications and users, none of
    -- which ingestion has any business reading. Naming the ingest role here
    -- instead would have been one grant and a permanent lie about who does what.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'solarcms_scheduler') THEN
        CREATE ROLE solarcms_scheduler NOLOGIN;
    END IF;
END $$;

-- The owner must be able to assume both in order to SET LOCAL ROLE.
GRANT solarcms_api, solarcms_ingest, solarcms_scheduler TO :owner;

-- Deliberately NOT granted: BYPASSRLS on either role, and SUPERUSER on any.
-- The ingest worker is exempted from specific policies on specific tables in
-- 0008 instead, so the blast radius of a mistake stays bounded to telemetry and
-- health rather than covering every Client-owned table in the system.
