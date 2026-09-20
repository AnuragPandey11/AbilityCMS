"""Clients. Super Admin only."""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.api.patching import patch_assignments
from solarcms.schemas.identity import ClientCreate, ClientUpdate

router = APIRouter(prefix="/clients", tags=["clients"])


@router.get("")
async def list_clients(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("system.admin")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT id, code, name, status, is_demo, created_at,
               client_number, gst_number, contact_email,
               contract_start_date, contract_valid_till
          FROM clients ORDER BY code
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_client(
    body: ClientCreate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Create a Client in `onboarding` (MASTER §6.5).

    `is_demo` gates Guest access: I-6 permits a Guest only on a demonstration
    Client, enforced by the clients_visibility policy rather than by this route.

    The commercial fields are ⚠ PROPOSED (migration 0019) and all optional — a
    Client is still creatable from a code and a name alone.

    ⚠ The contract duration is resolved to a date *here*, once. The form asks
    "valid for N days" because that is how the contract reads, but storing the
    count would leave every caller to recompute the expiry against created_at,
    and the answer would change with every passing day.
    """
    existing = (await session.execute(
        text("SELECT id FROM clients WHERE code = :code"), {"code": body.code})).first()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "client code already exists")

    # Checked here as well as by the partial unique index, so a re-used account
    # number comes back as a 409 naming the field rather than as a 500 from an
    # IntegrityError. The index remains the authority — this check races, and
    # losing that race is still correct behaviour, just an uglier error.
    if body.client_number is not None:
        clash = (await session.execute(
            text("SELECT code FROM clients WHERE client_number = :n"),
            {"n": body.client_number})).first()
        if clash is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"client number {body.client_number!r} is already used "
                f"by Client {clash.code!r}")

    # A duration with no start date means "from today" — the common case, since
    # a Client is usually registered on the day its contract begins.
    start = body.contract_start_date
    valid_till: date | None = None
    if body.contract_valid_days is not None:
        start = start or date.today()
        valid_till = start + timedelta(days=body.contract_valid_days)

    row = (await session.execute(text("""
        INSERT INTO clients (code, name, status, is_demo, client_number, gst_number,
                             contact_email, contract_start_date, contract_valid_till)
        VALUES (:code, :name, 'onboarding', :is_demo, :client_number, :gst_number,
                :contact_email, :contract_start_date, :contract_valid_till)
        RETURNING id, code, name, status, is_demo, client_number, gst_number,
                  contact_email, contract_start_date, contract_valid_till
    """), {
        "code": body.code, "name": body.name, "is_demo": body.is_demo,
        "client_number": body.client_number, "gst_number": body.gst_number,
        "contact_email": body.contact_email,
        "contract_start_date": start, "contract_valid_till": valid_till,
    })).first()
    assert row is not None

    # ── The Client's first User, in the same transaction ────────────────────
    # Not a follow-up call. A Client that exists with nobody able to sign into
    # it looks complete on every screen, and only the person who created it
    # knows a second step is outstanding. If this fails, the Client is rolled
    # back with it — one object, created once, or not at all.
    created_user: dict[str, Any] | None = None
    if body.first_user is not None:
        from solarcms.api.auth import hash_password

        taken = (await session.execute(
            text("SELECT id FROM users WHERE email = :email"),
            {"email": body.first_user.email})).first()
        if taken is not None:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"a User with the email {body.first_user.email!r} already "
                f"exists. Add them to this Client from the Users screen "
                f"instead of creating a second account for the same person.")

        role_id = (await session.execute(
            text("SELECT id FROM roles WHERE code = :code"),
            {"code": body.first_user.role_code})).scalar()
        if role_id is None:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_ENTITY,
                f"unknown role {body.first_user.role_code!r}; run the seed")

        user_id = (await session.execute(text("""
            INSERT INTO users (email, password_hash, full_name, platform_role)
            VALUES (:email, :password_hash, :full_name, 'none')
            RETURNING id
        """), {
            "email": body.first_user.email,
            "password_hash": hash_password(body.first_user.password),
            "full_name": body.first_user.full_name or body.first_user.email.split("@")[0],
        })).scalar()

        membership_id = (await session.execute(text("""
            INSERT INTO memberships (user_id, client_id, role_id)
            VALUES (:user_id, :client_id, :role_id) RETURNING id
        """), {"user_id": user_id, "client_id": row.id, "role_id": role_id})).scalar()

        # Every dashboard, so the first sign-in is not an empty shell. Plant
        # access is deliberately NOT granted here and does not need to be: an
        # `admin` is allowed every Plant of their own Client by
        # `app_can_see_plant`, so Plants created later are visible without
        # anyone remembering to come back. For a non-admin first User the
        # assignment stays empty, and Guardrail 7 means that is zero Plants —
        # which is the correct, conservative default.
        await session.execute(text("""
            INSERT INTO user_dashboard_access (membership_id, dashboard_id)
            SELECT :membership_id, d.id FROM dashboards d
            ON CONFLICT DO NOTHING
        """), {"membership_id": membership_id})

        created_user = {
            "id": user_id, "email": body.first_user.email,
            "role_code": body.first_user.role_code,
        }

    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:client_id, :user_id, 'client.create', 'clients', :client_id,
                CAST(:after AS jsonb))
    """), {"client_id": row.id, "user_id": user.user_id,
           "after": json.dumps({
               "code": body.code, "name": body.name, "is_demo": body.is_demo,
               "client_number": body.client_number, "gst_number": body.gst_number,
               "contact_email": body.contact_email,
               "contract_start_date": str(start) if start else None,
               "contract_valid_till": str(valid_till) if valid_till else None,
               "first_user": created_user["email"] if created_user else None,
           })})
    # The password is never echoed back, not even the one just supplied.
    return {**dict(row._mapping), "first_user": created_user}


@router.patch("/{client_id}")
async def update_client(
    client_id: int, body: ClientUpdate, session: SessionDep,
    user: CurrentUser = Depends(require_permission("system.admin")),
) -> dict[str, Any]:
    """Update a Client. Super Admin only.

    ⚠ `is_demo` is an access-control switch, not a label: I-6 permits a Guest
    only on a demonstration Client, and the `clients_visibility` policy reads this
    column. Clearing it on a Client that has Guests revokes their access, which is
    the intended direction; setting it on a real Client would expose generation
    and financial data to any Guest attached to it.
    """
    # ⚠ Built from the fields the request actually carried, not from which of
    # them are non-null. `coalesce(:gst, gst_number)` made clearing a GST number
    # impossible: the field emptied on screen, the request was accepted, and the
    # old value was still there on the next read.
    sets, params = patch_assignments(
        body,
        {"name": "name", "status": "status", "is_demo": "is_demo",
         "client_number": "client_number", "gst_number": "gst_number",
         "contact_email": "contact_email",
         "contract_start_date": "contract_start_date",
         "contract_valid_till": "contract_valid_till"},
        casts={"contract_start_date": "date", "contract_valid_till": "date"},
    )
    returning = ("id, code, name, status, is_demo, client_number, gst_number, "
                 "contact_email, contract_start_date, contract_valid_till")
    if not sets:
        # A PATCH that changes nothing is not an error; it reads the Client back.
        row = (await session.execute(
            text(f"SELECT {returning} FROM clients WHERE id = :id"),
            {"id": client_id})).first()
    else:
        row = (await session.execute(
            text(f"UPDATE clients SET {', '.join(sets)} "
                 f"WHERE id = :id RETURNING {returning}"),
            {"id": client_id, **params})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "client not found")
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:id, :user_id, 'client.update', 'clients', :id, CAST(:after AS jsonb))
    """), {"id": client_id, "user_id": user.user_id,
           "after": json.dumps(
               # exclude_unset, not exclude_none: a field cleared to null is
               # a change worth auditing, and dropping it would record the
               # opposite of what happened.
               body.model_dump(exclude_unset=True), default=str)})
    return dict(row._mapping)
