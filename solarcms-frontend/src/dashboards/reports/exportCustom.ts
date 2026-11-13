/**
 * Download a custom report — the builder's buttons and the quick reports'
 * share this, so both handle a server without a PDF renderer the same way.
 */

import * as reportsApi from "@/api/endpoints/reports";
import type { CustomReportDefinition, ReportFormat } from "@/api/endpoints/reports";
import { triggerDownload } from "@/api/client";
import { isApiError } from "@/api/problem";
import { printHtml } from "./printHtml";

export const NO_PDF_RENDERER =
  "This server has no PDF renderer installed, so the report opened in your browser's print dialog — choose “Save as PDF” as the destination.";

/**
 * Computes the file afresh on the server and saves it as `filename`. Resolves
 * to a note for the reader when the PDF went to the print dialog instead, or
 * null; throws when the server refused, with its sentence (`describeExport`).
 */
export async function downloadCustomReport(
  definition: CustomReportDefinition,
  format: ReportFormat,
  filename: string,
): Promise<string | null> {
  try {
    triggerDownload(await reportsApi.exportCustomReport(definition, format), filename);
    return null;
  } catch (error) {
    if (format === "pdf" && isApiError(error) && error.status === 503) {
      printHtml(await reportsApi.customReportPage(definition));
      return NO_PDF_RENDERER;
    }
    throw error;
  }
}

export function describeExport(error: unknown): string {
  return isApiError(error) ? error.displayMessage : "Could not download the report.";
}
