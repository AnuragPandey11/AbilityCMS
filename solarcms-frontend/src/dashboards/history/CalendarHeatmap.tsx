/**
 * A Plant's days as month calendars, each day shaded by the chosen figure.
 *
 * Month calendars rather than a GitHub-style strip of 53 weeks: a date is
 * readable in place ("the 14th was dark"), the grid wraps on a phone instead
 * of scrolling sideways, and a period from the 10th to the 9th still reads as
 * two months.
 *
 * One hue, light to dark, for one magnitude (a sequential scale: the chart
 * colour at rising strength, so it follows the theme and owns no status
 * meaning). What is *not* a magnitude is drawn as shape, never colour:
 *
 * - **nothing measured** — an empty dashed outline, never the palest shade;
 * - **partial** (under 90% of the day's slots) — a small dot in the corner;
 * - **outside what it can physically be** — a ring and "!", the value kept;
 * - **today** — a ring, because it is still running;
 * - **a day of the month outside the period** — faint, not clickable.
 *
 * Every day is a button: Tab reaches it, its label reads the day's figure and
 * coverage aloud, and Enter opens it (`onOpen`). The legend says what each
 * shape means, so nothing is carried by colour alone.
 */

import type { CSSProperties } from "react";
import type { HistoryDay } from "@/api/endpoints/history";
import { formatNumber } from "@/format/value";
import { token, withAlpha } from "@/theme/tokens";
import {
  PARTIAL_COVERAGE,
  calendarMonths,
  displayDate,
  fillAlpha,
  isFlagged,
  isPartial,
  scaleBounds,
  shade,
  valueOf,
  type Metric,
} from "./metrics";

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function describe(day: HistoryDay, metric: Metric): string {
  const value = valueOf(day, metric.key);
  const figure =
    value === null ? "nothing measured" : `${metric.label} ${formatNumber(value, { digits: metric.digits })} ${metric.unit}`;
  const parts = [displayDate(day.date), figure];
  if (isFlagged(day, metric.key)) parts.push("outside what PR can physically be");
  if (day.coverage !== null && metric.key !== "coverage") parts.push(`coverage ${Math.round(day.coverage)}%`);
  if (day.in_progress) parts.push("today, still running");
  return parts.join(", ");
}

export function CalendarHeatmap({
  days,
  metric,
  selected,
  onOpen,
}: {
  days: HistoryDay[];
  metric: Metric;
  selected: string | null;
  onOpen: (day: HistoryDay) => void;
}): JSX.Element {
  const bounds = scaleBounds(days, metric.key);
  const months = calendarMonths(days);
  const base = token("chart-primary");

  const cellStyle = (day: HistoryDay): CSSProperties | undefined => {
    const value = valueOf(day, metric.key);
    if (value === null || !bounds || isFlagged(day, metric.key)) return undefined;
    return { backgroundColor: withAlpha(base, fillAlpha(shade(value, bounds))) };
  };
  /** Light figures on the darker half of the scale, so the day number stays legible. */
  const darkFill = (day: HistoryDay): boolean => {
    const value = valueOf(day, metric.key);
    return value !== null && bounds !== null && !isFlagged(day, metric.key) && shade(value, bounds) > 0.55;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-x-6 gap-y-5 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
        {months.map((month) => (
          <section key={month.key} aria-label={month.title} className="min-w-0">
            <h3 className="mb-1.5 text-xs font-semibold text-ink">{month.title}</h3>
            <div className="grid grid-cols-7 gap-1">
              {WEEKDAYS.map((letter, index) => (
                <div
                  key={`${month.key}-h${index}`}
                  aria-hidden
                  title={WEEKDAY_NAMES[index]}
                  className="pb-0.5 text-center text-[10px] font-medium text-ink-faint"
                >
                  {letter}
                </div>
              ))}
              {month.weeks.flat().map((cell, index) => {
                if (!cell) return <div key={`${month.key}-p${index}`} aria-hidden className="aspect-square" />;
                const day = cell.day;
                if (!day) {
                  return (
                    <div
                      key={cell.date}
                      aria-hidden
                      className="flex aspect-square items-center justify-center rounded text-[10px] text-ink-faint/50"
                    >
                      {cell.dayOfMonth}
                    </div>
                  );
                }
                const value = valueOf(day, metric.key);
                const flagged = isFlagged(day, metric.key);
                // Only a figure can be partial: a day nothing measured is already an outline.
                const partial = value !== null && isPartial(day) && metric.key !== "coverage";
                const isSelected = selected === day.date;
                return (
                  <button
                    key={cell.date}
                    type="button"
                    onClick={() => onOpen(day)}
                    aria-label={describe(day, metric)}
                    title={describe(day, metric)}
                    aria-pressed={isSelected}
                    style={cellStyle(day)}
                    className={`relative flex aspect-square items-center justify-center rounded text-[10px] font-medium tabular-nums transition hover:ring-2 hover:ring-accent/50 focus-visible:ring-2 focus-visible:ring-accent ${
                      value === null
                        ? "border border-dashed border-line-strong text-ink-faint"
                        : flagged
                          ? "border-2 border-warn text-warn"
                          : darkFill(day)
                            ? "text-on-accent"
                            : "text-ink"
                    } ${day.in_progress ? "outline outline-2 outline-offset-1 outline-ink-muted" : ""} ${
                      isSelected ? "ring-2 ring-accent" : ""
                    }`}
                  >
                    {flagged ? "!" : cell.dayOfMonth}
                    {partial ? (
                      <span
                        aria-hidden
                        className={`absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full ${darkFill(day) ? "bg-on-accent" : "bg-ink-muted"}`}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {/* The legend: the scale, and every shape that is not on it. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-ink-muted">
        {bounds ? (
          <span className="flex items-center gap-2">
            <span className="figure">{formatNumber(bounds.min, { digits: metric.digits })}</span>
            <span
              aria-hidden
              className="h-2.5 w-28 rounded-sm"
              style={{
                background: `linear-gradient(to right, ${withAlpha(base, fillAlpha(shade(bounds.min, bounds)))}, ${withAlpha(base, fillAlpha(1))})`,
              }}
            />
            <span className="figure">
              {formatNumber(bounds.max, { digits: metric.digits })} {metric.unit}
            </span>
          </span>
        ) : (
          <span>Nothing was measured on any day of this period.</span>
        )}
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-3 rounded-sm border border-dashed border-line-strong" />
          nothing measured
        </span>
        {metric.key !== "coverage" ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="relative h-3 w-3 rounded-sm bg-surface-sunken">
              <span className="absolute right-0 top-0 h-1.5 w-1.5 rounded-full bg-ink-muted" />
            </span>
            partial — under {PARTIAL_COVERAGE}% of the day measured
          </span>
        ) : null}
        {metric.key === "performance_ratio" ? (
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="flex h-3 w-3 items-center justify-center rounded-sm border-2 border-warn text-[8px] font-bold text-warn">
              !
            </span>
            outside what PR can be — open the day for why
          </span>
        ) : null}
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-3 rounded-sm outline outline-2 outline-offset-1 outline-ink-muted" />
          today, still running
        </span>
      </div>
    </div>
  );
}
