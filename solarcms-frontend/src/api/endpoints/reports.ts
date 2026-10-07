import { z } from "zod";
import {
  postForBlob,
  postForText,
  request,
  requestBlob,
  requestText,
  type QueryParams,
} from "../client";
import {
  ReportDefinitionSchema,
  ReportRunRequestSchema,
  ReportRunSchema,
  ReportTableSchema,
  parse,
  type ReportDefinition,
  type ReportRun,
  type ReportTable,
} from "../schemas";

// ── Report tables: one Plant, one period, answered while the reader waits ────

export type ReportKind = "daily_plant" | "monthly_plant" | "inverter" | "weather" | "alarm";
export type ReportPeriod = "today" | "yesterday" | "last_7_days" | "last_30_days" | "custom";
export type ReportFormat = "csv" | "xlsx" | "pdf";

export interface ReportTableQuery {
  kind: ReportKind;
  plantId: number;
  period: ReportPeriod;
  /** The Plant's own dates, `YYYY-MM-DD`, inclusive. Custom periods only. */
  fromDate?: string;
  toDate?: string;
  /**
   * `HH:MM` on the Plant's clock: the period starts at `fromTime` on the
   * first day and stops at `toTime` on the last (23:59 is the day's end).
   * Custom periods only; omitted, that end is the whole day's edge.
   */
  fromTime?: string;
  toTime?: string;
}

function tableParams(query: ReportTableQuery): QueryParams {
  return {
    plant_id: query.plantId,
    period: query.period,
    ...(query.period === "custom"
      ? {
          from_date: query.fromDate,
          to_date: query.toDate,
          from_time: query.fromTime,
          to_time: query.toTime,
        }
      : {}),
  };
}

/**
 * The table as JSON. The period is resolved on the server, in the Plant's own
 * zone — "today" at a Plant in Kolkata began at its midnight, whatever the
 * browser's clock says.
 */
export async function getReportTable(query: ReportTableQuery): Promise<ReportTable> {
  const path = `/reports/tables/${query.kind}`;
  return parse(ReportTableSchema, await request(path, { params: tableParams(query) }), `GET ${path}`);
}

/**
 * The same table as a file, computed afresh on the server — never assembled
 * from the preview this browser holds, so a download cannot carry a figure the
 * server did not make. A PDF is refused with 503 when the server has no PDF
 * renderer; the caller then offers `html` to print.
 */
export async function exportReportTable(
  query: ReportTableQuery,
  format: ReportFormat,
): Promise<Blob> {
  return requestBlob(`/reports/tables/${query.kind}/export`, {
    ...tableParams(query),
    format,
  });
}

/**
 * The printable page the PDF is rendered from — offered when the server has
 * no PDF renderer, so the browser can print the same table to PDF instead.
 */
export async function reportTablePage(query: ReportTableQuery): Promise<string> {
  return requestText(`/reports/tables/${query.kind}/export`, {
    ...tableParams(query),
    format: "html",
  });
}

/**
 * What the server names the file — the Plant, the kind and the days, and the
 * times when the period was cut inside a day (`20260922T0600`).
 */
export function reportFilename(table: ReportTable, format: ReportFormat): string {
  const day = (iso: string) => iso.replace(/-/g, "");
  const timed = table.from_time != null || table.to_time != null;
  const at = (iso: string, clock: string | null | undefined, edge: string) =>
    timed ? `${day(iso)}T${(clock ?? edge).replace(":", "")}` : day(iso);
  const first = at(table.first_day, table.from_time, "00:00");
  const last = at(table.last_day, table.to_time, "23:59");
  return `${table.plant.code}_${table.kind}_${first}_${last}.${format}`;
}

// ── Custom reports: any Devices' readings, across Plants, at any interval ────

export type CustomAggregation = "auto" | "avg" | "min" | "max" | "last" | "change";

/** One column: a Device and one reading it sends. */
export interface SeriesRef {
  device_id: number;
  tag_code: string;
}

/**
 * What a custom report reads. `series` names each Device and reading, so a
 * saved report reopens exactly as it was built. The period takes the standard
 * reports' names and is resolved on the first chosen Plant's clock.
 */
export interface CustomReportDefinition {
  name?: string | null;
  /** The Plants chosen in the builder, so a saved report reopens on them. */
  plant_ids?: number[];
  series: SeriesRef[];
  interval_minutes: number;
  aggregation: CustomAggregation;
  period: ReportPeriod;
  from_date?: string | null;
  to_date?: string | null;
  from_time?: string | null;
  to_time?: string | null;
}

export const CatalogTagSchema = z.object({
  code: z.string(),
  name: z.string(),
  unit: z.string().nullable(),
  category: z.string().nullable(),
  cumulative: z.boolean(),
});
export type CatalogTag = z.infer<typeof CatalogTagSchema>;

export const CustomCatalogSchema = z.object({
  plants: z.array(
    z.object({
      id: z.number(),
      code: z.string(),
      name: z.string(),
      timezone: z.string(),
      client_code: z.string().nullable(),
    }),
  ),
  devices: z.array(
    z.object({
      id: z.number(),
      code: z.string(),
      name: z.string().nullable(),
      plant_id: z.number(),
      type_code: z.string(),
      type_name: z.string(),
      tags: z.array(CatalogTagSchema),
    }),
  ),
});
export type CustomCatalog = z.infer<typeof CustomCatalogSchema>;
export type CatalogDevice = CustomCatalog["devices"][number];

export const SavedReportSchema = z.object({
  id: z.number(),
  name: z.string(),
  definition: z.unknown(),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.number().nullable(),
  created_by_email: z.string().nullable(),
  can_change: z.boolean(),
});
export type SavedReport = z.infer<typeof SavedReportSchema>;

/** The chosen Plants' Devices and the readings each one sends. */
export async function customCatalog(plantIds: number[]): Promise<CustomCatalog> {
  return parse(
    CustomCatalogSchema,
    await request("/reports/custom/catalog", { params: { plant_ids: plantIds } }),
    "GET /reports/custom/catalog",
  );
}

export async function customTable(definition: CustomReportDefinition): Promise<ReportTable> {
  return parse(
    ReportTableSchema,
    await request("/reports/custom/table", { method: "POST", body: definition }),
    "POST /reports/custom/table",
  );
}

export async function exportCustomReport(
  definition: CustomReportDefinition,
  format: ReportFormat,
): Promise<Blob> {
  return postForBlob("/reports/custom/export", { format }, definition);
}

export async function customReportPage(definition: CustomReportDefinition): Promise<string> {
  return postForText("/reports/custom/export", { format: "html" }, definition);
}

export async function listSavedReports(): Promise<SavedReport[]> {
  return parse(
    z.array(SavedReportSchema),
    await request("/reports/custom/saved"),
    "GET /reports/custom/saved",
  );
}

/** Save a new report, or replace one by id. Returns the saved report's id. */
export async function saveReport(
  name: string,
  definition: CustomReportDefinition,
  id?: number,
): Promise<number> {
  const body = await request(
    id === undefined ? "/reports/custom/saved" : `/reports/custom/saved/${id}`,
    { method: id === undefined ? "POST" : "PUT", body: { name, definition } },
  );
  return parse(z.object({ id: z.number() }), body, "save custom report").id;
}

export async function deleteSavedReport(id: number): Promise<void> {
  await request(`/reports/custom/saved/${id}`, { method: "DELETE" });
}

// ── Report definitions and runs: a Client's Reports, rendered by the scheduler

export async function listDefinitions(): Promise<ReportDefinition[]> {
  return parse(
    z.array(ReportDefinitionSchema),
    await request("/reports/definitions"),
    "GET /reports/definitions",
  );
}

/**
 * Queue a run. Returns 202 with a `run_id`; poll until the state settles.
 *
 * ⚠ A Financial Report is refused with 409 when no ABT Meter is registered.
 * I-11 forbids computing one from an MFM — the ABT Meter is the sealed
 * settlement instrument. Render that specifically: "report failed" invites
 * someone to retry forever (§6.7).
 */
export async function requestRun(
  definitionId: number,
  periodStart: string,
  periodEnd: string,
  // Required for a Super Admin, who belongs to no Client; ignored for anyone else.
  clientId: number | null,
): Promise<{ run_id: number; state: string; created_at: string }> {
  const body = await request("/reports/runs", {
    method: "POST",
    params: {
      definition_id: definitionId,
      period_start: periodStart,
      period_end: periodEnd,
      ...(clientId !== null ? { client_id: clientId } : {}),
    },
  });
  return parse(ReportRunRequestSchema, body, "POST /reports/runs");
}

export async function getRun(runId: number): Promise<ReportRun> {
  return parse(
    ReportRunSchema,
    await request(`/reports/runs/${runId}`),
    `GET /reports/runs/${runId}`,
  );
}

/**
 * Split `artifact_urls` into downloadable links and explanatory notes.
 *
 * `pdf_unavailable` is a message, not a URL: the run succeeded and the XLSX is
 * there, PDF rendering is simply not installed. Offer the XLSX rather than
 * showing a failure (§6.7).
 */
export function splitArtifacts(run: ReportRun): {
  links: { format: string; url: string }[];
  notes: string[];
} {
  const links: { format: string; url: string }[] = [];
  const notes: string[] = [];
  for (const [key, value] of Object.entries(run.artifact_urls ?? {})) {
    if (key.endsWith("_unavailable")) notes.push(value);
    else links.push({ format: key, url: value });
  }
  return { links, notes };
}
