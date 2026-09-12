"""Notification dispatch: email, WhatsApp, SMS.

Every attempt is one `notification_log` row (tender §24) — one delivery, to one
recipient, via one channel.

**An unconfigured channel records a failure rather than a success.** If SMTP is
not configured, the row is written `failed` with a reason saying so. Marking it
`sent` because nothing raised would make the delivery history a work of fiction,
and the history is what someone consults after an Alarm was missed.

⚠ WhatsApp has no provider yet (MASTER §8.2): the Business API needs an approved
provider and per-template review, with weeks of lead time, and the client has
deferred the choice. The transport here is a generic HTTP POST so that adopting a
provider is configuration plus a template mapping, not a rewrite.
"""

from __future__ import annotations

import asyncio
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Literal
from urllib.parse import urlparse

import httpx
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.config import Settings, get_settings

log = structlog.get_logger(__name__)

Channel = Literal["email", "whatsapp", "sms"]


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    delivered: bool
    status: str  # queued | sent | delivered | failed
    failure_reason: str | None = None


def _send_email_blocking(settings: Settings, to: str, subject: str, body: str) -> None:
    """Synchronous SMTP, run off the event loop by the caller.

    stdlib smtplib rather than an async client: notification volume is low, the
    dependency list is pinned by the spec, and a thread per message is cheaper
    than a library that is not in it.
    """
    url = urlparse(settings.smtp_url or "")
    message = EmailMessage()
    message["From"] = url.username or "solarcms@localhost"
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)

    port = url.port or (465 if url.scheme == "smtps" else 587)
    if url.scheme == "smtps":
        client: smtplib.SMTP | smtplib.SMTP_SSL = smtplib.SMTP_SSL(
            url.hostname or "localhost", port, timeout=15)
    else:
        client = smtplib.SMTP(url.hostname or "localhost", port, timeout=15)
        client.starttls()
    with client:
        if url.username and url.password:
            client.login(url.username, url.password)
        client.send_message(message)


async def send_email(to: str, subject: str, body: str) -> DeliveryResult:
    settings = get_settings()
    if not settings.smtp_url:
        return DeliveryResult(False, "failed", "no SMTP transport configured")
    if not to:
        return DeliveryResult(False, "failed", "recipient has no email address")
    try:
        await asyncio.to_thread(_send_email_blocking, settings, to, subject, body)
    except Exception as exc:
        return DeliveryResult(False, "failed", f"smtp error: {exc}")
    # 'sent', not 'delivered': handing a message to an SMTP server says nothing
    # about it reaching a mailbox. Only a provider webhook could justify
    # 'delivered', and we have none.
    return DeliveryResult(True, "sent")


async def send_whatsapp(to: str, body: str) -> DeliveryResult:
    settings = get_settings()
    if not settings.whatsapp_api_url or not settings.whatsapp_api_token:
        # ⚠ Expected until the client chooses a provider (MASTER §8.2).
        return DeliveryResult(False, "failed", "no WhatsApp provider configured")
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                settings.whatsapp_api_url,
                headers={
                    "Authorization":
                        f"Bearer {settings.whatsapp_api_token.get_secret_value()}"
                },
                json={"to": to, "type": "text", "text": {"body": body}},
            )
        if response.status_code >= 400:
            return DeliveryResult(False, "failed",
                                  f"provider returned {response.status_code}")
    except Exception as exc:
        return DeliveryResult(False, "failed", f"whatsapp error: {exc}")
    return DeliveryResult(True, "sent")


async def send_sms(to: str, body: str) -> DeliveryResult:
    # No SMS provider is configured or chosen. Recorded honestly rather than
    # silently dropped: a channel nobody set up must show as failed in the
    # delivery history, or an operator will believe a message went out.
    return DeliveryResult(False, "failed", "no SMS provider configured")


async def dispatch(channel: Channel, recipient: str, subject: str, body: str) -> DeliveryResult:
    if channel == "email":
        return await send_email(recipient, subject, body)
    if channel == "whatsapp":
        return await send_whatsapp(recipient, body)
    if channel == "sms":
        return await send_sms(recipient, body)
    return DeliveryResult(False, "failed", f"unknown channel {channel!r}")


async def record_and_send(
    session: AsyncSession, *, client_id: int, channel: Channel, message: str,
    recipient_user_id: int | None = None, alarm_id: int | None = None,
    report_run_id: int | None = None, escalation_level: int | None = None,
    subject: str = "SolarCMS notification",
) -> int:
    """Attempt one delivery and record it. Returns the notification_log id.

    The row is written whatever the outcome. A failed send is not an error the
    caller must handle — it is a fact the delivery history has to carry, because
    "why did nobody hear about this Alarm" is answered from this table.
    """
    recipient = ""
    if recipient_user_id is not None:
        recipient = (await session.execute(
            text("SELECT email FROM users WHERE id = :id"),
            {"id": recipient_user_id})).scalar() or ""

    result = await dispatch(channel, recipient, subject, message)
    row = (await session.execute(text("""
        INSERT INTO notification_log (client_id, alarm_id, report_run_id,
                                      recipient_user_id, channel, message,
                                      escalation_level, delivery_status, failure_reason)
        VALUES (:client_id, :alarm_id, :report_run_id, :recipient_user_id, :channel,
                :message, :escalation_level, :status, :failure_reason)
        RETURNING id
    """), {
        "client_id": client_id, "alarm_id": alarm_id, "report_run_id": report_run_id,
        "recipient_user_id": recipient_user_id, "channel": channel, "message": message,
        "escalation_level": escalation_level, "status": result.status,
        "failure_reason": result.failure_reason,
    })).first()
    assert row is not None

    if not result.delivered:
        log.warning("notification not delivered", channel=channel,
                    reason=result.failure_reason, alarm_id=alarm_id)
    return int(row.id)


async def notify_alarm_subscribers(
    session: AsyncSession, *, alarm_id: int, client_id: int, plant_id: int | None,
    severity: str, message: str,
) -> int:
    """Notify everyone subscribed to Alarms of at least this severity.

    Subscriptions are per Plant or Client-wide (`plant_id IS NULL`). Severity
    gating happens in SQL so that a Low-severity Alarm never even builds a
    recipient list.
    """
    severity_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
    rank = severity_rank.get(severity, 0)

    subscribers = (await session.execute(text("""
        SELECT s.user_id, s.channel, s.message_template
          FROM notification_subscriptions s
         WHERE s.client_id = :client_id AND s.enabled
           AND (s.plant_id IS NULL OR s.plant_id = :plant_id)
           AND CASE s.min_severity WHEN 'low' THEN 0 WHEN 'medium' THEN 1
                                   WHEN 'high' THEN 2 ELSE 3 END <= :rank
         ORDER BY s.priority DESC
    """), {"client_id": client_id, "plant_id": plant_id, "rank": rank})).all()

    for subscriber in subscribers:
        body = (subscriber.message_template or "{message}").replace("{message}", message)
        await record_and_send(
            session, client_id=client_id, channel=subscriber.channel, message=body,
            recipient_user_id=subscriber.user_id, alarm_id=alarm_id,
            subject=f"[{severity.upper()}] SolarCMS alarm",
        )
    return len(subscribers)
