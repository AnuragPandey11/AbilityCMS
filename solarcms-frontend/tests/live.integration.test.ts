// @vitest-environment node
/**
 * Live contract test: real responses from the running backend, parsed with the
 * same zod schemas the application uses.
 *
 * §0.2 says not to mock the API, and this is the reason it matters. The first
 * run of this test is what showed `dc_capacity_kwp` arriving as the **string**
 * `"5600.00"` rather than a number — a plain cast would have carried that
 * straight into a capacity sum.
 *
 * Skips itself when the API is not reachable, so `npm test` stays runnable
 * without a database.
 *
 *   uvicorn solarcms.api.main:app --port 8000    # from solarcms-backend/
 *   SOLARCMS_TEST_EMAIL=… SOLARCMS_TEST_PASSWORD=… npx vitest run tests/live
 */

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AlarmSchema,
  DeviceHealthSchema,
  DeviceListItemSchema,
  DeviceModelSchema,
  DeviceTypeSchema,
  MeSchema,
  PlantDetailSchema,
  PlantKpisSchema,
  PlantPageSchema,
  ReadingsResponseSchema,
  SldSchema,
  SystemHealthSchema,
  TagSchema,
  TokenPairSchema,
  KPI_PERIODS,
} from "@/api/schemas";

const BASE = process.env.SOLARCMS_API ?? "http://localhost:8000";
const EMAIL = process.env.SOLARCMS_TEST_EMAIL ?? "smoke@solarcms.test";
const PASSWORD = process.env.SOLARCMS_TEST_PASSWORD ?? "SmokeTest123!";

let token: string | null = null;
let reachable = false;
let plantId: number | null = null;

async function api<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.output<S>> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status, `${path} returned ${response.status}`).toBe(200);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(`${path} did not match its schema: ${parsed.error.toString()}`);
  }
  return parsed.data;
}

beforeAll(async () => {
  try {
    const health = await fetch(`${BASE}/healthz`);
    reachable = health.ok;
  } catch {
    reachable = false;
  }
  // When the suite was asked to run live, an unreachable API is a failure, not
  // a reason to pass twelve empty tests.
  if (!reachable) {
    throw new Error(
      `SOLARCMS_LIVE is set but ${BASE} is not reachable. Start the backend: ` +
        `uvicorn solarcms.api.main:app --port 8000`,
    );
  }

  const response = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(
      `Live login failed (${response.status}) for ${EMAIL}. Set SOLARCMS_TEST_EMAIL ` +
        `and SOLARCMS_TEST_PASSWORD to a real account.`,
    );
  }
  token = TokenPairSchema.parse(await response.json()).access_token;
});

describe.skipIf(!process.env.SOLARCMS_LIVE)("live API contract", () => {
  it("parses /auth/me", async () => {
    const me = await api("/auth/me", MeSchema);
    expect(me.dashboards.length).toBeGreaterThan(0);
    plantId = me.plants[0]?.id ?? null;
  });

  it("parses the Tag catalogue, which is the only source of units", async () => {
    const tags = await api("/catalog/tags", z.array(TagSchema));
    expect(tags.length).toBeGreaterThan(0);
    // Every Tag must carry a unit; a blank one would silently render bare.
    for (const tag of tags) expect(typeof tag.unit).toBe("string");
    // Guardrail: a status Tag is never throttled.
    for (const tag of tags.filter((candidate) => candidate.category === "status")) {
      expect(tag.min_interval_s, `${tag.code} is a DI and must not be throttled`).toBe(0);
    }
  });

  it("parses the Device Type and Model catalogues", async () => {
    const types = await api("/catalog/device-types", z.array(DeviceTypeSchema));
    await api("/catalog/device-models", z.array(DeviceModelSchema));
    // in_power_path is what decides SLD membership.
    expect(types.some((type) => type.in_power_path)).toBe(true);
    expect(types.some((type) => !type.in_power_path)).toBe(true);
  });

  it("parses /plants, including NUMERIC columns that arrive as strings", async () => {
    const page = await api("/plants?limit=50", PlantPageSchema);
    for (const plant of page.items) {
      // The whole reason for the numeric() coercion: the API sends "5600.00".
      if (plant.dc_capacity_kwp !== null) {
        expect(typeof plant.dc_capacity_kwp).toBe("number");
        expect(Number.isFinite(plant.dc_capacity_kwp)).toBe(true);
      }
    }
  });

  it("parses a Plant, its Devices, and its Blocks", async () => {
    if (plantId === null) return;
    const plant = await api(`/plants/${plantId}`, PlantDetailSchema);
    // Timestamps render in this zone, not the browser's.
    expect(plant.timezone).toBeTruthy();
    await api(`/plants/${plantId}/devices`, z.array(DeviceListItemSchema));
    await api(`/plants/${plantId}/blocks`, z.array(z.unknown()));
  });

  it("parses KPIs for every period, and keeps an undefined figure null", async () => {
    if (plantId === null) return;
    for (const period of KPI_PERIODS) {
      const kpis = await api(`/plants/${plantId}/kpis?period=${period}`, PlantKpisSchema);
      // Null must survive parsing as null. If this ever becomes 0, every tile
      // in the application starts lying (§4.3).
      for (const figure of [kpis.performance_ratio, kpis.cuf, kpis.availability]) {
        if (figure.value === null) {
          expect(figure.undefined_reason).toBeTruthy();
        } else {
          expect(Number.isFinite(figure.value)).toBe(true);
        }
        expect(figure.variant).toBeTruthy();
      }
    }
  });

  it("parses the SLD, with its two side lists", async () => {
    if (plantId === null) return;
    const sld = await api(`/plants/${plantId}/sld`, SldSchema);
    expect(Array.isArray(sld.excluded_not_in_power_path)).toBe(true);
    expect(Array.isArray(sld.orphaned)).toBe(true);
  });

  it("parses alarms and device health", async () => {
    await api("/alarms?limit=50", z.array(AlarmSchema));
    await api("/health/devices", z.array(DeviceHealthSchema));
    await api("/health/system", SystemHealthSchema);
  });

  it("reports the tier that served a readings query", async () => {
    if (plantId === null) return;
    const devices = await api(
      `/plants/${plantId}/devices`,
      z.array(DeviceListItemSchema),
    );
    if (devices.length === 0) return;
    const to = new Date();
    const from = new Date(to.getTime() - 3600 * 1000);
    const readings = await api(
      `/readings?device_ids=${devices[0].id}&from=${from.toISOString()}&to=${to.toISOString()}&resolution=auto`,
      ReadingsResponseSchema,
    );
    // A one-hour window is inside the raw tier's range and retention.
    expect(readings.tier).toBe("readings");
  });

  it("refuses a query above the point cap with 422 rather than serving it", async () => {
    if (plantId === null) return;
    const devices = await api(
      `/plants/${plantId}/devices`,
      z.array(DeviceListItemSchema),
    );
    if (devices.length === 0) return;
    const to = new Date();
    const from = new Date(to.getTime() - 5 * 3600 * 1000);
    const ids = devices.map((device) => `device_ids=${device.id}`).join("&");
    const response = await fetch(
      `${BASE}/readings?${ids}&from=${from.toISOString()}&to=${to.toISOString()}&resolution=readings`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    // Either it fits, or it is refused before the query runs — never a timeout.
    expect([200, 422]).toContain(response.status);
  });

  it("returns problem+json for an unauthenticated request", async () => {
    const response = await fetch(`${BASE}/auth/me`);
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  it("gives an identical 401 for a wrong password (no account enumeration)", async () => {
    const wrongPassword = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: "definitely-not-it" }),
    });
    const unknownUser = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@nowhere.test", password: "x" }),
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    // The bodies must be indistinguishable, or the UI can enumerate accounts.
    expect(await wrongPassword.json()).toEqual({
      ...(await unknownUser.json()),
      instance: "/auth/login",
    });
  });
});
