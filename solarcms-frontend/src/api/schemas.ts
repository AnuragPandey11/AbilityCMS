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
  // The Client's own name, so a screen can say whose data it shows without
  // calling `GET /clients`, which is Super Admin only. Null for a platform
  // administrator, who is a member of no Client.
  client_code: z.string().nullable().catch(null),
  client_name: z.string().nullable().catch(null),
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
  // A calculated Tag: arithmetic over other Tag codes, held as data so that the
  // client's "Need to Calculate" rows are configuration rather than a release.
  // Null means a Device publishes this value.
  formula: z.string().nullable().catch(null),
  derived_scope: z.enum(["device", "plant"]).nullable().catch(null),
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
  device_type_name: z.string().optional().catch(undefined),
  in_power_path: z.boolean().optional().catch(undefined),
  rated_capacity_kw: nullableNumeric().optional(),
  // How many signals this Model schedules, and how far its repeating group runs
  // — enough to label the choice "Reference String Inverter, 23 signals + up to
  // 28 PV strings" without a second request per Model.
  signal_count: z.number().optional().catch(undefined),
  repeat_max: z.number().optional().catch(undefined),
  derived_count: z.number().optional().catch(undefined),
});
export type DeviceModel = z.infer<typeof DeviceModelSchema>;

/** A Model's signal schedule — a starting point for a Device's bindings, not their authority. */
export const DeviceModelTagSchema = z.object({
  tag_id: z.number(),
  tag_code: z.string(),
  name: z.string(),
  unit: z.string(),
  category: z.string(),
  scale_default: nullableNumeric(),
  valid_min: nullableNumeric(),
  valid_max: nullableNumeric(),
  default_source_key: z.string().nullable(),
  // Position in a repeating group (PV1..PV28); null for a signal appearing once.
  repeat_index: z.number().nullable().catch(null),
  sort_order: z.number().catch(0),
  // Marks a row nothing publishes: it is computed, and no source key will ever
  // arrive for it. The bindings screen must not show it as "unmapped".
  formula: z.string().nullable().catch(null),
  derived_scope: z.string().nullable().catch(null),
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
  // Every Plant belongs to exactly one Client. Carried on the row rather than
  // fetched per Plant, because a Super Admin sees several Clients' Plants in
  // one list and "whose is this" is the first question they ask of it.
  //
  // `client_code` and `client_name` can be null where the Client row itself is
  // not readable — a Guest on a non-demonstration Client can see the Plant and
  // not the Client. The id is always present; the label is not.
  client_id: z.number(),
  client_code: z.string().nullable().catch(null),
  client_name: z.string().nullable().catch(null),
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
    client_id: z.number().nullable().catch(null),
    // Needed by broker discovery, which is keyed on what the topic says rather
    // than on our ids. Nullable where the Client row itself is unreadable.
    client_code: z.string().nullable().catch(null),
    client_name: z.string().nullable().catch(null),
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

/**
 * How much of the period the figures beside it actually saw.
 *
 * ⚠ **Guardrail 18: never render a KPI without this.** A gap does not make a
 * figure look wrong, it makes it look *low* — an average over fewer samples is
 * still an average, a total over a hole is simply smaller, and for availability
 * a gap reads as nothing having happened. None of those announce themselves,
 * and nothing else on the response reveals them.
 *
 * It never corrects the figure, and neither may anything downstream: scaling a
 * total by `1 / ratio` is inventing data.
 *
 * `.catch(null)` rather than required, so a deployment where the API has not
 * yet shipped the block degrades to "coverage unknown" instead of blanking
 * every KPI on the screen with a parse failure.
 */
export const KpiCoverageSchema = z.object({
  /**
   * 0..1 — received samples over expected. Expected is counted per binding
   * against each Tag's own throttle, never per Device.
   *
   * **Null when nothing was expected**, which is what a Plant with no Devices
   * reports: `expected_samples` is 0, so there is no ratio to take. That is a
   * different statement from 0% coverage — nothing was missed, because nothing
   * was due — and collapsing the two is how a Plant that has not been
   * commissioned yet ends up reported as one that has gone dark.
   */
  ratio: nullableNumeric(),
  complete: z.boolean(),
  expected_samples: z.number(),
  received_samples: z.number(),
  missing_seconds: z.number(),
  /** Planned work. Excluded from coverage, so servicing does not degrade the
   *  figure a performance guarantee is paid on. */
  excluded_seconds: z.number(),
});
export type KpiCoverage = z.infer<typeof KpiCoverageSchema>;

export const PlantKpisSchema = z.object({
  plant_id: z.number(),
  period: z.string(),
  energy_kwh: numeric(),
  performance_ratio: KpiFigureSchema,
  cuf: KpiFigureSchema,
  availability: KpiFigureSchema,
  co2_avoided_kg: KpiFigureSchema,
  /** Which meter's counter the energy (and so PR, CUF, CO₂) came from. Only
   *  the part the screen names; optional for an API that predates it. */
  energy_source: z
    .object({
      device_type_code: z.string().nullable(),
      tag_code: z.string().nullable(),
      device_count: z.number(),
    })
    .nullable()
    .optional()
    .catch(null),
  /** The period's energy over DC capacity. Optional so an API that predates
   *  it degrades to "—" rather than failing the whole response. */
  specific_yield: KpiFigureSchema.nullable().optional().catch(null),
  coverage: KpiCoverageSchema.nullable().catch(null),
  /** Where the period began, in the Plant's calendar: its midnight, the 1st,
   *  1 January — or its first reading, for lifetime. */
  period_start: z.string().nullable().optional().catch(null),
  /** The later of that and the Plant's first reading: what CUF's hours count
   *  from. Later than `period_start` only for a Plant younger than the period. */
  measured_since: z.string().nullable().optional().catch(null),
  /** Which tier served these. A figure from `agg_1d` over "today" is a
   *  different resolution of claim than one from `agg_1m`. */
  source_tier: z.string().nullable().optional().catch(null),
  assumptions_note: z.string(),
});
export type PlantKpis = z.infer<typeof PlantKpisSchema>;

// ── Operating status ────────────────────────────────────────────────────────

/**
 * One Plant-local day's start and stop, from `GET /plants/{id}/operating-status`.
 *
 * `*_observed` is the part that keeps the card honest. A Plant first heard at
 * 13:55 already generating did not start at 13:55; it started somewhere in the
 * silence before, and `start_after` is the last moment it was known to be off
 * (null when nothing that day said so).
 */
export const OperatingDaySchema = z.object({
  date: z.string(),
  start_at: z.string().nullable(),
  start_after: z.string().nullable(),
  start_observed: z.boolean(),
  stop_at: z.string().nullable(),
  stop_after: z.string().nullable(),
  stop_observed: z.boolean(),
  /** Still generating at the day's last reading. */
  ended_running: z.boolean(),
  last_sample_at: z.string().nullable(),
  /**
   * Today only: already generating at midnight and heard without a break from
   * yesterday — so today has no start of its own, and it is not a start "by
   * 00:00" either.
   */
  start_carried_over: z.boolean().optional().catch(false),
  /** Yesterday only: the same run seen from the other side — it did not stop. */
  ran_past_midnight: z.boolean().optional().catch(false),
});
export type OperatingDay = z.infer<typeof OperatingDaySchema>;

export const OperatingStateSchema = z
  .enum(["running", "stopped", "not_started", "unknown"])
  .nullable()
  .catch(null);
export type OperatingState = z.infer<typeof OperatingStateSchema>;

export const GridStateSchema = z
  .enum(["connected", "disconnected", "partial", "unknown"])
  .nullable()
  .catch(null);

/**
 * Whether the Plant is generating, when it started and stopped, its peak and
 * the grid. Every rule is the backend's (`domain/operating`, thresholds in
 * `assumptions.py`) and is echoed back so the screen can say what it meant.
 */
export const OperatingStatusSchema = z.object({
  plant_id: z.number(),
  as_of: z.string(),
  operating: z.object({
    state: OperatingStateSchema,
    undefined_reason: z.string().nullable(),
    last_sample_at: z.string().nullable(),
    source: z.object({
      device_type_code: z.string(),
      tag_code: z.string(),
      aggregate: z.string(),
      device_count: z.number(),
      reporting: z.number(),
    }),
    start_above: numeric(),
    stop_at_or_below: numeric(),
    unit: z.string(),
    resolution: z.string(),
    flagged_buckets: z.number(),
  }),
  today: OperatingDaySchema,
  yesterday: OperatingDaySchema,
  peak: z.object({
    value: nullableNumeric(),
    at: z.string().nullable(),
    unit: z.string().nullable(),
    source: z
      .object({
        device_type_code: z.string().nullable(),
        tag_code: z.string(),
        aggregate: z.string(),
        device_count: z.number(),
      })
      .nullable(),
    undefined_reason: z.string().nullable(),
  }),
  grid: z.object({
    state: GridStateSchema,
    breakers: z.number(),
    reporting: z.number(),
    closed: z.number(),
    open: z.number(),
    undefined_reason: z.string().nullable(),
    source: z.object({ device_type_code: z.string(), tag_code: z.string() }),
  }),
});
export type OperatingStatus = z.infer<typeof OperatingStatusSchema>;

/**
 * The same rule for one Device on its own output — `GET /devices/{id}/operating-status`.
 * The Inverter view's "operating status", in place of a status code whose
 * meanings nobody has supplied.
 */
export const DeviceOperatingStatusSchema = z.object({
  device_id: z.number(),
  plant_id: z.number(),
  as_of: z.string(),
  operating: OperatingStatusSchema.shape.operating,
  today: OperatingDaySchema,
  yesterday: OperatingDaySchema,
});
export type DeviceOperatingStatus = z.infer<typeof DeviceOperatingStatusSchema>;

export const BlockKpisSchema = z.object({
  block_id: z.number(),
  period: z.string(),
  period_start: z.string().nullable().optional().catch(null),
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
  /**
   * The enclosure this Device sits in — an MCR, an ICR, a panel. Named by the
   * `{collector_code}` segment of the topic.
   *
   * ⚠ A Collector is **not a Device** and must never be drawn as one. It is a
   * box drawn *around* the Devices that share this value; nothing in the
   * electrical chain passes through it. `null` is a real answer, not a gap:
   * the five-segment topic shape has no Collector, and that equipment sits in
   * no enclosure at all.
   */
  collector_code: z.string().nullable().catch(null),
  source_address: z.string().nullable(),
  // Health thresholds multiply this, so it is shown wherever health is shown.
  expected_interval_s: z.number(),
  type_code: z.string(),
  in_power_path: z.boolean(),
  /**
   * Which of the four SLD stages this Device's Type folds into, and the
   * accepted per-Device correction where one exists.
   *
   * The schematic uses them to break ties by electrical position. Ordering ties
   * alphabetically by type code — which is what it used to do — put a
   * settlement meter upstream of the transformer on an unwired Plant, because
   * `MFM` sorts before `TRANSFORMER`.
   */
  sld_stage: z.string().nullable().optional().catch(null),
  sld_stage_override: z.string().nullable().optional().catch(null),
  variant: z.string().nullable(),
  comm_status: CommStatusSchema.nullable(),
  last_seen_at: z.string().nullable(),
  frozen_tag_count: z.number().nullable(),
  // Enough to answer "what is this thing" from the list alone. The diagram
  // shows a Device's detail on click, and a second request per click would
  // make a panel that is meant to feel instant take a network round trip.
  type_name: z.string().nullable().optional().catch(null),
  model_code: z.string().nullable().optional().catch(null),
  manufacturer: z.string().nullable().optional().catch(null),
  serial_number: z.string().nullable().optional().catch(null),
  installed_on: z.string().nullable().optional().catch(null),
  rated_capacity_kw: nullableNumeric().optional(),
  string_count: z.number().nullable().optional().catch(null),
  completeness_24h: nullableNumeric().optional(),
  binding_count: z.number().nullable().optional().catch(null),
});
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;

export const DeviceDetailSchema = DeviceListItemSchema.extend({
  plant_id: z.number(),
  device_model_id: z.number(),
  serial_number: z.string().nullable(),
  rated_capacity_kw: nullableNumeric(),
  installed_on: z.string().nullable(),
  completeness_24h: nullableNumeric(),
  // How many inputs of the Model's repeating group this unit has — the PV
  // strings on this Inverter. A fact about the unit, not the Model.
  string_count: z.number().nullable().catch(null),
}).passthrough();
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>;

// ── Commissioning ───────────────────────────────────────────────────────────

/**
 * One thing standing between a Plant and going live.
 *
 * Onboarding fails quietly: a Device with no topic simply never reports, and a
 * Device with no bindings decodes nothing. Both look exactly like equipment that
 * has not been switched on. This turns each into something nameable.
 */
export const CommissioningIssueSchema = z.object({
  severity: z.enum(["blocking", "warning", "info"]).catch("warning"),
  code: z.string(),
  detail: z.string(),
  device_id: z.number().optional(),
  device_code: z.string().optional(),
  keys: z.array(z.string()).optional(),
});
export type CommissioningIssue = z.infer<typeof CommissioningIssueSchema>;

export const CommissioningReportSchema = z.object({
  plant_id: z.number(),
  status: z.string(),
  device_count: z.number(),
  unmapped_key_count: z.number(),
  ready: z.boolean(),
  blocking_count: z.number(),
  issues: z.array(CommissioningIssueSchema),
  next_status: z.string().nullable(),
});
export type CommissioningReport = z.infer<typeof CommissioningReportSchema>;

/** A payload key a Device is publishing that no binding maps. */
export const UnmappedKeySchema = z.object({
  source_key: z.string(),
  suggested_tag_code: z.string().nullable(),
});
export const UnmappedKeysSchema = z.object({
  device_id: z.number(),
  keys: z.array(UnmappedKeySchema),
});
export type UnmappedKey = z.infer<typeof UnmappedKeySchema>;

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
  /** The enclosure this Device sits in. A box around the node, never a node. */
  collector_code: string | null;
  children: SldNodeData[];
}

export const SldNodeSchema: z.ZodType<SldNodeData> = z.lazy(() =>
  z.object({
    device_id: z.number(),
    code: z.string(),
    name: z.string(),
    type: z.string(),
    variant: z.string().nullable(),
    // The enclosure, drawn as a box around this node — never as a node.
    //
    // No `.catch()` here, unlike everywhere else: this schema is recursive and
    // annotated `z.ZodType<SldNodeData>`, and a catch widens the *input* type
    // to `unknown`, which no longer matches the interface. The server always
    // sends the field, so leniency would buy nothing.
    collector_code: z.string().nullable(),
    children: z.array(SldNodeSchema),
  }),
);

export const SldSchema = z.object({
  plant_id: z.number(),
  roots: z.array(SldNodeSchema),
  device_count: z.number(),
  // Not an error: a Weather Station and a PPC are real, monitored Devices that
  // carry no current. They belong in a side panel, not the tree (§6.4).
  // ⚠ Still absent from the electrical *tree* — a Weather Station has no
  // `parent_device_id` story and inventing one would corrupt the diagram
  // (MASTER §2.3). What changed is that the renderer now *draws* them, unwired
  // and visually distinct, rather than hiding them in a side panel. They are
  // placed inside their collector's box when they have one, which is how a WMS
  // in the MCR becomes visible as being in the MCR.
  excluded_not_in_power_path: z.array(
    z.object({
      device_id: z.number(),
      code: z.string(),
      name: z.string().nullable().optional().catch(null),
      type: z.string(),
      variant: z.string().nullable().optional().catch(null),
      collector_code: z.string().nullable().optional().catch(null),
    }),
  ),
  // A data problem worth surfacing — dropping these makes the diagram claim the
  // Plant has less equipment than it does.
  orphaned: z.array(z.object({ device_id: z.number(), code: z.string() })),
  // Every enclosure at this Plant and what is in it — including Devices that
  // carry no current, because a Collector holding one Inverter and one Weather
  // Station is still one box in the room.
  collectors: z
    .array(
      z.object({
        code: z.string(),
        device_ids: z.array(z.number()),
        device_count: z.number(),
        in_power_path_count: z.number(),
        /**
         * What the enclosure feeds into — the single edge the box owns.
         *
         * A Collector is not a Device, so this is the only connection it can
         * have, and it is drawn once from the box's border rather than once
         * per occupant. `null` means nobody has recorded it yet, which is
         * every Collector the moment it first appears on the broker.
         */
        parent_device_id: z.number().nullable().catch(null),
      }),
    )
    .catch([]),
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
    /**
     * ⚠ Arrives as a **JSON string** on the aggregate tiers.
     *
     * It is a `count(*)`, so Postgres types it `BIGINT`, and this driver path
     * serialises BIGINT as a string to avoid the 2^53 precision cliff. Declared
     * as `z.number()` it failed `safeParse` for every aggregate response — and
     * because the whole envelope is parsed at once, one string here blanked the
     * entire chart with "Unexpected response shape from GET /readings". The raw
     * tier carries no `sample_count` at all, which is why it only ever broke on
     * ranges long enough to be served by an aggregate.
     */
    sample_count: nullableNumeric().optional(),
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
  // The owner's code; a platform administrator sees every Client's rules.
  client_code: z.string().nullable().catch(null),
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
  // What the scope points at (a Plant, Device, Type or Client code). Null for
  // `global`, and for a target the caller is not allowed to see.
  scope_code: z.string().nullable().catch(null),
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

// ── Dashboard slots ─────────────────────────────────────────────────────────
//
// The layout is fixed and the sources are not. A slot is a *position* on the
// screen (`kpi.current_power`), and the backend resolves it against whatever
// Devices the Plant actually has — an ABT Meter on an 8 MW Plant, the sum of
// four Inverters on a rooftop one. `source` says which, and the screen shows it:
// 6.32 MW is a different claim depending on whether a meter measured it or
// twelve machines were added together.

export const SlotSourceSchema = z.object({
  kind: z.enum(["device_tag", "plant_attribute", "device_count"]),
  device_type_code: z.string().nullable(),
  tag_code: z.string().nullable(),
  aggregate: z.string(),
  device_count: z.number(),
  is_aggregated: z.boolean(),
  /** The preferred source is bound but silent; a lower-ranked one answered. */
  degraded: z.boolean(),
});
export type SlotSource = z.infer<typeof SlotSourceSchema>;

export const ResolvedSlotSchema = z.object({
  slot_code: z.string(),
  label: z.string(),
  position: z.number(),
  /** null is never 0. A missing input is unknown, not zero (Guardrail 3). */
  value: z.number().nullable(),
  unit: z.string().nullable(),
  /**
   * `no_source` — nothing on this Plant can answer (a commissioning gap).
   * `no_value` — the source exists and has gone quiet (a fault, happening now).
   * `unconfigured` — the slot declares no candidates.
   * They read as the same blank tile and mean entirely different things.
   */
  undefined_reason: z.enum(["no_source", "no_value", "unconfigured"]).nullable(),
  source: SlotSourceSchema.nullable(),
  override_note: z.string().nullable().optional(),
});
export type ResolvedSlot = z.infer<typeof ResolvedSlotSchema>;

export const SLD_STAGE_CODES = [
  "PV_ARRAY",
  "INVERTERS",
  "TRANSFORMER",
  "GRID",
] as const;
export type SldStageCode = (typeof SLD_STAGE_CODES)[number];

export const SldStageSchema = z.object({
  code: z.enum(SLD_STAGE_CODES),
  label: z.string(),
  position: z.number(),
  device_count: z.number(),
  online_count: z.number(),
  /** False when no Device folds into this stage — not the same as "it is down". */
  instrumented: z.boolean(),
  health: z.enum(["ok", "degraded", "down", "unmonitored"]),
  devices: z.array(
    z.object({
      device_id: z.number(),
      code: z.string(),
      device_type_code: z.string(),
      online: z.boolean(),
    }),
  ),
  slots: z.array(ResolvedSlotSchema),
});
export type SldStage = z.infer<typeof SldStageSchema>;

export const SldStagesSchema = z.object({
  stages: z.array(SldStageSchema),
  /** Power-path Devices whose Type has no stage — a gap in the catalogue. */
  unstaged: z.array(
    z.object({
      device_id: z.number(),
      code: z.string(),
      device_type_code: z.string(),
    }),
  ),
});
export type SldStages = z.infer<typeof SldStagesSchema>;

export const PlantDashboardSchema = z.object({
  plant_id: z.number(),
  /** Panel code → its slots. Panels and positions are identical on every Plant. */
  panels: z.record(z.string(), z.array(ResolvedSlotSchema)),
  sld: SldStagesSchema,
  device_count: z.number(),
  assumptions_note: z.string(),
});
export type PlantDashboard = z.infer<typeof PlantDashboardSchema>;

/** Panel codes, in the order the page lays them out. */
export const DASHBOARD_PANELS = [
  "kpi_row",
  "plant_status",
  "power_summary",
  "energy_summary",
  "environment",
] as const;

/**
 * The curated columns of a per-Device summary table, by Device Type.
 *
 * Not everything a Device publishes — an Inverter is bound to eighty Tags once
 * its PV strings are counted, and a table eighty columns wide answers nothing.
 */
export const DeviceTableColumnSchema = z.object({
  tag_id: z.number(),
  tag_code: z.string(),
  name: z.string(),
  unit: z.string().nullable(),
  category: TagCategorySchema,
  position: z.number(),
});
export type DeviceTableColumn = z.infer<typeof DeviceTableColumnSchema>;

export const DeviceTableColumnsSchema = z.record(
  z.string(),
  z.array(DeviceTableColumnSchema),
);
export type DeviceTableColumns = z.infer<typeof DeviceTableColumnsSchema>;
