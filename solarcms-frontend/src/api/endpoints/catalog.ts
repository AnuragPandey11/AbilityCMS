import { request } from "../client";
import {
  DeviceModelSchema,
  DeviceModelTagSchema,
  DeviceTypeSchema,
  TagSchema,
  parse,
  type DeviceModel,
  type DeviceModelTag,
  type DeviceType,
  type Tag,
} from "../schemas";
import { z } from "zod";

/**
 * The Tag registry. Units live here and nowhere else in the frontend (§4.1,
 * Guardrail 2) — a hard-coded unit is wrong by a factor of 1000 sooner or later.
 */
export async function tags(): Promise<Tag[]> {
  return parse(
    z.array(TagSchema),
    await request("/catalog/tags"),
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

export async function deviceModels(): Promise<DeviceModel[]> {
  return parse(
    z.array(DeviceModelSchema),
    await request("/catalog/device-models"),
    "GET /catalog/device-models",
  );
}

export async function deviceModelTags(
  modelId: number,
): Promise<DeviceModelTag[]> {
  return parse(
    z.array(DeviceModelTagSchema),
    await request(`/catalog/device-models/${modelId}/tags`),
    "GET /catalog/device-models/{id}/tags",
  );
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
}

/** Adding a metric is an INSERT here, never a column and never a migration. */
export async function createTag(body: TagCreate): Promise<unknown> {
  return request("/catalog/tags", { method: "POST", body });
}
