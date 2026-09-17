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
    },
  });
  return parse(PlantPageSchema, body, "GET /plants");
}

/** Walk every page. Portfolio is computed from these, never stored (§6.1). */
export async function listAllPlants(): Promise<PlantPage["items"]> {
  const out: PlantPage["items"] = [];
  let cursor: string | null = null;
  // Bounded: at the F-2 ceiling this terminates long before the guard bites.
  for (let page = 0; page < 100; page += 1) {
    const result: PlantPage = await listPlants({ limit: 200, cursor });
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

export interface PlantCreate {
  code: string;
  name: string;
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
