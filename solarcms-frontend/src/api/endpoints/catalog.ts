import { request } from "../client";
import {
  DeviceModelSchema,
  DeviceModelTagSchema,
  DeviceTableColumnsSchema,
  DeviceTypeSchema,
  TagSchema,
  parse,
  type DeviceModel,
  type DeviceModelTag,
  type DeviceTableColumns,
  type DeviceType,
  type Tag,
} from "../schemas";
import { z } from "zod";

/**
 * The Tag registry. Units live here and nowhere else in the frontend (§4.1,
 * Guardrail 2) — a hard-coded unit is wrong by a factor of 1000 sooner or later.
 */
export interface TagQuery {
  category?: string | null;
  /** true: only calculated Tags. false: only published ones. */
  derived?: boolean | null;
  search?: string | null;
}

export async function tags(query: TagQuery = {}): Promise<Tag[]> {
  return parse(
    z.array(TagSchema),
    await request("/catalog/tags", {
      params: {
        category: query.category ?? undefined,
        derived: query.derived ?? undefined,
        search: query.search ?? undefined,
      },
    }),
    "GET /catalog/tags",
  );
}

export async function deviceTypes(): Promise<DeviceType[]> {
  return parse(
    z.array(DeviceTypeSchema),
    await request("/catalog/device-types"),
    "GET /catalog/device-types",
  );
}

export async function deviceModels(
  deviceTypeCode?: string | null,
): Promise<DeviceModel[]> {
  return parse(
    z.array(DeviceModelSchema),
    await request("/catalog/device-models", {
      params: { device_type_code: deviceTypeCode ?? undefined },
    }),
    "GET /catalog/device-models",
  );
}

/**
 * A Model's signal schedule.
 *
 * `stringCount` slices the repeating group the way a Device with that many
 * strings would bind it — so the onboarding form can show "you are about to
 * bind 59 Tags" before anything is created, rather than after.
 */
export async function deviceModelTags(
  modelId: number,
  stringCount?: number | null,
): Promise<DeviceModelTag[]> {
  return parse(
    z.array(DeviceModelTagSchema),
    await request(`/catalog/device-models/${modelId}/tags`, {
      params: { string_count: stringCount ?? undefined },
    }),
    "GET /catalog/device-models/{id}/tags",
  );
}

export interface DeviceModelCreate {
  device_type_code: string;
  manufacturer: string;
  model_code: string;
  variant?: string | null;
  rated_capacity_kw?: number | null;
}

/** Add a real make and model to the catalogue. Platform-owned: system.admin. */
export async function createDeviceModel(
  body: DeviceModelCreate,
): Promise<{ id: number; model_code: string }> {
  return (await request("/catalog/device-models", {
    method: "POST",
    body,
  })) as { id: number; model_code: string };
}

export interface ModelTagEntry {
  tag_code: string;
  default_source_key?: string | null;
  repeat_index?: number | null;
  sort_order?: number | null;
}

/**
 * ⚠ **Replaces** a Model's whole signal schedule. A Tag omitted here disappears,
 * which is deliberate — a withdrawn signal left behind is indistinguishable, on
 * every screen, from a sensor that has failed.
 */
export async function replaceDeviceModelTags(
  modelId: number,
  tags: ModelTagEntry[],
): Promise<{ model_id: number; tags: number }> {
  return (await request(`/catalog/device-models/${modelId}/tags`, {
    method: "PUT",
    body: { tags },
  })) as { model_id: number; tags: number };
}

export interface TagCreate {
  code: string;
  name: string;
  unit: string;
  category?: string;
  rollup_method?: string;
  scale_default?: number;
  valid_min?: number | null;
  valid_max?: number | null;
  min_interval_s?: number;
  is_cumulative?: boolean;
  /**
   * Arithmetic over other Tag codes: "(A + B + C) / 3". Constants INV_CAPACITY,
   * DC_CAPACITY and AC_CAPACITY are available; a plant-scope formula may also
   * read aggregates, as SUM.ENERGY_TODAY or AVG.GHI_CUMULATIVE.
   */
  formula?: string | null;
  derived_scope?: "device" | "plant" | null;
}

/** Adding a metric is an INSERT here, never a column and never a migration. */
export async function createTag(body: TagCreate): Promise<unknown> {
  return request("/catalog/tags", { method: "POST", body });
}

export type TagUpdate = Partial<Omit<TagCreate, "code">> & {
  /** A formula is removed by asking — null is indistinguishable from "unchanged". */
  clear_formula?: boolean;
};

/**
 * Edit a metric: its unit, its bounds, its scale, or its formula.
 *
 * ⚠ Not retrospective. A scale corrected today applies from today; Readings
 * already decoded under the old one are repaired only by replaying `mqtt_raw`,
 * which the backend does and this screen cannot.
 */
export async function updateTag(
  tagId: number,
  body: TagUpdate,
): Promise<Tag> {
  return parse(
    TagSchema,
    await request(`/catalog/tags/${tagId}`, { method: "PATCH", body }),
    `PATCH /catalog/tags/${tagId}`,
  );
}

/** Which Tags form the columns of a per-Device summary table, by Device Type. */
export async function deviceTableColumns(): Promise<DeviceTableColumns> {
  const body = await request("/catalog/device-table-columns");
  return parse(
    DeviceTableColumnsSchema,
    body,
    "GET /catalog/device-table-columns",
  );
}
