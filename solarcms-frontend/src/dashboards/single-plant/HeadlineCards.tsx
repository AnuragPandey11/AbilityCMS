/**
 * The headline figures, drawn — each with a picture of what it is.
 *
 * Four forms, one per quantity, because the four figures are four different
 * *kinds* of number and a row of identical sparklines would say they were the
 * same kind. Current Power heads the page; the three energy registers sit at
 * its foot.
 *
 *   Current Power     a dial against AC capacity — a rate, bounded above
 *   Today's Energy    a sun clock, one spoke per hour of the Plant's day
 *   Month Energy      one column per day of the Plant's month
 *   Lifetime Energy   an odometer — it *is* a register that only counts up
 *
 * ── What every card keeps ───────────────────────────────────────────────────
 * - **The figure is the slot's, unaltered**, and so is its provenance line. A
 *   drawing is added to a figure; it never replaces the claim.
 * - **Accent only.** Nothing here is a verdict, so nothing is green, amber or
 *   red: 44% of capacity at 09:00 is a Plant doing exactly what it should.
 * - **A hole is drawn as a hole.** An hour or a day nobody measured is a dashed
 *   mark, never a short bar, and the energy that could not be placed in any
 *   period is stated on the card (Guardrails 18, 23).
 * - **Where a drawing cannot be honest, the card falls back to the figure**
 *   and says why — no AC capacity to draw power against, a unit that does not
 *   match the capacity's, a slot with no value at all.
 */

import { useId, type ComponentType, type ReactNode } from "react";
import type { ResolvedSlot } from "@/api/schemas";
import { useSlotSteps } from "@/api/useSlotSteps";
import type { PeriodEnergy } from "@/dashboards/single-plant/registerSteps";
import { SlotRailTile } from "@/components/dashboard/SlotValue";
import { FittedFigure } from "@/components/charts/FittedFigure";
import type { IconProps } from "@/components/icons";
import { digitsForUnit, formatCompact, formatHeadline, formatNumber } from "@/format/value";
import { formatDate, formatTime } from "@/format/datetime";

/**
 * An id usable inside `url(#…)`. React's own carry colons (`:r1:`), which are
 * legal in an id and not reliably so inside an SVG paint reference.
 */
function useSvgId(): string {
  return useId().replace(/:/g, "");
}

/** Below this share of the figure, energy that could not be placed is not worth a line. */
const UNPLACED_NOTE_SHARE = 0.01;

interface CardProps {
  slot: ResolvedSlot;
  icon: ComponentType<IconProps>;
  /** A control at the foot of the card, in every state it can render in. */
  action?: ReactNode;
  /** Draw at the size of a fifth of a row rather than a third. */
  compact?: boolean;
}

export function HeadlineCard({
  slot,
  icon,
  action,
  compact,
  plantId,
  acCapacityKw,
}: CardProps & {
  plantId: number;
  acCapacityKw: number | null;
}): JSX.Element {
  // No value, no drawing: the tile's explanation of *why* there is no value is
  // worth more than any picture of nothing.
  if (slot.value === null) return <SlotRailTile slot={slot} icon={icon} action={action} />;
  switch (slot.slot_code) {
    case "kpi.current_power":
      return <PowerCard slot={slot} icon={icon} action={action} acCapacityKw={acCapacityKw} />;
    case "kpi.energy_today":
      return (
        <SunClockCard slot={slot} icon={icon} action={action} compact={compact} plantId={plantId} />
      );
    case "kpi.energy_month":
      return <DayColumnsCard slot={slot} icon={icon} action={action} plantId={plantId} />;
    case "kpi.energy_lifetime":
      return <OdometerCard slot={slot} icon={icon} action={action} />;
    default:
      return <SlotRailTile slot={slot} icon={icon} action={action} />;
  }
}

/** The figure as the tile prints it, for drawings that carry it themselves. */
function slotHeadline(slot: ResolvedSlot): { text: string; title: string } {
  const headline = formatHeadline(slot.value, { digits: digitsForUnit(slot.unit) });
  return {
    text: headline.text,
    title: `${headline.compacted ? headline.exact : String(slot.value)}${slot.unit ? ` ${slot.unit}` : ""}`,
  };
}

/** What a register view could not place, said once, in the provenance line. */
function placementNote(
  slot: ResolvedSlot,
  steps: ReturnType<typeof useSlotSteps>,
  by: "hour" | "day",
): ReactNode {
  if (steps.unavailableReason) return steps.unavailableReason;
  if (steps.isError) return `the ${by === "hour" ? "hourly" : "daily"} breakdown could not be loaded`;
  if (steps.isLoading || slot.value === null) return null;
  const parts: string[] = [];
  const unplaced = slot.value - steps.placed;
  if (unplaced > Math.abs(slot.value) * UNPLACED_NOTE_SHARE) {
    parts.push(`${formatNumber(unplaced, { digits: 0 })}${slot.unit ? ` ${slot.unit}` : ""} not placed by ${by}`);
  }
  if (steps.backwardsSteps > 0) parts.push(`${steps.backwardsSteps} counter reset(s) skipped`);
  if (steps.flaggedCount > 0) parts.push(`${steps.flaggedCount} flagged reading(s) left out`);
  if (parts.length === 0) return null;
  return (
    <span
      className="cursor-help underline decoration-dotted underline-offset-2"
      title={
        `The register counted this, but nothing says which ${by} it accrued in: it came before ` +
        `the first stored reading in the ${by === "hour" ? "day" : "month"}, or across a silence. ` +
        "It is left out of the drawing rather than guessed into one period, and the figure above " +
        "still includes it. A backwards step (a rollover, reset or replaced meter — OPEN-14) is " +
        "never counted."
      }
    >
      {parts.join(" · ")}
    </span>
  );
}

// ── Current Power ─────────────────────────────────────────────────────────────

/** A point on a circle, angles in degrees clockwise from three o'clock (SVG's own). */
function polar(cx: number, cy: number, r: number, degrees: number): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  return [cx + r * Math.cos(radians), cy + r * Math.sin(radians)];
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x0, y0] = polar(cx, cy, r, from);
  const [x1, y1] = polar(cx, cy, r, to);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function PowerCard({ slot, icon, action, acCapacityKw }: CardProps & { acCapacityKw: number | null }): JSX.Element {
  if (acCapacityKw === null || acCapacityKw <= 0) {
    return <SlotRailTile slot={slot} icon={icon} action={action} note="no AC capacity recorded to draw this against" />;
  }
  // The figure's unit comes from the Tag catalogue and the capacity's from the
  // column name. Where they differ they are not compared — dividing kW by MW is
  // the factor-of-1000 error §4.1 exists to prevent.
  if (slot.unit !== "kW") {
    return (
      <SlotRailTile
        slot={slot}
        icon={icon}
        action={action}
        note={`reported in ${slot.unit ?? "no unit"}, and AC capacity is in kW — not compared`}
      />
    );
  }
  const fraction = (slot.value ?? 0) / acCapacityKw;
  // Outside 0..1 the arc stops at its end and the note says so; the figure is
  // never altered to fit the dial (Guardrail 33).
  const outside =
    fraction > 1
      ? "above the AC capacity recorded — check the nameplate or the meter"
      : fraction < 0
        ? "negative — the meter may be reading import (OPEN-15)"
        : undefined;
  return (
    <SlotRailTile
      slot={slot}
      icon={icon}
      action={action}
      figure={false}
      note={outside}
      visual={<PowerDial slot={slot} fraction={fraction} capacity={acCapacityKw} />}
    />
  );
}

function PowerDial({
  slot,
  fraction,
  capacity,
}: {
  slot: ResolvedSlot;
  fraction: number;
  capacity: number;
}): JSX.Element {
  const gradient = useSvgId();
  const { text, title } = slotHeadline(slot);
  const cx = 100;
  const cy = 94;
  const r = 74;
  const start = 150;
  const sweep = 240;
  const clamped = Math.min(1, Math.max(0, fraction));
  const end = start + sweep * clamped;
  const [tipX, tipY] = polar(cx, cy, r, end);
  return (
    <div className="mx-auto w-full max-w-[15rem]">
      <div className="relative" role="img" aria-label={`${title} of ${formatNumber(capacity, { digits: 0 })} kW AC capacity`}>
        <svg viewBox="0 0 200 150" className="block h-auto w-full" aria-hidden="true">
          <defs>
            <linearGradient id={gradient} x1="0" x2="1" y1="1" y2="0">
              <stop offset="0" style={{ stopColor: "rgb(var(--c-accent))", stopOpacity: 0.55 }} />
              <stop offset="1" style={{ stopColor: "rgb(var(--c-accent))" }} />
            </linearGradient>
          </defs>
          <path d={arcPath(cx, cy, r, start, start + sweep)} fill="none" strokeWidth={12} strokeLinecap="round" className="stroke-line" />
          {Array.from({ length: 9 }, (_, index) => {
            const angle = start + (sweep / 8) * index;
            const major = index % 4 === 0;
            const [x0, y0] = polar(cx, cy, major ? 86 : 88, angle);
            const [x1, y1] = polar(cx, cy, major ? 95 : 93, angle);
            return (
              <line key={index} x1={x0} y1={y0} x2={x1} y2={y1} strokeWidth={1.5} strokeLinecap="round" className="stroke-line-strong" />
            );
          })}
          {clamped > 0 ? (
            <>
              <path d={arcPath(cx, cy, r, start, Math.max(end, start + 0.5))} fill="none" strokeWidth={12} strokeLinecap="round" stroke={`url(#${gradient})`} />
              <circle cx={tipX} cy={tipY} r={11} className="fill-accent" opacity={0.2} />
              <circle cx={tipX} cy={tipY} r={4.5} className="fill-accent-strong" />
            </>
          ) : null}
        </svg>
        {/* The unit on its own line: beside the figure, inside the ring, it took
            the width the digits needed and shrank them on a narrow tile. */}
        <div className="absolute inset-x-[17%] top-[62%] flex -translate-y-1/2 flex-col items-center">
          <FittedFigure
            value={text}
            className="figure text-[1.9rem] font-semibold leading-none tracking-tight text-ink"
            title={title}
          />
          {slot.unit ? <span className="mt-1 text-xs text-ink-muted">{slot.unit}</span> : null}
          <span className="mt-0.5 text-xs font-semibold text-accent">
            {Math.round(fraction * 100)}% of AC
          </span>
        </div>
      </div>
      <div className="-mt-2 flex justify-between px-[7%] text-[10px] text-ink-faint">
        <span>0</span>
        <span>{formatNumber(capacity, { digits: 0 })} kW</span>
      </div>
    </div>
  );
}

// ── Today's Energy ────────────────────────────────────────────────────────────

function periodLabel(period: PeriodEnergy, timeZone: string | undefined, unit: string | null): string {
  const span = `${formatTime(period.start, timeZone).slice(0, 5)}–${formatTime(period.end, timeZone).slice(0, 5)}`;
  switch (period.state) {
    case "future":
      return `${span} · still to come`;
    case "gap":
      return `${span} · nothing that can be placed in this hour`;
    default: {
      const value = `${formatNumber(period.energy, { digits: 0 })} ${unit ?? ""}`.trim();
      const partial = period.state === "partial" ? ` · ${period.contributors} of ${period.expected} Devices` : "";
      const current = period.state === "current" ? " · so far" : "";
      return `${span} · ${value}${partial}${current}`;
    }
  }
}

function SunClockCard({ slot, icon, action, compact, plantId }: CardProps & { plantId: number }): JSX.Element {
  // "Today's energy" is a daily register by definition: its restart at midnight
  // is the day turning over, not an anomaly.
  const steps = useSlotSteps(plantId, slot.slot_code, "day", { resetsExpected: true });
  if (steps.unavailableReason) {
    return <SlotRailTile slot={slot} icon={icon} action={action} note={steps.unavailableReason} />;
  }
  return (
    <SlotRailTile
      slot={slot}
      icon={icon}
      action={action}
      figure={false}
      note={placementNote(slot, steps, "hour")}
      visual={<SunClock slot={slot} steps={steps} compact={compact} />}
    />
  );
}

function SunClock({
  slot,
  steps,
  compact = false,
}: {
  slot: ResolvedSlot;
  steps: ReturnType<typeof useSlotSteps>;
  compact?: boolean;
}): JSX.Element {
  const { text, title } = slotHeadline(slot);
  const c = 100;
  const inner = 50;
  const reach = 36;
  const frame = steps.frame;
  const peak = Math.max(0, ...steps.periods.map((period) => period.energy ?? 0));
  const angleOf = (period: PeriodEnergy): number =>
    frame ? (((period.start + period.end) / 2 - frame.start) / (frame.end - frame.start)) * 360 - 90 : 0;

  return (
    <div
      className={`relative mx-auto aspect-square w-full ${compact ? "max-w-[8.5rem]" : "max-w-[11rem]"}`}
      role="img"
      aria-label={`${title} today, by hour`}
    >
      <svg viewBox="0 0 200 200" className="block h-full w-full">
        {steps.periods.map((period) => {
          const angle = angleOf(period);
          const label = <title>{periodLabel(period, steps.timeZone, slot.unit)}</title>;
          if (period.energy === null) {
            const [x, y] = polar(c, c, inner + 4, angle);
            return period.state === "future" || period.state === "current" ? (
              <circle key={period.start} cx={x} cy={y} r={2.4} fill="none" strokeWidth={1.3} className="stroke-line-strong">
                {label}
              </circle>
            ) : (
              // Past, and nothing placed: a dashed stub, never a spoke of zero.
              <line
                key={period.start}
                x1={polar(c, c, inner, angle)[0]}
                y1={polar(c, c, inner, angle)[1]}
                x2={polar(c, c, inner + 9, angle)[0]}
                y2={polar(c, c, inner + 9, angle)[1]}
                strokeWidth={2}
                strokeDasharray="2 2.5"
                className="stroke-line-strong"
              >
                {label}
              </line>
            );
          }
          const length = Math.max(3, peak > 0 ? (reach * period.energy) / peak : 3);
          const [x0, y0] = polar(c, c, inner, angle);
          const [x1, y1] = polar(c, c, inner + length, angle);
          const tone =
            period.state === "current"
              ? "stroke-accent-strong"
              : period.state === "partial"
                ? "stroke-accent/45"
                : "stroke-accent";
          return (
            <line key={period.start} x1={x0} y1={y0} x2={x1} y2={y1} strokeWidth={7} strokeLinecap="round" className={tone}>
              {label}
            </line>
          );
        })}
      </svg>
      {(["00", "06", "12", "18"] as const).map((hour, index) => (
        <span
          key={hour}
          className={`pointer-events-none absolute text-[10px] leading-none text-ink-faint ${
            [
              "left-1/2 top-0 -translate-x-1/2",
              "right-0 top-1/2 -translate-y-1/2",
              "bottom-0 left-1/2 -translate-x-1/2",
              "left-0 top-1/2 -translate-y-1/2",
            ][index]
          }`}
        >
          {hour}
        </span>
      ))}
      <div className="pointer-events-none absolute inset-[29%] flex flex-col items-center justify-center">
        {/* One step smaller in a compact clock, so the figure stays inside the
            ring instead of reaching over the spokes it is the total of. */}
        <FittedFigure
          value={text}
          className={`figure ${compact ? "text-lg" : "text-2xl"} font-semibold leading-none tracking-tight text-ink`}
          title={title}
        />
        {slot.unit ? (
          <span className={`${compact ? "mt-0.5 text-[10px]" : "mt-1 text-xs"} text-ink-muted`}>{slot.unit}</span>
        ) : null}
      </div>
    </div>
  );
}

// ── Month Energy ──────────────────────────────────────────────────────────────

function DayColumnsCard({ slot, icon, action, plantId }: CardProps & { plantId: number }): JSX.Element {
  const steps = useSlotSteps(plantId, slot.slot_code, "month");
  if (steps.unavailableReason) {
    return <SlotRailTile slot={slot} icon={icon} action={action} note={steps.unavailableReason} />;
  }
  return (
    <SlotRailTile
      slot={slot}
      icon={icon}
      action={action}
      note={placementNote(slot, steps, "day")}
      visual={<DayColumns slot={slot} steps={steps} />}
    />
  );
}

function DayColumns({ slot, steps }: { slot: ResolvedSlot; steps: ReturnType<typeof useSlotSteps> }): JSX.Element {
  if (steps.isLoading && steps.periods.length === 0) {
    return <div className="h-24 animate-pulse rounded-control bg-line-soft/50" />;
  }
  const days = steps.periods;
  const peak = Math.max(0, ...days.map((day) => day.energy ?? 0));
  // Only whole days that every Device answered set the average: today is still
  // accruing, and a partial day is low for a reason that is not the weather.
  const whole = days.filter((day) => day.state === "complete" && day.energy !== null);
  const average =
    whole.length >= 2 ? whole.reduce((total, day) => total + (day.energy ?? 0), 0) / whole.length : null;
  const unit = slot.unit ?? "";
  const labelled = new Set([1, 8, 15, 22, days.length]);

  const describe = (day: PeriodEnergy): string => {
    const date = formatDate(day.start, steps.timeZone);
    switch (day.state) {
      case "future":
        return `${date} · still to come`;
      case "gap":
        return `${date} · nothing that can be placed on this day`;
      default:
        return `${date} · ${formatNumber(day.energy, { digits: 0 })} ${unit}${
          day.state === "partial" ? ` · ${day.contributors} of ${day.expected} Devices` : ""
        }${day.state === "current" ? " · so far" : ""}`;
    }
  };

  return (
    <div>
      <div className="mb-1 h-3.5 text-right text-[10px] leading-none text-ink-muted">
        {average !== null ? `avg ${formatCompact(average)} ${unit} / day` : null}
      </div>
      <div className="relative h-20" role="img" aria-label={`${slot.label}, one column per day`}>
        <div className="flex h-full items-end gap-[2px]">
          {days.map((day) => (
            <div key={day.start} className="flex h-full min-w-0 flex-1 flex-col justify-end" title={describe(day)}>
              {day.energy !== null ? (
                <div
                  className={`rounded-t-[3px] ${
                    day.state === "current"
                      ? "bg-accent-strong"
                      : day.state === "partial"
                        ? "bg-accent/45"
                        : "bg-accent"
                  }`}
                  style={{ height: `${Math.max(2, peak > 0 ? (day.energy / peak) * 100 : 2)}%` }}
                />
              ) : day.state === "future" ? (
                <div className="mx-auto h-1 w-1 rounded-full bg-line-strong" />
              ) : (
                // Past and nothing placed: an outline, never a short bar.
                <div className="h-2.5 rounded-[2px] border border-dashed border-line-strong" />
              )}
            </div>
          ))}
        </div>
        {average !== null && peak > 0 ? (
          <div
            className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-muted/50"
            style={{ bottom: `${(average / peak) * 100}%` }}
          />
        ) : null}
      </div>
      <div className="relative mt-1 h-3 text-[10px] leading-none text-ink-faint">
        {days.map((day, index) =>
          labelled.has(index + 1) ? (
            <span
              key={day.start}
              className="absolute -translate-x-1/2"
              style={{ left: `${((index + 0.5) / days.length) * 100}%` }}
            >
              {index + 1}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}

// ── Lifetime Energy ───────────────────────────────────────────────────────────

/** Past this many characters a drum is too narrow to read at a tile's width. */
const ODOMETER_MAX_CHARS = 13;

function OdometerCard({ slot, icon, action }: CardProps): JSX.Element {
  const value = slot.value ?? 0;
  const text = formatNumber(value, { digits: Math.abs(value) >= 10_000 ? 0 : 1 });
  if (value < 0 || text.length > ODOMETER_MAX_CHARS) return <SlotRailTile slot={slot} icon={icon} action={action} />;
  return <SlotRailTile slot={slot} icon={icon} action={action} figure={false} visual={<Odometer text={text} unit={slot.unit} />} />;
}

function Odometer({ text, unit }: { text: string; unit: string | null }): JSX.Element {
  const shade = useSvgId();
  const drumWidth = 22;
  const markWidth = 7;
  const gap = 2;
  const height = 36;
  const glyphs = [...text];
  const lastDigit = glyphs.reduce((found, glyph, index) => (/\d/.test(glyph) ? index : found), -1);
  let x = 0;
  const placed = glyphs.map((glyph, index) => {
    const isDigit = /\d/.test(glyph);
    const at = x;
    x += (isDigit ? drumWidth : markWidth) + gap;
    return { glyph, index, isDigit, at };
  });
  const width = x - gap;

  return (
    <div>
      <div className="rounded-control border border-line bg-surface-sunken p-2 shadow-[inset_0_2px_6px_rgb(0_0_0/0.25)]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mx-auto block h-auto w-full max-w-[15rem]"
          role="img"
          aria-label={`${text}${unit ? ` ${unit}` : ""}`}
        >
          <defs>
            {/* A drum is a cylinder: dark at the top and bottom edges, in either theme. */}
            <linearGradient id={shade} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#000" stopOpacity={0.45} />
              <stop offset="0.3" stopColor="#000" stopOpacity={0} />
              <stop offset="0.7" stopColor="#000" stopOpacity={0} />
              <stop offset="1" stopColor="#000" stopOpacity={0.45} />
            </linearGradient>
          </defs>
          {placed.map(({ glyph, index, isDigit, at }) =>
            isDigit ? (
              <g key={index}>
                <rect
                  x={at}
                  y={0}
                  width={drumWidth}
                  height={height}
                  rx={4}
                  className={index === lastDigit ? "fill-accent-soft" : "fill-surface-raised"}
                />
                <rect x={at} y={0} width={drumWidth} height={height} rx={4} fill={`url(#${shade})`} />
                <text
                  x={at + drumWidth / 2}
                  y={height / 2 + 7.5}
                  textAnchor="middle"
                  fontSize={21}
                  fontWeight={600}
                  className={index === lastDigit ? "fill-accent" : "fill-ink"}
                >
                  {glyph}
                </text>
              </g>
            ) : (
              <text key={index} x={at + markWidth / 2} y={height - 5} textAnchor="middle" fontSize={16} className="fill-ink-faint">
                {glyph}
              </text>
            ),
          )}
        </svg>
      </div>
      {unit ? <div className="mt-2 text-right text-xs font-medium text-ink-muted">{unit}</div> : null}
    </div>
  );
}
