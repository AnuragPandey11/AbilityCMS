/**
 * A Plant's forecast, from its own history only — no weather forecast (the
 * user's choice, 8 Oct 2026). `services/forecast.py` has the method.
 *
 * The power forecast is of the figure the Current Power card shows (the same
 * resolved source), and the energy forecast of "Energy Generated". Either can
 * be `null` with a sentence saying why — a Plant too new, or one whose history
 * has too many holes, is told so rather than shown a guess.
 */

import { z } from "zod";
import { request } from "../client";
import { nullableNumeric, parse } from "../schemas";

const SourceSchema = z.object({
  device_type_code: z.string().nullable(),
  tag_code: z.string().nullable(),
  aggregate: z.string().nullable(),
  device_count: z.number().nullable(),
});

const AccuracySchema = z.object({
  horizon_minutes: z.number().optional(),
  samples: z.number(),
  mae: nullableNumeric(),
  relative: nullableNumeric(),
});
export type ForecastAccuracy = z.infer<typeof AccuracySchema>;

const PowerSchema = z.object({
  unit: z.string().nullable(),
  source: SourceSchema,
  history_days: z.number(),
  unavailable: z.string().optional(),
  now: z.object({ at: z.string(), value: nullableNumeric() }).optional(),
  clearness: nullableNumeric().optional(),
  next_15m: z.object({ at: z.string(), value: nullableNumeric() }).optional(),
  next_1h: z.object({ at: z.string(), value: nullableNumeric() }).optional(),
  today: z
    .array(
      z.object({
        at: z.string(),
        actual: nullableNumeric(),
        forecast: nullableNumeric(),
        typical: nullableNumeric(),
        low: nullableNumeric(),
        high: nullableNumeric(),
      }),
    )
    .optional(),
  day_ahead: z
    .object({
      date: z.string(),
      profile: z.array(
        z.object({
          at: z.string(),
          forecast: nullableNumeric(),
          low: nullableNumeric(),
          high: nullableNumeric(),
        }),
      ),
    })
    .optional(),
  accuracy: z.array(AccuracySchema).optional(),
  versus_actual: z
    .array(z.object({ at: z.string(), forecast: nullableNumeric(), actual: nullableNumeric() }))
    .optional(),
});
export type PowerForecast = z.infer<typeof PowerSchema>;

const DaySchema = z.object({
  date: z.string(),
  value: nullableNumeric(),
  low: nullableNumeric(),
  high: nullableNumeric(),
});

const EnergySchema = z.object({
  unit: z.string().nullable(),
  source: SourceSchema,
  complete_days: z.number(),
  unavailable: z.string().optional(),
  history_days: z.number().optional(),
  tomorrow: DaySchema.optional(),
  week: z.array(DaySchema).optional(),
  versus_actual: z
    .array(
      z.object({
        date: z.string(),
        forecast: nullableNumeric(),
        low: nullableNumeric(),
        high: nullableNumeric(),
        actual: nullableNumeric(),
      }),
    )
    .optional(),
  accuracy: AccuracySchema.optional(),
});
export type EnergyForecast = z.infer<typeof EnergySchema>;

export const PlantForecastSchema = z.object({
  plant_id: z.number(),
  generated_at: z.string(),
  timezone: z.string(),
  method: z.string(),
  power: PowerSchema.nullable(),
  energy: EnergySchema.nullable(),
  power_unavailable: z.string().optional(),
  energy_unavailable: z.string().optional(),
});
export type PlantForecast = z.infer<typeof PlantForecastSchema>;

export async function plantForecast(plantId: number): Promise<PlantForecast> {
  return parse(
    PlantForecastSchema,
    await request(`/plants/${plantId}/forecast`),
    `GET /plants/${plantId}/forecast`,
  );
}
