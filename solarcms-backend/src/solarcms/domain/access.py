"""Who may give which tabs to whom — dimension A-3 (the user's decision, 1 Nov 2026).

A tab is a screen (`kind = 'screen'`) or an admin page (`kind = 'admin'`,
migration 0046). Every User but a platform administrator sees exactly the tabs
ticked for them, a Client Admin included; an admin page also needs its role
permission, because a tick never grants one.

The rules for changing what a User is given:

* **A platform administrator** may give anyone in a Client any tab.
* **A Client Admin** may give an Employee or a Guest only tabs they have
  themselves, and may not change any Client Admin's tabs, their own included —
  those are the platform administrator's to set.
* **An admin page is refused for a role that cannot use it**, rather than
  stored as a tick that does nothing.
* **A Client is never left without a way in**: a Client Admin keeps at least
  one tab, and the Client's last active Client Admin keeps Users — otherwise
  nobody could give anybody anything.

Pure (Guardrail 9): the router reads the facts, this decides.
"""

from __future__ import annotations

from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass

ROLE_WORDS: Mapping[str, str] = {
    "admin": "Client Admin",
    "employee": "Client Employee",
    "guest": "Guest",
}

USERS_PAGE = "admin_users"


@dataclass(frozen=True, slots=True)
class Refusal:
    """Why not: `forbidden` when it is not this person's to give, else the request is wrong."""

    reason: str
    forbidden: bool = False


@dataclass(frozen=True, slots=True)
class Tab:
    code: str
    name: str
    kind: str
    permission: str | None


def grant_refusal(
    *,
    requested: Sequence[str],
    catalogue: Mapping[str, Tab],
    target_role: str,
    role_permissions: Collection[str],
    actor_is_platform_admin: bool,
    actor_tabs: Collection[str],
    other_admins_with_users: int,
) -> Refusal | None:
    """Why these tabs may not be given to this User, or None if they may."""
    role = ROLE_WORDS.get(target_role, target_role)
    unknown = sorted(code for code in set(requested) if code not in catalogue)
    if unknown:
        return Refusal(f"there is no tab called {', '.join(unknown)}")
    unusable = sorted(
        catalogue[code].name for code in set(requested)
        if catalogue[code].kind == "admin"
        and catalogue[code].permission not in role_permissions
    )
    if unusable:
        return Refusal(f"a {role} cannot use {', '.join(unusable)} — the role does not "
                       "hold the permission that page needs, so a tick would do nothing")
    if not actor_is_platform_admin:
        if target_role == "admin":
            return Refusal("a Client Admin's tabs are set by the platform administrator, "
                           "not by another Client Admin", forbidden=True)
        beyond = sorted(catalogue[code].name for code in set(requested)
                        if code not in actor_tabs)
        if beyond:
            return Refusal(f"you can give only tabs you have yourself, not {', '.join(beyond)}",
                           forbidden=True)
    if target_role == "admin":
        if not requested:
            return Refusal("a Client Admin needs at least one tab, or they could open nothing")
        if USERS_PAGE not in requested and other_admins_with_users == 0:
            return Refusal("this is the Client's only active Client Admin who can open Users. "
                           "Keep Users ticked, or give it to another Client Admin first, so "
                           "somebody can always give access")
    return None


def offered(catalogue: Mapping[str, Tab], role_permissions: Collection[str]) -> list[str]:
    """The tabs a role can use: every screen, and each admin page it holds the permission for."""
    return [
        code for code, tab in catalogue.items()
        if tab.kind == "screen" or tab.permission in role_permissions
    ]
