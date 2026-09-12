"""Users, Plant Assignments and dashboard access."""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import text

from solarcms.api.auth import hash_password
from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.schemas.identity import UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("")
async def list_users(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("user.manage")),
) -> list[dict[str, Any]]:
    """Users of the caller's Client only — reached through `memberships`, which
    is Client-scoped by RLS. `users` itself is not, because one person may belong
    to several Clients."""
    rows = (await session.execute(text("""
        SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at,
               r.code AS role_code,
               (SELECT count(*) FROM user_plant_access upa
                 WHERE upa.membership_id = m.id) AS assigned_plants
          FROM memberships m
          JOIN users u ON u.id = m.user_id
          JOIN roles r ON r.id = m.role_id
         ORDER BY u.email
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_user(
    email: str, password: str, full_name: str, role_code: str, session: SessionDep,
    user: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    if user.client_id is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "a Client context is required to create a User")
    if role_code not in ("admin", "employee", "guest"):
        # Deliberately excludes super_admin: a Client Admin must not be able to
        # mint a platform administrator.
        raise HTTPException(status.HTTP_403_FORBIDDEN,
                            "role must be admin, employee or guest")

    row = (await session.execute(text("""
        INSERT INTO users (email, password_hash, full_name)
        VALUES (:email, :password_hash, :full_name)
        ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
        RETURNING id, email, full_name
    """), {"email": email, "password_hash": hash_password(password),
           "full_name": full_name})).first()
    assert row is not None

    await session.execute(text("""
        INSERT INTO memberships (user_id, client_id, role_id)
        SELECT :user_id, :client_id, id FROM roles WHERE code = :role_code
        ON CONFLICT (user_id, client_id) DO UPDATE SET role_id = EXCLUDED.role_id
    """), {"user_id": row.id, "client_id": user.client_id, "role_code": role_code})

    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, actor_email, action, entity_type,
                               entity_id)
        VALUES (:client_id, :actor, :email, 'user.create', 'users', :entity_id)
    """), {"client_id": user.client_id, "actor": user.user_id, "email": email,
           "entity_id": row.id})
    # An Employee starts with zero Plant Assignments and therefore sees zero
    # Plants (I-5). That is deliberate: access is granted explicitly, never by
    # default.
    return {**dict(row._mapping), "role": role_code, "assigned_plants": 0}


@router.put("/{user_id}/plants")
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


@router.put("/{user_id}/dashboards")
async def set_dashboard_access(
    user_id: int, dashboard_codes: list[str], session: SessionDep,
    actor: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    """Replace a User's dashboard access (dimension A-3)."""
    membership = (await session.execute(text("""
        SELECT id FROM memberships WHERE user_id = :user_id AND client_id = :client_id
    """), {"user_id": user_id, "client_id": actor.client_id})).first()
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user is not a member")

    await session.execute(
        text("DELETE FROM user_dashboard_access WHERE membership_id = :m"),
        {"m": membership.id})
    for code in dashboard_codes:
        await session.execute(text("""
            INSERT INTO user_dashboard_access (membership_id, dashboard_id)
            SELECT :m, id FROM dashboards WHERE code = :code ON CONFLICT DO NOTHING
        """), {"m": membership.id, "code": code})
    # Access changes are the audit trail's whole purpose: "who could see what,
    # and since when" is unanswerable otherwise.
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :actor, 'user.dashboards.set', 'users', :user_id,
                CAST(:after AS jsonb))
    """), {"client_id": actor.client_id, "actor": actor.user_id, "user_id": user_id,
           "after": json.dumps({"dashboards": dashboard_codes})})
    return {"user_id": user_id, "dashboards": dashboard_codes}


@router.patch("/{user_id}")
async def update_user(
    user_id: int, body: UserUpdate, session: SessionDep,
    actor: CurrentUser = Depends(require_permission("user.manage")),
) -> dict[str, Any]:
    """Update a User within the caller's Client.

    Reached through `memberships`, which is Client-scoped by RLS — so a User who
    is not a member of the caller's Client is a 404 here regardless of whether
    they exist elsewhere. `users` itself is not Client-scoped, because one person
    may legitimately belong to several Clients.
    """
    membership = (await session.execute(text("""
        SELECT m.id, m.role_id FROM memberships m
         WHERE m.user_id = :user_id AND m.client_id = :client_id
    """), {"user_id": user_id, "client_id": actor.client_id})).first()
    if membership is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user is not a member")

    if body.role_code is not None:
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
           "after": json.dumps({"role": body.role_code, "is_active": body.is_active})})
    return {**dict(row._mapping), "role": body.role_code}


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
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
