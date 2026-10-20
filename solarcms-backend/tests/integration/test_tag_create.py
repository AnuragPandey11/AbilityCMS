"""Adding a Tag to the catalogue, against a real database.

`POST /catalog/tags` ran an INSERT on `tags` as the API role, which held SELECT
and UPDATE there but never INSERT, so the Data Issues "A new kind of reading"
form was a 500 for every Super Admin (20 Oct 2026). Migration 0045 grants it.
`test_permissions` only ever proved the route refuses a non-admin.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from tests.conftest import requires_db
from tests.integration.test_api_regions import _super_admin

pytestmark = [pytest.mark.asyncio, requires_db]


async def test_super_admin_adds_a_tag() -> None:
    code = f"WTI_TEST_{uuid.uuid4().hex[:6].upper()}_TEMPERATURE"
    async with await _super_admin() as superuser:
        created = await superuser.post("/catalog/tags", json={
            "code": code, "name": "Winding temperature (test)", "unit": "degC",
            "category": "diagnostic", "valid_min": -20, "valid_max": 200,
        })
        assert created.status_code == 201, created.text
        assert created.json()["code"] == code

        again = await superuser.post("/catalog/tags", json={
            "code": code, "name": "Again", "unit": "degC"})
        assert again.status_code == 409

        listed = await superuser.get("/catalog/tags")
        assert code in {tag["code"] for tag in listed.json()}

    async with scoped_session(SecurityContext.platform(0), role=None) as s:
        audited = (await s.execute(text("""
            SELECT count(*) FROM audit_log
             WHERE action = 'tag.create' AND entity_id = :id
        """), {"id": created.json()["id"]})).scalar_one()
    assert audited == 1
