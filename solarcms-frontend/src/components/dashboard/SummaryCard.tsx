/**
 * A compressed section that opens into its full detail.
 *
 * The dashboard holds six or seven of these in one row across the bottom. Each
 * carries the two or three figures somebody actually scans for, plus a count of
 * what is behind it; the rest is one click away in a drawer. That is the whole
 * trade the dashboard is making — a screen that shows *what is happening* at a
 * glance, and a path to *what exactly* that never costs the glance.
 *
 * ── The headline figures are the summary, and they have to be chosen ────────
 * A card that shows the first two rows of a list is not a summary, it is a
 * truncation, and a truncation invites the click every time. The caller passes
 * the figures deliberately; where a panel has a natural headline (Active Power
 * for the electrical boundary, open count for Alarms) that is what goes here.
 *
 * ── A card whose section cannot answer anything says so and does not open ───
 * A weather panel on a Plant with no weather station is a permanent row of
 * dashes, and permanent dashes teach operators to ignore dashes. Such a card
 * renders muted and non-interactive with the reason on it, rather than opening
 * a drawer to show nothing.
 */

import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@/components/icons";
import { IconChevronRight } from "@/components/icons";

export interface SummaryFigure {
  label: string;
  /** Pre-formatted. This component never formats a number or joins a unit. */
  value: string;
  unit?: string | null;
  tone?: "default" | "ok" | "warn" | "bad" | "muted";
  title?: string;
}

const TONES: Record<string, string> = {
  default: "text-ink",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
  muted: "text-ink-faint",
};

export function SummaryCard({
  icon: Icon,
  title,
  figures,
  count,
  onOpen,
  unavailable,
  accent,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  figures: SummaryFigure[];
  /** "6 slots", "23 Devices" — what opening it will show. */
  count?: ReactNode;
  onOpen?: () => void;
  /** Why this section cannot answer anything here. Renders it inert. */
  unavailable?: string | null;
  /** Draws attention without claiming a status — used for an open Alarm count. */
  accent?: "bad" | "warn" | null;
}): JSX.Element {
  const interactive = onOpen !== undefined && !unavailable;

  const frame =
    accent === "bad"
      ? "border-bad/40 bg-bad/[0.05]"
      : accent === "warn"
        ? "border-warn/40 bg-warn/[0.05]"
        : "surface-card border-line";

  const body = (
    <>
      <div className="flex items-center gap-2.5">
        {/*
          One hue for every chip — the brand accent — unless the caller has
          already made a judgement (open Alarms, Devices offline). A tint per
          card would sit beside the figures and be read as a verdict on them.
        */}
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-control ${
            accent === "bad"
              ? "bg-bad/15 text-bad"
              : accent === "warn"
                ? "bg-warn/15 text-warn"
                : "icon-well"
          }`}
        >
          <Icon size={17} />
        </span>
        {/* Wraps rather than truncates: six across, "PERFORMA…" names nothing. */}
        <span className="min-w-0 text-sm font-semibold leading-snug text-ink">
          {title}
        </span>
        {interactive ? (
          <IconChevronRight size={15} className="ml-auto shrink-0 text-ink-faint" />
        ) : null}
      </div>

      {unavailable ? (
        <p className="mt-4 text-xs leading-snug text-ink-faint">{unavailable}</p>
      ) : (
        <>
          <div className="mt-4 space-y-2.5 border-t border-line pt-3">
            {figures.map((figure) => (
              <div key={figure.label} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-sm leading-snug text-ink-muted" title={figure.label}>
                  {figure.label}
                </span>
                <span
                  className={`figure shrink-0 text-base font-semibold ${TONES[figure.tone ?? "default"]}`}
                  title={figure.title}
                >
                  {figure.value}
                  {figure.unit ? (
                    <span className="ml-1 text-xs font-normal text-ink-muted">{figure.unit}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {count ? (
            <div className="mt-auto pt-4 text-xs text-ink-faint">{count}</div>
          ) : null}
        </>
      )}
    </>
  );

  const className = `flex h-full min-w-0 flex-col rounded-card border p-4 text-left ${frame} ${
    interactive ? "surface-interactive cursor-pointer transition hover:border-accent/55" : ""
  } ${unavailable ? "opacity-60" : ""}`;

  if (!interactive) return <div className={className}>{body}</div>;
  return (
    <button type="button" onClick={onOpen} className={className}>
      {body}
    </button>
  );
}
