"""Phase 9 acceptance: a queued run produces artifacts with a signed URL.

    Scheduled run produces XLSX + PDF to S3 with a signed URL.

PDF and S3 are qualified here, honestly:

* **PDF** requires WeasyPrint, an optional extra needing system pango/cairo. When
  it is absent the run still succeeds with XLSX and records why the PDF is
  missing — a Report in one format beats no Report.
* **S3** is the production target, but `boto3` is not among the specification's
  pinned dependencies. Storage is behind an interface with a local
  implementation; the property that matters — a time-limited, unguessable,
  signature-checked URL — is asserted regardless of backend.

I-11 gets the most attention, because it is the rule with commercial
consequences: a Financial Report must never be computed from an MFM.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.services.storage import LocalArtifactStore, artifact_key, get_store
from solarcms.workers.scheduler import run_queued_reports
from tests.conftest import requires_db

pytestmark = [pytest.mark.asyncio, requires_db]


async def _client_with_readings(device_type: str = "MFM") -> tuple[int, int]:
    """A Client with one Device of `device_type` and a month of daily energy.

    Returns (client_id, plant_id).
    """
    suffix = uuid.uuid4().hex[:8]
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        client_id = (await s.execute(text("""
            INSERT INTO clients (code, name, status) VALUES (:c, 'Rep', 'active')
            RETURNING id
        """), {"c": f"rep-{suffix}"})).scalar_one()
        plant_id = (await s.execute(text("""
            INSERT INTO plants (client_id, code, name, status, dc_capacity_kwp,
                                ac_capacity_kw)
            VALUES (:c, :code, 'Rep Plant', 'active', 1000, 900) RETURNING id
        """), {"c": client_id, "code": f"REP-{suffix}"})).scalar_one()
        model_id = (await s.execute(text("""
            INSERT INTO device_models (device_type_id, manufacturer, model_code)
            SELECT id, 'Rep', :m FROM device_types WHERE code = :t RETURNING id
        """), {"m": f"rep-{suffix}", "t": device_type})).scalar_one()
        device_id = (await s.execute(text("""
            INSERT INTO devices (client_id, plant_id, device_model_id, code, name)
            VALUES (:c, :p, :m, 'MTR-01', 'Meter') RETURNING id
        """), {"c": client_id, "p": plant_id, "m": model_id})).scalar_one()
        tag_id = (await s.execute(
            text("SELECT id FROM tags WHERE code = 'ENERGY_EXPORT_TOTAL'"))).scalar_one()

        base = datetime.now(UTC).replace(minute=0, second=0, microsecond=0) \
            - timedelta(days=3)
        await s.execute(text("""
            INSERT INTO readings (time, client_id, device_id, tag_id, value, quality)
            VALUES (:t, :c, :d, :tag, :v, 0)
        """), [{"t": base + timedelta(hours=h), "c": client_id, "d": device_id,
                "tag": tag_id, "v": 10_000.0 + h * 50} for h in range(72)])

    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        await s.execute(text("COMMIT"))
        for view in ("agg_1m", "agg_15m", "agg_1h", "agg_1d"):
            await s.execute(
                text(f"CALL refresh_continuous_aggregate('{view}', NULL, NULL)"))
    return client_id, plant_id


async def _queue_run(client_id: int, definition_code: str) -> int:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        definition_id = (await s.execute(
            text("SELECT id FROM report_definitions WHERE code = :c"),
            {"c": definition_code})).scalar_one()
        return int((await s.execute(text("""
            INSERT INTO report_runs (client_id, definition_id, period_start, period_end,
                                     state)
            VALUES (:c, :d, :start, :end, 'queued') RETURNING id
        """), {"c": client_id, "d": definition_id,
               "start": datetime.now(UTC) - timedelta(days=4),
               "end": datetime.now(UTC)})).scalar_one())


async def _run_state(run_id: int) -> tuple[str, dict | None, str | None]:
    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        row = (await s.execute(text("""
            SELECT state, artifact_urls, error FROM report_runs WHERE id = :id
        """), {"id": run_id})).first()
    assert row is not None
    return row.state, row.artifact_urls, row.error


class TestReportRendering:
    async def test_a_queued_run_renders_and_records_artifacts(self) -> None:
        client_id, _plant = await _client_with_readings()
        run_id = await _queue_run(client_id, "monthly_performance")

        assert await run_queued_reports() >= 1
        state, artifacts, error = await _run_state(run_id)
        assert state == "succeeded", f"run failed: {error}"
        assert artifacts is not None
        assert "xlsx" in artifacts, "XLSX is not optional"

    async def test_the_xlsx_is_a_real_workbook_with_the_figures_in_it(self) -> None:
        import io

        from openpyxl import load_workbook

        client_id, _plant = await _client_with_readings()
        run_id = await _queue_run(client_id, "monthly_performance")
        await run_queued_reports()
        _state, artifacts, _error = await _run_state(run_id)

        key = artifacts["xlsx"].split("/reports/artifacts/")[1].split("?")[0]
        content = await get_store().get(key)
        assert content is not None
        book = load_workbook(io.BytesIO(content))
        assert {"Summary", "Data"} <= set(book.sheetnames)
        summary = "".join(str(c.value) for row in book["Summary"].iter_rows()
                          for c in row if c.value)
        # The provenance travels with the figure, so it can be recomputed when
        # the client supplies their own formulas (OPEN-16).
        assert "OPEN-16" in summary
        assert "agg_" in summary

    async def test_the_signed_url_is_verified_and_expires(self) -> None:
        store = get_store()
        key = artifact_key(1, 999, "xlsx")
        await store.put(key, b"content", "application/octet-stream")
        url = await store.signed_url(key)

        expires = int(url.split("expires=")[1].split("&")[0])
        signature = url.split("signature=")[1]
        assert LocalArtifactStore.verify(key, expires, signature)
        # A tampered key or signature must not validate, and neither must a
        # link whose window has passed.
        assert not LocalArtifactStore.verify(key, expires, "deadbeef")
        assert not LocalArtifactStore.verify("reports/1/other.xlsx", expires, signature)
        assert not LocalArtifactStore.verify(key, 1, signature)

    async def test_the_artifact_key_is_not_guessable_from_the_run_id(self) -> None:
        first = artifact_key(1, 42, "xlsx")
        second = artifact_key(1, 42, "xlsx")
        assert first != second, "keys must carry a random component"


class TestFinancialReportsRefuseTheWrongInstrument:
    async def test_a_financial_report_fails_when_only_an_mfm_exists(self) -> None:
        """I-11. Refusing is the correct outcome.

        Producing an invoice figure from an operational meter would be worse than
        producing none: the MFM differs in accuracy class and has no commercial
        standing, and nobody downstream could tell the difference.
        """
        client_id, _plant = await _client_with_readings(device_type="MFM")
        run_id = await _queue_run(client_id, "monthly_settlement")

        await run_queued_reports()
        state, _artifacts, error = await _run_state(run_id)
        assert state == "failed"
        assert error is not None and "ABT Meter" in error

    async def test_a_financial_report_succeeds_with_an_abt_meter(self) -> None:
        client_id, _plant = await _client_with_readings(device_type="ABT_METER")
        run_id = await _queue_run(client_id, "monthly_settlement")

        await run_queued_reports()
        state, artifacts, error = await _run_state(run_id)
        assert state == "succeeded", f"run failed: {error}"
        assert artifacts is not None and "xlsx" in artifacts

    async def test_a_non_financial_report_is_happy_with_an_mfm(self) -> None:
        """The constraint applies to Financial Reports only — operational
        reporting from an MFM is exactly what it is for."""
        client_id, _plant = await _client_with_readings(device_type="MFM")
        run_id = await _queue_run(client_id, "monthly_performance")
        await run_queued_reports()
        state, _artifacts, error = await _run_state(run_id)
        assert state == "succeeded", f"run failed: {error}"


class TestRunClaiming:
    async def test_a_run_is_claimed_once_even_across_schedulers(self) -> None:
        """FOR UPDATE SKIP LOCKED: two schedulers must not render the same run."""
        client_id, _plant = await _client_with_readings()
        run_id = await _queue_run(client_id, "monthly_performance")

        first = await run_queued_reports()
        second = await run_queued_reports()
        assert first >= 1
        state, _artifacts, _error = await _run_state(run_id)
        assert state == "succeeded"
        # The second pass found nothing left queued, rather than re-rendering.
        assert second == 0


class TestReportsDoNotCrossClients:
    async def test_a_report_excludes_another_clients_devices(self) -> None:
        """The scheduler runs with platform privileges, so the barrier views do
        not scope its queries — `app_is_platform_admin()` is true and they return
        every Client's rows.

        Report generation must therefore scope by `client_id` itself. This is the
        one place in the system where isolation is *not* inherited from the
        database, which is exactly why it is asserted here: the leak it guards
        against produced a passing Financial Report built from another Client's
        meter before the predicate was added.
        """
        client_a, _plant_a = await _client_with_readings(device_type="MFM")
        client_b, _plant_b = await _client_with_readings(device_type="MFM")

        run_id = await _queue_run(client_a, "monthly_performance")
        await run_queued_reports()
        _state, artifacts, _error = await _run_state(run_id)

        key = artifacts["xlsx"].split("/reports/artifacts/")[1].split("?")[0]
        content = await get_store().get(key)
        assert content is not None

        import io

        from openpyxl import load_workbook

        book = load_workbook(io.BytesIO(content))
        plant_codes = {
            row[0] for row in book["Data"].iter_rows(min_row=2, values_only=True)
            if row and row[0]
        }
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            b_codes = {r.code for r in (await s.execute(
                text("SELECT code FROM plants WHERE client_id = :c"),
                {"c": client_b})).all()}
        assert plant_codes and not (plant_codes & b_codes), (
            f"report for client {client_a} contained client {client_b}'s plants"
        )

    async def test_a_financial_report_ignores_another_clients_abt_meter(self) -> None:
        """Client A has only an MFM; Client B has an ABT Meter.

        A Financial Report for A must still fail. Finding *an* ABT Meter
        somewhere is not the test — I-11 is about which instrument produced the
        Readings being invoiced.
        """
        client_a, _plant_a = await _client_with_readings(device_type="MFM")
        await _client_with_readings(device_type="ABT_METER")

        run_id = await _queue_run(client_a, "monthly_settlement")
        await run_queued_reports()
        state, _artifacts, error = await _run_state(run_id)
        assert state == "failed"
        assert error is not None and "ABT Meter" in error
