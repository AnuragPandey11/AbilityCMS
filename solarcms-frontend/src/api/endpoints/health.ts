import { z } from "zod";
import { request } from "../client";
import {
  DeviceHealthSchema,
  PlatformHealthSchema,
  SystemHealthSchema,
  parse,
  type DeviceHealth,
  type PlatformHealth,
  type SystemHealth,
} from "../schemas";

export async function deviceHealth(
  plantId?: number | null,
): Promise<DeviceHealth[]> {
  const body = await request("/health/devices", {
    params: { plant_id: plantId ?? undefined },
  });
  return parse(z.array(DeviceHealthSchema), body, "GET /health/devices");
}

/**
 * Ingest lag is the one number that distinguishes "nothing is generating" from
 * "nothing is arriving" — the two look identical on every other dashboard.
 * Guarded by `system.admin`.
 */
export async function systemHealth(): Promise<SystemHealth> {
  return parse(
    SystemHealthSchema,
    await request("/health/system"),
    "GET /health/system",
  );
}

/** Each SolarCMS process: running, working, and the broker as ingest sees it. */
export async function platformHealth(): Promise<PlatformHealth> {
  return parse(
    PlatformHealthSchema,
    await request("/health/processes"),
    "GET /health/processes",
  );
}

export async function healthz(): Promise<{ status: string }> {
  return (await request("/healthz")) as { status: string };
}
