"""Digital Input rule operators, and status Tags exempt from throttling.

The client's signal schedule (docs/TAG_CATALOGUE.md, 10 Sep 2026) showed that
`VCB` and `TRANSFORMER` publish **no analogue value at all** — only Digital Input
contacts. Two consequences the original schema could not express:

* An Alarm Rule needs `is_true` / `is_false`, which carry no threshold. The old
  operator CHECK rejected them.
* A status Tag must never be throttled. `min_interval_s = 60` on a trip contact
  discards an event that opened and re-closed inside the window, which is the
  single most important thing the Device will ever report.

Revision ID: 0009
Revises: 0008
"""

from __future__ import annotations

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE alarm_rules DROP CONSTRAINT ck_alarm_rules_rule_operator")
    op.execute("""
        ALTER TABLE alarm_rules ADD CONSTRAINT ck_alarm_rules_rule_operator
            CHECK (operator IN
                ('gt','lt','outside','inside','eq','is_true','is_false','special'))
    """)
    # A state rule with a threshold is a contradiction: there is nothing to
    # compare it against, and a stray value would silently mislead whoever reads
    # the rule next.
    op.execute("""
        ALTER TABLE alarm_rules ADD CONSTRAINT ck_alarm_rules_state_rule_has_no_threshold
            CHECK (operator NOT IN ('is_true','is_false')
                   OR (threshold IS NULL AND threshold_high IS NULL
                       AND clear_threshold IS NULL))
    """)
    op.execute("COMMENT ON COLUMN alarm_rules.operator IS "
               "'is_true/is_false carry no threshold. They exist because the client VCB "
               "and Transformer publish only Digital Input contacts, with no analogue "
               "value to compare (TAG_CATALOGUE 5.2, OPEN-18).'")

    # Guardrail 11, enforced rather than remembered.
    op.execute("""
        ALTER TABLE tags ADD CONSTRAINT ck_tags_status_tags_are_not_throttled
            CHECK (category <> 'status' OR min_interval_s = 0)
    """)
    op.execute("COMMENT ON COLUMN tags.min_interval_s IS "
               "'Write throttle. Must be 0 for category=status: a Digital Input is alarmed "
               "on change of state, and a periodic sample would miss a trip contact that "
               "opened and re-closed inside the window.'")
    # Any status Tag already seeded at the old default is corrected here rather
    # than left to violate the constraint.
    op.execute("UPDATE tags SET min_interval_s = 0 WHERE category = 'status'")


def downgrade() -> None:
    # Rules using the operators this migration introduced cannot survive the
    # narrower constraint being restored, and there is no sensible conversion: a
    # DI state rule has no threshold to fall back to. They are deleted, and any
    # Alarms raised by them go with them via ON DELETE CASCADE. Re-running the
    # seeder after a re-upgrade restores them.
    op.execute("DELETE FROM alarm_rules WHERE operator IN ('is_true', 'is_false')")

    op.execute("ALTER TABLE tags DROP CONSTRAINT ck_tags_status_tags_are_not_throttled")
    op.execute("ALTER TABLE alarm_rules "
               "DROP CONSTRAINT ck_alarm_rules_state_rule_has_no_threshold")
    op.execute("ALTER TABLE alarm_rules DROP CONSTRAINT ck_alarm_rules_rule_operator")
    op.execute("""
        ALTER TABLE alarm_rules ADD CONSTRAINT ck_alarm_rules_rule_operator
            CHECK (operator IN ('gt','lt','outside','inside','eq','special'))
    """)
