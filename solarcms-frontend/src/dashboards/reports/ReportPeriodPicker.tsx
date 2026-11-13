/**
 * A report's period: today, yesterday, the last 7 or 30 days, the last N days
 * (where offered), or a custom range of the Plant's own dates and clock times
 * — shared by the standard and custom reports, so the two can never read a
 * period differently.
 *
 * "Last N days" goes to the server as `last_N_days`, a name like the presets,
 * so a saved report keeps meaning the latest N days; a custom range is fixed
 * dates. The count is applied when the field is left or Enter is pressed —
 * applied per keystroke, the "7" of "70" would switch to Last 7 Days and take
 * the field away mid-word.
 *
 * The period goes to the server by name and is resolved there in the Plant's
 * zone. The custom range stops at the end time; 23:59 runs to the end of the
 * day, so a whole day typed by hand reads exactly as the same day chosen as
 * Yesterday.
 */

import { useEffect, useState } from "react";
import type { ReportPeriod } from "@/api/endpoints/reports";
import { SegmentedControl, inputClass } from "@/components/ui";
import { timezoneLabel } from "@/format/datetime";
import { lastDaysOf, shiftDate, type CustomRange } from "./format";

/** A segment: the presets and Custom are periods; "last_n" is any other count. */
type Choice = "today" | "yesterday" | "last_7_days" | "last_30_days" | "last_n" | "custom";

const PERIODS: { value: Choice; label: string; hint?: string }[] = [
  { value: "today", label: "Today", hint: "Since the Plant's midnight." },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 Days", hint: "Today and the six days before it." },
  { value: "last_30_days", label: "Last 30 Days", hint: "Today and the 29 days before it." },
  {
    value: "last_n",
    label: "Last N Days",
    hint: "Today and the days before it, as many as you choose. Saved as a count, so a saved report always reads the latest days.",
  },
  { value: "custom", label: "Custom" },
];

// A segment's label never breaks inside its pill; on a narrow screen the
// track scrolls sideways instead ("Last / 7 / Days" read as three options).
const PERIOD_OPTIONS = PERIODS.map((option) => ({
  ...option,
  label: <span className="whitespace-nowrap">{option.label}</span>,
}));

// Mirrors `domain/periods.MAX_REPORT_DAYS`; the server enforces it regardless.
export const MAX_CUSTOM_DAYS = 366;

/** Where "Last N Days" opens: two weeks, between the two presets. */
const DEFAULT_LAST_DAYS = 14;

function choiceOf(period: ReportPeriod): Choice {
  if (
    period === "today" ||
    period === "yesterday" ||
    period === "last_7_days" ||
    period === "last_30_days" ||
    period === "custom"
  ) {
    return period;
  }
  return lastDaysOf(period) !== null ? "last_n" : "today";
}

export function ReportPeriodPicker({
  period,
  onPeriod,
  range,
  onRange,
  now,
  zone,
  problem,
  noteId,
  subject = "report",
  offerLastDays = false,
}: {
  period: ReportPeriod;
  onPeriod: (next: ReportPeriod) => void;
  range: CustomRange;
  onRange: (next: CustomRange) => void;
  /** The Plant's wall clock, `YYYY-MM-DDTHH:MM`. */
  now: string;
  zone: string;
  problem: string | null;
  noteId: string;
  /** What the period is of, for the note under a custom range. */
  subject?: string;
  /** Offer "Last N Days" — the Reports screen does; a screen with a shorter limit need not. */
  offerLastDays?: boolean;
}): JSX.Element {
  const today = now.slice(0, 10);
  const { fromDate, fromTime, toDate, toTime } = range;
  const set = (patch: Partial<CustomRange>) => onRange({ ...range, ...patch });
  const choice = choiceOf(period);
  const options = offerLastDays
    ? PERIOD_OPTIONS
    : PERIOD_OPTIONS.filter((option) => option.value !== "last_n");

  // The count as typed, applied on leaving the field or Enter.
  const [days, setDays] = useState(String(lastDaysOf(period) ?? DEFAULT_LAST_DAYS));
  const [daysProblem, setDaysProblem] = useState<string | null>(null);
  useEffect(() => {
    // A period set from outside — a saved report opened — shows its count.
    const count = lastDaysOf(period);
    if (count !== null) setDays(String(count));
  }, [period]);

  const applyDays = () => {
    const count = Number(days.trim());
    if (!Number.isInteger(count) || count < 1 || count > MAX_CUSTOM_DAYS) {
      setDaysProblem(`Choose a whole number of days from 1 to ${MAX_CUSTOM_DAYS}.`);
      return;
    }
    setDaysProblem(null);
    onPeriod(`last_${count}_days`);
  };

  const choose = (next: Choice) => {
    setDaysProblem(null);
    if (next === "last_n") {
      const count = Number(days);
      onPeriod(
        `last_${Number.isInteger(count) && count >= 1 && count <= MAX_CUSTOM_DAYS ? count : DEFAULT_LAST_DAYS}_days`,
      );
      return;
    }
    // Custom opens on the last seven days rather than two empty inputs: a
    // range to adjust is quicker than one to invent.
    if (next === "custom" && (!fromDate || !toDate)) {
      onRange({ ...range, toDate: today, fromDate: shiftDate(today, -6) });
    }
    onPeriod(next);
  };

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="max-w-full overflow-x-auto">
          <SegmentedControl label="Period" value={choice} onChange={choose} options={options} />
        </div>
        {choice === "last_n" ? (
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <span className="w-20">
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_CUSTOM_DAYS}
                step={1}
                aria-label="Number of days"
                value={days}
                onChange={(event) => setDays(event.target.value)}
                onBlur={applyDays}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyDays();
                }}
                className={inputClass}
                aria-describedby={noteId}
              />
            </span>
            days, ending today
          </label>
        ) : null}
        {period === "custom" ? (
          <div className="flex flex-wrap items-center gap-2">
            {/* Each day keeps its time beside it when the row wraps. Sized by
                wrappers: the shared input class is full-width. */}
            <div className="flex items-center gap-1.5">
              <div className="w-40">
                <input
                  type="date"
                  aria-label="First day"
                  value={fromDate}
                  max={toDate || today}
                  onChange={(event) => set({ fromDate: event.target.value })}
                  className={inputClass}
                  aria-describedby={noteId}
                />
              </div>
              <div className="w-32">
                <input
                  type="time"
                  aria-label="Start time"
                  value={fromTime}
                  max={fromDate === today ? now.slice(11, 16) : undefined}
                  onChange={(event) => set({ fromTime: event.target.value })}
                  className={inputClass}
                  aria-describedby={noteId}
                />
              </div>
            </div>
            <span className="text-xs text-ink-muted">to</span>
            <div className="flex items-center gap-1.5">
              <div className="w-40">
                <input
                  type="date"
                  aria-label="Last day"
                  value={toDate}
                  min={fromDate || undefined}
                  max={today}
                  onChange={(event) => set({ toDate: event.target.value })}
                  className={inputClass}
                  aria-describedby={noteId}
                />
              </div>
              <div className="w-32">
                <input
                  type="time"
                  aria-label="End time"
                  value={toTime}
                  min={fromDate === toDate ? fromTime : undefined}
                  onChange={(event) => set({ toTime: event.target.value })}
                  className={inputClass}
                  aria-describedby={noteId}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>
      {problem ? (
        <p id={noteId} className="mt-2 text-xs text-bad">
          {problem}
        </p>
      ) : choice === "last_n" ? (
        <p id={noteId} className={`mt-2 text-xs ${daysProblem ? "text-bad" : "text-ink-faint"}`}>
          {daysProblem ??
            `Today and the days before it on the Plant's calendar. Saved with a report as a count, so it always reads the latest ${lastDaysOf(period) ?? days} days.`}
        </p>
      ) : period === "custom" ? (
        <p id={noteId} className="mt-2 text-xs text-ink-faint">
          Times are the Plant&apos;s clock ({timezoneLabel(zone)}). The {subject} stops at the end time;
          23:59 runs to the end of the day.
        </p>
      ) : null}
    </div>
  );
}
