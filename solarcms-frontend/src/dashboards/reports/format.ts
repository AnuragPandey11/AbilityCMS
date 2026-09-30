/**
 * How a report table's cells read on screen. Pure, and the only place the
 * preview decides anything about a value's appearance — the server has already
 * decided the value, its unit and its precision, and the downloads use the
 * same three, so the preview and the file cannot disagree about a figure.
 *
 * Dates arrive as the Plant's own calendar dates (`YYYY-MM-DD`) and are
 * reformatted as text, never parsed into a `Date`: `new Date("2026-09-28")` is
 * UTC midnight, which in any zone west of Greenwich is the 27th.
 */

import type { ReportCellValue, ReportColumn } from "@/api/schemas";
import { formatDateTime } from "@/format/datetime";
import { UNDEFINED_DISPLAY, formatNumber } from "@/format/value";

// English three-letter months, as the server's `%b` writes them into the
// files — a locale's own abbreviation ("Sept") would make the preview and
// the Excel file name the same month differently.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function isNumericColumn(column: ReportColumn): boolean {
  return column.kind === "number" || column.kind === "percent" || column.kind === "count";
}

/** "Peak power (kW)" — the heading the CSV and Excel files carry too. */
export function columnHeading(column: ReportColumn): string {
  return column.unit ? `${column.label} (${column.unit})` : column.label;
}

/** `YYYY-MM-DD` → `DD-MM-YYYY` (tender §28), as text. */
export function formatPlantDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : iso;
}

/** "22-09-2026 to 28-09-2026", or one date when the period is one day. */
export function formatDayRange(firstDay: string, lastDay: string): string {
  return firstDay === lastDay
    ? formatPlantDate(firstDay)
    : `${formatPlantDate(firstDay)} to ${formatPlantDate(lastDay)}`;
}

/**
 * The period a table covers, as its files name it: the days alone when they
 * are whole, or "22-09-2026 06:00 to 28-09-2026 18:00" when either end was cut
 * inside a day — the other end then shows its day's edge, 00:00 or 23:59.
 */
export function formatReportPeriod(table: {
  first_day: string;
  last_day: string;
  from_time?: string | null;
  to_time?: string | null;
}): string {
  if (table.from_time == null && table.to_time == null) {
    return formatDayRange(table.first_day, table.last_day);
  }
  const begins = `${formatPlantDate(table.first_day)} ${table.from_time ?? "00:00"}`;
  const ends = table.to_time ?? "23:59";
  return table.first_day === table.last_day
    ? `${begins} to ${ends}`
    : `${begins} to ${formatPlantDate(table.last_day)} ${ends}`;
}

/** A cell as text. `null` is "nothing to read" — a dash, never 0 (Guardrail 3). */
export function formatReportCell(
  column: ReportColumn,
  value: ReportCellValue | undefined,
  timeZone: string,
): string {
  if (value === null || value === undefined || value === "") return UNDEFINED_DISPLAY;
  switch (column.kind) {
    case "date":
      return formatPlantDate(String(value));
    case "month": {
      const match = /^(\d{4})-(\d{2})$/.exec(String(value));
      const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
      return match && month ? `${month} ${match[1]}` : String(value);
    }
    case "datetime":
      return formatDateTime(String(value), timeZone);
    case "text":
      return String(value);
    case "count":
      // Never a decimal on a count (Guardrail 24).
      return typeof value === "number" ? formatNumber(value, { digits: 0 }) : String(value);
    default:
      return typeof value === "number"
        ? formatNumber(value, { digits: column.digits })
        : String(value);
  }
}

/** A `YYYY-MM-DD` moved by whole days — calendar arithmetic, no zone involved. */
export function shiftDate(iso: string, days: number): string {
  const at = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(at)) return iso;
  return new Date(at + days * 86_400_000).toISOString().slice(0, 10);
}

/** A custom period as the inputs hold it: Plant dates and `HH:MM` times. */
export interface CustomRange {
  fromDate: string;
  fromTime: string;
  toDate: string;
  toTime: string;
}

/**
 * Where a custom period stops, as a Plant wall-clock `YYYY-MM-DDTHH:MM` — so
 * it compares as text. The server's rule: the period stops at the end time,
 * and 23:59, the latest a clock input shows, is the end of that day.
 */
export function customRangeEnd(range: CustomRange): string {
  return range.toTime === "23:59"
    ? `${shiftDate(range.toDate, 1)}T00:00`
    : `${range.toDate}T${range.toTime}`;
}

/**
 * Why a custom range cannot be asked for yet, or null when it can. Checked
 * here only to avoid a round trip for the obvious cases; the server applies
 * the same rules, in the same order, and has the last word. `now` is the
 * Plant's wall clock, `YYYY-MM-DDTHH:MM`.
 */
export function customRangeProblem(
  range: CustomRange,
  now: string,
  maxDays: number,
): string | null {
  const { fromDate, fromTime, toDate, toTime } = range;
  const today = now.slice(0, 10);
  if (!fromDate || !toDate) return "Choose both a first and a last day.";
  if (!fromTime || !toTime) return "Choose both a start and an end time.";
  if (toDate < fromDate) return "The last day is before the first.";
  if (toDate > today) return `The last day cannot be after today (${formatPlantDate(today)}).`;
  const span = (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) /
    86_400_000 + 1;
  if (span > maxDays) return `A custom period is at most ${maxDays} days.`;
  const start = `${fromDate}T${fromTime}`;
  if (customRangeEnd(range) <= start) return "The end is not after the start.";
  if (start > now) return `The period cannot start after now (${now.slice(11, 16)}).`;
  return null;
}
