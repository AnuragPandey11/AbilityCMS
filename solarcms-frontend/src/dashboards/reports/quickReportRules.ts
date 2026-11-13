/**
 * Quick reports: the saved custom reports a reader keeps at the top of
 * Reports, up to five, in their own order (migration 0049). Pure — what a
 * card says about a saved report, and the row after a pin or an unpin.
 *
 * A pin is the reader's own; the saved report itself is still shared within
 * the Client. The definition is sent to the server as saved, so a period kept
 * by name ("Last 7 days") runs against the Plant's today every time, while a
 * custom range is fixed dates and the card says so.
 */

import type { CustomReportDefinition, ReportFormat, SavedReport } from "@/api/endpoints/reports";
import { formatReportPeriod, lastDaysOf } from "./format";

/** Mirrors `schemas/reports.CUSTOM_REPORT_PIN_LIMIT`; the server enforces it regardless. */
export const QUICK_REPORT_LIMIT = 5;

/** A saved definition, or null when it is not one this screen can read. */
export function asDefinition(value: unknown): CustomReportDefinition | null {
  if (!value || typeof value !== "object") return null;
  const definition = value as CustomReportDefinition;
  return Array.isArray(definition.series) ? definition : null;
}

/** The reader's quick reports, in their order. */
export function pinnedReports(saved: SavedReport[]): SavedReport[] {
  return saved
    .filter((report) => report.pin_position != null)
    .sort((a, b) => (a.pin_position ?? 0) - (b.pin_position ?? 0));
}

/** The row with `id` added at the end, or put in `replacing`'s place. */
export function withPin(row: number[], id: number, replacing?: number): number[] {
  if (row.includes(id)) return row;
  if (replacing !== undefined && row.includes(replacing)) {
    return row.map((other) => (other === replacing ? id : other));
  }
  return [...row, id];
}

export function withoutPin(row: number[], id: number): number[] {
  return row.filter((other) => other !== id);
}

/** "15 min", "1 hour", "6 hours", "1 day", "90 min". */
export function intervalWords(minutes: number): string {
  if (minutes === 1440) return "1 day";
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes === 60) return "1 hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} min`;
}

const NAMED_PERIODS: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
};

/**
 * The period as the card reads it. A custom range is fixed dates, so it says
 * so: pinned in March, it still reads March.
 */
export function periodWords(definition: CustomReportDefinition): string {
  const named = NAMED_PERIODS[definition.period];
  if (named) return named;
  const lastDays = lastDaysOf(definition.period);
  if (lastDays !== null) return `Last ${lastDays} day${lastDays === 1 ? "" : "s"}`;
  if (definition.period === "custom" && definition.from_date && definition.to_date) {
    const range = formatReportPeriod({
      first_day: definition.from_date,
      last_day: definition.to_date,
      from_time: definition.from_time && definition.from_time !== "00:00" ? definition.from_time : null,
      to_time: definition.to_time && definition.to_time !== "23:59" ? definition.to_time : null,
    });
    return `${range} (fixed dates)`;
  }
  return definition.period;
}

/** The Plants by name, those the reader can see; a count past three. */
export function plantWords(
  definition: CustomReportDefinition,
  plants: { id: number; name: string }[],
): string {
  const names = new Map(plants.map((plant) => [plant.id, plant.name]));
  const visible = (definition.plant_ids ?? []).flatMap((id) => {
    const name = names.get(id);
    return name === undefined ? [] : [name];
  });
  if (visible.length === 0) return "No Plant of this report is visible to you";
  return visible.length > 3 ? `${visible.slice(0, 2).join(", ")} and ${visible.length - 2} more` : visible.join(", ");
}

/** "12 columns · every 15 min · Last 7 days". */
export function definitionWords(definition: CustomReportDefinition): string {
  const columns = definition.series.length;
  return [
    `${columns} column${columns === 1 ? "" : "s"}`,
    `every ${intervalWords(definition.interval_minutes)}`,
    periodWords(definition),
  ].join(" · ");
}

/** `Inverter_power_hourly_20261113.xlsx` — the report's own name and the day it was run. */
export function quickReportFilename(name: string, format: ReportFormat, today: Date): string {
  const stem = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "report";
  const day = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(
    today.getDate(),
  ).padStart(2, "0")}`;
  return `${stem}_${day}.${format}`;
}
