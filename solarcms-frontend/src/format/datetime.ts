/**
 * Display formatting. Tender §28: **DD-MM-YYYY HH:MM:SS**.
 *
 * Two rules that are easy to get wrong and impossible to notice afterwards:
 *
 * 1. Render in the **Plant's** timezone, not the browser's (Guardrail 11). An
 *    operator abroad reading a generation curve shifted by five and a half hours
 *    will not notice it is shifted.
 * 2. Convert at the edge only. A formatted string is never stored, never put in
 *    state, and never sent back to the API — the API speaks ISO 8601 with offset.
 */

export const DEFAULT_TIMEZONE = "Asia/Kolkata";

/**
 * A timestamp in any of the three shapes this app actually receives.
 *
 * ⚠ **The number is not optional.** ECharts hands a tooltip formatter the axis
 * value as **epoch milliseconds** on a `type: "time"` axis, so every chart
 * tooltip that showed a timestamp was passing a `number` into a signature that
 * said `Date | string`. TypeScript could not catch it — the value arrives from
 * ECharts typed `unknown` and is narrowed by hand — and the result was
 * `TypeError: date.getTime is not a function` thrown *inside a render*, which
 * unmounts the chart. It only fired on the one branch that formatted the axis
 * value rather than the datum, which is why it hid behind a hover on a chart
 * with a gap in it.
 */
export type Timestamp = Date | string | number;

function parts(
  value: Timestamp,
  timeZone: string,
): Record<string, string> | null {
  const date =
    value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(date.getTime())) return null;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    // An unknown IANA zone must not blank the screen; fall back and say so via
    // the caller's tz label rather than throwing inside a render.
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  const out: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) out[part.type] = part.value;
  return out;
}

/** `DD-MM-YYYY HH:MM:SS` in the given zone. */
export function formatDateTime(
  value: Timestamp | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (value === null || value === undefined) return "—";
  const p = parts(value, timeZone);
  if (!p) return "—";
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** `DD-MM-YYYY`. */
export function formatDate(
  value: Timestamp | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (value === null || value === undefined) return "—";
  const p = parts(value, timeZone);
  if (!p) return "—";
  return `${p.day}-${p.month}-${p.year}`;
}

/** `HH:MM:SS` — for chart axes, where the date is already in the title. */
export function formatTime(
  value: Timestamp | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (value === null || value === undefined) return "—";
  const p = parts(value, timeZone);
  if (!p) return "—";
  return `${p.hour}:${p.minute}:${p.second}`;
}

/**
 * Axis label at a resolution matching the tier. A daily bucket labelled with
 * seconds implies a precision the data does not have.
 */
export function formatAxisLabel(
  value: Timestamp,
  tier: string,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  const p = parts(value, timeZone);
  if (!p) return "";
  if (tier === "agg_1d") return `${p.day}-${p.month}`;
  if (tier === "agg_1h") return `${p.day}-${p.month} ${p.hour}:00`;
  if (tier === "readings") return `${p.hour}:${p.minute}:${p.second}`;
  return `${p.hour}:${p.minute}`;
}

/**
 * A bucket's timestamp, at a resolution matching its tier.
 *
 * The same reasoning as `formatAxisLabel`, for the places that show a full
 * timestamp: a tooltip and a table view. A daily bucket rendered as
 * `17-09-2026 05:30:00` claims a reading taken at half past five — it is in
 * fact the whole of the 17th, and the 05:30 is only UTC midnight expressed in
 * the Plant's zone. An operator reading it as a time is being misled by the
 * formatter, not by the data.
 */
export function formatBucket(
  value: Timestamp | null | undefined,
  tier: string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (tier === "agg_1d") return formatDate(value, timeZone);
  return formatDateTime(value, timeZone);
}

/** "4s ago", "12m ago". Used for staleness, where the number is the point. */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ageSeconds(value: Timestamp | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const date =
    value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  if (Number.isNaN(date.getTime())) return null;
  return (Date.now() - date.getTime()) / 1000;
}

/**
 * The instant the Plant's calendar day containing `value` began, as epoch ms.
 *
 * "Today" is the Plant's day, not the browser's and not UTC's: an Asia/Kolkata
 * day begins at 18:30 UTC the evening before, and framing a generation curve
 * on the UTC day cuts the morning ramp in half.
 *
 * Found by reading the zone's wall clock rather than assuming an offset, and
 * checked twice, so a day that begins or ends on a daylight-saving change
 * still starts at its own midnight.
 */
export function startOfDayInZone(value: Timestamp, timeZone: string = DEFAULT_TIMEZONE): number {
  const p = parts(value, timeZone);
  if (!p) return Number.NaN;
  const midnightAsUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  const offsetAt = (instant: number): number => {
    const q = parts(instant, timeZone);
    if (!q) return 0;
    // `hour` can read "24" at midnight in some engines' en-GB output.
    const wall = Date.UTC(
      Number(q.year),
      Number(q.month) - 1,
      Number(q.day),
      Number(q.hour) % 24,
      Number(q.minute),
      Number(q.second),
    );
    return wall - instant;
  };
  const first = midnightAsUtc - offsetAt(midnightAsUtc);
  return midnightAsUtc - offsetAt(first);
}

/**
 * The Plant's calendar day containing `value`: `[start, end)` in epoch ms.
 *
 * `end` is the *next* day's start rather than `start + 24h`, which is wrong on
 * the two days a year a daylight-saving zone is 23 or 25 hours long.
 */
export function dayInZone(
  value: Timestamp,
  timeZone: string = DEFAULT_TIMEZONE,
): { start: number; end: number } {
  const start = startOfDayInZone(value, timeZone);
  // 25h past a midnight is always inside the following day, whatever its length.
  return { start, end: startOfDayInZone(start + 25 * 3_600_000, timeZone) };
}

/**
 * The last `count` days of the Plant's calendar, oldest first, ending with the
 * day containing `value` — each `[start, end)` in epoch ms.
 *
 * Stepped back from midnight to midnight, never by 24h, for the reason
 * `dayInZone` gives.
 */
export function recentDaysInZone(
  value: Timestamp,
  count: number,
  timeZone: string = DEFAULT_TIMEZONE,
): { start: number; end: number }[] {
  const days: { start: number; end: number }[] = [];
  let cursor = dayInZone(value, timeZone);
  for (let index = 0; index < count && Number.isFinite(cursor.start); index += 1) {
    days.unshift(cursor);
    // Noon of the day before: inside it whatever a daylight-saving hour does.
    cursor = dayInZone(cursor.start - 12 * 3_600_000, timeZone);
  }
  return days;
}

/**
 * Every day of the Plant's calendar month containing `value`, in order, each
 * `[start, end)` in epoch ms with its day-of-month.
 *
 * Built day by day from `dayInZone` rather than as `start + n × 24h`, for the
 * same reason `dayInZone` is: a month that crosses a daylight-saving change has
 * one day that is not 24 hours long, and every day after it would be off by one
 * hour — which, for a figure attributed to a day, is the difference between
 * 23:30 and the next morning.
 */
export function daysOfMonthInZone(
  value: Timestamp,
  timeZone: string = DEFAULT_TIMEZONE,
): { start: number; end: number; day: number }[] {
  const p = parts(value, timeZone);
  if (!p) return [];
  const month = p.month;
  // Noon on the 1st, stepped back from today's midnight: well inside day 1
  // whatever the zone's offset or a daylight-saving hour does to it.
  const today = startOfDayInZone(value, timeZone);
  let cursor = dayInZone(today - (Number(p.day) - 1) * 86_400_000 + 12 * 3_600_000, timeZone);
  const days: { start: number; end: number; day: number }[] = [];
  for (;;) {
    const q = parts(cursor.start + 12 * 3_600_000, timeZone);
    if (!q || q.month !== month || days.length > 31) break;
    days.push({ ...cursor, day: Number(q.day) });
    cursor = dayInZone(cursor.end, timeZone);
  }
  return days;
}

/** ISO 8601 with offset — the only form ever sent to the API. */
export function toApiInstant(value: Date): string {
  return value.toISOString();
}

/** The `YYYY-MM-DD` a `<input type="date">` wants. Never a display format. */
export function toDateInput(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** A short label naming the zone, so a shifted curve is at least attributable. */
export function timezoneLabel(timeZone: string): string {
  return timeZone.split("/").pop()?.replace(/_/g, " ") ?? timeZone;
}
