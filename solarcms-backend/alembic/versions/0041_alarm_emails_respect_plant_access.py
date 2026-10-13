"""Let the roles that send Alarm emails read Plant Assignments.

A subscription names a User and, optionally, a Plant. Until now nothing checked
that the User could *see* what they were emailed about: an Employee assigned
one Plant, given a Client-wide subscription, would be emailed every Plant's
Alarms; and a User removed from the Client kept receiving them, because the
subscription outlives the membership. Sending now joins the subscription to a
current membership and, for anyone but a Client Admin, to `user_plant_access`
— the same rule `app_can_see_plant` applies on every screen.

Alarm emails are queued by the alarm worker and the health sweep, both writing
as `solarcms_scheduler`, which has never been granted `user_plant_access`. The
table carries no row-level security (visibility is computed *from* it), so a
GRANT is the whole change. Without it the join fails "permission denied" and,
because notification shares the raise's transaction, the Alarm rolls back with
it — the failure 0025 and the 25 Sep 2026 fix both record.

Status: AGREED (13 Oct 2026) / BUILT.

Revision ID: 0041
Revises: 0040
"""

from __future__ import annotations

from alembic import op

revision = "0041"
down_revision = "0040"
branch_labels = None
depends_on = None

SCHEDULER = "solarcms_scheduler"


def upgrade() -> None:
    op.execute(f"GRANT SELECT ON user_plant_access TO {SCHEDULER}")


def downgrade() -> None:
    op.execute(f"REVOKE SELECT ON user_plant_access FROM {SCHEDULER}")
