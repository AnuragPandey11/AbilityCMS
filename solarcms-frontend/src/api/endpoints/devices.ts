import { z } from "zod";
import { request } from "../client";
import {
  BindingSchema,
  CredentialSchema,
  DeviceDetailSchema,
  DeviceListItemSchema,
  UnmappedKeysSchema,
  parse,
  type Binding,
  type Credential,
  type DeviceDetail,
  type DeviceListItem,
  type UnmappedKey,
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
  /**
   * The enclosure this Device sits in — an MCR, an ICR, a panel. A *name*, not
   * an id, because a Collector is not a Device: it publishes nothing, carries
   * no current, and is drawn as a box around its Devices rather than as one of
   * them. Omit it for equipment that sits in no enclosure.
   */
  collector_code?: string | null;
  source_address?: string | null;
  /**
   * ⚠ Must come from observation, not the default. Health thresholds multiply
   * this column, so a Device registered at 60s can sit silent for ten minutes
   * while still reading as healthy (§7.1).
   */
  expected_interval_s?: number;
  rated_capacity_kw?: number | null;
  installed_on?: string | null;
  /**
   * How many inputs of the Model's repeating group this unit has — the PV
   * strings on this Inverter. A fact about the unit, not the Model: the same
   * datasheet covers a 12-string and a 24-string machine.
   */
  string_count?: number | null;
  /**
   * Seed bindings from the Model's signal schedule. Left on by default: a Device
   * that exists and decodes nothing looks exactly like a broken one.
   */
  bind_from_model?: boolean;
}

export async function createDevice(
  plantId: number,
  body: DeviceCreate,
): Promise<{ id: number; code: string; bindings?: { bound: number } }> {
  return (await request("/devices", {
    method: "POST",
    params: { plant_id: plantId },
    body,
  })) as { id: number; code: string; bindings?: { bound: number } };
}

/**
 * Remove a Device from a Plant.
 *
 * ⚠ Readings have **no foreign key** to devices — a hypertable cannot check one
 * per inserted row and keep up with ingestion. So deleting a Device does not
 * remove its history: the rows stay, attributed to an id that resolves to
 * nothing, invisible everywhere and counted forever.
 *
 * The API therefore refuses a Device that has stored Readings unless `force` is
 * set, and says how many. For equipment that genuinely existed, decommissioning
 * (`updateDevice(id, { status: "decommissioned" })`) is the better answer: it
 * stops ingestion and hides the Device from the diagram while its generation
 * history stays attributable.
 */
export async function deleteDevice(
  deviceId: number,
  force = false,
): Promise<{ deleted: number; code: string; readings_deleted: number }> {
  return (await request(`/devices/${deviceId}`, {
    method: "DELETE",
    params: { force },
  })) as { deleted: number; code: string; readings_deleted: number };
}

export type DeviceUpdate = Partial<Omit<DeviceCreate, "device_model_id">> & {
  status?: string;
  /**
   * Fields to set to NULL. Needed because `null` and "unchanged" are the same
   * JSON in a PATCH body — without it a Collector can be assigned but never
   * unassigned.
   */
  clear?: string[];
};

export async function updateDevice(
  deviceId: number,
  body: DeviceUpdate,
): Promise<DeviceDetail> {
  return parse(
    DeviceDetailSchema,
    await request(`/devices/${deviceId}`, { method: "PATCH", body }),
    `PATCH /devices/${deviceId}`,
  );
}

/**
 * Regenerate bindings from the Model's schedule.
 *
 * The operation to reach for after changing a string count: raising a 12-string
 * Inverter to 24 adds the twelve new PV inputs without disturbing corrections
 * already made to the rest. `replace` discards existing bindings first — and
 * with them any per-Device scale or source-key correction.
 */
export async function bindFromModel(
  deviceId: number,
  replace = false,
): Promise<{ bound: number; strings: number }> {
  return (await request(`/devices/${deviceId}/bindings/from-model`, {
    method: "POST",
    params: { replace },
  })) as { bound: number; strings: number };
}

/**
 * Payload keys this Device publishes that nothing is bound to.
 *
 * Available nowhere else: an unmapped key never becomes a Reading, so no query
 * over history can reveal one. Each entry is a signal the Device really sends
 * and the platform is currently discarding.
 */
export async function unmappedKeys(deviceId: number): Promise<UnmappedKey[]> {
  const body = await request(`/devices/${deviceId}/unmapped-keys`);
  return parse(
    UnmappedKeysSchema,
    body,
    `GET /devices/${deviceId}/unmapped-keys`,
  ).keys;
}

export async function forgetUnmappedKeys(deviceId: number): Promise<void> {
  await request(`/devices/${deviceId}/unmapped-keys`, { method: "DELETE" });
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
