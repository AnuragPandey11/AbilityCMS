/**
 * The history screens' period: one choice, shared by every screen that reads
 * the past, and carried in the link.
 *
 * Energy Analytics, Performance History, Meteorological, MFM / Grid and the
 * HV equipment screens all answer "what happened over this stretch". Each had
 * its own control and its own idea of which stretches exist — four presets
 * here, a typed window there, today only on the meter screen — so opening
 * March on one and moving to the next screen threw the reader back to today.
 * One period now, chosen once (`state/useHistoryPeriod`), and written into the
 * URL so "WH1 in March" is a link somebody can be sent.
 *
 * ── What a period is ────────────────────────────────────────────────────────
 * A preset (resolved against now, so "last 30 days" stays the last 30 days
 * tomorrow) or a custom stretch of two **Plant-local wall times**. Wall times,
 * not instants: "1 March 00:00" means the Plant's midnight, and the same link
 * opened on another Plant means *that* Plant's midnight, which is what the
 * person sending it meant.
 *
 * Everything here is pure — no React, no clock read — so the calendar
 * arithmetic, which is where periods go wrong (month lengths, a year back from
 * 29 February, daylight saving), is tested on its own.
 */

import type { WindowRange } from "./trendWindow";
import { dateInputInZone, dayInZone, fromDateTimeInput, toDateTimeInput } from "@/format/datetime";

export type PeriodPreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "90d"
  | "this_month"
  | "last_month"
  | "this_year"
  | "last_year";

export type HistoryPeriod =
  | { kind: "preset"; preset: PeriodPreset }
  /** `from` and `to` are Plant-local `YYYY-MM-DDTHH:MM`; `to` is exclusive. */
  | { kind: "custom"; from: string; to: string };

export const DEFAULT_PERIOD: HistoryPeriod = { kind: "preset", preset: "today" };

export const PERIOD_PRESETS: { value: PeriodPreset; label: string; hint: string }[] = [
  { value: "today", label: "Today", hint: "The Plant's day so far, midnight to midnight." },
  { value: "yesterday", label: "Yesterday", hint: "The Plant's previous day." },
  { value: "7d", label: "Last 7 days", hint: "The last seven days, ending now." },
  { value: "30d", label: "Last 30 days", hint: "The last thirty days, ending now." },
  { value: "90d", label: "Last 90 days", hint: "The last ninety days, ending now." },
  { value: "this_month", label: "This month", hint: "From the 1st of this month at the Plant, so far." },
  { value: "last_month", label: "Last month", hint: "The whole of the previous calendar month." },
  { value: "this_year", label: "This year", hint: "From 1 January at the Plant, so far." },
  { value: "last_year", label: "Last year", hint: "The whole of the previous calendar year." },
];

const PRESET_SET = new Set<string>(PERIOD_PRESETS.map((preset) => preset.value));

const DAY_MS = 86_400_000;

// ── Wall-clock arithmetic ────────────────────────────────────────────────────

const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

interface Wall {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
}

function parseWall(value: string): Wall | null {
  const match = WALL.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map((part) => Number(part ?? 0)) as number[];
  const wall = { year: year!, month: month!, day: day!, hour: hour ?? 0, minute: minute ?? 0 };
  // Round-trip through a calendar so 2026-02-30 and 24:00 are refused, not rolled over.
  const probe = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute));
  if (
    probe.getUTCFullYear() !== wall.year ||
    probe.getUTCMonth() !== wall.month - 1 ||
    probe.getUTCDate() !== wall.day ||
    probe.getUTCHours() !== wall.hour ||
    probe.getUTCMinutes() !== wall.minute
  ) {
    return null;
  }
  return wall;
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

function wallString(wall: Wall): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** Midnight of a calendar date, `days` later (negative for earlier). */
function addDays(wall: Wall, days: number): Wall {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/**
 * `months` later, the day clamped to the target month's length: a month back
 * from 31 March is 28 (or 29) February, never 3 March.
 */
function addMonths(wall: Wall, months: number): Wall {
  const index = wall.year * 12 + (wall.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { ...wall, year, month, day: Math.min(wall.day, length) };
}

function isMidnight(wall: Wall): boolean {
  return wall.hour === 0 && wall.minute === 0;
}

/** Whole calendar days from `a` to `b`, both midnights. */
function daysBetween(a: Wall, b: Wall): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS);
}

function monthsBetween(a: Wall, b: Wall): number {
  return b.year * 12 + b.month - (a.year * 12 + a.month);
}

function startOfMonth(wall: Wall): Wall {
  return { year: wall.year, month: wall.month, day: 1, hour: 0, minute: 0 };
}

function todayWall(nowMs: number, timeZone: string): Wall {
  const today = parseWall(dateInputInZone(nowMs, timeZone));
  // An unknown zone gives no date; UTC's is better than none.
  return today ?? parseWall(new Date(nowMs).toISOString().slice(0, 10))!;
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * A period's nominal wall-clock bounds, `[from, to)` — for a period still in
 * progress (today, this month) the *end of* the day, month or year, which is
 * what its length and its neighbours are measured in. `resolve` clamps to now.
 */
export function nominalBounds(
  period: HistoryPeriod,
  nowMs: number,
  timeZone: string,
): { from: string; to: string } | null {
  if (period.kind === "custom") {
    const from = parseWall(period.from);
    const to = parseWall(period.to);
    return from && to ? { from: wallString(from), to: wallString(to) } : null;
  }
  const today = todayWall(nowMs, timeZone);
  const month = startOfMonth(today);
  const year: Wall = { year: today.year, month: 1, day: 1, hour: 0, minute: 0 };
  const now = toDateTimeInput(nowMs, timeZone);
  const bounds = (from: Wall, to: Wall) => ({ from: wallString(from), to: wallString(to) });
  switch (period.preset) {
    case "today":
      return bounds(today, addDays(today, 1));
    case "yesterday":
      return bounds(addDays(today, -1), today);
    case "7d":
    case "30d":
    case "90d": {
      // Rolling: ending now, starting the same wall time N days back.
      const days = period.preset === "7d" ? 7 : period.preset === "30d" ? 30 : 90;
      const end = parseWall(now) ?? today;
      return bounds(addDays(end, -days), end);
    }
    case "this_month":
      return bounds(month, addMonths(month, 1));
    case "last_month":
      return bounds(addMonths(month, -1), month);
    case "this_year":
      return bounds(year, addMonths(year, 12));
    case "last_year":
      return bounds(addMonths(year, -12), year);
  }
}

export interface ResolvedPeriod extends WindowRange {
  /** The window still ends now, so there is something new to learn. */
  live: boolean;
  /** The period's own length in ms (not clamped to now). */
  spanMs: number;
}

/**
 * The instants a period covers on the Plant's clock, or why it covers none.
 *
 * The end is clamped to now — there are no readings from the future — and a
 * single Plant day is framed midnight to midnight (`day`), so today's curve
 * stops at now on an axis that runs to 24:00.
 */
export function resolvePeriod(
  period: HistoryPeriod,
  nowMs: number,
  timeZone: string,
): ResolvedPeriod | { error: string } {
  const bounds = nominalBounds(period, nowMs, timeZone);
  if (!bounds) return { error: "That period is not a valid date and time." };
  const fromMs = fromDateTimeInput(bounds.from, timeZone);
  const toMs = fromDateTimeInput(bounds.to, timeZone);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return { error: "That period is not a valid date and time." };
  }
  if (toMs <= fromMs) return { error: "The end must come after the start." };
  if (fromMs >= nowMs) return { error: "The start is in the future — there are no readings yet." };
  const end = Math.min(toMs, nowMs);
  const from = parseWall(bounds.from)!;
  const to = parseWall(bounds.to)!;
  const oneDay = isMidnight(from) && isMidnight(to) && daysBetween(from, to) === 1;
  const day = oneDay ? dayInZone(fromMs, timeZone) : null;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(end).toISOString(),
    day,
    live: toMs >= nowMs,
    spanMs: toMs - fromMs,
  };
}

/** The Plant-local dates a period touches, first and last inclusive — what the Reports take. */
export function periodDates(
  period: HistoryPeriod,
  nowMs: number,
  timeZone: string,
): { first: string; last: string } | null {
  const resolved = resolvePeriod(period, nowMs, timeZone);
  if ("error" in resolved) return null;
  const first = dateInputInZone(resolved.from, timeZone);
  // The end is exclusive: a period ending at midnight does not touch that day.
  const last = dateInputInZone(Date.parse(resolved.to) - 1, timeZone);
  return { first, last };
}

// ── Moving through time ──────────────────────────────────────────────────────

/** The six presets that are a fixed calendar stretch, which a shifted period may turn back into. */
const CALENDAR_PRESETS: PeriodPreset[] = ["today", "yesterday", "this_month", "last_month", "this_year", "last_year"];

/** A custom period that is exactly a calendar preset is shown as that preset. */
export function canonical(period: HistoryPeriod, nowMs: number, timeZone: string): HistoryPeriod {
  if (period.kind !== "custom") return period;
  const own = nominalBounds(period, nowMs, timeZone);
  if (!own) return period;
  for (const preset of CALENDAR_PRESETS) {
    const bounds = nominalBounds({ kind: "preset", preset }, nowMs, timeZone);
    if (bounds && bounds.from === own.from && bounds.to === own.to) return { kind: "preset", preset };
  }
  return period;
}

/**
 * The period of the same length before (`-1`) or after (`+1`) this one —
 * a month for a month, a day for a day, otherwise the same duration — or null
 * when the one after would start in the future.
 */
export function shiftPeriod(
  period: HistoryPeriod,
  direction: -1 | 1,
  nowMs: number,
  timeZone: string,
): HistoryPeriod | null {
  const bounds = nominalBounds(period, nowMs, timeZone);
  if (!bounds) return null;
  const from = parseWall(bounds.from)!;
  const to = parseWall(bounds.to)!;
  let next: { from: Wall; to: Wall };
  if (isMidnight(from) && isMidnight(to) && from.day === 1 && to.day === 1) {
    const months = monthsBetween(from, to) * direction;
    next = { from: addMonths(from, months), to: addMonths(to, months) };
  } else if (isMidnight(from) && isMidnight(to)) {
    const days = daysBetween(from, to) * direction;
    next = { from: addDays(from, days), to: addDays(to, days) };
  } else {
    const fromMs = fromDateTimeInput(bounds.from, timeZone);
    const toMs = fromDateTimeInput(bounds.to, timeZone);
    const step = (toMs - fromMs) * direction;
    const shiftedFrom = parseWall(toDateTimeInput(fromMs + step, timeZone));
    const shiftedTo = parseWall(toDateTimeInput(toMs + step, timeZone));
    if (!shiftedFrom || !shiftedTo) return null;
    next = { from: shiftedFrom, to: shiftedTo };
  }
  if (fromDateTimeInput(wallString(next.from), timeZone) >= nowMs) return null;
  return canonical({ kind: "custom", from: wallString(next.from), to: wallString(next.to) }, nowMs, timeZone);
}

export type CompareMode = "none" | "previous" | "last_year";

export const COMPARE_MODES: { value: CompareMode; label: string; hint: string }[] = [
  { value: "none", label: "No comparison", hint: "Only the period chosen." },
  { value: "previous", label: "Previous period", hint: "The stretch of the same length just before it." },
  { value: "last_year", label: "Same period last year", hint: "The same dates, a year earlier." },
];

/** The stretch a period is compared with, as a period of its own. */
export function comparisonPeriod(
  period: HistoryPeriod,
  mode: CompareMode,
  nowMs: number,
  timeZone: string,
): HistoryPeriod | null {
  if (mode === "none") return null;
  if (mode === "previous") return shiftPeriod(period, -1, nowMs, timeZone);
  const bounds = nominalBounds(period, nowMs, timeZone);
  if (!bounds) return null;
  // A period still in progress is compared to the same point last year, not
  // the whole of it: this month so far against the same days of last year's.
  const resolved = resolvePeriod(period, nowMs, timeZone);
  const end =
    "error" in resolved || !resolved.live
      ? parseWall(bounds.to)!
      : parseWall(toDateTimeInput(Date.parse(resolved.to), timeZone))!;
  return {
    kind: "custom",
    from: wallString(addMonths(parseWall(bounds.from)!, -12)),
    to: wallString(addMonths(end, -12)),
  };
}

// ── Words ────────────────────────────────────────────────────────────────────

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const dmy = (wall: Wall) => `${pad(wall.day)}-${pad(wall.month)}-${pad(wall.year, 4)}`;
const hm = (wall: Wall) => `${pad(wall.hour)}:${pad(wall.minute)}`;

/** What the period is, in words — "Last 30 days", "March 2026", "01-03-2026 – 15-03-2026". */
export function periodLabel(period: HistoryPeriod, nowMs: number, timeZone: string): string {
  const shown = canonical(period, nowMs, timeZone);
  if (shown.kind === "preset") {
    return PERIOD_PRESETS.find((preset) => preset.value === shown.preset)?.label ?? shown.preset;
  }
  const from = parseWall(shown.from);
  const to = parseWall(shown.to);
  if (!from || !to) return "Custom period";
  if (isMidnight(from) && isMidnight(to)) {
    if (from.day === 1 && to.day === 1 && monthsBetween(from, to) === 1) {
      return `${MONTHS[from.month - 1]} ${from.year}`;
    }
    if (from.day === 1 && from.month === 1 && to.day === 1 && to.month === 1 && to.year - from.year === 1) {
      return String(from.year);
    }
    const last = addDays(to, -1);
    return daysBetween(from, to) === 1 ? dmy(from) : `${dmy(from)} – ${dmy(last)}`;
  }
  return `${dmy(from)} ${hm(from)} – ${dmy(to)} ${hm(to)}`;
}

/**
 * How fine the readings still are at the period's start — the retention
 * cascade (`domain/tiering.TIERS`), in words, so a chart a year back that is
 * hourly says why rather than looking coarse for no reason.
 */
export function detailNote(fromIso: string, nowMs: number): string | null {
  const age = nowMs - Date.parse(fromIso);
  if (!Number.isFinite(age)) return null;
  if (age > 3 * 365 * DAY_MS) return "Readings this old are kept as hourly and daily averages only.";
  if (age > 365 * DAY_MS) return "Readings this old are kept as 15-minute averages and coarser.";
  if (age > 30 * DAY_MS) return "Readings this old are kept as 1-minute averages and coarser.";
  return null;
}

// ── The link ─────────────────────────────────────────────────────────────────

/**
 * The period in a link: `?period=30d`, or `?from=2026-03-01&to=2026-03-31`
 * for whole days (the last day inclusive, as a person writes it), or
 * `?from=2026-03-01T06:00&to=2026-03-01T18:00` for a timed stretch.
 */
export function periodToParams(period: HistoryPeriod): Record<string, string> {
  if (period.kind === "preset") return { period: period.preset };
  const from = parseWall(period.from);
  const to = parseWall(period.to);
  if (from && to && isMidnight(from) && isMidnight(to)) {
    const day = (wall: Wall) => wallString(wall).slice(0, 10);
    return { from: day(from), to: day(addDays(to, -1)) };
  }
  return { from: period.from, to: period.to };
}

/** The period a link names, or null when it names none (or names one badly). */
export function periodFromParams(params: URLSearchParams): HistoryPeriod | null {
  const preset = params.get("period");
  if (preset && PRESET_SET.has(preset)) return { kind: "preset", preset: preset as PeriodPreset };
  const fromText = params.get("from");
  const toText = params.get("to");
  if (!fromText || !toText) return null;
  const from = parseWall(fromText);
  const to = parseWall(toText);
  if (!from || !to) return null;
  // A date alone at the end is that whole day.
  const end = toText.includes("T") ? to : addDays({ ...to, hour: 0, minute: 0 }, 1);
  const start = fromText.includes("T") ? from : { ...from, hour: 0, minute: 0 };
  const period: HistoryPeriod = { kind: "custom", from: wallString(start), to: wallString(end) };
  return period.from < period.to ? period : null;
}

/** Whether two periods are the same choice. */
export function samePeriod(a: HistoryPeriod | null, b: HistoryPeriod | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "preset" && b.kind === "preset") return a.preset === b.preset;
  if (a.kind === "custom" && b.kind === "custom") return a.from === b.from && a.to === b.to;
  return false;
}

/** A custom period of whole Plant days, first and last inclusive — a day clicked on the calendar. */
export function daysPeriod(first: string, last: string): HistoryPeriod {
  const from = parseWall(first);
  const to = parseWall(last);
  if (!from || !to) return DEFAULT_PERIOD;
  return { kind: "custom", from: wallString(from), to: wallString(addDays(to, 1)) };
}
