/**
 * Performance History (`GET /plants/{id}/history`) and the planned work drawn
 * on the history screens' time axes (`GET /operations/maintenance`).
 *
 * The history's days and months are the Reports' own arithmetic
 * (`services/performance_history.py`): a month here is the Monthly Plant
 * Report's row for it. Every figure may be `null` — a day nothing measured —
 * which is never 0 (Guardrail 23); PR arrives as a percentage, flagged when it
 * is outside what it can physically be and never clamped (Guardrail 33).
 */

import { z } from "zod";
import { request } from "../client";
import { nullableNumeric, parse } from "../schemas";

const HistoryDaySchema = z.object({
  date: z.string(),
  in_progress: z.boolean(),
  energy_kwh: nullableNumeric(),
  irradiation_kwh_m2: nullableNumeric(),
  specific_yield: nullableNumeric(),
  performance_ratio: nullableNumeric(),
  performance_ratio_flagged: z.boolean(),
  peak_power_kw: nullableNumeric(),
  coverage: nullableNumeric(),
});
export type HistoryDay = z.infer<typeof HistoryDaySchema>;

const HistoryMonthSchema = z.object({
  month: z.string(),
  days: z.number(),
  energy_kwh: nullableNumeric(),
  irradiation_kwh_m2: nullableNumeric(),
  specific_yield: nullableNumeric(),
  performance_ratio: nullableNumeric(),
  performance_ratio_flagged: z.boolean(),
  cuf: nullableNumeric(),
  cuf_flagged: z.boolean(),
  peak_power_kw: nullableNumeric(),
  coverage: nullableNumeric(),
});
export type HistoryMonth = z.infer<typeof HistoryMonthSchema>;

export const PlantHistorySchema = z.object({
  plant_id: z.number(),
  timezone: z.string(),
  first_day: z.string(),
  last_day: z.string(),
  dc_capacity_kwp: nullableNumeric(),
  ac_capacity_kw: nullableNumeric(),
  energy_label: z.string(),
  source_tier: z.string(),
  stats_tier: z.string(),
  days: z.array(HistoryDaySchema),
  months: z.array(HistoryMonthSchema),
  totals: z.object({
    days: z.number(),
    days_with_energy: z.number(),
    energy_kwh: nullableNumeric(),
    irradiation_kwh_m2: nullableNumeric(),
    specific_yield: nullableNumeric(),
    performance_ratio: nullableNumeric(),
    performance_ratio_flagged: z.boolean(),
    peak_power_kw: nullableNumeric(),
    pr_energy_share: nullableNumeric(),
  }),
  notes: z.array(z.string()),
  generated_at: z.string(),
});
export type PlantHistory = z.infer<typeof PlantHistorySchema>;

/** `first` and `last` are Plant-local `YYYY-MM-DD`, both inclusive; at most 366 days. */
export async function getPlantHistory(plantId: number, first: string, last: string): Promise<PlantHistory> {
  const body = await request(`/plants/${plantId}/history`, {
    params: { from_date: first, to_date: last },
  });
  return parse(PlantHistorySchema, body, "GET /plants/{id}/history");
}

const MaintenanceWindowSchema = z
  .object({
    id: z.number(),
    plant_id: z.number(),
    device_id: z.number().nullable(),
    device_code: z.string().nullable(),
    starts_at: z.string(),
    ends_at: z.string().nullable(),
    reason: z.string().nullable(),
  })
  .passthrough();
export type MaintenanceWindow = z.infer<typeof MaintenanceWindowSchema>;

/** Needs `plant.manage` on the server; ask only where the session holds it. */
export async function listMaintenance(plantId: number): Promise<MaintenanceWindow[]> {
  const body = await request("/operations/maintenance", { params: { plant_id: plantId } });
  return parse(z.array(MaintenanceWindowSchema), body, "GET /operations/maintenance");
}
