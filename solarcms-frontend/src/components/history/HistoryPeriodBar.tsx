/**
 * The history screens' one period control.
 *
 * One row, above everything it scopes, and the same on every screen that reads
 * the past — so the stretch chosen on one is the stretch on the next
 * (`useHistoryPeriod`). The parts, left to right:
 *
 * - **◀ / ▶** step to the period of the same length before or after: the
 *   month before a month, the day before a day. Forward stops at now.
 * - **Period** — the presets as a list (nobody fights a calendar for "last 30
 *   days"), and "Custom" for two Plant-local wall times.
 * - What is on screen, in words, in the Plant's time; and how fine the
 *   readings still are that far back, so an hourly chart a year ago says why.
 * - **Copy link** — the URL already carries the period; this puts it on the
 *   clipboard.
 *
 * ⚠ Times typed are the **Plant's** wall clock (`fromDateTimeInput`), never
 * the browser's: an operator abroad typing 06:00 means sunrise at the Plant.
 */

import { useEffect, useMemo, useState } from "react";
import {
  PERIOD_PRESETS,
  canonical,
  detailNote,
  nominalBounds,
  periodLabel,
  resolvePeriod,
  shiftPeriod,
  type HistoryPeriod,
  type PeriodPreset,
} from "@/api/historyPeriod";
import { SelectBox, inputClass } from "@/components/ui";
import { IconCalendar, IconCheck, IconChevronLeft, IconChevronRight } from "@/components/icons";
import { timezoneLabel, toDateTimeInput } from "@/format/datetime";

const CUSTOM = "custom";

export function HistoryPeriodBar({
  period,
  onChange,
  timezone,
  nowMs,
  note,
}: {
  period: HistoryPeriod;
  onChange: (period: HistoryPeriod) => void;
  /** The Plant's zone; undefined until the Plant has loaded, when nothing can be typed. */
  timezone: string | undefined;
  /** Anchored to the minute by the caller, as every window here is. */
  nowMs: number;
  /** A line the screen adds about what this period means for it. */
  note?: string | null;
}): JSX.Element {
  const zone = timezone ?? "UTC";
  const shown = canonical(period, nowMs, zone);
  const [customOpen, setCustomOpen] = useState(shown.kind === "custom");
  useEffect(() => {
    if (shown.kind === "custom") setCustomOpen(true);
  }, [shown.kind]);

  // The inputs hold what is typed; a period is applied only once both make one.
  const bounds = timezone ? nominalBounds(shown, nowMs, timezone) : null;
  const resolved = timezone ? resolvePeriod(shown, nowMs, timezone) : null;
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const boundsKey = bounds ? `${bounds.from}|${bounds.to}` : "";
  useEffect(() => {
    if (!bounds || !resolved || "error" in resolved) return;
    setFromInput(bounds.from);
    // A period still in progress shows its end as now, which is what is drawn.
    setToInput(resolved.live && timezone ? toDateTimeInput(Date.parse(resolved.to), timezone) : bounds.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey]);

  const draft = useMemo<HistoryPeriod | null>(
    () => (fromInput && toInput ? { kind: "custom", from: fromInput, to: toInput } : null),
    [fromInput, toInput],
  );
  const draftCheck = draft && timezone ? resolvePeriod(draft, nowMs, timezone) : null;
  const draftError = draftCheck && "error" in draftCheck ? draftCheck.error : null;

  const apply = (from: string, to: string) => {
    if (!from || !to || !timezone) return;
    const next: HistoryPeriod = { kind: "custom", from, to };
    if ("error" in resolvePeriod(next, nowMs, timezone)) return;
    onChange(canonical(next, nowMs, timezone));
  };

  const previous = timezone ? shiftPeriod(shown, -1, nowMs, timezone) : null;
  const next = timezone ? shiftPeriod(shown, 1, nowMs, timezone) : null;

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
    } catch {
      // No clipboard (an insecure origin, a refused permission): the address
      // bar already holds the same link, and saying "copied" would be untrue.
      setCopied(false);
    }
  };

  const latest = timezone ? toDateTimeInput(nowMs, timezone) : undefined;
  const label = periodLabel(shown, nowMs, zone);
  const detail = resolved && !("error" in resolved) ? detailNote(resolved.from, nowMs) : null;
  const stepButton =
    "flex h-8 w-8 items-center justify-center rounded-control border border-slate-300 bg-white text-ink-muted shadow-sm transition hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 dark:border-line dark:bg-surface-raised";

  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Period shown on this screen">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={stepButton}
            onClick={() => previous && onChange(previous)}
            disabled={!previous}
            aria-label="Previous period"
            title={previous ? `Back to ${periodLabel(previous, nowMs, zone)}` : undefined}
          >
            <IconChevronLeft size={16} />
          </button>
          <SelectBox
            label="Period"
            size="sm"
            value={shown.kind === "preset" && !customOpen ? shown.preset : CUSTOM}
            onChange={(value) => {
              if (value === CUSTOM) {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange({ kind: "preset", preset: value as PeriodPreset });
            }}
            display={
              <span className="flex items-center gap-1.5">
                <IconCalendar size={13} className="text-ink-muted" />
                {customOpen && shown.kind === "preset" ? "Custom" : label}
              </span>
            }
          >
            {PERIOD_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value} title={preset.hint}>
                {preset.label}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </SelectBox>
          <button
            type="button"
            className={stepButton}
            onClick={() => next && onChange(next)}
            disabled={!next}
            aria-label="Next period"
            title={next ? `On to ${periodLabel(next, nowMs, zone)}` : "Nothing after this has happened yet."}
          >
            <IconChevronRight size={16} />
          </button>
        </div>

        {customOpen ? (
          <>
            <label className="flex flex-col gap-1">
              <span className="field-label">From</span>
              <input
                type="datetime-local"
                value={fromInput}
                max={latest}
                disabled={!timezone}
                onChange={(event) => {
                  setFromInput(event.target.value);
                  apply(event.target.value, toInput);
                }}
                className={`${inputClass} w-auto py-1 text-xs`}
                aria-describedby="history-period-note"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="field-label">To</span>
              <input
                type="datetime-local"
                value={toInput}
                max={latest}
                disabled={!timezone}
                onChange={(event) => {
                  setToInput(event.target.value);
                  apply(fromInput, event.target.value);
                }}
                className={`${inputClass} w-auto py-1 text-xs`}
                aria-describedby="history-period-note"
              />
            </label>
          </>
        ) : null}

        <button
          type="button"
          onClick={() => void copyLink()}
          className="ml-auto flex items-center gap-1 rounded-control border border-line px-2 py-1.5 text-[11px] font-medium text-ink-muted transition hover:text-ink"
          title="Copy a link to this screen with this period, to send to someone"
        >
          {copied ? <IconCheck size={12} /> : null}
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
      <p id="history-period-note" className={`text-xs ${draftError && customOpen ? "text-bad" : "text-ink-faint"}`}>
        {draftError && customOpen ? (
          draftError
        ) : (
          <>
            Showing <span className="font-medium text-ink-muted">{label}</span>
            {timezone ? `, in the Plant's time (${timezoneLabel(timezone)})` : ""}.
            {detail ? ` ${detail}` : ""}
            {note ? ` ${note}` : ""}
          </>
        )}
      </p>
    </div>
  );
}
