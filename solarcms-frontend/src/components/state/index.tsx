/**
 * Loading, empty and error states.
 *
 * `EmptyState` carries more weight here than usual. The client's broker
 * currently publishes Plant-level totals only — there are no Inverters and no
 * equipment hierarchy yet (§0.4). Those screens are contracted and built, so
 * their empty state must read as *"per-Device data has not started arriving"*
 * rather than as a bug or a blank panel.
 */

import type { CSSProperties, ReactNode } from "react";
import { isApiError } from "@/api/problem";

export function LoadingState({ label = "Loading" }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 p-6 text-sm text-ink-muted">
      <span className="h-3 w-3 animate-pulse rounded-full bg-accent" />
      {label}…
    </div>
  );
}

export function Skeleton({
  className = "",
  style,
}: {
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div className={`animate-pulse rounded bg-line/60 ${className}`} style={style} />
  );
}

/**
 * Skeletons shaped like the thing that is coming.
 *
 * A centred "Loading…" moves every tile on the page the moment data lands, and
 * on a monitoring wall that reflow reads as the screen having gone wrong. These
 * occupy the final layout, so arriving data fills boxes that are already there.
 *
 * They are deliberately *shapes*, never placeholder numbers. A skeleton showing
 * "0 kW" or a dash is indistinguishable, for the second before it resolves, from
 * a Plant that has genuinely stopped generating — and that is the one reading an
 * operator must never get wrong.
 */
export function SkeletonKpiRow({ tiles = 6 }: { tiles?: number }): JSX.Element {
  return (
    <div
      className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
      aria-hidden="true"
    >
      {Array.from({ length: tiles }, (_, index) => (
        <div
          key={index}
          className="rounded-lg border border-line bg-surface-raised p-3"
        >
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="mt-2.5 h-6 w-24" />
          <Skeleton className="mt-2 h-2 w-16" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({
  rows = 6,
  columns = 5,
}: {
  rows?: number;
  columns?: number;
}): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-line" aria-hidden="true">
      <div className="flex gap-4 border-b border-line bg-surface-sunken px-3 py-2">
        {Array.from({ length: columns }, (_, index) => (
          <Skeleton key={index} className="h-2.5 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-4 border-b border-line/50 px-3 py-2.5">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-3 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonChart({ height = 220 }: { height?: number }): JSX.Element {
  return (
    <div
      className="rounded-lg border border-line bg-surface-raised p-3"
      aria-hidden="true"
    >
      <Skeleton className="h-2.5 w-28" />
      <div
        className="mt-3 flex items-end gap-1.5"
        style={{ height: `${height}px` }}
      >
        {Array.from({ length: 24 }, (_, index) => (
          <Skeleton
            key={index}
            className="flex-1"
            // A daylight curve rather than a flat bar chart: the shape a
            // generation chart is about to take.
            style={{
              height: `${20 + Math.sin((index / 23) * Math.PI) * 70}%`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function SkeletonPanel({
  lines = 3,
  title = true,
}: {
  lines?: number;
  title?: boolean;
}): JSX.Element {
  return (
    <div
      className="rounded-lg border border-line bg-surface-raised p-4"
      aria-hidden="true"
    >
      {title ? <Skeleton className="h-3 w-32" /> : null}
      <div className="mt-3 space-y-2">
        {Array.from({ length: lines }, (_, index) => (
          <Skeleton
            key={index}
            className={`h-3 ${index % 3 === 0 ? "w-full" : index % 3 === 1 ? "w-4/5" : "w-2/3"}`}
          />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  /** Say *why* it is empty. A blank panel is indistinguishable from a fault. */
  detail: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface-raised/40 p-8 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <div className="mx-auto mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
        {detail}
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * The empty state for a screen that is waiting on per-Device publishing (F-18).
 * Written once so every such screen says the same true thing.
 */
export function AwaitingDeviceDataState({
  screen,
  detail,
}: {
  screen: string;
  detail?: string;
}): JSX.Element {
  return (
    <EmptyState
      title={`No per-Device data for ${screen} yet`}
      detail={
        <>
          <p>
            {detail ??
              "The broker currently publishes Plant-level totals only — one meter and one weather station per Plant."}{" "}
            This screen is built and will populate as soon as per-Device publishing
            begins; nothing here is broken.
          </p>
          <p className="mt-2 text-xs text-ink-faint">
            To exercise it now, run <code className="font-mono">tools/simulate.py</code>,
            which publishes per-Device on the canonical topics.
          </p>
        </>
      }
    />
  );
}

export function ErrorState({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}): JSX.Element {
  // `displayMessage` is what makes a 500's opaque detail stay opaque and a 404
  // stay ambiguous about whether the thing exists (§8, Guardrail 7).
  const message = isApiError(error)
    ? error.displayMessage
    : error instanceof Error
      ? error.message
      : "Something went wrong.";
  const status = isApiError(error) ? error.status : null;

  return (
    <div className="rounded-lg border border-bad/30 bg-bad/10 p-6">
      <p className="text-sm font-medium text-bad">
        {status ? `Error ${status}` : "Error"}
      </p>
      <p className="mt-1 text-sm text-ink-muted">{message}</p>
      {retry ? (
        <button
          type="button"
          onClick={retry}
          className="mt-3 rounded border border-line px-3 py-1 text-xs text-ink hover:bg-surface-raised"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * A 403 rendered as its own thing. Reaching one means a control rendered that
 * should not have — worth looking different from a server fault (§8).
 */
export function ForbiddenState({ detail }: { detail: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-warn/30 bg-warn/10 p-6">
      <p className="text-sm font-medium text-warn">Not permitted</p>
      <p className="mt-1 text-sm text-ink-muted">{detail}</p>
    </div>
  );
}
