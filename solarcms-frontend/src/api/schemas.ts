/**
 * zod schemas mirroring the API's responses.
 *
 * Parsing rather than casting is the point (FRONTEND_SPEC §1). Two concrete
 * hazards it catches:
 *
 * - A KPI's `value` is `null` when the figure is undefined (§4.3). Parsed, that
 *   is a union the caller must handle; cast, it becomes `NaN` on a chart axis.
 * - Postgres `NUMERIC` columns can serialise as either a JSON number or a
 *   string depending on the driver path. `numeric()` normalises both rather than
 *   letting `"12.5" * 2` reach a calculation.
 */

import { z } from "zod";

/** A NUMERIC/DECIMAL column: number or numeric string, never silently NaN. */
const numeric = () =>
  z.union([z.number(), z.string()]).transform((value, ctx) => {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `not a number: ${value}`,
      });
      return z.NEVER;
    }
    return parsed;
  });

const nullableNumeric = () => numeric().nullable().catch(null);

// ── Auth ────────────────────────────────────────────────────────────────────

export const TokenPairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  token_type: z.string().default("bearer"),
  expires_at: z.string(),
});
export type TokenPair = z.infer<typeof TokenPairSchema>;

export const MePlantSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
});

export const MeSchema = z.object({
  user_id: z.number(),
  client_id: z.number().nullable(),
  role: z.string().nullable(),
  platform_admin: z.boolean(),
  // A-4. Gate on these, never on `role` (Guardrail 5).
  permissions: z.array(z.string()),
  // A-2. Already RLS-filtered; an empty array means zero Plants, not all (I-5).
  plants: z.array(MePlantSchema),
  // A-3. Which routes exist at all.
  dashboards: z.array(z.string()),
});
export type Me = z.infer<typeof MeSchema>;
export type MePlant = z.infer<typeof MePlantSchema>;

// ── Catalog ─────────────────────────────────────────────────────────────────

export const TagCategorySchema = z.enum([
  "performance",
  "electrical",
  "diagnostic",
  "environmental",
  "status",
]);
export type TagCategory = z.infer<typeof TagCategorySchema>;

export const TagSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  // ⚠ Rendered verbatim, never converted (§4.1). The client's own schedule mixes
  // kWh and MWh inside one Device and labels a current in kV.
  unit: z.string(),
  category: TagCategorySchema.catch("diagnostic"),
  rollup_method: z.string(),
  scale_default: nullableNumeric(),
  valid_min: nullableNumeric(),
  valid_max: nullableNumeric(),
  min_interval_s: z.number(),
  is_cumulative: z.boolean(),
});
export type Tag = z.infer<typeof TagSchema>;

export const DeviceTypeSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  in_power_path: z.boolean(),
  variant_set: z.array(z.string()).nullable().catch(null),
});
export type DeviceType = z.infer<typeof DeviceTypeSchema>;

export const DeviceModelSchema = z.object({
  id: z.number(),
  manufacturer: z.string().nullable(),
  model_code: z.string(),
  variant: z.string().nullable(),
  device_type_code: z.string(),
});
export type DeviceModel = z.infer<typeof DeviceModelSchema>;

/** A Model's signal schedule — a starting point for a Device's bindings, not their authority. */
export const DeviceModelTagSchema = z.object({
  tag_id: z.number(),
  tag_code: z.string(),
  name: z.string(),
  unit: z.string(),
  category: z.string(),
  scale_default: z.number(),
  valid_min: z.number().nullable(),
  valid_max: z.number().nullable(),
  default_source_key: z.string().nullable(),
});
export type DeviceModelTag = z.infer<typeof DeviceModelTagSchema>;

// ── Plants ──────────────────────────────────────────────────────────────────

export const PlantStatusSchema = z.enum([
  "draft",
  "commissioning",
  "active",
  "suspended",
  "decommissioned",
]);
export type PlantStatus = z.infer<typeof PlantStatusSchema>;

export const PlantListItemSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  ac_capacity_kw: nullableNumeric(),
  dc_capacity_kwp: nullableNumeric(),
  region_code: z.string().nullable(),
  device_count: z.number(),
});
export type PlantListItem = z.infer<typeof PlantListItemSchema>;

export const PlantPageSchema = z.object({
  items: z.array(PlantListItemSchema),
  // Cursor pagination. Follow this; never construct an offset (§6.2).
  next_cursor: z.string().nullable(),
});
export type PlantPage = z.infer<typeof PlantPageSchema>;

/** `GET /plants/{id}` is `SELECT p.*`, so it is permissive by design. */
export const PlantDetailSchema = z
  .object({
    id: z.number(),
    code: z.string(),
    name: z.string(),
    status: z.string(),
    ac_capacity_kw: nullableNumeric(),
    dc_capacity_kwp: nullableNumeric(),
    latitude: nullableNumeric(),
    longitude: nullableNumeric(),
    // Timestamps render in the Plant's timezone, never the browser's (§4.4).
    timezone: z.string().default("Asia/Kolkata"),
    region_code: z.string().nullable(),
    grid_factor: nullableNumeric(),
    commissioned_on: z.string().nullable(),
  })
  .passthrough();
export type PlantDetail = z.infer<typeof PlantDetailSchema>;

export const BlockSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  capacity_kwp: numeric(),
  device_count: z.number(),
});
export type Block = z.infer<typeof BlockSchema>;

// ── KPIs ────────────────────────────────────────────────────────────────────

/**
 * A KPI figure. `value: null` means *undefined*, not zero — PR is undefined at
 * night, and rendering it as 0% tells an operator their Plant failed (§4.3).
 * `variant` names the provisional formula and must be surfaced (OPEN-16).
 */
export const KpiFigureSchema = z.object({
  value: nullableNumeric(),
  variant: z.string().nullable(),
  undefined_reason: z.string().nullable(),
});
export type KpiFigure = z.infer<typeof KpiFigureSchema>;

export const PlantKpisSchema = z.object({
  plant_id: z.number(),
  period: z.string(),
  energy_kwh: numeric(),
  performance_ratio: KpiFigureSchema,
  cuf: KpiFigureSchema,
  availability: KpiFigureSchema,
  co2_avoided_kg: KpiFigureSchema,
  assumptions_note: z.string(),
});
export type PlantKpis = z.infer<typeof PlantKpisSchema>;

export const BlockKpisSchema = z.object({
  block_id: z.number(),
  period: z.string(),
  capacity_kwp: numeric(),
  energy_kwh: numeric(),
  specific_yield: KpiFigureSchema,
  assumptions_note: z.string(),
});
export type BlockKpis = z.infer<typeof BlockKpisSchema>;

export const KPI_PERIODS = ["today", "month", "year", "lifetime"] as const;
export type KpiPeriod = (typeof KPI_PERIODS)[number];

// ── Devices ─────────────────────────────────────────────────────────────────

export const CommStatusSchema = z
  .enum(["online", "degraded", "offline", "unknown"])
  .catch("unknown");
export type CommStatus = z.infer<typeof CommStatusSchema>;

export const DeviceListItemSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  // Three independent groupings; collapsing any two makes both unanswerable.
  block_id: z.number().nullable(), // where it is — geographic
  parent_device_id: z.number().nullable(), // what it feeds — electrical (the SLD)
  reports_via_device_id: z.number().nullable(), // what transmits it — communication
  source_address: z.string().nullable(),
  // Health thresholds multiply this, so it is shown wherever health is shown.
  expected_interval_s: z.number(),
  type_code: z.string(),
  in_power_path: z.boolean(),
  variant: z.string().nullable(),
  comm_status: CommStatusSchema.nullable(),
  last_seen_at: z.string().nullable(),
  frozen_tag_count: z.number().nullable(),
});
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;

export const DeviceDetailSchema = DeviceListItemSchema.extend({
  plant_id: z.number(),
  device_model_id: z.number(),
  serial_number: z.string().nullable(),
  rated_capacity_kw: nullableNumeric(),
  installed_on: z.string().nullable(),
  completeness_24h: nullableNumeric(),
}).passthrough();
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>;

export const BindingSchema = z.object({
  id: z.number(),
  source_key: z.string(),
  tag_id: z.number(),
  tag_code: z.string(),
  unit: z.string(),
  scale: numeric(),
  value_offset: numeric(),
  valid_min: nullableNumeric(),
  valid_max: nullableNumeric(),
  enabled: z.boolean(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const CredentialSchema = z.object({
  username: z.string(),
  password: z.string(),
  topic_scope: z.string(),
  note: z.string(),
});
export type Credential = z.infer<typeof CredentialSchema>;

// ── Single Line Diagram ─────────────────────────────────────────────────────

export interface SldNodeData {
  device_id: number;
  code: string;
  name: string;
  type: string;
  variant: string | null;
  children: SldNodeData[];
}

export const SldNodeSchema: z.ZodType<SldNodeData> = z.lazy(() =>
  z.object({
    device_id: z.number(),
    code: z.string(),
    name: z.string(),
    type: z.string(),
    variant: z.string().nullable(),
    children: z.array(SldNodeSchema),
  }),
);

export const SldSchema = z.object({
  plant_id: z.number(),
  roots: z.array(SldNodeSchema),
  device_count: z.number(),
  // Not an error: a Weather Station and a PPC are real, monitored Devices that
  // carry no current. They belong in a side panel, not the tree (§6.4).
  excluded_not_in_power_path: z.array(
    z.object({ device_id: z.number(), code: z.string(), type: z.string() }),
  ),
  // A data problem worth surfacing — dropping these makes the diagram claim the
  // Plant has less equipment than it does.
  orphaned: z.array(z.object({ device_id: z.number(), code: z.string() })),
});
export type Sld = z.infer<typeof SldSchema>;

// ── Readings ────────────────────────────────────────────────────────────────

/** 0 good · 1 out of range · 2 stale · 3 unparseable (§4.2). */
export const QualitySchema = z.number().int().min(0).max(3).catch(3);

export const ReadingPointSchema = z
  .object({
    bucket: z.string(),
    device_id: z.number(),
    tag_id: z.number(),
    tag_code: z.string(),
    value: nullableNumeric(),
    quality: QualitySchema.nullable(),
    // Present only on aggregate tiers. The read path already picked `value`
    // using the Tag's rollup_method; these are for min/max bands.
    avg_value: nullableNumeric().optional(),
    min_value: nullableNumeric().optional(),
    max_value: nullableNumeric().optional(),
    last_value: nullableNumeric().optional(),
    sample_count: z.number().nullable().optional(),
    rollup_method: z.string().nullable().optional(),
  })
  .passthrough();
export type ReadingPoint = z.infer<typeof ReadingPointSchema>;

export const TIERS = [
  "readings",
  "agg_1m",
  "agg_15m",
  "agg_1h",
  "agg_1d",
] as const;
export type Tier = (typeof TIERS)[number];

export const ReadingsResponseSchema = z.object({
  // Surface this: a chart of a year is daily averages, and an unlabelled
  // smoothed line reads as a measurement (§9).
  tier: z.enum(TIERS),
  resolution_requested: z.string(),
  from: z.string(),
  to: z.string(),
  count: z.number(),
  items: z.array(ReadingPointSchema),
});
export type ReadingsResponse = z.infer<typeof ReadingsResponseSchema>;

// ── Alarms ──────────────────────────────────────────────────────────────────

export const AlarmStateSchema = z.enum(["active", "acknowledged", "resolved"]);
export const AlarmSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
]);
export type AlarmState = z.infer<typeof AlarmStateSchema>;
export type AlarmSeverity = z.infer<typeof AlarmSeveritySchema>;

export const AlarmSchema = z.object({
  id: z.number(),
  state: AlarmStateSchema,
  severity: AlarmSeveritySchema,
  opened_at: z.string(),
  acknowledged_at: z.string().nullable(),
  resolved_at: z.string().nullable(),
  message: z.string(),
  trigger_value: nullableNumeric(),
  // Tender §18 keeps communication and equipment separate, so the filter must.
  classification: z.string().nullable(),
  // An Alarm at L2 has already woken somebody.
  escalation_level: z.number(),
  device_id: z.number().nullable(),
  plant_id: z.number().nullable(),
  device_code: z.string().nullable(),
  rule_code: z.string(),
});
export type Alarm = z.infer<typeof AlarmSchema>;

export const AlarmRuleSchema = z.object({
  id: z.number(),
  // NULL means a platform default: read-only to a Client (§7.3).
  client_id: z.number().nullable(),
  code: z.string(),
  name: z.string(),
  scope_type: z.string(),
  scope_id: z.number().nullable(),
  operator: z.string(),
  threshold: nullableNumeric(),
  threshold_high: nullableNumeric(),
  clear_threshold: nullableNumeric(),
  duration_s: z.number(),
  severity: AlarmSeveritySchema,
  enabled: z.boolean(),
  tag_code: z.string().nullable(),
  device_type_code: z.string().nullable(),
});
export type AlarmRule = z.infer<typeof AlarmRuleSchema>;

/** `is_true`/`is_false` carry no threshold — the contact is the condition. */
export const BOOLEAN_OPERATORS = ["is_true", "is_false"] as const;
export const OPERATORS = [
  "gt",
  "gte",
  "lt",
  "lte",
  "eq",
  "neq",
  "outside",
  "inside",
  ...BOOLEAN_OPERATORS,
] as const;
export function operatorNeedsThreshold(operator: string): boolean {
  return !(BOOLEAN_OPERATORS as readonly string[]).includes(operator);
}

// ── Health ──────────────────────────────────────────────────────────────────

export const DeviceHealthSchema = z.object({
  device_id: z.number(),
  device_code: z.string(),
  plant_id: z.number(),
  comm_status: CommStatusSchema,
  last_seen_at: z.string().nullable(),
  frozen_tag_count: z.number().nullable(),
  completeness_24h: nullableNumeric(),
  updated_at: z.string().nullable(),
  expected_interval_s: z.number(),
  reports_via_device_id: z.number().nullable(),
});
export type DeviceHealth = z.infer<typeof DeviceHealthSchema>;

export const SystemHealthSchema = z.object({
  ingest_lag_seconds: nullableNumeric(),
  quarantined_last_hour: z.number(),
  alarm_stream_depth: z.number(),
  continuous_aggregates: z.array(
    z.object({ view: z.string(), last_refresh: z.string().nullable() }),
  ),
});
export type SystemHealth = z.infer<typeof SystemHealthSchema>;

// ── Reports ─────────────────────────────────────────────────────────────────

export const ReportDefinitionSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  // I-11: a Financial Report needs an ABT Meter and is refused with 409 without
  // one. The flag lets the UI warn before the request rather than after.
  is_financial: z.boolean(),
  query_spec: z.unknown().nullable(),
});
export type ReportDefinition = z.infer<typeof ReportDefinitionSchema>;

export const ReportRunRequestSchema = z.object({
  run_id: z.number(),
  state: z.string(),
  created_at: z.string(),
});

export const ReportRunSchema = z.object({
  id: z.number(),
  state: z.enum(["queued", "running", "succeeded", "failed"]).catch("queued"),
  period_start: z.string(),
  period_end: z.string(),
  // Signed, expiring URLs. `pdf_unavailable` is a *message*, not a URL: the run
  // succeeded and the XLSX exists (§6.7).
  artifact_urls: z.record(z.string()).nullable(),
  row_count: z.number().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
export type ReportRun = z.infer<typeof ReportRunSchema>;

// ── Users, Clients, Audit ───────────────────────────────────────────────────

export const UserSchema = z.object({
  id: z.number(),
  email: z.string(),
  full_name: z.string().nullable(),
  is_active: z.boolean(),
  last_login_at: z.string().nullable(),
  role_code: z.string(),
  // Zero assignments means zero Plants, never full access (I-5, Guardrail 7).
  assigned_plants: z.number(),
});
export type User = z.infer<typeof UserSchema>;

export const RegionSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  country: z.string(),
  // CO₂-avoided divides by this; null means "no figure", never zero (tender §18).
  grid_emission_factor_kg_per_kwh: z.coerce.number().nullable(),
  created_at: z.string(),
});
export type Region = z.infer<typeof RegionSchema>;

export const ClientSchema = z.object({
  id: z.number(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  is_demo: z.boolean(),
  created_at: z.string(),
  // ⚠ Commercial identity is PROPOSED, not client-confirmed (migration 0019).
  // Nullable throughout and `.nullish()` rather than `.nullable()`: a Client
  // created before the migration has none of these, and a response that omits
  // the key entirely must still parse.
  client_number: z.string().nullish(),
  gst_number: z.string().nullish(),
  contact_email: z.string().nullish(),
  contract_start_date: z.string().nullish(),
  // A real date, not the day count the creation form asks for — the API does
  // that addition once, so nothing downstream recomputes an expiry that would
  // change with every passing day.
  contract_valid_till: z.string().nullish(),
});
export type Client = z.infer<typeof ClientSchema>;

export const AuditEntrySchema = z.object({
  id: z.number(),
  client_id: z.number().nullable(),
  user_id: z.number().nullable(),
  actor_email: z.string().nullable(),
  action: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.number().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  occurred_at: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// ── Live socket ─────────────────────────────────────────────────────────────

export const LiveFrameSchema = z.object({
  client_id: z.number(),
  plant_id: z.number(),
  device_id: z.number(),
  // ⚠ Keyed by tag_id **as a string**. Join against /catalog/tags for code and
  // unit; the socket carries neither (§5.1).
  values: z.record(numeric()),
  at: z.string(),
});
export type LiveFrame = z.infer<typeof LiveFrameSchema>;

export const LiveControlSchema = z.union([
  z.object({ type: z.literal("subscribed"), rooms: z.array(z.string()) }),
  z.object({ type: z.literal("no_rooms"), detail: z.string() }),
]);

/**
 * Parse with a named context so a schema drift shows up as a legible console
 * error rather than a component rendering `undefined`.
 */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  context: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.error(
      `[schema] ${context} did not match:`,
      result.error.format(),
      data,
    );
    throw new Error(`Unexpected response shape from ${context}`);
  }
  return result.data;
}
