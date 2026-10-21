"""PR's sunlight floor: float noise is no sunlight.

Pure `domain/` tests. OASIS_2MW's weather station sends 9.75E-42 for zero, and
PR refused only an exact zero, so its dial printed 1.02E+42% (21 Oct 2026).
"""

from __future__ import annotations

import pytest

from solarcms.domain.assumptions import PR_MIN_IRRADIATION_WH_PER_M2
from solarcms.domain.formulas import performance_ratio


def test_a_pr_is_worked_out_as_before() -> None:
    # 800 kWh from 1,000 kWp over 1 kWh/m²: 0.8.
    assert performance_ratio(800.0, 1_000.0, 1_000.0).value == pytest.approx(0.8)


def test_a_pr_above_100_percent_is_still_a_value() -> None:
    # Shown and flagged on screen, never withheld or clamped (Guardrail 33).
    assert performance_ratio(2_643.0, 1_000.0, 1_000.0).value == pytest.approx(2.643)


def test_float_noise_for_sunlight_is_no_sunlight() -> None:
    # OASIS_2MW's GHI: 9.75E-42 kWh/m² is 9.75E-39 Wh/m².
    result = performance_ratio(4_240.0, 9.75e-39, 2_000.0)
    assert result.value is None
    assert result.undefined_reason == "too little sunlight recorded in period"


def test_the_sunlight_floor_is_a_floor() -> None:
    assert performance_ratio(1.0, PR_MIN_IRRADIATION_WH_PER_M2 * 0.99, 1.0).value is None
    # 0.009 kWh from 1 kWp over 10 Wh/m²: 0.9.
    assert performance_ratio(
        0.009, PR_MIN_IRRADIATION_WH_PER_M2, 1.0).value == pytest.approx(0.9)


def test_no_sunlight_keeps_its_own_reason() -> None:
    assert performance_ratio(10.0, 0.0, 1_000.0).undefined_reason == "no irradiation in period"
