/**
 * What each status code means at a Plant, as the client says (migration 0032).
 *
 * A Device's status code (`DEVICE_STATUS`, the Inverter's `STS` key) is a
 * number whose meaning depends on the make, so the client states it per Plant,
 * per Device Type and per Tag. `observed` lists the codes the Plant's equipment
 * actually sent this week, so meanings are given to what arrives. A code
 * nobody has described is shown as sent, never guessed at.
 */

import { z } from "zod";
import { request } from "../client";
import { parse } from "../schemas";

export const StatusKindSchema = z.enum(["normal", "standby", "warning", "fault"]);
export type StatusKind = z.infer<typeof StatusKindSchema>;

export const StatusCodeSchema = z.object({
  id: z.number(),
  device_type_code: z.string(),
  tag_code: z.string(),
  tag_name: z.string(),
  code: z.number(),
  label: z.string(),
  kind: StatusKindSchema,
  note: z.string().nullable(),
  updated_at: z.string(),
  updated_by: z.string().nullable(),
});
export type StatusCode = z.infer<typeof StatusCodeSchema>;

export const ObservedCodeSchema = z.object({
  device_type_code: z.string(),
  tag_code: z.string(),
  tag_name: z.string(),
  code: z.number(),
  devices: z.number(),
  last_seen: z.string(),
  /** The payload keys it arrives as — `STS` on the client's Inverters. */
  source_keys: z.array(z.string()).optional().catch(undefined),
});
export type ObservedCode = z.infer<typeof ObservedCodeSchema>;

export const PlantStatusCodesSchema = z.object({
  plant_id: z.number(),
  codes: z.array(StatusCodeSchema),
  observed: z.array(ObservedCodeSchema),
  can_edit: z.boolean(),
});
export type PlantStatusCodes = z.infer<typeof PlantStatusCodesSchema>;

export interface StatusCodeInput {
  device_type_code: string;
  tag_code: string;
  code: number;
  label: string;
  kind: StatusKind;
  note?: string | null;
}

export async function plantStatusCodes(plantId: number): Promise<PlantStatusCodes> {
  return parse(
    PlantStatusCodesSchema,
    await request(`/plants/${plantId}/status-codes`),
    `GET /plants/${plantId}/status-codes`,
  );
}

export async function setStatusCode(plantId: number, body: StatusCodeInput): Promise<void> {
  await request(`/plants/${plantId}/status-codes`, { method: "PUT", body });
}

export async function deleteStatusCode(plantId: number, codeId: number): Promise<void> {
  await request(`/plants/${plantId}/status-codes/${codeId}`, { method: "DELETE" });
}
