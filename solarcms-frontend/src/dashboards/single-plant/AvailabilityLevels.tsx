/**
 * The Availability tile: Plant first, Grid and Inverter under it, Data
 * availability at the foot (option B, the user's choice of 1 Nov 2026 from the
 * rendered mockup).
 *
 * Three levels judged as a chain over daylight minutes — the grid, then the
 * Plant given a grid, then each Inverter given both — so one lost minute is
 * blamed on one level (`domain/availability.py`, ⚠ PROPOSED). Plant leads
 * because it is the O&M figure; Grid and Inverter say where the rest went.
 * Data availability is the old figure — the share of time Devices were
 * reporting — and sits at the foot because it is about the data, not the Plant.
 *
 * Each sub-line states a duration and, for an Inverter, which one — never a
 * cause. Nothing here knows why the Plant stopped, and an open Alarm is where a
 * cause would come from.
 */

import type { ReactNode } from "react";
import type { AvailabilityLevels, KpiFigure } from "@/api/schemas";
import { RatioMeter } from "@/components/charts/RatioMeter";
import { ratioTone, type RatioTone } from "@/components/charts/RatioDial";
import { formatRatioAsPercent, ratioIsImplausible } from "@/format/value";

/** "45 min", "3 h", "3 h 5 min", "2 d 4 h" — a span of minutes in words. */
export function minutesWords(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

function sentence(text: string | null | undefined, fallback: string): string {
  const words = text ?? fallback;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function gridLine(levels: AvailabilityLevels): string {
  const { grid } = levels;
  if (grid.value === null) return sentence(grid.undefined_reason, "not defined for this period");
  const parts = [grid.down_minutes > 0 ? `Down ${minutesWords(grid.down_minutes)}` : "No outage"];
  if (grid.no_data_minutes > 0) parts.push(`no reading for ${minutesWords(grid.no_data_minutes)}`);
  return parts.join(" · ");
}

function plantLine(levels: AvailabilityLevels): string {
  const { plant } = levels;
  if (plant.value === null) return sentence(plant.undefined_reason, "not defined for this period");
  const parts = [
    plant.down_minutes > 0 ? `Stopped ${minutesWords(plant.down_minutes)}` : "No plant-wide stop",
  ];
  if (levels.unattributed_minutes > 0) {
    parts.push(`${minutesWords(levels.unattributed_minutes)} not attributed`);
  }
  if (plant.without_grid_minutes > 0 && levels.grid.value === null) {
    parts.push("grid outages not set aside");
  }
  return parts.join(" · ");
}

function inverterLine(levels: AvailabilityLevels): string {
  const { inverter } = levels;
  if (inverter.value === null) {
    return sentence(inverter.undefined_reason, "not defined for this period");
  }
  const { worst } = inverter;
  if (!worst) return "No Inverter down";
  const others = inverter.down_minutes > worst.down_minutes ? " and others" : "";
  return `${worst.device_code} down ${minutesWords(worst.down_minutes)}${others}`;
}

const TEXT: Record<RatioTone, string> = { chart: "text-ink", warn: "text-warn", bad: "text-bad" };
const FILL: Record<RatioTone, string> = { chart: "bg-chart", warn: "bg-warn", bad: "bg-bad" };

/** A smaller level: name and figure on one line, a thin meter, and what it lost. */
function LevelRow({
  name,
  figure,
  line,
  title,
  notAvailable,
}: {
  name: string;
  figure: KpiFigure;
  line: string;
  title: string;
  /** Nothing at the Plant measures this level — not "nothing yet". */
  notAvailable: boolean;
}): JSX.Element {
  const value = figure.value;
  const drawn = value !== null && !ratioIsImplausible(value);
  const tone = drawn ? ratioTone(value, true) : "chart";
  const text = formatRatioAsPercent(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="cursor-help text-[13px] font-medium text-ink-muted" title={title}>
          {name}
        </span>
        {value === null ? (
          // "Not Available" only where nothing measures it; before dawn, or
          // where the figures could not be worked out, it is a dash.
          <span className="text-xs font-semibold text-ink-faint">
            {notAvailable ? "Not Available" : "—"}
          </span>
        ) : (
          <span className={`figure text-[17px] font-semibold ${drawn ? TEXT[tone] : "text-warn"}`}>
            {text.endsWith("%") ? text.slice(0, -1) : text}
            {text.endsWith("%") ? (
              <span className="ml-px text-xs font-medium text-ink-muted">%</span>
            ) : null}
          </span>
        )}
      </div>
      <div
        className={`relative h-2 overflow-hidden rounded ${
          drawn ? "bg-line" : "border border-dashed border-line-strong"
        }`}
        aria-hidden="true"
      >
        {drawn ? (
          <span
            className={`absolute inset-y-0 left-0 rounded ${FILL[tone]}`}
            style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
          />
        ) : null}
        {drawn
          ? [25, 50, 75].map((quarter) => (
              <span
                key={quarter}
                className="absolute inset-y-0 w-[1.5px] bg-surface-raised"
                style={{ left: `${quarter}%` }}
              />
            ))
          : null}
      </div>
      <span className="text-[11.5px] leading-snug text-ink-faint">{line}</span>
    </div>
  );
}

const TITLES = {
  plant:
    "Whether the Plant as a whole could generate, over daylight time with the grid there. " +
    "Down when no Inverter produces while they report, or every breaker is open. " +
    "One Inverter down is not the Plant down. Provisional (OPEN-16).",
  grid:
    "Whether the grid was there to export to: the grid meter's frequency within limits and its " +
    "voltage present, over daylight time. Provisional (OPEN-16).",
  inverter: (levels: AvailabilityLevels) =>
    `Inverters producing while the grid and the Plant were available, weighted by ${
      levels.inverter.weighted_by === "capacity" ? "rated capacity" : "count (not every size is recorded)"
    }. Provisional (OPEN-16).`,
};

/** The tile's drawing: Plant large, then Grid and Inverter. */
export function AvailabilityLevelsVisual({ levels }: { levels: AvailabilityLevels }): JSX.Element {
  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="cursor-help text-[13px] font-medium text-ink-muted" title={TITLES.plant}>
          Plant
        </span>
        <RatioMeter figure={levels.plant} label="Plant availability" />
        {levels.plant.value !== null ? (
          <span className="text-[11.5px] leading-snug text-ink-faint">{plantLine(levels)}</span>
        ) : null}
      </div>
      <div className="flex flex-col gap-2.5 border-t border-line pt-2.5">
        <LevelRow
          name="Grid"
          figure={levels.grid}
          line={gridLine(levels)}
          title={TITLES.grid}
          notAvailable={!levels.failed && levels.grid.source === null}
        />
        <LevelRow
          name="Inverter"
          figure={levels.inverter}
          line={inverterLine(levels)}
          title={TITLES.inverter(levels)}
          notAvailable={!levels.failed && levels.inverter.inverter_count < 2}
        />
      </div>
    </div>
  );
}

/**
 * The foot: Data availability, then the period and what it covered. Whole days
 * still to be worked out, or too old for minute data, are said, never hidden.
 */
export function availabilityFoot(
  levels: AvailabilityLevels,
  data: KpiFigure,
  period: ReactNode,
): ReactNode {
  const notes: string[] = [];
  if (levels.days_pending > 0) {
    notes.push(
      `${levels.days_counted} of ${levels.days_counted + levels.days_pending} earlier days worked out so far`,
    );
  }
  if (levels.days_beyond_retention > 0) {
    notes.push(`${levels.days_beyond_retention} days older than a year not counted`);
  }
  if (levels.curtailed_minutes > 0) notes.push(`curtailed ${minutesWords(levels.curtailed_minutes)}`);
  if (levels.planned_minutes > 0) notes.push(`planned work ${minutesWords(levels.planned_minutes)}`);
  return (
    <span className="flex flex-col gap-0.5">
      <span
        title="The share of time the Plant's Devices were reporting. Silent time is never counted as down above; it is shown here instead."
      >
        <span className="text-ink-muted">Data availability {formatRatioAsPercent(data.value)}</span>
        {" · Devices reporting"}
      </span>
      <span>
        {period}
        {levels.daylight_minutes > 0 ? ` · ${minutesWords(levels.daylight_minutes)} of daylight` : ""}
        {notes.length > 0 ? ` · ${notes.join(" · ")}` : ""}
      </span>
    </span>
  );
}
