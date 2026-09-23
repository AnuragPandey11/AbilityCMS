/**
 * Move a Plant along `draft → commissioning → active` from wherever it is seen.
 *
 * The transition existed in the API from the start but had no control outside
 * the onboarding wizard, which meant a Plant that finished commissioning a week
 * later could only be activated by walking back through a wizard built for
 * creating one. Status is a fact about a live Plant, so it is edited where the
 * Plant is looked at.
 *
 * Activation is gated on the readiness checks, and the panel that lists them
 * opens beside the control — refusing without saying why is what makes an
 * operator force every transition out of habit.
 *
 * ⚠ The panel drops down over the page rather than opening in place. The
 * control sits in the sticky application header, and an in-place panel there
 * grew the header itself: a readiness list taller than the viewport, pinned to
 * the top, whose bottom — the Activate button — could never be scrolled to.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as plantsApi from "@/api/endpoints/plants";
import { isApiError } from "@/api/problem";
import { usePlantCommissioning } from "@/api/hooks";
import { usePermission } from "@/auth/usePermission";
import { Button } from "@/components/ui";
import { PlantStatusPill } from "@/components/domain";
import { CommissioningPanel } from "@/admin/CommissioningPanel";

/** The readiness panel's width where there is room, and its distance from the viewport's edge. */
const PANEL_WIDTH = 672;
const GUTTER = 16;

const NEXT: Record<string, { status: string; label: string } | undefined> = {
  draft: { status: "commissioning", label: "Start commissioning" },
  commissioning: { status: "active", label: "Activate" },
};

/** What each status means for the numbers, in one line. */
const MEANING: Record<string, string> = {
  draft: "Not yet collecting. Excluded from every Portfolio total.",
  commissioning:
    "Data is flowing and being validated. Still excluded from Portfolio totals, so a half-mapped Plant cannot drag fleet PR down.",
  active: "Live, and counted in every Portfolio total.",
  suspended: "Retained but not counted.",
  decommissioned: "Retired. History is kept; nothing new is expected.",
};

export function PlantStatusControl({
  plantId,
  status,
}: {
  plantId: number;
  status: string;
}): JSX.Element {
  const canManage = usePermission("plant.manage");
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; width: number; maxHeight: number } | null>(
    null,
  );

  // The panel hangs from the control but is clamped to the viewport: from a
  // control halfway across a narrow header, a panel anchored at its left edge
  // runs off the right of the screen. Measured before paint, so it never
  // renders once in the wrong place.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = (): void => {
      const anchor = root.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - GUTTER * 2);
      const left = Math.min(Math.max(anchor.left, GUTTER), window.innerWidth - width - GUTTER);
      setPlace({
        left: left - anchor.left,
        width,
        maxHeight: Math.max(240, window.innerHeight - anchor.bottom - GUTTER * 1.5),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open]);

  // A dropdown that only its own button can close is a trap. Escape and a
  // press anywhere outside both dismiss it.
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Only fetched once the operator opens the control: a readiness sweep walks
  // every Device of the Plant, and running it on every dashboard load would be
  // a cost paid by everyone for a control few people use.
  const report = usePlantCommissioning(plantId, open);

  const change = useMutation({
    mutationFn: ({ next, force }: { next: string; force?: boolean }) =>
      plantsApi.changePlantStatus(plantId, next, { force }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["plants"] });
    },
    onError: (err) =>
      setError(
        isApiError(err)
          ? err.displayMessage
          : "Could not change the Plant's status.",
      ),
  });

  const next = NEXT[status];
  const ready = report.data?.ready ?? false;
  const blocking = report.data?.blocking_count ?? 0;

  if (!canManage) {
    return <PlantStatusPill status={status} title={MEANING[status]} />;
  }

  return (
    <div ref={root} className="relative inline-flex shrink-0">
      <div className="flex items-center gap-2">
        <PlantStatusPill status={status} title={MEANING[status]} />
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          aria-expanded={open}
          className="surface-tile whitespace-nowrap rounded-control border border-line px-2.5 py-1 text-xs text-ink-muted transition hover:border-line-strong hover:text-ink"
        >
          {open ? "Hide readiness" : "Change status"}
        </button>
      </div>

      {open && place ? (
        <div
          className="surface-card absolute top-full z-30 mt-2 space-y-2 overflow-y-auto rounded-card border border-line p-3"
          style={place}
        >
          <p className="text-[11px] text-ink-muted">{MEANING[status]}</p>
          <CommissioningPanel plantId={plantId} />

          <div className="flex flex-wrap items-center gap-2">
            {next ? (
              <Button
                variant="primary"
                disabled={change.isPending}
                onClick={() => change.mutate({ next: next.status })}
              >
                {change.isPending ? "Working…" : next.label}
              </Button>
            ) : null}
            {next?.status === "active" && !ready && report.isSuccess ? (
              <Button
                disabled={change.isPending}
                onClick={() =>
                  change.mutate({ next: "active", force: true })
                }
                title="Recorded in the audit log as an override, with the issue count at the time."
              >
                Activate anyway ({blocking})
              </Button>
            ) : null}
            {status === "active" ? (
              <Button
                disabled={change.isPending}
                onClick={() => change.mutate({ next: "commissioning" })}
                title="Takes the Plant back out of Portfolio totals while something is investigated."
              >
                Back to commissioning
              </Button>
            ) : null}
          </div>

          {error ? (
            <p className="rounded border border-bad/30 bg-bad/10 px-2 py-1 text-xs text-bad">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
