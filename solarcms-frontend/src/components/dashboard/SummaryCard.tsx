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
        : "surface-tile border-line";

  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
            accent === "bad"
              ? "bg-bad/12 text-bad"
              : accent === "warn"
                ? "bg-warn/12 text-warn"
                : "bg-accent/10 text-accent"
          }`}
        >
          <Icon size={12} />
        </span>
        <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
          {title}
        </span>
        {interactive ? (
          <IconChevronRight size={13} className="ml-auto shrink-0 text-ink-faint" />
        ) : null}
      </div>

      {unavailable ? (
        <p className="mt-2 text-[10px] leading-snug text-ink-faint">{unavailable}</p>
      ) : (
        <>
          <div className="mt-1.5 space-y-0.5">
            {figures.map((figure) => (
              <div key={figure.label} className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[10px] text-ink-faint">{figure.label}</span>
                <span
                  className={`shrink-0 font-mono text-[12px] tabular-nums ${TONES[figure.tone ?? "default"]}`}
                  title={figure.title}
                >
                  {figure.value}
                  {figure.unit ? (
                    <span className="ml-0.5 text-[9px] text-ink-muted">{figure.unit}</span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
          {count ? (
            <div className="mt-1.5 border-t border-line-soft pt-1 text-[9px] text-ink-faint">
              {count}
            </div>
          ) : null}
        </>
      )}
    </>
  );

  const className = `flex min-w-0 flex-col rounded-card border p-2.5 text-left ${frame} ${
    interactive ? "surface-interactive cursor-pointer hover:border-accent/55" : ""
  } ${unavailable ? "opacity-60" : ""}`;

  if (!interactive) return <div className={className}>{body}</div>;
  return (
    <button type="button" onClick={onOpen} className={className}>
      {body}
    </button>
  );
}
