"""Where the sun is, from a Plant's latitude and longitude and the time.

Used where a Plant has no weather station measuring, to tell daylight from a
stoppage (`domain/availability`): a Plant producing nothing at 13:00 under a
sun 60° up has stopped; at 19:00 it is night. The NOAA approximation — good to
a fraction of a degree, far finer than any threshold it is compared with.

Pure (Guardrail 9).
"""

from __future__ import annotations

import math
from datetime import UTC, datetime


def solar_elevation_deg(latitude: float, longitude: float, at: datetime) -> float:
    """The sun's elevation above the horizon, in degrees, at `at` (aware)."""
    moment = at.astimezone(UTC)
    day_of_year = moment.timetuple().tm_yday
    hour = moment.hour + moment.minute / 60 + moment.second / 3600
    # The fractional year, in radians.
    gamma = 2 * math.pi / 365 * (day_of_year - 1 + (hour - 12) / 24)
    equation_of_time = 229.18 * (
        0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma)
        - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma)
    )
    declination = (
        0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma)
        - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
        - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma)
    )
    solar_minutes = hour * 60 + equation_of_time + 4 * longitude
    hour_angle = math.radians(solar_minutes / 4 - 180)
    lat = math.radians(latitude)
    cos_zenith = (
        math.sin(lat) * math.sin(declination)
        + math.cos(lat) * math.cos(declination) * math.cos(hour_angle)
    )
    return 90.0 - math.degrees(math.acos(max(-1.0, min(1.0, cos_zenith))))
