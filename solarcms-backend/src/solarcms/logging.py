"""structlog configuration. JSON in production, human-readable locally."""

from __future__ import annotations

import logging
import sys
import time
from collections.abc import Hashable

import structlog


def configure_logging(level: str = "INFO", json_output: bool = True) -> None:
    """Install structlog processors. Call once at process start."""
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level.upper())

    shared: list[structlog.typing.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.StackInfoRenderer(),
        structlog.processors.TimeStamper(fmt="iso", utc=True),
    ]
    # Assigned in branches rather than by ternary: the two renderer classes share
    # no common base in structlog's stubs, so a ternary widens to `object`.
    renderer: structlog.typing.Processor
    if json_output:
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer(colors=True)

    structlog.configure(
        processors=[*shared, structlog.processors.format_exc_info, renderer],
        wrapper_class=structlog.make_filtering_bound_logger(
            logging.getLevelNamesMapping()[level.upper()]
        ),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)  # type: ignore[no-any-return]


class RepeatGate:
    """Let a line that repeats with every message through once per window.

    Some facts are true of every message a Device sends — "these keys are not
    mapped", "this topic is not registered" — and logged per message they are
    most of the log by volume: a Device on a 30 s cycle writes the same line
    2,880 times a day, and at the scale of docs/CAPACITY_AND_DEPLOYMENT.md that
    is the logging bill (§6.6). Nothing is lost by saying it once an hour: the
    count of lines held back travels with the next one, and the screens that
    act on these facts (Data Issues, discovery) read the data, not the log.

    Bounded: past `max_keys` the oldest are forgotten, which at worst lets one
    line through early.
    """

    def __init__(self, window_s: float, *, max_keys: int = 10_000) -> None:
        self._window_s = window_s
        self._max_keys = max_keys
        self._open_at: dict[Hashable, float] = {}
        self._held: dict[Hashable, int] = {}

    def allow(self, key: Hashable, now: float | None = None) -> int | None:
        """How many were held back since the last one, if this one may be logged;
        None if it is to be held back."""
        moment = time.monotonic() if now is None else now
        if moment < self._open_at.get(key, float("-inf")):
            self._held[key] = self._held.get(key, 0) + 1
            return None
        if key not in self._open_at and len(self._open_at) >= self._max_keys:
            oldest = next(iter(self._open_at))
            self._open_at.pop(oldest)
            self._held.pop(oldest, None)
        self._open_at.pop(key, None)
        self._open_at[key] = moment + self._window_s
        return self._held.pop(key, 0)
