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

function parts(
  value: Date | string,
  timeZone: string,
): Record<string, string> | null {
  const date = typeof value === "string" ? new Date(value) : value;
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
  value: Date | string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (value === null || value === undefined) return "—";
  const p = parts(value, timeZone);
  if (!p) return "—";
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

/** `DD-MM-YYYY`. */
export function formatDate(
  value: Date | string | null | undefined,
  timeZone: string = DEFAULT_TIMEZONE,
): string {
  if (value === null || value === undefined) return "—";
  const p = parts(value, timeZone);
  if (!p) return "—";
  return `${p.day}-${p.month}-${p.year}`;
}

/** `HH:MM:SS` — for chart axes, where the date is already in the title. */
export function formatTime(
  value: Date | string | null | undefined,
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
  value: Date | string,
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

/** "4s ago", "12m ago". Used for staleness, where the number is the point. */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ageSeconds(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return (Date.now() - date.getTime()) / 1000;
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
