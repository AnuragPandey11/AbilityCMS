"""Range queries return from the correct tier, and the tier holds real values.

Phase 6 (BACKEND_SPEC §13). Two separate claims, both needed:

1. `select_tier` picks the coarsest tier that covers the range and still retains
   it — pure logic, covered by the unit tests.
2. That tier actually *contains* the data, and the read path picks the column
   matching each Tag's `rollup_method`. Averaging a cumulative energy counter is
   meaningless, so `last_value` versus `avg_value` is not a detail.

The second claim needs a populated continuous aggregate, which is why this test
writes Readings and refreshes the aggregates rather than trusting the policies to
have run.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.domain.tiering import value_column
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]


async def _plant_with_readings() -> tuple[int, int, int, int]:
    """A Device with one hour of 1-minute Readings on two Tags.

    Returns (client_id, device_id, power_tag_id, energy_tag_id). The two Tags
    differ in `rollup_method` — `avg` for power, `last` for the cumulative
    counter — which is the distinction the read path has to honour.
    """
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:code, 'Tier', 'active')
            RETURNING id
        """), {"code": f"tier-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status)
            VALUES (:c, :code, 'Tier Plant', 'active') RETURNING id
        """), {"c": client_id, "code": f"TIER-{suffix}"})).scalar_one()
        model_id = (await s.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code)
            SELECT id, 'Tier', :m FROM device_types WHERE code = 'INVERTER'
            RETURNING id
        """), {"m": f"tier-{suffix}"})).scalar_one()
        device_id = (await s.execute(text("""
            INSERT INTO devices (client_id, plant_id, device_model_id, code, name,
                                 expected_interval_s)
            VALUES (:c, :p, :m, 'INV-01', 'Tier Inverter', 60) RETURNING id
        """), {"c": client_id, "p": plant_id, "m": model_id})).scalar_one()

        power_tag = (await s.execute(
            text("SELECT id FROM tags WHERE code = 'AC_ACTIVE_POWER'"))).scalar_one()
        energy_tag = (await s.execute(
            text("SELECT id FROM tags WHERE code = 'ENERGY_EXPORT_TOTAL'"))).scalar_one()

        # One hour, one Reading per minute. Power oscillates; the counter climbs.
        base = datetime.now(UTC).replace(second=0, microsecond=0) - timedelta(hours=2)
        rows = []
        for minute in range(60):
            at = base + timedelta(minutes=minute)
            rows.append({"t": at, "c": client_id, "d": device_id, "tag": power_tag,
                         "v": 100.0 + minute, "q": 0})
            rows.append({"t": at, "c": client_id, "d": device_id, "tag": energy_tag,
                         "v": 1000.0 + minute * 10, "q": 0})
        await s.execute(text("""
            INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
            VALUES (:t, :c, :d, :tag, :v, :q)
        """), rows)

    # Continuous aggregates materialise on a schedule; refresh explicitly so the
    # test asserts the cascade rather than the timing of a background job.
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        await s.execute(text("COMMIT"))
        for view in ("agg_1m", "agg_15m", "agg_1h"):
            await s.execute(
                text(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)"))
    return client_id, device_id, power_tag, energy_tag


class TestAggregatesHoldRealValues:
    async def test_one_minute_tier_is_populated_and_correct(self) -> None:
        client_id, device_id, power_tag, energy_tag = await _plant_with_readings()
        async with scoped_session(
            SecurityContext(user_id=1, client_id=client_id, role_code="admin")
        ) as session:
            rows = (await session.execute(text("""
                SELECT count(*) AS buckets, sum(sample_count) AS samples
                  FROM agg_1m_v WHERE device_id = :d AND tag_id = :t
            """), {"d": device_id, "t": power_tag})).first()
            assert rows is not None
            assert rows.buckets == 60, "expected one bucket per minute"
            assert rows.samples == 60

    async def test_hourly_tier_rolls_up_from_the_tiers_below_it(self) -> None:
        client_id, device_id, power_tag, energy_tag = await _plant_with_readings()
        async with scoped_session(
            SecurityContext(user_id=1, client_id=client_id, role_code="admin")
        ) as session:
            row = (await session.execute(text("""
                SELECT avg_value, min_value, max_value, sample_count
                  FROM agg_1h_v WHERE device_id = :d AND tag_id = :t
                 ORDER BY bucket LIMIT 1
            """), {"d": device_id, "t": power_tag})).first()
            assert row is not None, "agg_1h was empty; the cascade did not run"
            # Power ran 100..159, so the hour's extremes must bracket that.
            assert row.min_value >= 100.0
            assert row.max_value <= 159.0
            assert row.sample_count > 0

    async def test_a_counter_is_read_by_last_value_not_average(self) -> None:
        """The distinction that makes energy correct.

        The counter climbs 1000 → 1590. Its average (~1295) is a meaningless
        number; only the last value in a bucket is the counter's state.
        """
        client_id, device_id, _power, energy_tag = await _plant_with_readings()
        async with scoped_session(
            SecurityContext(user_id=1, client_id=client_id, role_code="admin")
        ) as session:
            row = (await session.execute(text("""
                SELECT avg_value, last_value, max_value
                  FROM agg_1h_v WHERE device_id = :d AND tag_id = :t
                 ORDER BY bucket DESC LIMIT 1
            """), {"d": device_id, "t": energy_tag})).first()
            assert row is not None
            assert row.last_value == pytest.approx(1590.0)
            assert row.avg_value != row.last_value
            # And the Tag itself declares which column is correct.
            method = (await session.execute(
                text("SELECT rollup_method FROM tags WHERE id = :t"),
                {"t": energy_tag})).scalar_one()
            assert method == "last"
            assert value_column(method) == "last_value"
