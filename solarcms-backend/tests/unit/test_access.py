"""Who may give which tabs to whom (`domain/access.py`). Plain values only."""

from __future__ import annotations

from solarcms.domain.access import Tab, grant_refusal, offered

CATALOGUE = {
    "single_plant": Tab("single_plant", "Single Plant", "screen", None),
    "alarms": Tab("alarms", "Alarms", "screen", None),
    "admin_bindings": Tab("admin_bindings", "Tag Mapping", "admin", "config.modify"),
    "admin_users": Tab("admin_users", "Users", "admin", "user.manage"),
}
ADMIN = {"dashboard.view", "config.modify", "user.manage", "plant.manage"}
EMPLOYEE = {"dashboard.view", "alarm.acknowledge"}


def refusal(**kw: object):  # type: ignore[no-untyped-def]
    base: dict[str, object] = {
        "requested": [], "catalogue": CATALOGUE, "target_role": "employee",
        "role_permissions": EMPLOYEE, "actor_is_platform_admin": True,
        "actor_tabs": set(), "other_admins_with_users": 1,
    }
    base.update(kw)
    return grant_refusal(**base)  # type: ignore[arg-type]


def test_a_platform_administrator_gives_a_client_admin_any_tab_the_role_can_use() -> None:
    assert refusal(requested=["single_plant", "admin_bindings", "admin_users"],
                   target_role="admin", role_permissions=ADMIN) is None


def test_an_admin_page_the_role_cannot_use_is_refused_not_stored() -> None:
    result = refusal(requested=["admin_bindings"])
    assert result is not None and not result.forbidden
    assert "Tag Mapping" in result.reason


def test_an_unknown_tab_is_refused() -> None:
    result = refusal(requested=["nowhere"])
    assert result is not None and "nowhere" in result.reason


def test_a_client_admin_gives_only_tabs_they_have() -> None:
    assert refusal(requested=["single_plant"], actor_is_platform_admin=False,
                   actor_tabs={"single_plant"}) is None
    result = refusal(requested=["single_plant", "alarms"], actor_is_platform_admin=False,
                     actor_tabs={"single_plant"})
    assert result is not None and result.forbidden and "Alarms" in result.reason


def test_a_client_admin_never_sets_a_client_admins_tabs() -> None:
    result = refusal(requested=["single_plant"], target_role="admin", role_permissions=ADMIN,
                     actor_is_platform_admin=False, actor_tabs=set(CATALOGUE))
    assert result is not None and result.forbidden


def test_a_client_admin_keeps_at_least_one_tab() -> None:
    result = refusal(requested=[], target_role="admin", role_permissions=ADMIN)
    assert result is not None and "at least one" in result.reason


def test_the_last_client_admin_who_can_open_users_keeps_it() -> None:
    result = refusal(requested=["single_plant"], target_role="admin", role_permissions=ADMIN,
                     other_admins_with_users=0)
    assert result is not None and "Users" in result.reason
    assert refusal(requested=["single_plant"], target_role="admin", role_permissions=ADMIN,
                   other_admins_with_users=1) is None


def test_an_employee_may_be_given_nothing() -> None:
    assert refusal(requested=[]) is None


def test_offered_is_every_screen_and_the_admin_pages_a_role_can_use() -> None:
    assert offered(CATALOGUE, EMPLOYEE) == ["single_plant", "alarms"]
    assert offered(CATALOGUE, ADMIN) == list(CATALOGUE)
