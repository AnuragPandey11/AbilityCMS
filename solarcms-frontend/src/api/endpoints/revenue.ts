/**
 * Revenue: exported energy × the Plant's tariff (`services/revenue.py`,
 * ⚠ PROPOSED — the user's choices of 1 Nov 2026).
 *
 * Export is the ABT Meter's where the Plant has one; otherwise the MFM's, and
 * `basis` is then `estimate` — the screen must say so beside every figure,
 * because only the ABT Meter is the settlement instrument (I-11). Every figure
 * may be `null` with a reason: no tariff recorded, or no register read twice,
 * is never ₹0.
 */

import { z } from "zod";
import { request } from "../client";
import { nullableNumeric, parse } from "../schemas";

const SourceSchema = z.object({
  basis: z.enum(["settlement", "estimate"]).nullable(),
  export_device_type_code: z.string().nullable(),
  export_device_types: z.array(z.string()),
  export_device_count: z.number(),
  generation_device_type_code: z.string().nullable(),
  words: z.string().nullable(),
});
export type RevenueSource = z.infer<typeof SourceSchema>;

const FiguresSchema = z.object({
  generated_kwh: nullableNumeric(),
  exported_kwh: nullableNumeric(),
  imported_kwh: nullableNumeric(),
  revenue_inr: nullableNumeric(),
  revenue_reason: z.string().nullable(),
});

const PeriodSchema = FiguresSchema.extend({
  label: z.string(),
  source: SourceSchema,
  refused_steps: z.number(),
  expected: z.object({
    exported_kwh: nullableNumeric(),
    revenue_inr: nullableNumeric(),
    reason: z.string().nullable(),
    days_carried: z.number(),
  }),
  loss: z.object({
    value: nullableNumeric(),
    floor: z.boolean(),
    missing: z.array(z.string()),
    reason: z.string().nullable(),
    downtime_hours: nullableNumeric().optional(),
  }),
});
export type RevenuePeriod = z.infer<typeof PeriodSchema>;

export const REVENUE_PERIODS = ["today", "month", "year"] as const;
export type RevenuePeriodCode = (typeof REVENUE_PERIODS)[number];

export const PlantRevenueSchema = z.object({
  plant_id: z.number(),
  timezone: z.string(),
  computed_at: z.string(),
  tariff_inr_per_kwh: nullableNumeric(),
  financial_year_start_month: z.number(),
  settlement_device_type_code: z.string(),
  periods: z.object({ today: PeriodSchema, month: PeriodSchema, year: PeriodSchema }),
  rule: z.record(z.string()),
});
export type PlantRevenue = z.infer<typeof PlantRevenueSchema>;

export const REVENUE_GRANULARITIES = ["day", "month", "year"] as const;
export type RevenueGranularity = (typeof REVENUE_GRANULARITIES)[number];

const TrendPointSchema = FiguresSchema.extend({
  key: z.string(),
  label: z.string(),
  first_day: z.string(),
  last_day: z.string(),
  in_progress: z.boolean(),
  basis: z.enum(["settlement", "estimate"]).nullable(),
});
export type RevenueTrendPoint = z.infer<typeof TrendPointSchema>;

export const RevenueTrendSchema = z.object({
  plant_id: z.number(),
  granularity: z.enum(REVENUE_GRANULARITIES),
  timezone: z.string(),
  tariff_inr_per_kwh: nullableNumeric(),
  source: SourceSchema,
  points: z.array(TrendPointSchema),
  notes: z.array(z.string()),
});
export type RevenueTrend = z.infer<typeof RevenueTrendSchema>;

const FleetRowSchema = FiguresSchema.extend({
  plant_id: z.number(),
  code: z.string(),
  name: z.string(),
  client_name: z.string().nullable(),
  tariff_inr_per_kwh: nullableNumeric(),
  source: SourceSchema,
});
export type FleetRevenueRow = z.infer<typeof FleetRowSchema>;

export const FleetRevenueSchema = z.object({
  period: z.enum(REVENUE_PERIODS),
  computed_at: z.string(),
  plants: z.array(FleetRowSchema),
});
export type FleetRevenue = z.infer<typeof FleetRevenueSchema>;

export async function plantRevenue(plantId: number): Promise<PlantRevenue> {
  return parse(
    PlantRevenueSchema,
    await request(`/plants/${plantId}/revenue`),
    `GET /plants/${plantId}/revenue`,
  );
}

export async function revenueTrend(plantId: number, granularity: RevenueGranularity): Promise<RevenueTrend> {
  return parse(
    RevenueTrendSchema,
    await request(`/plants/${plantId}/revenue/trend`, { params: { granularity } }),
    `GET /plants/${plantId}/revenue/trend`,
  );
}

export async function fleetRevenue(period: RevenuePeriodCode): Promise<FleetRevenue> {
  return parse(
    FleetRevenueSchema,
    await request("/revenue/plants", { params: { period } }),
    "GET /revenue/plants",
  );
}
