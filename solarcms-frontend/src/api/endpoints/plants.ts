import { z } from "zod";
import { request } from "../client";
import {
  BlockKpisSchema,
  BlockSchema,
  CommissioningReportSchema,
  PlantDashboardSchema,
  PlantDetailSchema,
  PlantKpisSchema,
  PlantPageSchema,
  SldSchema,
  parse,
  type Block,
  type BlockKpis,
  type CommissioningReport,
  type KpiPeriod,
  type PlantDashboard,
  type PlantDetail,
  type PlantKpis,
  type PlantPage,
  type Sld,
} from "../schemas";

export interface ListPlantsParams {
  limit?: number;
  cursor?: string | null;
  status?: string | null;
  /**
   * Narrow to one Client. A filter, never a grant: it ANDs with the row-level
   * policy, so passing another Client's id returns an empty page rather than
   * their Plants. It exists because a Super Admin sees every Client's Plants in
   * one list and needs to separate them.
   */
  clientId?: number | null;
}

/** Cursor-paginated. Follow `next_cursor`; never construct an offset (§6.2). */
export async function listPlants(
  params: ListPlantsParams = {},
): Promise<PlantPage> {
  const body = await request("/plants", {
    params: {
      limit: params.limit ?? 50,
      cursor: params.cursor ?? undefined,
      status: params.status ?? undefined,
      client_id: params.clientId ?? undefined,
    },
  });
  return parse(PlantPageSchema, body, "GET /plants");
}

/** Walk every page. Portfolio is computed from these, never stored (§6.1). */
export async function listAllPlants(
  params: Omit<ListPlantsParams, "limit" | "cursor"> = {},
): Promise<PlantPage["items"]> {
  const out: PlantPage["items"] = [];
  let cursor: string | null = null;
  // Bounded: at the F-2 ceiling this terminates long before the guard bites.
  for (let page = 0; page < 100; page += 1) {
    const result: PlantPage = await listPlants({ ...params, limit: 200, cursor });
    out.push(...result.items);
    if (!result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return out;
}

export async function getPlant(plantId: number): Promise<PlantDetail> {
  return parse(
    PlantDetailSchema,
    await request(`/plants/${plantId}`),
    `GET /plants/${plantId}`,
  );
}

export async function plantKpis(
  plantId: number,
  period: KpiPeriod = "today",
): Promise<PlantKpis> {
  const body = await request(`/plants/${plantId}/kpis`, { params: { period } });
  return parse(PlantKpisSchema, body, `GET /plants/${plantId}/kpis`);
}

/**
 * Blocks are optional. An empty array is valid and normal — render no grouping
 * level at all rather than an "Unassigned" pseudo-Block (§6.3, MASTER §2.2).
 */
export async function listBlocks(plantId: number): Promise<Block[]> {
  return parse(
    z.array(BlockSchema),
    await request(`/plants/${plantId}/blocks`),
    `GET /plants/${plantId}/blocks`,
  );
}

export async function blockKpis(
  blockId: number,
  period: KpiPeriod = "today",
): Promise<BlockKpis> {
  const body = await request(`/blocks/${blockId}/kpis`, { params: { period } });
  return parse(BlockKpisSchema, body, `GET /blocks/${blockId}/kpis`);
}

/** The electrical tree, ready-built. Blocks never appear in it (Guardrail 8). */
export async function plantSld(plantId: number): Promise<Sld> {
  return parse(
    SldSchema,
    await request(`/plants/${plantId}/sld`),
    `GET /plants/${plantId}/sld`,
  );
}

/**
 * Planned Device count per Device Type code, e.g. `{ INVERTER: 24, MFM: 2 }`.
 *
 * ⚠ The *planned* figure from the contract or design sheet, recorded at
 * onboarding before a single Device is registered. Never the live count — that
 * is `count(*)` on devices, and `GET /plants/{id}` returns both. The gap
 * between them is what remains to be commissioned.
 *
 * A map rather than named fields on purpose: a field per Device Type would need
 * a schema change every time the catalogue grows, and the form could only offer
 * the Types someone remembered to add. The API validates keys against
 * `device_types`, so this stays checked without being hardcoded.
 */
export type DeviceCounts = Record<string, number>;

/**
 * Read a topic the way ingest will, before any Device is registered for it.
 *
 * The topic is written and published *before* we onboard, so registering a
 * Device should mean pasting the one the engineers configured and being told
 * what it means — not retyping its parts into four boxes and hoping they match.
 *
 * Requires `plant.manage`, not `system.admin`: it returns only the structure of
 * a string the caller typed, so it carries none of the isolation concerns that
 * keep broker *discovery* Super-Admin-only. This is the path that lets a Client
 * Admin register their own equipment — including equipment that has not started
 * publishing yet.
 */
export interface ParsedTopic {
  topic: string;
  matched: boolean;
  client_code: string | null;
  plant_code: string | null;
  /** `null` is a real answer — the five-segment shape has no enclosure. */
  collector_code: string | null;
  device_code: string | null;
  already_registered_device_id: number | null;
  /** Human-readable reasons this topic cannot be used, in order of severity. */
  problems: string[];
  usable: boolean;
}

export async function parseTopic(
  plantId: number,
  topic: string,
): Promise<ParsedTopic> {
  return (await request(`/plants/${plantId}/parse-topic`, {
    params: { topic },
  })) as ParsedTopic;
}

export interface PlantCreate {
  code: string;
  name: string;
  /**
   * Which Client this Plant belongs to.
   *
   * Required for a Super Admin, who belongs to no Client and so cannot have one
   * inferred — the API refuses the request with a 422 rather than guessing.
   * **Ignored** for a Client Admin, whose Client comes from their session and
   * nothing else, so they cannot file a Plant under someone else (I-9).
   */
  client_id?: number | null;
  region_code?: string | null;
  ac_capacity_kw?: number | null;
  dc_capacity_kwp?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  timezone?: string;
  commissioned_on?: string | null;
  device_counts?: DeviceCounts | null;
}

/** Always created in `draft` — the backend sets the status, not the caller. */
export async function createPlant(body: PlantCreate): Promise<{ id: number }> {
  return (await request("/plants", { method: "POST", body })) as { id: number };
}

export interface PlantUpdate {
  name?: string | null;
  status?: string | null;
  region_code?: string | null;
  ac_capacity_kw?: number | null;
  dc_capacity_kwp?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  commissioned_on?: string | null;
  /**
   * Replaces the whole set when present; omit the key to leave counts alone.
   * `{}` means "this Plant has no planned Devices" and clears them.
   */
  device_counts?: DeviceCounts | null;
}

export async function updatePlant(
  plantId: number,
  body: PlantUpdate,
): Promise<unknown> {
  return request(`/plants/${plantId}`, { method: "PATCH", body });
}

export async function createBlock(
  plantId: number,
  body: { code: string; name: string; capacity_kwp: number },
): Promise<unknown> {
  return request(`/plants/${plantId}/blocks`, { method: "POST", body });
}

export async function updateBlock(
  blockId: number,
  body: { name?: string | null; capacity_kwp?: number | null },
): Promise<unknown> {
  return request(`/blocks/${blockId}`, { method: "PATCH", body });
}

/**
 * Refused with 409 while Devices still reference the Block. That is deliberate —
 * clearing their `block_id` implicitly would move equipment out of a zone as a
 * side effect of a delete.
 */
export async function deleteBlock(blockId: number): Promise<void> {
  await request(`/blocks/${blockId}`, { method: "DELETE" });
}

/**
 * What still stands between this Plant and going live.
 *
 * Onboarding fails quietly rather than loudly: a Device with no topic simply
 * never reports, a Device with no bindings decodes nothing, and both look like
 * equipment that has not been switched on yet. This turns each into a named,
 * countable item — so "the Plant is ready" becomes a check rather than an
 * opinion.
 */
export async function commissioningReport(
  plantId: number,
): Promise<CommissioningReport> {
  return parse(
    CommissioningReportSchema,
    await request(`/plants/${plantId}/commissioning`),
    `GET /plants/${plantId}/commissioning`,
  );
}

/**
 * Move a Plant along `draft → commissioning → active`.
 *
 * Its own call rather than a PATCH field, because a transition is not an edit:
 * going `active` publishes the Plant into every Portfolio total the Client sees.
 * A Plant failing its readiness checks is refused with 409 unless `force` is
 * set — the operator may know something the checks do not, but never by
 * accident.
 */
export async function changePlantStatus(
  plantId: number,
  status: string,
  options: { force?: boolean; note?: string } = {},
): Promise<{ id: number; status: string; changed: boolean }> {
  return (await request(`/plants/${plantId}/status`, {
    method: "POST",
    body: { status, force: options.force ?? false, note: options.note ?? null },
  })) as { id: number; status: string; changed: boolean };
}

/**
 * The fixed dashboard, resolved against whatever this Plant actually has.
 *
 * Same panels, same positions, every Plant. What differs is only which Device
 * answered each slot, which travels with the value rather than being inferred
 * here — the frontend never decides where a number came from.
 */
export async function plantDashboard(plantId: number): Promise<PlantDashboard> {
  const body = await request(`/plants/${plantId}/dashboard`);
  return parse(PlantDashboardSchema, body, `GET /plants/${plantId}/dashboard`);
}

/**
 * Every enclosure at this Plant, with what it holds and what it feeds into.
 *
 * ⚠ A Collector is **not a Device** (Guardrail 12). It has no Model, no Tags,
 * no topic and no Readings, it never appears in a Device list, and it is drawn
 * as a box *around* its occupants rather than as a node in the chain. The one
 * thing that can be said about it beyond its name is the single outward edge it
 * owns — which is what these two calls are for.
 */
export const PlantCollectorSchema = z.object({
  code: z.string(),
  device_count: z.number(),
  in_power_path_count: z.number(),
  /**
   * What the room feeds into. `null` is a real answer, not missing data — it is
   * the state of every Collector the moment it first appears on the broker.
   */
  parent_device_id: z.number().nullable().catch(null),
  note: z.string().nullable().catch(null),
});
export type PlantCollector = z.infer<typeof PlantCollectorSchema>;

/**
 * What the write returns: the stored row, not the roll-up.
 *
 * Narrower than the listing on purpose — membership is derived from
 * `devices.collector_code` and is not part of what was just written, so the PUT
 * has no counts to report.
 */
export const CollectorEdgeSchema = z.object({
  id: z.number(),
  code: z.string(),
  parent_device_id: z.number().nullable().catch(null),
  note: z.string().nullable().catch(null),
});
export type CollectorEdge = z.infer<typeof CollectorEdgeSchema>;

export async function listPlantCollectors(
  plantId: number,
): Promise<PlantCollector[]> {
  const body = await request(`/plants/${plantId}/collectors`);
  return parse(
    z.array(PlantCollectorSchema),
    body,
    `GET /plants/${plantId}/collectors`,
  );
}

/**
 * Say what an enclosure feeds into — said once, on the box.
 *
 * Seventeen Inverters in an MCR do not each run a cable to the transformer; the
 * room has one outgoing connection. Recorded per-Device that would be seventeen
 * identical parents the reader has to notice are identical, and the server
 * refuses it anyway: a Device inside a Collector may not point at one outside
 * it, because that edge belongs to the room.
 *
 * `parentDeviceId = null` clears it. The Device chosen must sit outside this
 * Collector — a box that fed one of its own occupants would be a ring drawn
 * through a wall — and the server enforces that.
 */
export async function setCollectorParent(
  plantId: number,
  code: string,
  parentDeviceId: number | null,
  note?: string | null,
): Promise<CollectorEdge> {
  const body = await request(
    `/plants/${plantId}/collectors/${encodeURIComponent(code)}`,
    { method: "PUT", body: { parent_device_id: parentDeviceId, note: note ?? null } },
  );
  return parse(
    CollectorEdgeSchema,
    body,
    `PUT /plants/${plantId}/collectors/${code}`,
  );
}
