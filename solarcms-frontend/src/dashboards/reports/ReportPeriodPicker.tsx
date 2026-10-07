/**
 * A report's period: today, yesterday, the last 7 or 30 days, or a custom
 * range of the Plant's own dates and clock times — shared by the standard and
 * custom reports, so the two can never read a period differently.
 *
 * The period goes to the server by name and is resolved there in the Plant's
 * zone. The custom range stops at the end time; 23:59 runs to the end of the
 * day, so a whole day typed by hand reads exactly as the same day chosen as
 * Yesterday.
 */

import type { ReportPeriod } from "@/api/endpoints/reports";
import { SegmentedControl, inputClass } from "@/components/ui";
import { timezoneLabel } from "@/format/datetime";
import { shiftDate, type CustomRange } from "./format";

const PERIODS: { value: ReportPeriod; label: string; hint?: string }[] = [
  { value: "today", label: "Today", hint: "Since the Plant's midnight." },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 Days", hint: "Today and the six days before it." },
  { value: "last_30_days", label: "Last 30 Days", hint: "Today and the 29 days before it." },
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

export function ReportPeriodPicker({
  period,
  onPeriod,
  range,
  onRange,
  now,
  zone,
  problem,
  noteId,
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
}): JSX.Element {
  const today = now.slice(0, 10);
  const { fromDate, fromTime, toDate, toTime } = range;
  const set = (patch: Partial<CustomRange>) => onRange({ ...range, ...patch });

  const choose = (next: ReportPeriod) => {
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
          <SegmentedControl label="Period" value={period} onChange={choose} options={PERIOD_OPTIONS} />
        </div>
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
      ) : period === "custom" ? (
        <p id={noteId} className="mt-2 text-xs text-ink-faint">
          Times are the Plant&apos;s clock ({timezoneLabel(zone)}). The report stops at the end time;
          23:59 runs to the end of the day.
        </p>
      ) : null}
    </div>
  );
}
