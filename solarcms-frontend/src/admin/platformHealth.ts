/**
 * Words and small rules shared by the System Health page and the header's pill,
 * kept apart from the page so the application frame does not import a screen.
 */

import type { HealthTone, PlatformHealth } from "@/api/schemas";
import { formatAge } from "@/format/datetime";

export const PROCESS_LABEL: Record<string, string> = {
  api: "API",
  ingest: "Ingest",
  alarm: "Alarm checks",
  health_sweeper: "Device health sweep",
  scheduler: "Scheduler",
};

export const STATE_WORD: Record<string, string> = {
  working: "Working",
  starting: "Starting",
  degraded: "Degraded",
  stalled: "Stalled",
  failing: "Failing",
  down: "Down",
  stopped: "Stopped",
  not_seen: "Not seen",
  connected: "Connected",
  quiet: "Quiet",
  disconnected: "Disconnected",
  unknown: "Unknown",
  absent: "Not running",
};

/**
 * "12s ago", counted back from the server's `as_of` rather than the browser's
 * clock — a laptop whose clock drifts would otherwise age every heartbeat.
 */
export function agoText(iso: string | null | undefined, now: number, never = "never"): string {
  if (!iso) return never;
  return formatAge(Math.max(0, (now - Date.parse(iso)) / 1000));
}

/** A length of time, "12s" — `formatAge` without its "ago". */
export function span(seconds: number | null | undefined): string {
  return formatAge(seconds).replace(/ ago$/, "");
}

/** Everything that is not fine, worst first — the banner and the header both read it. */
export function problems(health: PlatformHealth): { tone: HealthTone; text: string }[] {
  const out: { tone: HealthTone; text: string }[] = [];
  if (!health.redis.ok) {
    out.push({ tone: "bad", text: `Redis is unreachable: ${health.redis.error ?? "no detail"}` });
  }
  for (const process of health.processes) {
    if (process.tone !== "ok") {
      out.push({
        tone: process.tone,
        text: `${PROCESS_LABEL[process.name] ?? process.name}: ${process.reason}`,
      });
    }
  }
  if (health.broker && health.broker.tone !== "ok") {
    out.push({ tone: health.broker.tone, text: `Broker: ${health.broker.reason}` });
  }
  if (health.supervisor && health.supervisor.tone !== "ok") {
    out.push({ tone: health.supervisor.tone, text: `Supervisor: ${health.supervisor.reason}` });
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "bad" ? -1 : 1));
}
