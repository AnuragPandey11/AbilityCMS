"""Report definitions, runs and downloads."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import text

from solarcms.api.deps import CurrentUser, SessionDep, require_permission
from solarcms.services.storage import LocalArtifactStore, get_store

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/definitions")
async def list_definitions(
    session: SessionDep,
    _: CurrentUser = Depends(require_permission("report.generate")),
) -> list[dict[str, Any]]:
    rows = (await session.execute(text("""
        SELECT id, code, name, description, is_financial, query_spec
          FROM report_definitions
         WHERE client_id IS NULL OR client_id = app_client_id()
         ORDER BY code
    """))).all()
    return [dict(row._mapping) for row in rows]


@router.post("/runs", status_code=status.HTTP_202_ACCEPTED)
async def request_run(
    definition_id: int, period_start: datetime, period_end: datetime,
    session: SessionDep,
    user: CurrentUser = Depends(require_permission("report.generate")),
) -> dict[str, Any]:
    """Queue a Report. Async — the scheduler renders it.

    ⚠ A Financial Report is refused unless the Plant has an ABT Meter. I-11
    forbids computing one from an MFM: the ABT Meter is the sealed, revenue-grade
    settlement instrument and only it has commercial standing. Refusing is the
    correct failure — producing an invoice figure from an operational meter is
    the incorrect one.
    """
    definition = (await session.execute(text("""
        SELECT id, is_financial, code FROM report_definitions
         WHERE id = :id AND (client_id IS NULL OR client_id = app_client_id())
    """), {"id": definition_id})).first()
    if definition is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "report definition not found")

    if definition.is_financial:
        abt_meters = (await session.execute(text("""
            SELECT count(*) FROM devices d
              JOIN device_models dm ON dm.id = d.device_model_id
              JOIN device_types dt  ON dt.id = dm.device_type_id
             WHERE dt.code = 'ABT_METER' AND d.status = 'active'
        """))).scalar()
        if not abt_meters:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "financial reports require an ABT Meter; none is registered. I-11 "
                "forbids computing them from an MFM.",
            )

    row = (await session.execute(text("""
        INSERT INTO report_runs (client_id, definition_id, requested_by, period_start,
                                 period_end, state)
        VALUES (app_client_id(), :definition_id, :user_id, :start, :end, 'queued')
        RETURNING id, state, created_at
    """), {"definition_id": definition_id, "user_id": user.user_id,
           "start": period_start, "end": period_end})).first()
    assert row is not None
    await session.execute(text("""
        INSERT INTO audit_log (client_id, user_id, action, entity_type, entity_id, after)
        VALUES (app_client_id(), :user_id, 'report.request', 'report_runs', :id,
                CAST(:after AS jsonb))
    """), {"user_id": user.user_id, "id": row.id,
           "after": json.dumps({"definition": definition.code,
                                "period_start": period_start.isoformat(),
                                "period_end": period_end.isoformat(),
                                "is_financial": definition.is_financial})})
    return {"run_id": row.id, "state": row.state, "created_at": row.created_at}


@router.get("/runs/{run_id}")
async def get_run(
    run_id: int, session: SessionDep,
    _: CurrentUser = Depends(require_permission("report.generate")),
) -> dict[str, Any]:
    row = (await session.execute(text("""
        SELECT id, state, period_start, period_end, artifact_urls, row_count, error,
               created_at, completed_at
          FROM report_runs WHERE id = :run_id
    """), {"run_id": run_id})).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "run not found")
    return dict(row._mapping)


@router.get("/artifacts/{key:path}")
async def download_artifact(
    key: str, expires: int, signature: str,
) -> Response:
    """Serve a rendered Report against a signed URL.

    Deliberately **not** behind the bearer-token guard: a signed URL is the
    credential, which is what lets a Report be emailed as a link. The signature
    covers the key and the expiry, so neither can be altered, and the URL stops
    working when it expires.
    """
    if not LocalArtifactStore.verify(key, expires, signature):
        # One response for a bad signature, a tampered key and an expired link:
        # distinguishing them tells a prober which part to keep guessing at.
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid or expired link")

    content = await get_store().get(key)
    if content is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "artifact not found")

    media_type = ("application/pdf" if key.endswith(".pdf")
                  else "application/vnd.openxmlformats-officedocument."
                       "spreadsheetml.sheet")
    filename = key.rsplit("/", 1)[-1]
    return Response(
        content=content, media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
