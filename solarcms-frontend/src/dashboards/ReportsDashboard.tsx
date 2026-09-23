/**
 * `reports` (§6.7).
 *
 * List definitions, request a run, poll it, download.
 *
 * Two failures are rendered specifically rather than as generic errors:
 *
 * - **409 on a Financial Report**: no ABT Meter is registered. I-11 forbids
 *   computing one from an MFM — the ABT Meter is the sealed settlement
 *   instrument. Saying "report failed" invites someone to retry forever.
 * - **`artifact_urls.pdf_unavailable`**: the run succeeded and the XLSX is
 *   there; PDF rendering is not installed. Offer the XLSX.
 *
 * `artifact_urls` carries **signed, expiring** URLs. They are used directly,
 * never re-signed and never cached past their expiry.
 */

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useReportDefinitions, useReportRun } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as clientsApi from "@/api/endpoints/clients";
import * as reportsApi from "@/api/endpoints/reports";
import { artifactHref } from "@/api/client";
import { isApiError } from "@/api/problem";
import { Button, Field, Panel, Badge, inputClass } from "@/components/ui";
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { formatDateTime, toDateInput } from "@/format/datetime";
import { formatNumber } from "@/format/value";
import { usePermission } from "@/auth/usePermission";
import { useAuth } from "@/auth/AuthProvider";

export function ReportsDashboard(): JSX.Element {
  const canGenerate = usePermission("report.generate");
  const definitionsQuery = useReportDefinitions(canGenerate);
  const { me } = useAuth();
  // A Super Admin belongs to no Client, and every Report run is filed under one.
  const needsClient = me?.platform_admin === true && me.client_id === null;
  const clientsQuery = useQuery({
    queryKey: qk.clients(),
    queryFn: clientsApi.listClients,
    enabled: needsClient,
    retry: false,
  });
  const [clientId, setClientId] = useState<number | null>(null);

  const monthAgo = new Date(Date.now() - 30 * 86400_000);
  const [definitionId, setDefinitionId] = useState<number | null>(null);
  const [periodStart, setPeriodStart] = useState(toDateInput(monthAgo));
  const [periodEnd, setPeriodEnd] = useState(toDateInput(new Date()));
  const [runId, setRunId] = useState<number | null>(null);
  const [abtRefusal, setAbtRefusal] = useState<string | null>(null);
  const [genericError, setGenericError] = useState<string | null>(null);

  const runQuery = useReportRun(runId);

  const requestRun = useMutation({
    mutationFn: () =>
      reportsApi.requestRun(
        definitionId as number,
        new Date(`${periodStart}T00:00:00`).toISOString(),
        new Date(`${periodEnd}T23:59:59`).toISOString(),
        needsClient ? clientId : null,
      ),
    onMutate: () => {
      setAbtRefusal(null);
      setGenericError(null);
    },
    onSuccess: (result) => setRunId(result.run_id),
    onError: (error) => {
      if (isApiError(error) && error.isConflict) {
        // The 409 that means "no ABT Meter". Rendered as the rule it is.
        setAbtRefusal(error.problem.detail);
        return;
      }
      setGenericError(
        isApiError(error) ? error.displayMessage : "Could not request the Report.",
      );
    },
  });

  if (!canGenerate) {
    return (
      <ForbiddenState detail="Running Reports requires the report.generate permission." />
    );
  }
  if (definitionsQuery.isLoading) return <LoadingState label="Loading definitions" />;
  if (definitionsQuery.isError) {
    return (
      <ErrorState
        error={definitionsQuery.error}
        retry={() => void definitionsQuery.refetch()}
      />
    );
  }

  const definitions = definitionsQuery.data ?? [];
  const selected = definitions.find((definition) => definition.id === definitionId);
  const run = runQuery.data;
  const artifacts = run ? reportsApi.splitArtifacts(run) : { links: [], notes: [] };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="page-title">Reports</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Reports are rendered asynchronously by the scheduler and read from aggregate
          tiers, never from raw Readings.
        </p>
      </div>

      {definitions.length === 0 ? (
        <EmptyState
          title="No Report definitions"
          detail="No platform or Client Report definitions are available to this account."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
          <Panel title="Request a Report">
            <div className="space-y-3">
              {needsClient ? (
                <Field label="Client" required>
                  <select
                    value={clientId ?? ""}
                    onChange={(event) =>
                      setClientId(event.target.value ? Number(event.target.value) : null)
                    }
                    className={inputClass}
                    disabled={clientsQuery.isLoading}
                  >
                    <option value="">
                      {clientsQuery.isLoading ? "Loading…" : "Choose…"}
                    </option>
                    {(clientsQuery.data ?? []).map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}

              <Field label="Definition" required>
                <select
                  value={definitionId ?? ""}
                  onChange={(event) =>
                    setDefinitionId(event.target.value ? Number(event.target.value) : null)
                  }
                  className={inputClass}
                >
                  <option value="">Choose…</option>
                  {definitions.map((definition) => (
                    <option key={definition.id} value={definition.id}>
                      {definition.name}
                      {definition.is_financial ? " (financial)" : ""}
                    </option>
                  ))}
                </select>
              </Field>

              {selected?.description ? (
                <p className="text-[11px] leading-snug text-ink-faint">
                  {selected.description}
                </p>
              ) : null}

              {selected?.is_financial ? (
                <div className="rounded border border-warn/30 bg-warn/10 px-2.5 py-2 text-[11px] leading-snug text-ink-muted">
                  <Badge tone="warn">Financial</Badge>
                  <p className="mt-1.5">
                    Computed only from the ABT Meter — the sealed, revenue-grade
                    settlement instrument. It cannot be derived from an MFM, so this
                    will be refused if no ABT Meter is registered.
                  </p>
                </div>
              ) : null}

              <Field label="Period start" required>
                <input
                  type="date"
                  value={periodStart}
                  onChange={(event) => setPeriodStart(event.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Period end" required>
                <input
                  type="date"
                  value={periodEnd}
                  onChange={(event) => setPeriodEnd(event.target.value)}
                  className={inputClass}
                />
              </Field>

              <Button
                variant="primary"
                className="w-full"
                disabled={
                  definitionId === null ||
                  (needsClient && clientId === null) ||
                  requestRun.isPending
                }
                onClick={() => requestRun.mutate()}
              >
                {requestRun.isPending ? "Requesting…" : "Generate"}
              </Button>
            </div>
          </Panel>

          <div className="space-y-4">
            {abtRefusal ? (
              // Not a failure to retry — a rule. Say which rule.
              <div className="rounded border border-warn/40 bg-warn/10 p-4">
                <p className="text-sm font-medium text-warn">
                  No ABT Meter is registered
                </p>
                <p className="mt-1 text-xs text-ink-muted">{abtRefusal}</p>
                <p className="mt-2 text-xs text-ink-faint">
                  A Financial Report has commercial standing only when it comes from
                  the sealed settlement meter. Deriving one from an operational MFM is
                  forbidden, so retrying will not help — register the ABT Meter for
                  this Plant first.
                </p>
              </div>
            ) : null}

            {genericError ? (
              <div className="rounded border border-bad/30 bg-bad/10 px-3 py-2 text-xs text-bad">
                {genericError}
              </div>
            ) : null}

            <Panel title="Run">
              {runId === null ? (
                <p className="text-xs text-ink-faint">
                  No run requested in this session.
                </p>
              ) : runQuery.isLoading ? (
                <LoadingState label="Reading run status" />
              ) : runQuery.isError ? (
                <ErrorState error={runQuery.error} />
              ) : run ? (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge
                      tone={
                        run.state === "succeeded"
                          ? "ok"
                          : run.state === "failed"
                            ? "bad"
                            : "warn"
                      }
                    >
                      {run.state}
                    </Badge>
                    <span className="text-ink-muted">Run #{run.id}</span>
                    <span className="text-ink-faint">
                      {formatDateTime(run.period_start)} → {formatDateTime(run.period_end)}
                    </span>
                    {run.row_count !== null ? (
                      <span className="text-ink-faint">
                        {formatNumber(run.row_count, { digits: 0 })} rows
                      </span>
                    ) : null}
                  </div>

                  {run.state === "queued" || run.state === "running" ? (
                    <p className="text-xs text-ink-muted">
                      The scheduler renders Reports out of band; this polls until it
                      settles.
                    </p>
                  ) : null}

                  {run.state === "failed" ? (
                    <div className="rounded border border-bad/30 bg-bad/10 px-3 py-2">
                      <p className="text-xs font-medium text-bad">Run failed</p>
                      <p className="mt-1 text-xs text-ink-muted">
                        {run.error ?? "No reason was recorded."}
                      </p>
                    </div>
                  ) : null}

                  {artifacts.links.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {artifacts.links.map((artifact) => (
                        <a
                          key={artifact.format}
                          href={artifactHref(artifact.url)}
                          className="rounded border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/20"
                          // The signed URL is itself the credential and expires;
                          // it is used as given, never re-signed or stored.
                          title="Signed link, valid for a limited time."
                        >
                          Download {artifact.format.toUpperCase()}
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {artifacts.notes.map((note) => (
                    // pdf_unavailable: the run succeeded. Not a failure.
                    <p
                      key={note}
                      className="rounded border border-line bg-surface px-3 py-2 text-[11px] text-ink-muted"
                    >
                      {note} The spreadsheet above is complete and unaffected.
                    </p>
                  ))}
                </div>
              ) : null}
            </Panel>

            <Panel title="Available definitions">
              <ul className="space-y-2">
                {definitions.map((definition) => (
                  <li
                    key={definition.id}
                    className="flex items-start justify-between gap-3 rounded border border-line bg-surface px-3 py-2"
                  >
                    <div>
                      <div className="text-xs font-medium text-ink">{definition.name}</div>
                      <div className="text-[11px] text-ink-faint">
                        {definition.description ?? definition.code}
                      </div>
                    </div>
                    {definition.is_financial ? (
                      <Badge
                        tone="warn"
                        title="Requires the ABT Meter. Never computed from an MFM."
                      >
                        financial
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}
