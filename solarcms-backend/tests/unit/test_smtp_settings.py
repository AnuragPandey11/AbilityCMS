"""The SMTP URL carries a percent-encoded login, and the sender is its own setting."""

from __future__ import annotations

from email.message import EmailMessage
from typing import Any

import pytest

from solarcms.config import Settings
from solarcms.services import notifications


class FakeSMTP:
    login_args: tuple[str, str] | None = None
    message: EmailMessage | None = None

    def __init__(self, host: str, port: int, timeout: float) -> None:
        self.host, self.port = host, port

    def starttls(self) -> None:
        pass

    def login(self, user: str, password: str) -> None:
        FakeSMTP.login_args = (user, password)

    def send_message(self, message: EmailMessage) -> None:
        FakeSMTP.message = message

    def __enter__(self) -> FakeSMTP:
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


def _settings(**smtp: Any) -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        database_url="postgresql+asyncpg://u:p@localhost/db",
        redis_url="redis://localhost:6379/0",
        mqtt_host="localhost",
        jwt_secret="test",
        **smtp,
    )


def test_ses_login_is_decoded_and_sender_is_its_own_setting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(notifications.smtplib, "SMTP", FakeSMTP)
    settings = _settings(
        smtp_url="smtp://AKIAEXAMPLE:abc%2Fdef%2Bg%3D@email-smtp.ap-south-1.amazonaws.com:587",
        smtp_from="SolarCMS <alerts@example.com>",
    )
    notifications._send_email_blocking(settings, "ops@example.com", "Subject", "Body")
    assert FakeSMTP.login_args == ("AKIAEXAMPLE", "abc/def+g=")
    assert FakeSMTP.message is not None
    assert FakeSMTP.message["From"] == "SolarCMS <alerts@example.com>"


def test_without_a_sender_setting_the_login_name_is_the_sender(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(notifications.smtplib, "SMTP", FakeSMTP)
    settings = _settings(smtp_url="smtp://alerts%40example.com:secret@smtp.example.com:587")
    notifications._send_email_blocking(settings, "ops@example.com", "Subject", "Body")
    assert FakeSMTP.login_args == ("alerts@example.com", "secret")
    assert FakeSMTP.message is not None
    assert FakeSMTP.message["From"] == "alerts@example.com"
