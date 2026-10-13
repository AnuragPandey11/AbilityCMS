"""Alarm email subscriptions: who is emailed about which Alarms.

The table has existed since 0006 and the sender since the alarm worker was
built; what was missing was any way to manage it short of a database
administrator inserting rows by hand. A subscription names a User of the
Client, a Plant or every Plant, and the lowest severity they want — `medium`
means medium, high and critical.

⚠ Nobody may be subscribed to a Plant they cannot see (`domain/notification_scope`),
and the sender checks the same rule again at sending time, because access
changes after a subscription is made. The list therefore reports, per row,
whether it would be sent *now* and, if not, why — a subscription that silently
emails nobody is exactly the failure this screen exists to end.

Email is the only channel offered: Users have no phone number on record and
no WhatsApp or SMS provider is chosen (MASTER §8.2).
"""

from __future__ import annotations

import json
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.api.patching import patch_assignments
from solarcms.config import get_settings
from solarcms.domain.notification_scope import (
    SEVERITIES,
    Recipient,
    refusal,
    sees_every_plant,
    severities_received,
)
from solarcms.schemas.alarming import (
    NotificationSubscriptionCreate,
    NotificationSubscriptionUpdate,
)
from solarcms.services.notifications import queue_notification

router = APIRouter(prefix="/notification-subscriptions", tags=["notifications"])

_MANAGE = require_permission("user.manage")


async def _audit(
    session: Any, user: CurrentUser, client_id: int, action: str, entity_id: int,
    *, before: dict[str, Any] | None = None, after: dict[str, Any] | None = None,
) -> None:
    """In the same transaction as the change, filed under the subscription's Client."""
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id,
                               before, after)
        VALUES (:client_id, :user_id, :action, 'notification_subscriptions', :entity_id,
                CAST(:before AS jsonb), CAST(:after AS jsonb))
    """), {
        "client_id": client_id, "user_id": user.user_id, "action": action,
        "entity_id": entity_id,
        "before": json.dumps(before, default=str) if before else None,
        "after": json.dumps(after, default=str) if after else None,
    })


async def _client_id(session: Any, user: CurrentUser, requested: int | None) -> int:
    """The Client being managed.

    A Client Admin manages their own, and `requested` is ignored rather than
    validated, so it cannot reach another. A platform administrator belongs to
    no Client and names one, as `POST /users` and `POST /plants` require.
    """
    if user.is_platform_admin and requested is not None:
        found = (await session.execute(
            text("SELECT id FROM clients WHERE id = :id"), {"id": requested})).first()
        if found is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"no Client with id {requested}")
        return int(found.id)
    if user.client_id is not None:
        return user.client_id
    raise HTTPException(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        "choose the Client. A platform administrator is a member of no Client, "
        "so it cannot be inferred.")


async def _members(session: Any, client_id: int) -> dict[int, dict[str, Any]]:
    """Every member of the Client, with the Plants each may see."""
    rows = (await session.execute(text("""
        SELECT u.id AS user_id, u.email, u.full_name, u.is_active,
               r.code AS role_code, m.id AS membership_id
          FROM memberships m
          JOIN users u ON u.id = m.user_id
          JOIN roles r ON r.id = m.role_id
         WHERE m.client_id = :client_id
         ORDER BY u.email
    """), {"client_id": client_id})).all()
    assigned: dict[int, list[int]] = defaultdict(list)
    if rows:
        for row in (await session.execute(text("""
            SELECT membership_id, plant_id FROM user_plant_access
             WHERE membership_id = ANY(:ids)
        """), {"ids": [r.membership_id for r in rows]})).all():
            assigned[row.membership_id].append(row.plant_id)
    return {
        row.user_id: {
            "user_id": row.user_id, "email": row.email, "full_name": row.full_name,
            "is_active": row.is_active, "role_code": row.role_code,
            "plant_ids": sorted(assigned[row.membership_id]),
        }
        for row in rows
    }


def _recipient(member: dict[str, Any] | None, fallback_name: str) -> Recipient:
    if member is None:
        return Recipient(is_member=False, is_active=False, role_code=None,
                         plant_ids=(), name=fallback_name)
    return Recipient(
        is_member=True, is_active=bool(member["is_active"]),
        role_code=member["role_code"], plant_ids=member["plant_ids"],
        name=member["full_name"] or member["email"],
    )


def _channels() -> list[dict[str, Any]]:
    email_ready = bool(get_settings().smtp_url)
    return [
        {"code": "email", "label": "Email", "available": True, "configured": email_ready,
         "reason": None if email_ready else
         "No email server is configured on this server, so nothing will be sent "
         "until SMTP_URL is set."},
        {"code": "whatsapp", "label": "WhatsApp", "available": False, "configured": False,
         "reason": "Users have no phone number on record, and no WhatsApp provider "
                   "is chosen yet."},
        {"code": "sms", "label": "SMS", "available": False, "configured": False,
         "reason": "Users have no phone number on record, and no SMS provider is "
                   "chosen yet."},
    ]


@router.get("/options")
async def subscription_options(
    session: SessionDep, client_id: int | None = None,
    user: CurrentUser = Depends(_MANAGE),
) -> dict[str, Any]:
    """What a subscription can be made of: members, Plants, channels, severities."""
    target = await _client_id(session, user, client_id)
    members = await _members(session, target)
    plants = (await session.execute(text("""
        SELECT id, code, name FROM plants WHERE client_id = :client_id ORDER BY code
    """), {"client_id": target})).all()
    return {
        "client_id": target,
        "members": [
            {**m, "sees_every_plant": sees_every_plant(_recipient(m, m["email"]))}
            for m in members.values()
        ],
        "plants": [dict(p._mapping) for p in plants],
        "channels": _channels(),
        "severities": [
            {"code": s, "receives": list(severities_received(s))} for s in SEVERITIES
        ],
    }


@router.get("")
async def list_subscriptions(
    session: SessionDep, client_id: int | None = None,
    user: CurrentUser = Depends(_MANAGE),
) -> list[dict[str, Any]]:
    """The Client's subscriptions, each with whether it is sent now and its last email."""
    target = await _client_id(session, user, client_id)
    members = await _members(session, target)
    rows = (await session.execute(text("""
        SELECT s.id, s.client_id, s.user_id, u.email, u.full_name,
               s.plant_id, p.code AS plant_code, p.name AS plant_name,
               s.channel, s.min_severity, s.enabled
          FROM notification_subscriptions s
          JOIN users u ON u.id = s.user_id
          LEFT JOIN plants p ON p.id = s.plant_id
         WHERE s.client_id = :client_id
         ORDER BY u.email, p.code NULLS FIRST, s.id
    """), {"client_id": target})).all()
    last: dict[tuple[int, str], dict[str, Any]] = {}
    if rows:
        for row in (await session.execute(text("""
            SELECT DISTINCT ON (recipient_user_id, channel)
                   recipient_user_id, channel, delivery_status, failure_reason,
                   subject, coalesce(sent_at, queued_at) AS at
              FROM notification_log
             WHERE client_id = :client_id AND recipient_user_id = ANY(:ids)
             ORDER BY recipient_user_id, channel, id DESC
        """), {"client_id": target, "ids": sorted({r.user_id for r in rows})})).all():
            last[(row.recipient_user_id, row.channel)] = {
                "status": row.delivery_status, "at": row.at, "subject": row.subject,
                "failure_reason": row.failure_reason,
            }
    out: list[dict[str, Any]] = []
    for row in rows:
        member = members.get(row.user_id)
        reason = refusal(_recipient(member, row.full_name or row.email), row.plant_id)
        if reason is None and not row.enabled:
            reason = "Paused."
        out.append({
            **dict(row._mapping),
            "role_code": member["role_code"] if member else None,
            "receives": list(severities_received(row.min_severity)),
            "sending": reason is None,
            "not_sent_reason": reason,
            "last_notification": last.get((row.user_id, row.channel)),
        })
    return out


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_subscription(
    body: NotificationSubscriptionCreate, session: SessionDep,
    user: CurrentUser = Depends(_MANAGE),
) -> dict[str, Any]:
    """Subscribe a member of the Client. Refused, with the reason, if they could
    not see what they would be emailed about."""
    target = await _client_id(session, user, body.client_id)
    members = await _members(session, target)
    member = members.get(body.user_id)
    if member is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                            "that User is not a member of this Client")
    if body.plant_id is not None:
        plant = (await session.execute(text(
            "SELECT id FROM plants WHERE id = :id AND client_id = :client_id"
        ), {"id": body.plant_id, "client_id": target})).first()
        if plant is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                "that Plant does not belong to this Client")
    reason = refusal(_recipient(member, member["email"]), body.plant_id)
    if reason is not None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, reason)

    existing = (await session.execute(text("""
        SELECT id FROM notification_subscriptions
         WHERE client_id = :client_id AND user_id = :user_id AND channel = :channel
           AND plant_id IS NOT DISTINCT FROM CAST(:plant_id AS bigint)
    """), {"client_id": target, "user_id": body.user_id, "channel": body.channel,
           "plant_id": body.plant_id})).first()
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "that User is already subscribed for this Plant; change its severity "
            "instead of adding a second one, which would email them twice")

    row = (await session.execute(text("""
        INSERT INTO notification_subscriptions (client_id, user_id, plant_id, channel,
                                                min_severity)
        VALUES (:client_id, :user_id, :plant_id, :channel, :min_severity)
        RETURNING id, client_id, user_id, plant_id, channel, min_severity, enabled
    """), {"client_id": target, "user_id": body.user_id, "plant_id": body.plant_id,
           "channel": body.channel, "min_severity": body.min_severity})).first()
    assert row is not None
    created = dict(row._mapping)
    await _audit(session, user, target, "notification_subscription.create", row.id,
                 after={**created, "email": member["email"]})
    return created


@router.patch("/{subscription_id}")
async def update_subscription(
    subscription_id: int, body: NotificationSubscriptionUpdate, session: SessionDep,
    user: CurrentUser = Depends(_MANAGE),
) -> dict[str, Any]:
    """Change the severity, or pause and resume. RLS confines it to the caller's
    Client, so another Client's subscription is a 404."""
    before = (await session.execute(text("""
        SELECT id, client_id, user_id, plant_id, channel, min_severity, enabled
          FROM notification_subscriptions WHERE id = :id
    """), {"id": subscription_id})).first()
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "subscription not found")
    for field in ("min_severity", "enabled"):
        if field in body.model_fields_set and getattr(body, field) is None:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY,
                                f"{field} cannot be cleared, only changed")
    sets, params = patch_assignments(
        body, {"min_severity": "min_severity", "enabled": "enabled"})
    if not sets:
        return dict(before._mapping)
    row = (await session.execute(text(f"""
        UPDATE notification_subscriptions SET {', '.join(sets)} WHERE id = :id
        RETURNING id, client_id, user_id, plant_id, channel, min_severity, enabled
    """), {**params, "id": subscription_id})).first()
    assert row is not None
    after = dict(row._mapping)
    await _audit(session, user, before.client_id, "notification_subscription.update",
                 subscription_id, before=dict(before._mapping), after=after)
    return after


@router.delete("/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_subscription(
    subscription_id: int, session: SessionDep,
    user: CurrentUser = Depends(_MANAGE),
) -> Response:
    row = (await session.execute(text("""
        DELETE FROM notification_subscriptions WHERE id = :id
        RETURNING id, client_id, user_id, plant_id, channel, min_severity, enabled
    """), {"id": subscription_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "subscription not found")
    await _audit(session, user, row.client_id, "notification_subscription.delete",
                 subscription_id, before=dict(row._mapping))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{subscription_id}/test")
async def send_test(
    subscription_id: int, session: SessionDep,
    user: CurrentUser = Depends(_MANAGE),
) -> dict[str, Any]:
    """Queue one test email to this subscriber, through the same queue and sender
    as a real Alarm, so its delivery — or its failure, with the server's reason —
    shows on the list a few seconds later.

    Refused where a real Alarm email would not be sent, because a test that
    arrives when the real thing never would is worse than none.
    """
    sub = (await session.execute(text("""
        SELECT s.id, s.client_id, s.user_id, s.plant_id, s.channel, s.min_severity,
               u.email, u.full_name, c.name AS client_name, p.code AS plant_code
          FROM notification_subscriptions s
          JOIN users u ON u.id = s.user_id
          JOIN clients c ON c.id = s.client_id
          LEFT JOIN plants p ON p.id = s.plant_id
         WHERE s.id = :id
    """), {"id": subscription_id})).first()
    if sub is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "subscription not found")
    members = await _members(session, sub.client_id)
    reason = refusal(_recipient(members.get(sub.user_id), sub.full_name or sub.email),
                     sub.plant_id)
    if reason is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, reason)
    if not get_settings().smtp_url:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "No email server is configured on this server (SMTP_URL), "
                            "so nothing can be sent.")

    scope = f"Plant {sub.plant_code}" if sub.plant_id is not None else "every Plant"
    received = ", ".join(severities_received(sub.min_severity))
    message = (
        f"This is a test of SolarCMS Alarm emails, sent from the Alarm Emails screen.\n\n"
        f"You are subscribed to {received} Alarms for {scope} of {sub.client_name}. "
        f"Nothing is wrong at any Plant; no reply is needed."
    )
    notification_id = await queue_notification(
        session, client_id=sub.client_id, channel="email", message=message,
        recipient_user_id=sub.user_id, subject="[TEST] SolarCMS alarm email",
    )
    await _audit(session, user, sub.client_id, "notification_subscription.test",
                 subscription_id, after={"notification_id": notification_id,
                                         "email": sub.email})
    return {"notification_id": notification_id, "email": sub.email}
