import { z } from "zod";
import { request } from "../client";
import {
  ReportDefinitionSchema,
  ReportRunRequestSchema,
  ReportRunSchema,
  parse,
  type ReportDefinition,
  type ReportRun,
} from "../schemas";

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
): Promise<{ run_id: number; state: string; created_at: string }> {
  const body = await request("/reports/runs", {
    method: "POST",
    params: {
      definition_id: definitionId,
      period_start: periodStart,
      period_end: periodEnd,
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
