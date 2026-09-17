/**
 * What still stands between a Plant and going live.
 *
 * Onboarding fails quietly rather than loudly, and that is the problem this
 * screen exists for. A Device registered without a topic never reports. A Device
 * with no bindings decodes nothing. An Inverter with no rated capacity has no
 * specific yield. Every one of those looks, on every other screen, exactly like
 * equipment that has not been switched on yet — so the Plant gets activated, the
 * gaps ship, and the numbers are quietly wrong for a month.
 *
 * Each check is therefore named, counted and attributed to a Device, and
 * activation is refused while any *blocking* one stands. Overriding is possible
 * — the operator may know something the checks do not — but never by accident.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePlantCommissioning } from "@/api/hooks";
import * as plantsApi from "@/api/endpoints/plants";
import { isApiError } from "@/api/problem";
import { Badge, Button, Panel } from "@/components/ui";
import { ErrorState, Skeleton } from "@/components/state";
import type { CommissioningIssue } from "@/api/schemas";

const SEVERITY_TONE = {
  blocking: "bad",
  warning: "warn",
  info: "neutral",
} as const;

const SEVERITY_LABEL = {
  blocking: "Blocks activation",
  warning: "Worth fixing",
  info: "For information",
} as const;

/** Plain-language guidance per check, so the fix is obvious from the screen. */
const REMEDY: Record<string, string> = {
  no_devices: "Add the Plant's equipment on the Devices step.",
  no_dc_capacity: "Set the Plant's DC capacity — Performance Ratio divides by it.",
  no_ac_capacity: "Set the Plant's AC capacity — CUF divides by it.",
  no_region: "Assign a Region so CO₂ uses the local grid factor.",
  no_kpi_panel: "Re-run the seed: every Plant gets a KPI panel Device.",
  device_without_topic:
    "Give the Device its MQTT topic. The topic is the only thing that says whose data a message is.",
  device_without_bindings:
    "Open Device Bindings and map its payload keys to Tags, or re-seed them from its Model.",
  device_partially_bound:
    "Some of the Model's signals are unbound — check the string count and re-seed from the Model.",
  device_never_heard:
    "Nothing has arrived from this Device yet. Check the publisher's credentials and topic.",
  inverter_without_capacity:
    "Set the Inverter's rated capacity — specific yield is energy ÷ capacity.",
  device_unmapped_keys:
    "The Device is publishing signals nothing is mapped to. Bind them, or they are discarded.",
  device_without_parent:
    "Set what this Device feeds into, unless it is the point where the Plant meets the grid.",
  multiple_sld_roots:
    "More than one Device feeds into nothing, so the diagram will render as separate trees.",
};

export function CommissioningPanel({
  plantId,
  onStatusChanged,
}: {
  plantId: number | null;
  onStatusChanged?: (status: string) => void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const report = usePlantCommissioning(plantId);

  const activate = useMutation({
    mutationFn: (force: boolean) =>
      plantsApi.changePlantStatus(plantId as number, "active", { force }),
    onSuccess: () => {
      setError(null);
      onStatusChanged?.("active");
      void queryClient.invalidateQueries({ queryKey: ["plants"] });
    },
    onError: (err) =>
      setError(
        isApiError(err) ? err.displayMessage : "Could not activate the Plant.",
      ),
  });

  if (plantId === null) return null;

  if (report.isLoading) {
    return (
      <Panel title="Readiness" subtitle="Checking what is left to do…">
        <div className="space-y-2">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </Panel>
    );
  }
  if (report.isError) {
    return <ErrorState error={report.error} retry={() => void report.refetch()} />;
  }

  const data = report.data;
  if (!data) return null;

  const grouped = (["blocking", "warning", "info"] as const)
    .map((severity) => ({
      severity,
      issues: data.issues.filter((issue) => issue.severity === severity),
    }))
    .filter((group) => group.issues.length > 0);

  return (
    <Panel
      title="Readiness"
      subtitle={
        data.ready
          ? "Every blocking check passes. This Plant can go active."
          : `${data.blocking_count} blocking issue(s) to resolve before activation.`
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={data.ready ? "ok" : "bad"}>
          {data.ready ? "Ready" : "Not ready"}
        </Badge>
        <Badge tone="neutral">{data.status}</Badge>
        <span className="text-ink-muted">
          {data.device_count} Device(s)
          {data.unmapped_key_count > 0
            ? ` · ${data.unmapped_key_count} unmapped signal(s)`
            : ""}
        </span>
        <button
          type="button"
          onClick={() => void report.refetch()}
          className="ml-auto text-[11px] text-ink-muted hover:text-ink hover:underline"
        >
          Re-check
        </button>
      </div>

      {grouped.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Nothing outstanding. Every Device has a topic, bindings, and has been
          heard from.
        </p>
      ) : (
        <div className="space-y-3">
          {grouped.map((group) => (
            <div key={group.severity}>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                {SEVERITY_LABEL[group.severity]} ({group.issues.length})
              </p>
              <ul className="space-y-1">
                {group.issues.map((issue, index) => (
                  <IssueRow key={`${issue.code}-${index}`} issue={issue} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {error ? (
        <p className="mt-3 rounded border border-bad/30 bg-bad/10 px-2 py-1 text-xs text-bad">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={!data.ready || activate.isPending}
          onClick={() => activate.mutate(false)}
        >
          {activate.isPending ? "Activating…" : "Activate"}
        </Button>
        {!data.ready ? (
          <Button
            disabled={activate.isPending}
            onClick={() => activate.mutate(true)}
            title="Records who overrode the checks, and that they were overridden."
          >
            Activate anyway
          </Button>
        ) : null}
        <span className="text-[11px] text-ink-faint">
          Only an active Plant counts toward Portfolio totals.
        </span>
      </div>
    </Panel>
  );
}

function IssueRow({ issue }: { issue: CommissioningIssue }): JSX.Element {
  const remedy = REMEDY[issue.code];
  return (
    <li className="rounded border border-line bg-surface-raised/40 px-2 py-1.5">
      <div className="flex items-start gap-2">
        <Badge tone={SEVERITY_TONE[issue.severity]}>
          {issue.device_code ?? issue.code.replace(/_/g, " ")}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-xs text-ink">{issue.detail}</p>
          {remedy ? (
            <p className="mt-0.5 text-[11px] text-ink-muted">{remedy}</p>
          ) : null}
          {issue.keys && issue.keys.length > 0 ? (
            <p className="mt-1 break-words font-mono text-[11px] text-ink-faint">
              {issue.keys.join("  ·  ")}
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}
