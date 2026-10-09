"""What one send attempt makes of a queued notification.

Sending used to happen once, inside the transaction that raised the Alarm; a
failure was recorded and never retried. Now a failure that may pass is queued
again with backoff, one that will not is failed at once, and after the last
attempt the record says it gave up.
"""

from __future__ import annotations

import smtplib

from solarcms.services.notifications import (
    DeliveryResult,
    _smtp_retryable,
    outcome,
    retry_delay_s,
)


def test_a_delivered_notification_is_done() -> None:
    decided = outcome(DeliveryResult(True, "sent"), attempts=1, max_attempts=5)
    assert decided == {"status": "sent", "reason": None, "retry_in": None, "done": True}


def test_a_timeout_is_tried_again_with_backoff() -> None:
    first = outcome(DeliveryResult(False, "failed", "timeout", retryable=True), 1, 5)
    third = outcome(DeliveryResult(False, "failed", "timeout", retryable=True), 3, 5)
    assert first["status"] == "queued" and first["retry_in"] == 60
    assert third["retry_in"] == 240
    assert not first["done"]


def test_no_provider_configured_fails_at_once() -> None:
    decided = outcome(DeliveryResult(False, "failed", "no SMTP transport configured"), 1, 5)
    assert decided["status"] == "failed" and decided["done"]


def test_the_last_attempt_says_it_gave_up() -> None:
    decided = outcome(DeliveryResult(False, "failed", "timeout", retryable=True), 5, 5)
    assert decided["status"] == "failed"
    assert "gave up after 5 attempts" in decided["reason"]


def test_backoff_doubles() -> None:
    assert [retry_delay_s(n) for n in (1, 2, 3, 4)] == [60, 120, 240, 480]


def test_smtp_temporary_and_permanent_refusals() -> None:
    assert _smtp_retryable(smtplib.SMTPServerDisconnected("gone"))
    assert _smtp_retryable(smtplib.SMTPResponseException(451, b"try later"))
    assert not _smtp_retryable(smtplib.SMTPResponseException(550, b"no such user"))
    assert not _smtp_retryable(smtplib.SMTPAuthenticationError(535, b"bad login"))
