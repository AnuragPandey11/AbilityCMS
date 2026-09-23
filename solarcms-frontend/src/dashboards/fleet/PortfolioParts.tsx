/**
 * The Portfolio's presentational pieces — headline tiles, title-band cells,
 * the generation bars, the status ring and the summary list.
 *
 * No data access and no arithmetic: every value arrives from the Portfolio,
 * which computes it from what each Plant reported. The rules the pieces keep
 * are the ones every figure on the platform keeps — `null` is "—", never 0; a
 * compacted number keeps its exact digits on the tooltip; a unit is shown
 * beside its figure and never converted.
 */

import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@/components/icons";
import { InfoHint } from "@/components/ui";
import { FittedFigure } from "@/components/charts/FittedFigure";
import { UNDEFINED_DISPLAY, formatHeadline } from "@/format/value";
import {
  CONDITIONS,
  CONDITION_DETAIL,
  CONDITION_LABEL,
  type PlantCondition,
} from "./condition";

// ── Headline tile ───────────────────────────────────────────────────────────

export type TileTone = "accent" | "info" | "ok" | "warn" | "bad" | "violet" | "neutral";

/**
 * The icon well. `accent` is a tile's identity — what it measures — and is the
 * brand hue for every tile alike; the icon, not a colour, says which tile it
 * is. `ok`/`warn`/`bad` are verdicts, for a tile whose caller has made one
 * (an Alarm count). `info` and `violet` were per-tile identity hues and now
 * render as the accent: a row of nine tiles in six colours read as nine
 * unrelated products.
 */
const ICON_WELL: Record<TileTone, string> = {
  accent: "icon-well",
  info: "icon-well",
  violet: "icon-well",
  ok: "bg-ok/10 text-ok ring-1 ring-inset ring-ok/20",
  warn: "bg-warn/10 text-warn ring-1 ring-inset ring-warn/25",
  bad: "bg-bad/10 text-bad ring-1 ring-inset ring-bad/25",
  neutral: "bg-surface-sunken text-ink-muted",
};

/**
 * The frame carries a judgement only where the caller has made one — an
 * implausible ratio, an Alarm count — and only when it is bad news. `ok` is
 * the plain card: a green outline around "nothing is wrong" was the loudest
 * line on the screen, and a dashboard that shouts when all is well has
 * nothing left to shout with when it is not.
 */
const FRAME_TONE: Record<TileTone, string> = {
  accent: "border-line",
  info: "border-line",
  ok: "border-line",
  warn: "border-warn/60",
  bad: "border-bad/60",
  violet: "border-line",
  neutral: "border-line",
};

const FIGURE_TONE = {
  ink: "text-ink",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  faint: "text-ink-faint",
} as const;

export type FigureTone = keyof typeof FIGURE_TONE;

export function FleetTile({
  icon: Icon,
  iconTone,
  frame = "neutral",
  label,
  hint,
  showHint = false,
  footer,
  footerTone = "faint",
  className = "",
  children,
}: {
  icon: ComponentType<IconProps>;
  iconTone: TileTone;
  frame?: TileTone;
  label: ReactNode;
  hint?: string;
  /**
   * Draw the ⓘ beside the label. Off by default — the hint is still the
   * tile's tooltip — because at six across the icon is what forces a
   * two-word label onto two lines.
   */
  showHint?: boolean;
  footer?: ReactNode;
  footerTone?: "faint" | "warn";
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={`surface-card flex min-w-0 flex-col rounded-card border p-4 ${FRAME_TONE[frame]} ${className}`}
      title={showHint ? undefined : hint}
    >
      {/* Wraps rather than truncates: "FLEET PERF…" identifies nothing. */}
      {/*
        Two lines tall whatever the label, so a row whose one label wraps
        ("Fleet performance ratio") still has every figure on one baseline.
      */}
      <div className="tile-label flex min-h-[2.25rem] items-center gap-2">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${ICON_WELL[iconTone]}`}
        >
          <Icon size={16} />
        </span>
        <span className="min-w-0">{label}</span>
        {hint && showHint ? <InfoHint text={hint} /> : null}
      </div>
      <div className="mt-2">{children}</div>
      {footer ? (
        <div
          className={`mt-auto truncate pt-2 text-xs leading-snug ${
            footerTone === "warn" ? "text-warn" : "text-ink-faint"
          }`}
          title={typeof footer === "string" ? footer : undefined}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A figure in a tile: compacted above the headline threshold, exact on the
 * tooltip, unit beside it, a dash for undefined. A string is shown as given —
 * for a percentage, which carries its own sign.
 */
export function TileFigure({
  value,
  unit,
  loading,
  tone = "ink",
  title,
  digits,
}: {
  value: number | string | null | undefined;
  unit?: string | null;
  loading?: boolean;
  tone?: FigureTone;
  title?: string;
  /** Pass `0` for a tally — there is no such thing as 0.4 of an Alarm. */
  digits?: number;
}): JSX.Element {
  const figureClass = "figure text-[1.9rem] font-semibold leading-none tracking-tight";
  const unitClass = "ml-1.5 text-sm font-medium text-ink-muted";
  if (loading) {
    return <FittedFigure value="…" className={`${figureClass} text-ink-faint`} unitClassName={unitClass} />;
  }
  if (typeof value === "string") {
    return (
      <FittedFigure
        value={value}
        unit={unit}
        className={`${figureClass} ${FIGURE_TONE[tone]}`}
        unitClassName={unitClass}
        title={title}
      />
    );
  }
  const headline = formatHeadline(value, { digits });
  const isUndefined = headline.text === UNDEFINED_DISPLAY;
  return (
    <FittedFigure
      value={headline.text}
      unit={isUndefined ? null : unit}
      className={`${figureClass} ${isUndefined ? "text-ink-faint" : FIGURE_TONE[tone]}`}
      unitClassName={unitClass}
      title={
        title ?? (headline.compacted ? `${headline.exact}${unit ? ` ${unit}` : ""}` : undefined)
      }
    />
  );
}

// ── Title band ──────────────────────────────────────────────────────────────

export function HeaderCell({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="surface-tile flex min-w-[8.5rem] flex-col justify-center rounded-card border border-line px-4 py-2"
      title={title}
    >
      <span className="tile-label">
        {label}
      </span>
      <span className="figure mt-1 text-lg font-bold leading-none">{children}</span>
    </div>
  );
}

const STATUS_TEXT = { ok: "text-ok", warn: "text-warn", bad: "text-bad", neutral: "text-ink-faint" };
const STATUS_DOT = { ok: "bg-ok lamp-ok", warn: "bg-warn lamp-warn", bad: "bg-bad lamp-bad", neutral: "bg-ink-faint" };

export function StatusWord({
  word,
  tone,
}: {
  word: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}): JSX.Element {
  return (
    <span className={`flex items-center gap-2 font-sans tracking-wide ${STATUS_TEXT[tone]}`}>
      <span className={`h-2 w-2 rounded-full ${STATUS_DOT[tone]}`} />
      {word}
    </span>
  );
}

// ── Generation by Plant ─────────────────────────────────────────────────────

export interface GenerationRow {
  key: number;
  label: string;
  /** null draws no bar and a dash — never a zero-length bar. */
  value: number | null;
  /** The ceiling the bar is drawn against; null means the fleet's largest. */
  max: number | null;
  /** Provenance, or why there is no figure. */
  hint: string;
}

/**
 * One bar per Plant on a track to its own ceiling, so a bar that is short
 * because the Plant is small and one that is short because it is producing
 * little read differently. HTML rather than a chart library: it is a table
 * with a shape, and the value is what the reader came for.
 *
 * The bar is the brand accent, not `ok`: it is the same colour at 4% of
 * capacity as at 90%, so it asserts nothing about health, and green would say
 * "healthy" about every Plant on the list. How a Plant is doing is the Plant
 * Status panel's job.
 */
export function GenerationBars({
  rows,
  onSelect,
}: {
  rows: GenerationRow[];
  onSelect: (plantId: number) => void;
}): JSX.Element {
  const largest = Math.max(0, ...rows.map((row) => row.value ?? 0));
  return (
    <ul className="space-y-3">
      {rows.map((row) => {
        const ceiling = row.max && row.max > 0 ? row.max : largest;
        // The bar is clamped to its track; the figure beside it never is.
        const share =
          row.value === null || ceiling <= 0 ? 0 : Math.min(1, Math.max(0, row.value / ceiling));
        const text = row.value === null ? UNDEFINED_DISPLAY : formatHeadline(row.value).text;
        const inside = share >= 0.3;
        return (
          <li key={row.key}>
            <button
              type="button"
              onClick={() => onSelect(row.key)}
              title={row.hint}
              className="grid w-full grid-cols-[minmax(6rem,10rem)_1fr] items-center gap-4 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <span className="truncate text-sm font-medium text-ink">{row.label}</span>
              <span className="relative flex h-8 items-center overflow-hidden rounded-lg bg-surface-sunken">
                {share > 0 ? (
                  <span
                    className="flex h-full items-center justify-end rounded-lg bg-accent px-2.5"
                    style={{ width: `max(${share * 100}%, 1.75rem)` }}
                  >
                    {inside ? (
                      <span className="figure text-xs font-semibold text-on-accent">{text}</span>
                    ) : null}
                  </span>
                ) : null}
                {!inside ? (
                  <span
                    className={`figure px-2.5 text-xs font-semibold ${
                      row.value === null ? "text-ink-faint" : "text-ink"
                    }`}
                  >
                    {text}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ── Plant Status ────────────────────────────────────────────────────────────

const CONDITION_STROKE: Record<PlantCondition, string> = {
  online: "stroke-ok",
  warning: "stroke-warn",
  fault: "stroke-bad",
  offline: "stroke-ink-faint",
  unmonitored: "stroke-line-strong",
};
const CONDITION_SWATCH: Record<PlantCondition, string> = {
  online: "bg-ok",
  warning: "bg-warn",
  fault: "bg-bad",
  offline: "bg-ink-faint",
  unmonitored: "bg-line-strong",
};

/**
 * Plants by condition, as a ring. Part-to-whole with at most five segments,
 * each a status colour, so the donut is legitimate here where it would not be
 * for a comparison. Identity is never colour alone: every segment is named in
 * the legend beside its count.
 */
export function PlantStatusRing({
  counts,
  total,
}: {
  counts: Record<PlantCondition, number>;
  total: number;
}): JSX.Element {
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  const present = CONDITIONS.filter((condition) => counts[condition] > 0);
  let offset = 0;
  return (
    <div className="flex items-center gap-6">
      <div className="relative h-[140px] w-[140px] shrink-0">
        <svg viewBox="0 0 140 140" className="h-full w-full -rotate-90">
          <circle cx="70" cy="70" r={radius} fill="none" strokeWidth="16" className="stroke-surface-sunken" />
          {present.map((condition) => {
            const length = total > 0 ? (counts[condition] / total) * circumference : 0;
            const dash = (
              <circle
                key={condition}
                cx="70"
                cy="70"
                r={radius}
                fill="none"
                strokeWidth="16"
                className={CONDITION_STROKE[condition]}
                strokeDasharray={`${length} ${circumference - length}`}
                strokeDashoffset={-offset}
              >
                <title>{`${CONDITION_LABEL[condition]}: ${counts[condition]}`}</title>
              </circle>
            );
            offset += length;
            return dash;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="figure text-3xl font-semibold leading-none text-ink">{total}</span>
          <span className="mt-1 text-xs font-medium text-ink-muted">
            Plants
          </span>
        </div>
      </div>
      <ul className="min-w-0 space-y-4">
        {present.map((condition) => (
          <li key={condition} title={CONDITION_DETAIL[condition]}>
            <div className="flex items-center gap-2 text-sm text-ink">
              <span className={`h-3 w-3 rounded-sm ${CONDITION_SWATCH[condition]}`} />
              {CONDITION_LABEL[condition]}
            </div>
            <div className="mt-1 flex items-baseline gap-3 font-mono">
              <span className="text-xl font-semibold text-ink">{counts[condition]}</span>
              <span className="text-sm text-ink-muted">
                {total > 0 ? `${((counts[condition] / total) * 100).toFixed(1)}%` : UNDEFINED_DISPLAY}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────────────────

/**
 * A panel whose title sits in the body rather than above a rule — the
 * Portfolio's three summary cards read as objects, not as framed sections.
 */
export function FleetCard({
  title,
  subtitle,
  className = "",
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className={`surface-card flex min-w-0 flex-col rounded-card border border-line p-5 ${className}`}>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm leading-snug text-ink-muted">{subtitle}</p> : null}
      <div className="mt-5 min-h-0 flex-1">{children}</div>
    </section>
  );
}

// ── Fleet Summary ───────────────────────────────────────────────────────────

export function SummaryRow({
  label,
  value,
  tone = "ink",
  hint,
}: {
  label: string;
  value: string;
  tone?: FigureTone;
  hint?: string;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-3" title={hint}>
      <span className="text-sm text-ink-muted">{label}</span>
      <span className={`figure text-sm font-semibold ${FIGURE_TONE[tone]}`}>{value}</span>
    </div>
  );
}
