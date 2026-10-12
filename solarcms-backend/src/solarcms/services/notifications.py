"""Notification dispatch: email, WhatsApp, SMS.

Every notification is one `notification_log` row (tender §24) — one delivery,
to one recipient, via one channel.

**Queued, then sent** (migration 0035, 8 Oct 2026). Whoever raises an Alarm or
fires an escalation only *queues* its notifications, in the same transaction,
so a notification never exists without its Alarm. `deliver_due`, run by the
scheduler, sends them: claimed with a lease, several at once, each with a time
limit, and retried with backoff when the failure may pass. Sending used to
happen inside the raising transaction, one recipient after another, so a slow
mail server held up every other Device's Alarm — and a send that failed once
was never tried again.

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
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from solarcms.config import Settings, get_settings
from solarcms.db.rls import SCHEDULER_ROLE, SecurityContext
from solarcms.db.session import scoped_session

log = structlog.get_logger(__name__)

Channel = Literal["email", "whatsapp", "sms"]


#: A claimed row is invisible to other dispatchers for this long — longer than
#: any one send is allowed (`SEND_TIMEOUT_S`), so a lease never lapses mid-send.
#: A dispatcher that dies mid-send leaves the row to be retried when it lapses.
CLAIM_LEASE_S = 120
SEND_TIMEOUT_S = 45
#: Backoff before the n-th retry: 1, 2, 4, 8 … minutes.
RETRY_BASE_S = 60


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    delivered: bool
    status: str  # queued | sent | delivered | failed
    failure_reason: str | None = None
    # Whether trying again later could succeed: a timeout or a server's
    # temporary refusal, yes; no provider configured or no address, never.
    retryable: bool = False


def _smtp_retryable(exc: Exception) -> bool:
    """A 4xx reply or a dropped connection may pass; a 5xx refusal will not."""
    if isinstance(exc, smtplib.SMTPRecipientsRefused | smtplib.SMTPSenderRefused
                  | smtplib.SMTPAuthenticationError | smtplib.SMTPNotSupportedError):
        return False
    if isinstance(exc, smtplib.SMTPResponseException):
        return 400 <= exc.smtp_code < 500
    return True  # connection refused, reset, timed out, server disconnected


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
        return DeliveryResult(False, "failed", f"smtp error: {exc}",
                              retryable=_smtp_retryable(exc))
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
            # Rate limited or the provider's own fault: worth another try.
            return DeliveryResult(False, "failed",
                                  f"provider returned {response.status_code}",
                                  retryable=response.status_code == 429
                                  or response.status_code >= 500)
    except Exception as exc:
        return DeliveryResult(False, "failed", f"whatsapp error: {exc}",
                              retryable=isinstance(exc, httpx.TransportError))
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


async def queue_notification(
    session: AsyncSession, *, client_id: int, channel: Channel, message: str,
    recipient_user_id: int | None = None, alarm_id: int | None = None,
    report_run_id: int | None = None, escalation_level: int | None = None,
    subject: str = "SolarCMS notification",
) -> int:
    """Record one notification to be sent, in the caller's transaction.

    Returns the notification_log id. Nothing is sent here: `deliver_due` does
    that, so the caller's transaction — usually the one raising an Alarm —
    never waits on a mail server.
    """
    row = (await session.execute(text("""
        INSERT INTO notification_log (client_id, alarm_id, report_run_id,
                                      recipient_user_id, channel, message, subject,
                                      escalation_level, delivery_status, next_attempt_at)
        VALUES (:client_id, :alarm_id, :report_run_id, :recipient_user_id, :channel,
                :message, :subject, :escalation_level, 'queued', now())
        RETURNING id
    """), {
        "client_id": client_id, "alarm_id": alarm_id, "report_run_id": report_run_id,
        "recipient_user_id": recipient_user_id, "channel": channel, "message": message,
        "subject": subject, "escalation_level": escalation_level,
    })).first()
    assert row is not None
    return int(row.id)


async def queue_alarm_notifications(
    session: AsyncSession, *, alarm_id: int, client_id: int, plant_id: int | None,
    severity: str, message: str,
) -> int:
    """Queue a notification for everyone subscribed to Alarms of at least this severity.

    Subscriptions are per Plant or Client-wide (`plant_id IS NULL`). Severity
    gating happens in SQL so that a Low-severity Alarm never even builds a
    recipient list. Returns how many were queued.
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
        await queue_notification(
            session, client_id=client_id, channel=subscriber.channel, message=body,
            recipient_user_id=subscriber.user_id, alarm_id=alarm_id,
            subject=f"[{severity.upper()}] SolarCMS alarm",
        )
    return len(subscribers)


def retry_delay_s(attempts: int) -> int:
    """Seconds before the next try, after `attempts` tries."""
    return int(RETRY_BASE_S * 2 ** max(0, attempts - 1))


def outcome(result: DeliveryResult, attempts: int, max_attempts: int) -> dict[str, Any]:
    """What one send makes of its row: sent, queued again, or failed for good."""
    if result.delivered:
        return {"status": result.status, "reason": None, "retry_in": None, "done": True}
    if result.retryable and attempts < max_attempts:
        return {"status": "queued", "reason": result.failure_reason,
                "retry_in": retry_delay_s(attempts), "done": False}
    reason = result.failure_reason
    if result.retryable:
        reason = f"{reason} (gave up after {attempts} attempts)"
    return {"status": "failed", "reason": reason, "retry_in": None, "done": True}


async def _send_one(row: Any, recipient: str) -> DeliveryResult:
    try:
        return await asyncio.wait_for(
            dispatch(row.channel, recipient, row.subject or "SolarCMS notification",
                     row.message),
            timeout=SEND_TIMEOUT_S,
        )
    except TimeoutError:
        return DeliveryResult(False, "failed", f"no answer within {SEND_TIMEOUT_S}s",
                              retryable=True)
    except Exception as exc:  # a bug in a transport must not stop the queue
        return DeliveryResult(False, "failed", f"{type(exc).__name__}: {exc}",
                              retryable=False)


async def deliver_due(limit: int = 50) -> dict[str, int]:
    """Send queued notifications whose time has come. Returns counts by outcome.

    Claimed with `FOR UPDATE SKIP LOCKED` and a lease (`next_attempt_at` pushed
    forward), committed before any send, so two dispatchers never send the same
    row and a transaction is never held open across a network call. Sent
    `notify_concurrency` at a time, each within `SEND_TIMEOUT_S`.
    """
    settings = get_settings()
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        claimed = (await s.execute(text("""
            UPDATE notification_log n
               SET attempts = n.attempts + 1,
                   next_attempt_at = now() + make_interval(secs => CAST(:lease AS integer))
             WHERE n.id IN (
                SELECT id FROM notification_log
                 WHERE delivery_status = 'queued'
                   AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                 ORDER BY next_attempt_at NULLS FIRST, id
                 LIMIT :limit
                   FOR UPDATE SKIP LOCKED)
            RETURNING n.id, n.channel, n.message, n.subject, n.recipient_user_id,
                      n.alarm_id, n.attempts
        """), {"lease": CLAIM_LEASE_S, "limit": limit})).all()
        recipients: dict[int, str] = {}
        user_ids = sorted({r.recipient_user_id for r in claimed
                           if r.recipient_user_id is not None})
        if user_ids:
            recipients = {
                u.id: u.email or "" for u in (await s.execute(
                    text("SELECT id, email FROM users WHERE id = ANY(:ids)"),
                    {"ids": user_ids})).all()
            }
    if not claimed:
        return {}

    gate = asyncio.Semaphore(max(1, settings.notify_concurrency))

    async def send(row: Any) -> tuple[Any, DeliveryResult]:
        async with gate:
            recipient = recipients.get(row.recipient_user_id, "")
            return row, await _send_one(row, recipient)

    results = await asyncio.gather(*(send(row) for row in claimed))

    counts: dict[str, int] = {}
    async with scoped_session(SecurityContext.platform(0), role=SCHEDULER_ROLE) as s:
        for row, result in results:
            decided = outcome(result, row.attempts, settings.notify_max_attempts)
            await s.execute(text("""
                UPDATE notification_log
                   SET delivery_status = :status, failure_reason = :reason,
                       next_attempt_at = CASE WHEN CAST(:retry_in AS integer) IS NULL THEN NULL
                           ELSE now() + make_interval(secs => CAST(:retry_in AS integer)) END,
                       sent_at = CASE WHEN CAST(:done AS boolean) THEN now() ELSE sent_at END
                 WHERE id = :id
            """), {"id": row.id, **decided})
            key = "retrying" if decided["status"] == "queued" else decided["status"]
            counts[key] = counts.get(key, 0) + 1
            if not result.delivered:
                log.warning("notification not delivered", channel=row.channel,
                            reason=result.failure_reason, alarm_id=row.alarm_id,
                            attempt=row.attempts, will_retry=decided["status"] == "queued")
    return counts
