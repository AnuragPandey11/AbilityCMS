"""Users, Plant Assignments and dashboard access."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.api.auth import hash_password
from solarcms.api.deps import CurrentUser, SessionDep, require_page, require_permission
from solarcms.domain.access import USERS_PAGE, Tab, grant_refusal, offered
from solarcms.schemas.identity import UserUpdate

# Every route here is the Users page's, and needs it ticked (migration 0046) as
# well as `user.manage`. Listing Users also serves Alarm Emails.
router = APIRouter(prefix="/users", tags=["users"])
_USERS_PAGE = Depends(require_page(USERS_PAGE))


async def _catalogue(session: AsyncSession) -> dict[str, Tab]:
    rows = (await session.execute(text(
        "SELECT code, name, kind, permission FROM dashboards ORDER BY sort_order"))).all()
    return {r.code: Tab(r.code, r.name, r.kind, r.permission) for r in rows}


async def _role_permissions(session: AsyncSession, role_code: str) -> frozenset[str]:
    rows = (await session.execute(text("""
        SELECT p.code FROM role_permissions rp
          JOIN roles r ON r.id = rp.role_id
          JOIN permissions p ON p.id = rp.permission_id
         WHERE r.code = :role
    """), {"role": role_code})).all()
    return frozenset(r.code for r in rows)


async def _actor_tabs(session: AsyncSession, actor: CurrentUser) -> frozenset[str]:
    rows = (await session.execute(text("""
        SELECT d.code FROM user_dashboard_access uda
          JOIN memberships m ON m.id = uda.membership_id
          JOIN dashboards d  ON d.id = uda.dashboard_id
         WHERE m.user_id = :user_id AND m.client_id = :client_id
    """), {"user_id": actor.user_id, "client_id": actor.client_id})).all()
    return frozenset(r.code for r in rows)


async def _other_admins_with_users(
    session: AsyncSession, client_id: int, user_id: int,
) -> int:
    """Active Client Admins of the Client, other than this one, who can open Users."""
    return int((await session.execute(text("""
        SELECT count(*) FROM memberships m
          JOIN roles r ON r.id = m.role_id AND r.code = 'admin'
          JOIN users u ON u.id = m.user_id AND u.is_active
          JOIN user_dashboard_access uda ON uda.membership_id = m.id
          JOIN dashboards d ON d.id = uda.dashboard_id AND d.code = :users_page
         WHERE m.client_id = :client_id AND m.user_id <> :user_id
    """), {"client_id": client_id, "user_id": user_id, "users_page": USERS_PAGE})).scalar() or 0)


async def _check_grant(
    session: AsyncSession, actor: CurrentUser, *, client_id: int, user_id: int,
    role_code: str, codes: list[str],
) -> None:
    """Refuse tabs this actor may not give this User (`domain/access.grant_refusal`)."""
    refusal = grant_refusal(
        requested=codes,
        catalogue=await _catalogue(session),
        target_role=role_code,
        role_permissions=await _role_permissions(session, role_code),
        actor_is_platform_admin=actor.is_platform_admin,
        actor_tabs=await _actor_tabs(session, actor),
        other_admins_with_users=await _other_admins_with_users(session, client_id, user_id),
    )
    if refusal is not None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN if refusal.forbidden
            else status.HTTP_422_UNPROCESSABLE_ENTITY,
            refusal.reason)


async def _grant(session: AsyncSession, membership_id: int, codes: list[str]) -> None:
    await session.execute(
        text("DELETE FROM user_dashboard_access WHERE membership_id = :m"),
        {"m": membership_id})
    for code in codes:
        await session.execute(text("""
            INSERT INTO user_dashboard_access (membership_id, dashboard_id)
            SELECT :m, id FROM dashboards WHERE code = :code ON CONFLICT DO NOTHING
        """), {"m": membership_id, "code": code})


@router.get("/access-catalogue", dependencies=[_USERS_PAGE])
async def access_catalogue(
    session: SessionDep,
    actor: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    """Every tab, which a role can use, and which this caller may give.

    The checkboxes on the Users screen: every screen and each admin page, the
    ones a role cannot use (an admin page whose permission it lacks) offered
    disabled, and — for a Client Admin — only their own tabs givable, since a
    tick from them may never exceed what they hold.
    """
    catalogue = await _catalogue(session)
    roles = {}
    for code in ("admin", "employee", "guest"):
        roles[code] = offered(catalogue, await _role_permissions(session, code))
    return {
        "tabs": [{"code": t.code, "name": t.name, "kind": t.kind,
                  "permission": t.permission} for t in catalogue.values()],
        "offered_by_role": roles,
        # None: a platform administrator may give anything, to anyone.
        "givable": None if actor.is_platform_admin else sorted(await _actor_tabs(session, actor)),
        "sets_client_admin_tabs": actor.is_platform_admin,
    }


@router.get("", dependencies=[Depends(require_page(USERS_PAGE, "admin_alarm_emails"))])
async def list_users(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("user.manage")),
) -> list[dict[str, Any]]:
    """Users of the caller's Client only — reached through `memberships`, which
    is Client-scoped by RLS. `users` itself is not, because one person may belong
    to several Clients.

    Each row carries the Plants and dashboards the membership holds now, so the
    Access panel opens showing them ticked. Both PUTs replace the whole list,
    and a panel that opened blank turned "add one Plant" into "revoke the rest".
    """
    rows = (await session.execute(text("""
        SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at,
               r.code AS role_code,
               (SELECT count(*) FROM user_plant_access upa
                 WHERE upa.membership_id = m.id) AS assigned_plants,
               ARRAY(SELECT upa.plant_id FROM user_plant_access upa
                      WHERE upa.membership_id = m.id
                      ORDER BY upa.plant_id) AS plant_ids,
               ARRAY(SELECT d.code FROM user_dashboard_access uda
                       JOIN dashboards d ON d.id = uda.dashboard_id
                      WHERE uda.membership_id = m.id
                      ORDER BY d.sort_order) AS dashboards
          FROM memberships m
          JOIN users u ON u.id = m.user_id
          JOIN roles r ON r.id = m.role_id
         ORDER BY u.email
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.post("", status_code=status.HTTP_201_CREATED, dependencies=[_USERS_PAGE])
async def create_user(
    email: str, password: str, full_name: str, role_code: str, session: SessionDep,
    client_id: int | None = None,
    dashboard_codes: list[str] | None = Body(default=None, embed=True),
    user: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    """Create a User in a Client.

    A **Client Admin** creates in their own Client and `client_id` is ignored, not
    validated, so they cannot file a User under another Client. A **platform
    administrator** belongs to no Client and must name one, as `POST /plants`
    does, rather than switch the whole session into it first.
    """
    if user.is_platform_admin and user.client_id is None:
        if client_id is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                "choose the Client this User belongs to. A platform administrator "
                "is a member of no Client, so it cannot be inferred.")
        owner = (await session.execute(
            text("SELECT id FROM clients WHERE id = :id"), {"id": client_id})).first()
        if owner is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"no Client with id {client_id}")
        target_client_id = owner.id
    elif user.client_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "a Client context is required to create a User")
    else:
        target_client_id = user.client_id
    if role_code not in ("admin", "employee", "guest"):
        # Deliberately excludes super_admin: a Client Admin must not be able to
        # mint a platform administrator.
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "role must be admin, employee or guest")
    if role_code == "admin" and not user.is_platform_admin:
        # A Client Admin's tabs are the platform administrator's to set
        # (migration 0046), and one created with none could open nothing.
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "a Client Admin is created by the platform administrator, who sets the tabs "
            "they may open")
    codes = list(dict.fromkeys(dashboard_codes or []))
    await _check_grant(session, user, client_id=target_client_id, user_id=0,
                       role_code=role_code, codes=codes)

    row = (await session.execute(text("""
        INSERT INTO users (email, password_hash, full_name)
        VALUES (:email, :password_hash, :full_name)
        ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
        RETURNING id, email, full_name
    """), {"email": email, "password_hash": hash_password(password),
           "full_name": full_name})).first()
    assert row is not None

    membership_id = (await session.execute(text("""
        INSERT INTO memberships (user_id, client_id, role_id)
        SELECT :user_id, :client_id, id FROM roles WHERE code = :role_code
        ON CONFLICT (user_id, client_id) DO UPDATE SET role_id = EXCLUDED.role_id
        RETURNING id
    """), {"user_id": row.id, "client_id": target_client_id, "role_code": role_code})).scalar_one()
    # The tabs ticked on the form, in the same transaction: a User created
    # without them opens to "no dashboards are assigned".
    await _grant(session, membership_id, codes)

    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, actor_email, action, entity_type,
                               entity_id, after)
        VALUES (:client_id, :actor, :email, 'user.create', 'users', :entity_id,
                CAST(:after AS jsonb))
    """), {"client_id": target_client_id, "actor": user.user_id, "email": email,
           "entity_id": row.id,
           "after": json.dumps({"role": role_code, "dashboards": codes})})
    # An Employee starts with zero Plant Assignments and therefore sees zero
    # Plants (I-5). That is deliberate: access is granted explicitly, never by
    # default.
    return {**dict(row._mapping), "role": role_code, "assigned_plants": 0,
            "dashboards": codes}


@router.put("/{user_id}/plants", dependencies=[_USERS_PAGE])
async def set_plant_access(
    user_id: int, plant_ids: list[int], session: SessionDep,
    actor: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    """Replace a User's Plant Assignments (dimension A-2)."""
    membership = (await session.execute(text("""
        SELECT id FROM memberships WHERE user_id = :user_id AND client_id = :client_id
    """), {"user_id": user_id, "client_id": actor.client_id})).first()
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user is not a member")

    await session.execute(
        text("DELETE FROM user_plant_access WHERE membership_id = :m"),
        {"m": membership.id})
    for plant_id in plant_ids:
        # RLS on `plants` means a plant_id the caller cannot see matches nothing,
        # so this silently grants only what they were entitled to grant (I-9's
        # sibling property for Plant Assignment).
        await session.execute(text("""
            INSERT INTO user_plant_access (membership_id, plant_id)
            SELECT :m, id FROM plants WHERE id = :plant_id
            ON CONFLICT DO NOTHING
        """), {"m": membership.id, "plant_id": plant_id})

    granted = (await session.execute(
        text("SELECT count(*) FROM user_plant_access WHERE membership_id = :m"),
        {"m": membership.id})).scalar()
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :actor, 'user.plants.set', 'users', :user_id, CAST(:after AS jsonb))
    """), {"client_id": actor.client_id, "actor": actor.user_id, "user_id": user_id,
           "after": f'{{"requested":{len(plant_ids)},"granted":{granted}}}'})
    return {"user_id": user_id, "requested": len(plant_ids), "granted": granted}


@router.put("/{user_id}/dashboards", dependencies=[_USERS_PAGE])
async def set_dashboard_access(
    user_id: int, dashboard_codes: list[str], session: SessionDep,
    actor: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    """Replace the tabs a User is given — screens and admin pages (A-3).

    Who may give what is `domain/access.grant_refusal`: a platform administrator
    anything; a Client Admin only to an Employee or Guest, and only tabs they
    have themselves; never an admin page the User's role cannot use.
    """
    membership = (await session.execute(text("""
        SELECT m.id, r.code AS role_code FROM memberships m
          JOIN roles r ON r.id = m.role_id
         WHERE m.user_id = :user_id AND m.client_id = :client_id
    """), {"user_id": user_id, "client_id": actor.client_id})).first()
    if membership is None or actor.client_id is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user is not a member")

    dashboard_codes = list(dict.fromkeys(dashboard_codes))
    await _check_grant(session, actor, client_id=actor.client_id, user_id=user_id,
                       role_code=membership.role_code, codes=dashboard_codes)
    await _grant(session, membership.id, dashboard_codes)
    # Access changes are the audit trail's whole purpose: "who could see what,
    # and since when" is unanswerable otherwise.
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :actor, 'user.dashboards.set', 'users', :user_id,
                CAST(:after AS jsonb))
    """), {"client_id": actor.client_id, "actor": actor.user_id, "user_id": user_id,
           "after": json.dumps({"dashboards": dashboard_codes})})
    return {"user_id": user_id, "dashboards": dashboard_codes}


@router.patch("/{user_id}", dependencies=[_USERS_PAGE])
async def update_user(
    user_id: int, body: UserUpdate, session: SessionDep,
    actor: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    """Update a User within the caller's Client.

    Reached through `memberships`, which is Client-scoped by RLS — so a User who
    is not a member of the caller's Client is a 404 here regardless of whether
    they exist elsewhere. `users` itself is not Client-scoped, because one person
    may legitimately belong to several Clients — so a password set here is that
    person's one password, for every Client they sign in to.

    A role change takes effect on the person's next request: `get_current_user`
    reads the role from the membership, never from the token.
    """
    membership = (await session.execute(text("""
        SELECT m.id, r.code AS role_code, u.platform_role
          FROM memberships m
          JOIN roles r ON r.id = m.role_id
          JOIN users u ON u.id = m.user_id
         WHERE m.user_id = :user_id AND m.client_id = :client_id
    """), {"user_id": user_id, "client_id": actor.client_id})).first()
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user is not a member")

    # A Client's administrator must not be able to take over a platform
    # administrator's account by resetting its password or disabling it.
    if membership.platform_role == "super_admin" and not actor.is_platform_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "a platform administrator's account is managed by the platform")

    role_changes = body.role_code is not None and body.role_code != membership.role_code
    if role_changes and user_id == actor.user_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "you cannot change your own role. Ask another administrator, so nobody "
            "demotes themselves by accident.")
    if role_changes and membership.role_code == "admin":
        # The last Client Admin leaving the role would leave nobody able to
        # manage the Client's Users, Plants or Alarm emails.
        other_admins = (await session.execute(text("""
            SELECT count(*) FROM memberships m
              JOIN roles r ON r.id = m.role_id
              JOIN users u ON u.id = m.user_id
             WHERE m.client_id = :client_id AND r.code = 'admin'
               AND m.user_id <> :user_id AND u.is_active
        """), {"client_id": actor.client_id, "user_id": user_id})).scalar()
        if not other_admins:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "this is the Client's only active Client Admin. Make someone else "
                "Client Admin first, so the Client is never left without one.")

    if role_changes:
        await session.execute(text("""
            UPDATE memberships SET role_id = (SELECT id FROM roles WHERE code = :code)
             WHERE id = :membership_id
        """), {"code": body.role_code, "membership_id": membership.id})

    row = (await session.execute(text("""
        UPDATE users
           SET full_name = coalesce(:full_name, full_name),
               is_active = coalesce(:is_active, is_active),
               password_hash = coalesce(:password_hash, password_hash)
         WHERE id = :id
        RETURNING id, email, full_name, is_active
    """), {
        "id": user_id, "full_name": body.full_name, "is_active": body.is_active,
        "password_hash": hash_password(body.password) if body.password else None,
    })).first()
    assert row is not None

    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :actor, 'user.update', 'users', :id, CAST(:after AS jsonb))
    """), {"client_id": actor.client_id, "actor": actor.user_id, "id": user_id,
           # Never the password itself, only that it was set.
           "after": json.dumps({"role": body.role_code, "is_active": body.is_active,
                                "full_name": body.full_name,
                                "password_changed": body.password is not None})})
    return {**dict(row._mapping), "role": body.role_code}


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT,
               dependencies=[_USERS_PAGE])
async def remove_user(
    user_id: int, session: SessionDep,
    actor: CurrentUser = Depends(require_permission("user.manage")),
) -> Response:
    """Remove a User from this Client.

    Deletes the **membership**, not the User row. A person may belong to several
    Clients, and deleting the User would revoke access everywhere on one Client
    admin's say-so. The `users` row is also referenced by `audit_log` and
    `alarms.acknowledged_by`, which must remain attributable after someone
    leaves — the audit trail is worthless if it can be emptied by removing staff.
    """
    if user_id == actor.user_id:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "you cannot remove your own membership")
    row = (await session.execute(text("""
        DELETE FROM memberships WHERE user_id = :user_id AND client_id = :client_id
        RETURNING id
    """), {"user_id": user_id, "client_id": actor.client_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user is not a member")
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id)
        VALUES (:client_id, :actor, 'user.membership.delete', 'users', :id)
    """), {"client_id": actor.client_id, "actor": actor.user_id, "id": user_id})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
