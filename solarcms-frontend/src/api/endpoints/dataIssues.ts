/**
 * Data Issues — what the broker sends that the platform cannot use or does not
 * trust, one Plant at a time, each with the facts its fix needs.
 *
 * Read here; fixed through the routes that already own each change (bindings,
 * topics, the Device and the Plant), so every fix keeps those routes' checks,
 * audit rows and cache invalidation. Only acknowledging is new.
 *
 * ⚠ `can_see_unregistered` is false for anyone but a platform administrator:
 * an unregistered topic is quarantined with no Client (Guardrail 5). The screen
 * must then say it cannot see them — never imply there are none.
 */

import { z } from "zod";
import { request } from "../client";
import { parse } from "../schemas";

export const IssueCategorySchema = z.enum(["data_lost", "data_wrong", "setup"]);
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

export const AcknowledgementSchema = z.object({
  id: z.number(),
  note: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
});
export type Acknowledgement = z.infer<typeof AcknowledgementSchema>;

export const DataIssueSchema = z.object({
  /** Stable for as long as the same thing is wrong — what an acknowledgement names. */
  key: z.string(),
  kind: z.string(),
  category: IssueCategorySchema,
  title: z.string(),
  detail: z.string(),
  device_id: z.number().nullable(),
  device_code: z.string().nullable(),
  /** Per kind; read through the accessors in `admin/dataIssues/facts.ts`. */
  facts: z.record(z.unknown()),
  acknowledged: AcknowledgementSchema.nullable(),
});
export type DataIssue = z.infer<typeof DataIssueSchema>;

export const IssueCountsSchema = z.object({
  data_lost: z.number(),
  data_wrong: z.number(),
  setup: z.number(),
  acknowledged: z.number(),
});
export type IssueCounts = z.infer<typeof IssueCountsSchema>;

export const PlantDataIssuesSchema = z.object({
  plant_id: z.number(),
  generated_at: z.string(),
  can_see_unregistered: z.boolean(),
  counts: IssueCountsSchema,
  issues: z.array(DataIssueSchema),
});
export type PlantDataIssues = z.infer<typeof PlantDataIssuesSchema>;

export const UnregisteredPlantSchema = z.object({
  client_code: z.string(),
  plant_code: z.string(),
  client_registered: z.boolean(),
  topics: z.array(z.string()),
  last_seen: z.string(),
  messages: z.number(),
});
export type UnregisteredPlant = z.infer<typeof UnregisteredPlantSchema>;

export const DataIssuesSummarySchema = z.object({
  generated_at: z.string(),
  plants: z.array(z.object({
    plant_id: z.number(),
    code: z.string(),
    name: z.string(),
    counts: IssueCountsSchema,
  })),
  unregistered_plants: z.array(UnregisteredPlantSchema),
  can_see_unregistered: z.boolean(),
  /** Data being lost or wrong, open — never `setup`, never acknowledged. */
  open_urgent: z.number(),
});
export type DataIssuesSummary = z.infer<typeof DataIssuesSummarySchema>;

export async function plantDataIssues(plantId: number): Promise<PlantDataIssues> {
  return parse(
    PlantDataIssuesSchema,
    await request(`/plants/${plantId}/data-issues`),
    `GET /plants/${plantId}/data-issues`,
  );
}

export async function dataIssuesSummary(): Promise<DataIssuesSummary> {
  return parse(
    DataIssuesSummarySchema,
    await request("/data-issues/summary"),
    "GET /data-issues/summary",
  );
}

export async function acknowledge(
  plantId: number,
  issueKey: string,
  note: string | null,
): Promise<void> {
  await request(`/plants/${plantId}/data-issues/acknowledgements`, {
    method: "POST",
    body: { issue_key: issueKey, note },
  });
}

export async function unacknowledge(acknowledgementId: number): Promise<void> {
  await request(`/data-issues/acknowledgements/${acknowledgementId}`, {
    method: "DELETE",
  });
}
