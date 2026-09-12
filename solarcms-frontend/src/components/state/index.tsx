/**
 * Loading, empty and error states.
 *
 * `EmptyState` carries more weight here than usual. The client's broker
 * currently publishes Plant-level totals only — there are no Inverters and no
 * equipment hierarchy yet (§0.4). Those screens are contracted and built, so
 * their empty state must read as *"per-Device data has not started arriving"*
 * rather than as a bug or a blank panel.
 */

import type { ReactNode } from "react";
import { isApiError } from "@/api/problem";

export function LoadingState({ label = "Loading" }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3 p-6 text-sm text-ink-muted">
      <span className="h-3 w-3 animate-pulse rounded-full bg-accent" />
      {label}…
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }): JSX.Element {
  return <div className={`animate-pulse rounded bg-line/60 ${className}`} />;
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
