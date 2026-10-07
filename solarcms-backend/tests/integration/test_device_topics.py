"""A Device fed by more than one topic (migration 0030), through the API.

An Inverter's PV strings arrive on topics of their own — `…/INVERTER_1_STRING16`
— and are that Inverter's, not a Device of their own. These drive the API as a
Client Admin, so RLS, the permission guard and the audit trail are all in the
path, and then check that the resolver honours the result.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import text

from solarcms.cache.live import invalidate_resolution
from solarcms.db.rls import SecurityContext
from solarcms.db.session import scoped_session
from solarcms.workers.resolver import ResolutionFailure, load_topic_patterns, resolve
from tests.conftest import requires_db
from tests.integration.test_api_onboarding import _admin_client, _model_id

pytestmark = [pytest.mark.asyncio, requires_db]


async def _resolve(topic: str) -> int | None:
    await invalidate_resolution(topic)
    async with scoped_session(SecurityContext.platform(0), role=None) as session:
        result = await resolve(session, topic, await load_topic_patterns(session))
    return None if isinstance(result, ResolutionFailure) else result.device_id


class TestExtraTopics:
    async def test_strings_feed_their_inverter_and_nothing_else(self) -> None:
        http, client_id = await _admin_client()
        model = await _model_id("INVERTER")
        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            client_code = (await s.execute(text(
                "SELECT code FROM clients WHERE id = :id"), {"id": client_id})).scalar_one()
        plant_code = f"XT{uuid.uuid4().hex[:6]}"
        base = f"scms/v1/{client_code}/{plant_code}"

        async with http:
            plant = (await http.post("/plants", json={
                "code": plant_code, "name": "Extra Topics"})).json()
            inverter = await http.post(f"/devices?plant_id={plant['id']}", json={
                "code": "INVERTER_1", "name": "Inverter 1", "device_model_id": model,
                "source_address": f"{base}/MCR/INVERTER_1", "collector_code": "MCR"})
            assert inverter.status_code == 201, inverter.text
            device_id = inverter.json()["id"]

            strings = f"{base}/MCR/INVERTER_1_STRING16"
            added = await http.post(f"/devices/{device_id}/topics",
                                    json={"topic": strings, "note": "PV1..16"})
            assert added.status_code == 201, added.text
            assert added.json()["created"] is True

            # Idempotent: attaching it again changes nothing.
            again = await http.post(f"/devices/{device_id}/topics", json={"topic": strings})
            assert again.status_code == 201 and again.json()["created"] is False

            listed = (await http.get(f"/plants/{plant['id']}/devices")).json()
            assert listed[0]["extra_topics"] == [strings]
            topics = (await http.get(f"/devices/{device_id}/topics")).json()
            assert [t["topic"] for t in topics] == [f"{base}/MCR/INVERTER_1", strings]
            assert [t["is_primary"] for t in topics] == [True, False]

            # The topic decides the enclosure, and two topics of one Device
            # cannot disagree about it (Guardrail 13).
            other_room = await http.post(f"/devices/{device_id}/topics",
                                         json={"topic": f"{base}/ICR/INVERTER_1_STRING28"})
            assert other_room.status_code == 409
            assert "collector" in other_room.json()["detail"]

            # Another Plant's topic is refused, never overruled.
            elsewhere = await http.post(f"/devices/{device_id}/topics", json={
                "topic": f"scms/v1/{client_code}/OTHER/MCR/INVERTER_1_STRING28"})
            assert elsewhere.status_code == 409

            # A topic held as an extra cannot become another Device's primary.
            thief = await http.post(f"/devices?plant_id={plant['id']}", json={
                "code": "INVERTER_1_STRING16", "name": "Not an Inverter",
                "device_model_id": model, "source_address": strings,
                "collector_code": "MCR"})
            assert thief.status_code == 409
            assert "extra topics" in thief.json()["detail"]

            # The resolver gives the strings' messages to the Inverter.
            assert await _resolve(strings) == device_id

            removed = await http.delete(f"/devices/{device_id}/topics",
                                        params={"topic": strings})
            assert removed.status_code == 200, removed.text
            assert await _resolve(strings) is None

            missing = await http.delete(f"/devices/{device_id}/topics",
                                        params={"topic": strings})
            assert missing.status_code == 404

        async with scoped_session(SecurityContext.platform(0), role=None) as s:
            actions = [r.action for r in (await s.execute(text("""
                SELECT action FROM audit_log
                 WHERE entity_type = 'devices' AND entity_id = :id
                   AND action LIKE 'device.topic.%' ORDER BY id
            """), {"id": device_id})).all()]
        assert actions == ["device.topic.add", "device.topic.remove"]
