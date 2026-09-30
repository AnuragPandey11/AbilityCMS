"""Register the dashboard catalogue with the schema, not with the seed.

Which dashboards a build contains is a fact about the build. It was held in
`services/seed.py` as a constant and copied into `dashboards` by `cli seed`, so
the database was a mirror of the code that had to be refreshed by hand — and a
deploy that shipped a new screen without re-seeding left it invisible. Not
broken, not logged: absent. `GET /auth/me` answers from this table, the sidebar
is built from that answer, and `routes/index.tsx` then reports the missing code
as *"not assigned to your account"* — a permissions explanation for what is
really an unregistered row, which sends the reader to the one place the cause
is not.

`alembic upgrade head` is a deploy step nobody can skip, so the rows now arrive
with the code that needs them and the two cannot drift. A screen added later
gets its own migration; `cli seed` no longer writes this table.

⚠ The rows below are a snapshot, deliberately literal rather than imported from
`seed.py`: a migration must replay the same way for ever, and an import would
make this one's effect change every time that tuple is edited.

⚠ No `set_config('app.is_platform_admin', ...)` here, unlike a migration that
touches a Client-owned table. `dashboards` is in 0008's CATALOG group — platform
catalogue, GRANT SELECT to the runtime roles, no RLS and no policy — so the
owner's writes are not filtered. Do not add one by reflex.

Revision ID: 0028
Revises: 0027
"""

from __future__ import annotations

from sqlalchemy import text

from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None

# (code, name, sort_order) — dimension A-3: which dashboard *types* a User may
# open. Gaps in the ordering are intentional, so a later screen can be placed
# beside the one it belongs with rather than renumbering the rest.
DASHBOARDS: tuple[tuple[str, str, int], ...] = (
    # Tender §7 names these eight.
    ("portfolio", "Portfolio", 10),
    ("plant_overview", "Plant Overview", 20),
    ("plant_list", "Plant List", 30),
    ("single_plant", "Single Plant", 40),
    ("sld", "Single Line Diagram", 50),
    ("inverter_monitoring", "Inverter Monitoring", 60),
    # The client's reference String Analysis screen (30 Sep 2026): every PV
    # string of every Inverter at once, coloured by `domain/strings.py`.
    ("string_analysis", "String Analysis", 61),
    # Not tender §7 — the client's reference screens (28 Sep 2026): the Weather
    # Station's readings and trends, historical Plant trends over a chosen
    # window, and the Plant's meters. Granted like any other: a Client Admin
    # sees them at once, anyone else once an administrator assigns them.
    ("meteorological", "Meteorological", 62),
    ("energy_analytics", "Energy Analytics", 64),
    ("grid_monitoring", "MFM / Grid", 66),
    # The client's reference screens for the Plant's HV equipment (30 Sep
    # 2026): the Transformer's temperatures and protection contacts, the Power
    # Plant Controller's setpoints and control enables, and every VCB's
    # contacts. Granted like the three above.
    ("transformer_monitoring", "Transformer", 67),
    ("ppc_monitoring", "PPC", 68),
    ("vcb_monitoring", "VCB", 69),
    ("alarms", "Alarms", 70),
    ("reports", "Reports", 80),
)


def upgrade() -> None:
    # Upsert, because every database that has run `cli seed` already holds most
    # of these: this must be a no-op there and an insert on a fresh one. The
    # label and order are corrected on conflict; the code is the identity and is
    # never rewritten, since `user_dashboard_access` points at the id behind it.
    stmt = text("""
        INSERT INTO dashboards (code, name, sort_order)
        VALUES (:code, :name, :sort_order)
        ON CONFLICT (code) DO UPDATE
            SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order
    """)
    for code, name, sort_order in DASHBOARDS:
        op.execute(stmt.bindparams(code=code, name=name, sort_order=sort_order))


def downgrade() -> None:
    """Deliberately does nothing.

    `user_dashboard_access.dashboard_id` is ON DELETE CASCADE, so deleting a
    catalogue row silently revokes that screen from every User an administrator
    had granted it to — configuration a human entered, destroyed to undo a
    migration that only ever added reference data. Leaving the rows is
    harmless: a build without those screens simply never routes their codes.
    """
