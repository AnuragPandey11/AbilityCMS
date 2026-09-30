import { z } from "zod";
import { request, requestBlob, requestText, type QueryParams } from "../client";
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
