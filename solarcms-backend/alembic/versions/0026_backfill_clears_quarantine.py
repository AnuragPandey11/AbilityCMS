"""Let ingest mark a quarantined message as decoded.

Backfill replays the messages a Device produced before anybody registered it —
they are held whole in `mqtt_raw`, decoded into nothing — and turns them into
Readings. Re-running it must not double-count, and `readings` has no unique
constraint to lean on: it is a hypertable, and a uniqueness check on every
inserted row is exactly what the ingest path cannot afford.

The safety therefore comes from the quarantine flag itself. Backfill replays
**only** rows marked `quarantined`, and clears the flag on each as it goes, so a
second run finds nothing left to replay. That requires UPDATE, and the ingest
role held only SELECT and INSERT — so the replay wrote its Readings, hit the
flag update, and rolled the whole transaction back. It failed safely rather than
half-writing, but it failed.

⚠ Deliberately narrow. Ingest gains UPDATE on `mqtt_raw` and nothing else; it
still holds no UPDATE or DELETE anywhere in telemetry, and `readings` remains
append-only to every role. The flag is metadata about what happened to a
message, not the message — the payload is never rewritten.

Revision ID: 0026
Revises: 0025
"""

from __future__ import annotations

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

INGEST_ROLE = "solarcms_ingest"


def upgrade() -> None:
    op.execute(f"GRANT UPDATE ON mqtt_raw TO {INGEST_ROLE}")


def downgrade() -> None:
    op.execute(f"REVOKE UPDATE ON mqtt_raw FROM {INGEST_ROLE}")
