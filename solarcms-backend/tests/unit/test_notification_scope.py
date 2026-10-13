"""Who may be emailed about which Alarms (domain/notification_scope.py)."""

from __future__ import annotations

from solarcms.domain.notification_scope import (
    Recipient,
    refusal,
    severities_received,
)

ADMIN = Recipient(is_member=True, is_active=True, role_code="admin", plant_ids=(),
                  name="Asha")
EMPLOYEE = Recipient(is_member=True, is_active=True, role_code="employee",
                     plant_ids=(7,), name="Ravi")


def test_medium_means_medium_high_and_critical() -> None:
    assert severities_received("medium") == ("medium", "high", "critical")
    assert severities_received("critical") == ("critical",)
    assert severities_received("low") == ("low", "medium", "high", "critical")


def test_a_client_admin_may_be_emailed_about_every_plant_or_any_one() -> None:
    assert refusal(ADMIN, None) is None
    assert refusal(ADMIN, 99) is None


def test_an_employee_is_emailed_only_about_a_plant_they_can_see() -> None:
    assert refusal(EMPLOYEE, 7) is None
    reason = refusal(EMPLOYEE, 8)
    assert reason is not None and "cannot see that Plant" in reason


def test_an_employee_cannot_be_given_every_plant() -> None:
    # Client-wide would reach Plants outside their assignments.
    reason = refusal(EMPLOYEE, None)
    assert reason is not None and "Plants they cannot see" in reason


def test_zero_assignments_is_zero_plants_never_all() -> None:
    nobody = Recipient(is_member=True, is_active=True, role_code="employee",
                       plant_ids=())
    assert refusal(nobody, 7) is not None
    assert refusal(nobody, None) is not None


def test_someone_who_left_or_was_disabled_is_never_emailed() -> None:
    left = Recipient(is_member=False, is_active=True, role_code=None, plant_ids=())
    disabled = Recipient(is_member=True, is_active=False, role_code="admin",
                         plant_ids=())
    assert "not a member" in (refusal(left, None) or "")
    assert "disabled" in (refusal(disabled, None) or "")
