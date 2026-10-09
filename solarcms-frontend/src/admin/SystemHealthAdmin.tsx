/**
 * System Health — is the platform itself working, separately from the Plants.
 *
 * Every other screen answers questions about Plants, and none can tell a silent
 * Plant from a dead ingest worker: both are a flat line. This one reads each
 * process's own heartbeat (`GET /health/processes`) and says, per process:
 * running, whether its latest unit of work *completed* (not merely ran), when
 * it last *saved* something, and its last error — plus the broker as ingest
 * sees it and whether a supervisor will restart what crashes.
 *
 * Why "completed" and "saved" rather than "alive": four times on this project a
 * process looped, caught its own failure, logged it and slept, writing nothing
 * for days while every liveness check passed (CLAUDE.md). A green dot for a
 * process that is up and failing is the exact lie this page exists to prevent.
 *
 * The verdicts are the server's (`domain/system_health.py`); this arranges them.
 * Below them, the database-side figures that used to open the System screen:
 * ingest lag, quarantine, the alarm stream and aggregate freshness.
 */

import { usePlatformHealth, useSystemHealth } from "@/api/hooks";
import type { HealthTone, PlatformHealth, ProcessHealth } from "@/api/schemas";
import { PROCESS_LABEL, STATE_WORD, agoText, problems, span } from "@/admin/platformHealth";
import { StatTile } from "@/components/charts/KpiTile";
import { Badge, Panel } from "@/components/ui";
import { ErrorState, ForbiddenState, LoadingState } from "@/components/state";
import { usePermission } from "@/auth/usePermission";
import { formatAge, formatDateTime } from "@/format/datetime";
import { formatNumber } from "@/format/value";

// Re-exported so a test or another screen can reach them from the page.
export { PROCESS_LABEL, STATE_WORD, agoText, problems, span };

const FRAME: Record<HealthTone, string> = {
  // A frame lights up only for bad news; "working" is the plain card.
  ok: "border-line",
  warn: "border-warn/50",
  bad: "border-bad/50",
};

const REASON_TEXT: Record<HealthTone, string> = {
  ok: "text-ink-muted",
  warn: "text-warn",
  bad: "text-bad",
};

function StatePill({ state, tone }: { state: string; tone: HealthTone }): JSX.Element {
  return <Badge tone={tone}>{STATE_WORD[state] ?? state}</Badge>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

function ProcessCard({ process, now }: { process: ProcessHealth; now: number }): JSX.Element {
  const supervised = process.supervised;
  const isApi = process.name === "api";
  return (
    <div
      data-testid={`process-${process.name}`}
      data-state={process.state}
      className={`surface-tile rounded-card border p-4 ${FRAME[process.tone]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{PROCESS_LABEL[process.name] ?? process.name}</div>
          <div className="mt-0.5 text-xs text-ink-faint">{process.purpose}</div>
        </div>
        <StatePill state={process.state} tone={process.tone} />
      </div>
      <p className={`mt-2 text-xs leading-snug ${REASON_TEXT[process.tone]}`}>{process.reason}</p>
      <dl className="mt-2 divide-y divide-line-soft text-xs">
        {isApi ? null : (
          <>
            <Row label="Last completed work">{agoText(process.last_cycle_at, now)}</Row>
            <Row label="Last saved">
              {process.last_write_at ? (
                <span title={process.last_write ?? undefined}>
                  {agoText(process.last_write_at, now)}
                  {process.last_write ? <span className="text-ink-muted"> · {process.last_write}</span> : null}
                </span>
              ) : (
                "nothing yet"
              )}
            </Row>
            <Row label="Last error">
              {process.last_error_at ? (
                <span className="break-words" title={process.last_error ?? undefined}>
                  {agoText(process.last_error_at, now)}
                  {process.errors ? <span className="text-ink-muted"> · {formatNumber(process.errors, { digits: 0 })} since start</span> : null}
                </span>
              ) : (
                "none since it started"
              )}
            </Row>
          </>
        )}
        <Row label="Restarts">
          {supervised ? (
            <span
              title={
                supervised.last_exit_at
                  ? `Last exit: code ${supervised.last_exit_code ?? "?"} after running ${span(supervised.last_ran_for_s)}, ${agoText(supervised.last_exit_at, now)}`
                  : undefined
              }
            >
              {formatNumber(supervised.restarts, { digits: 0 })}
              {supervised.last_exit_at ? (
                <span className="text-ink-muted"> · last {agoText(supervised.last_exit_at, now)}, code {supervised.last_exit_code ?? "?"}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-ink-muted">not supervised</span>
          )}
        </Row>
        {process.passes && Object.keys(process.passes).length > 0 ? (
          <Row label="Pass time">
            {Object.entries(process.passes).map(([job, pass], index) => (
              <span
                key={job}
                className={pass.took_s > pass.every_s ? "text-warn" : undefined}
                title="How long the latest pass took, against the interval it must fit within. Longer means it is falling behind."
              >
                {index > 0 ? " · " : ""}
                {job} {pass.took_s < 10 ? pass.took_s.toFixed(1) : Math.round(pass.took_s)} s of{" "}
                {Math.round(pass.every_s)} s
              </span>
            ))}
          </Row>
        ) : null}
        {process.instances &&
        process.instances.filter((copy) => copy.role !== "stopped").length > 1 ? (
          <Row label="Copies">
            <span title={process.instances.map((copy) => `${copy.instance} (${copy.role})`).join("\n")}>
              {process.instances.filter((copy) => copy.role === "active").length} working ·{" "}
              {process.instances.filter((copy) => copy.role === "standby").length} on standby
            </span>
          </Row>
        ) : null}
        <Row label="Running since">
          {process.started_at ? formatDateTime(process.started_at) : isApi && supervised?.started_at ? formatDateTime(supervised.started_at) : "—"}
          {process.pid ? <span className="text-ink-muted"> · pid {process.pid}</span> : null}
        </Row>
      </dl>
      {process.last_error ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-ink-muted hover:text-ink">Last error message</summary>
          <p className="mt-1 break-words rounded border border-line bg-surface-sunken px-2 py-1.5 font-mono text-[11px] text-ink">
            {process.last_error}
          </p>
        </details>
      ) : null}
    </div>
  );
}

function BrokerCard({ health, now }: { health: PlatformHealth; now: number }): JSX.Element | null {
  const broker = health.broker;
  if (!broker) return null;
  return (
    <div data-testid="broker" className={`surface-tile rounded-card border p-4 ${FRAME[broker.tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink">Broker</div>
          <div className="mt-0.5 text-xs text-ink-faint">Where the equipment's messages arrive, as ingest sees it.</div>
        </div>
        <StatePill state={broker.state} tone={broker.tone} />
      </div>
      <p className={`mt-2 text-xs leading-snug ${REASON_TEXT[broker.tone]}`}>{broker.reason}</p>
      <dl className="mt-2 divide-y divide-line-soft text-xs">
        <Row label="Address"><span className="font-mono">{broker.broker ?? "—"}</span></Row>
        <Row label="Listening for">
          <span className="font-mono">{broker.topics.length ? broker.topics.join(", ") : "—"}</span>
        </Row>
        <Row label="Last message">{agoText(broker.last_message_at, now, "none yet")}</Row>
        <Row label="Messages since ingest started">{formatNumber(broker.messages, { digits: 0 })}</Row>
        <Row label="Connected since">{broker.connected_at ? formatDateTime(broker.connected_at) : "—"}</Row>
      </dl>
    </div>
  );
}

function SupervisorCard({ health, now }: { health: PlatformHealth; now: number }): JSX.Element | null {
  const supervisor = health.supervisor;
  if (!supervisor) return null;
  return (
    <div data-testid="supervisor" className={`surface-tile rounded-card border p-4 ${FRAME[supervisor.tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ink">Supervisor</div>
          <div className="mt-0.5 text-xs text-ink-faint">Starts the processes above and restarts any that exits.</div>
        </div>
        <StatePill state={supervisor.state} tone={supervisor.tone} />
      </div>
      <p className={`mt-2 text-xs leading-snug ${REASON_TEXT[supervisor.tone]}`}>{supervisor.reason}</p>
      <dl className="mt-2 divide-y divide-line-soft text-xs">
        <Row label="Running since">{supervisor.started_at ? formatDateTime(supervisor.started_at) : "—"}</Row>
        <Row label="Last heartbeat">{agoText(supervisor.beat_at, now)}</Row>
        <Row label="Logs"><span className="break-all font-mono">{supervisor.log_dir ?? "—"}</span></Row>
      </dl>
    </div>
  );
}

export function PlatformHealthView({ health }: { health: PlatformHealth }): JSX.Element {
  const now = Date.parse(health.as_of);
  const issues = problems(health);
  return (
    <div className="space-y-4">
      {issues.length > 0 ? (
        <div
          role="alert"
          className={`rounded-card border px-4 py-3 text-sm ${
            health.overall === "bad" ? "border-bad/40 bg-bad/10" : "border-warn/40 bg-warn/10"
          }`}
        >
          <div className="font-semibold text-ink">
            {issues.length === 1 ? "1 problem" : `${issues.length} problems`}
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink">
            {issues.map((issue) => (
              <li key={issue.text}>{issue.text}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Panel title="Processes" subtitle="Each one's own heartbeat, every 10 seconds." tray padding="p-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {health.processes.map((process) => (
            <ProcessCard key={process.name} process={process} now={now} />
          ))}
        </div>
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <BrokerCard health={health} now={now} />
        <SupervisorCard health={health} now={now} />
      </div>
    </div>
  );
}

export function SystemHealthAdmin(): JSX.Element {
  const isPlatformAdmin = usePermission("system.admin");
  const platform = usePlatformHealth(isPlatformAdmin);
  const data = useSystemHealth(isPlatformAdmin);

  if (!isPlatformAdmin) {
    return <ForbiddenState detail="System Health requires the system.admin permission." />;
  }

  const health = platform.data;
  const figures = data.data;
  const verdict =
    health === undefined
      ? null
      : health.overall === "ok"
        ? { tone: "ok" as const, text: "Everything is working" }
        : { tone: health.overall, text: health.overall === "bad" ? "Something is wrong" : "Needs a look" };

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="page-title">System Health</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Is the platform itself running — separately from whether the Plants are.
            {health ? <span className="text-ink-faint"> Checked {formatDateTime(health.as_of)}.</span> : null}
          </p>
        </div>
        {verdict ? (
          <span data-testid="overall">
            <Badge tone={verdict.tone}>
              <span className="px-1 py-0.5 text-sm">{verdict.text}</span>
            </Badge>
          </span>
        ) : null}
      </header>

      {platform.isLoading ? (
        <LoadingState label="Reading the processes' heartbeats" />
      ) : platform.isError ? (
        <ErrorState error={platform.error} retry={() => void platform.refetch()} />
      ) : health ? (
        <PlatformHealthView health={health} />
      ) : null}

      <h2 className="pt-2 text-sm font-semibold text-ink">What the database says</h2>
      {data.isLoading ? (
        <LoadingState label="Reading the database's figures" />
      ) : data.isError ? (
        <ErrorState error={data.error} retry={() => void data.refetch()} />
      ) : figures ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Ingest lag"
              value={figures.ingest_lag_seconds === null ? "—" : formatAge(figures.ingest_lag_seconds)}
              tone={
                figures.ingest_lag_seconds === null
                  ? "default"
                  : figures.ingest_lag_seconds > 300
                    ? "bad"
                    : figures.ingest_lag_seconds > 60
                      ? "warn"
                      : "ok"
              }
              hint="Age of the newest Reading. This is what separates 'nothing is generating' from 'nothing is arriving'."
            />
            <StatTile
              label="Quarantined (1h)"
              value={formatNumber(figures.quarantined_last_hour, { digits: 0 })}
              tone={figures.quarantined_last_hour > 0 ? "warn" : "default"}
              hint="Messages on unrecognised topics. Retained in mqtt_raw and alarmed — never attributed to a Client by guessing at the payload."
            />
            <StatTile
              label="Alarm backlog"
              value={
                figures.alarm_backlog === null || figures.alarm_backlog === undefined
                  ? "—"
                  : formatNumber(figures.alarm_backlog, { digits: 0 })
              }
              tone={(figures.alarm_backlog ?? 0) > 1_000 ? "warn" : "default"}
              // ⚠ Not the stream's length: that counts readings already
              // evaluated and kept for replay, and read as 21,000 behind on a
              // worker that was fully caught up.
              hint={`Readings the Alarm checks have not evaluated yet — a growing figure means they are falling behind ingestion. The stream itself holds ${formatNumber(figures.alarm_stream_depth, { digits: 0 })}, most already evaluated and kept for replay.`}
            />
            <StatTile
              label="Continuous aggregates"
              value={formatNumber(figures.continuous_aggregates.length, { digits: 0 })}
              hint="A stalled aggregate is invisible everywhere else — the tiers serving week and month views simply stop filling."
            />
          </div>
          <Panel title="Aggregate freshness" subtitle="Reports and KPIs read these tiers, never raw Readings.">
            <ul className="space-y-1.5">
              {figures.continuous_aggregates.map((aggregate) => (
                <li
                  key={aggregate.view}
                  className="flex items-center justify-between rounded border border-line bg-surface px-3 py-1.5 text-xs"
                >
                  <span className="font-mono text-ink">{aggregate.view}</span>
                  <span className="text-ink-muted">
                    {aggregate.last_refresh ? `refreshed ${formatDateTime(aggregate.last_refresh)}` : "never refreshed"}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </>
      ) : null}
    </div>
  );
}
