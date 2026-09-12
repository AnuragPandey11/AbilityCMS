import { z } from "zod";
import { request } from "../client";
import {
  BindingSchema,
  CredentialSchema,
  DeviceDetailSchema,
  DeviceListItemSchema,
  parse,
  type Binding,
  type Credential,
  type DeviceDetail,
  type DeviceListItem,
} from "../schemas";

export async function listDevices(
  plantId: number,
  blockId?: number | null,
): Promise<DeviceListItem[]> {
  const body = await request(`/plants/${plantId}/devices`, {
    params: { block_id: blockId ?? undefined },
  });
  return parse(
    z.array(DeviceListItemSchema),
    body,
    `GET /plants/${plantId}/devices`,
  );
}

export async function getDevice(deviceId: number): Promise<DeviceDetail> {
  return parse(
    DeviceDetailSchema,
    await request(`/devices/${deviceId}`),
    `GET /devices/${deviceId}`,
  );
}

/**
 * Which Tags a Device exposes. This — with `/catalog/tags` — is the answer to
 * "what does this Device show", never a hard-coded list per Device Type (§0.3).
 *
 * ⚠ Guarded by `config.modify`, not `dashboard.view`. A viewer without it gets
 * 403, so callers must tolerate an absent binding set.
 */
export async function getBindings(deviceId: number): Promise<Binding[]> {
  return parse(
    z.array(BindingSchema),
    await request(`/devices/${deviceId}/bindings`),
    `GET /devices/${deviceId}/bindings`,
  );
}

export interface BindingUpsert {
  source_key: string;
  tag_code: string;
  scale?: number;
  value_offset?: number;
  valid_min?: number | null;
  valid_max?: number | null;
  enabled?: boolean;
}

/**
 * ⚠ **Replaces** the whole set — anything omitted is deleted. A form that looks
 * like a merge silently drops bindings (§7.2).
 *
 * Existing Readings are not retroactively re-decoded; `mqtt_raw` holds the raw
 * payloads for 90 days and a backend replay is the only route back.
 */
export async function replaceBindings(
  deviceId: number,
  bindings: BindingUpsert[],
): Promise<{ device_id: number; bindings: number; resolution_cache: string }> {
  return (await request(`/devices/${deviceId}/bindings`, {
    method: "PUT",
    body: { bindings },
  })) as { device_id: number; bindings: number; resolution_cache: string };
}

export interface DeviceCreate {
  code: string;
  name: string;
  device_model_id: number;
  serial_number?: string | null;
  block_id?: number | null;
  parent_device_id?: number | null;
  reports_via_device_id?: number | null;
  source_address?: string | null;
  /**
   * ⚠ Must come from observation, not the default. Health thresholds multiply
   * this column, so a Device registered at 60s can sit silent for ten minutes
   * while still reading as healthy (§7.1).
   */
  expected_interval_s?: number;
  rated_capacity_kw?: number | null;
  installed_on?: string | null;
}

export async function createDevice(
  plantId: number,
  body: DeviceCreate,
): Promise<{ id: number; code: string }> {
  return (await request("/devices", {
    method: "POST",
    params: { plant_id: plantId },
    body,
  })) as { id: number; code: string };
}

/** All-or-nothing. A parent must appear before its child in the list. */
export async function bulkImportDevices(
  plantId: number,
  devices: DeviceCreate[],
): Promise<{ created: number; devices: { id: number; code: string }[] }> {
  return (await request("/devices/bulk-import", {
    method: "POST",
    params: { plant_id: plantId },
    body: { devices },
  })) as { created: number; devices: { id: number; code: string }[] };
}

/** Shown once and stored irreversibly — regenerated, never retrieved. */
export async function mintCredential(deviceId: number): Promise<Credential> {
  return parse(
    CredentialSchema,
    await request(`/devices/${deviceId}/credential`, { method: "POST" }),
    `POST /devices/${deviceId}/credential`,
  );
}
