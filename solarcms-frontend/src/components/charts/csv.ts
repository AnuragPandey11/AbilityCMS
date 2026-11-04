/**
 * A chart's points as a CSV file — exactly what is drawn, nothing more.
 *
 * Built in the browser from the series already on screen, so the file cannot
 * carry a figure the chart did not. Times are the Plant's wall clock in the
 * platform's display format (tender §28); a bucket nothing reported in is left
 * out, never written as 0 (Guardrail 23). UTF-8 with a byte-order mark, or
 * Excel opens "°C" as "Â°C" — the server's exports do the same.
 *
 * ⚠ Exporting is its own permission (`data.export`, MASTER §4.3). The chart
 * cannot know the session, so it offers the button only when its caller
 * passes a file name (`TrendChart` `exportName`).
 */

import type { Tier } from "@/api/schemas";
import type { TrendPoint } from "@/api/useSlotTrend";
import { formatBucket } from "@/format/datetime";

function cell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** A finite number as written, nothing else — never a locale's grouping. */
function number(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

export function trendCsv(
  points: TrendPoint[],
  { label, unit, tier, timezone }: { label: string; unit: string | null; tier: Tier | null; timezone: string },
): string {
  const heading = unit ? `${label} (${unit})` : label;
  const banded = points.some((point) => point.low !== undefined && point.high !== undefined);
  const header = ["Time", heading, ...(banded ? ["Lowest in bucket", "Highest in bucket"] : []), "Devices"];
  const lines = [header.map(cell).join(",")];
  for (const point of points) {
    if (point.value === null) continue;
    const row = [
      formatBucket(point.at, tier, timezone),
      number(point.value),
      ...(banded ? [number(point.low), number(point.high)] : []),
      String(point.contributors),
    ];
    lines.push(row.map(cell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/** Hand the browser a file. A no-op where there is no document (tests, server render). */
export function downloadCsv(filename: string, text: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[^\w.-]+/g, "_");
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** A file name stem: the Plant, what is drawn, and the period's first and last day. */
export function exportStem(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("_")
    .replace(/[^\w.-]+/g, "_");
}

/** Any table as CSV — a header row and rows of cells already formatted for reading. */
export function rowsCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header.map(cell).join(",")];
  for (const row of rows) {
    lines.push(
      row.map((value) => (typeof value === "number" ? number(value) : cell(value ?? ""))).join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
