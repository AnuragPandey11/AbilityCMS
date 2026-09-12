"""Clients. Super Admin only."""

from __future__ import annotations

import json
from datetime import date, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
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
           })})
    return dict(row._mapping)


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
    row = (await session.execute(text("""
        UPDATE clients
           SET name = coalesce(:name, name),
               status = coalesce(:status, status),
               is_demo = coalesce(:is_demo, is_demo),
               client_number = coalesce(:client_number, client_number),
               gst_number = coalesce(:gst_number, gst_number),
               contact_email = coalesce(:contact_email, contact_email),
               contract_start_date = coalesce(CAST(:contract_start_date AS date),
                                              contract_start_date),
               contract_valid_till = coalesce(CAST(:contract_valid_till AS date),
                                              contract_valid_till)
         WHERE id = :id
        RETURNING id, code, name, status, is_demo, client_number, gst_number,
                  contact_email, contract_start_date, contract_valid_till
    """), {"id": client_id, "name": body.name, "status": body.status,
           "is_demo": body.is_demo, "client_number": body.client_number,
           "gst_number": body.gst_number, "contact_email": body.contact_email,
           "contract_start_date": body.contract_start_date,
           "contract_valid_till": body.contract_valid_till})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "client not found")
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (:id, :user_id, 'client.update', 'clients', :id, CAST(:after AS jsonb))
    """), {"id": client_id, "user_id": user.user_id,
           "after": json.dumps(body.model_dump(exclude_none=True), default=str)})
    return dict(row._mapping)
