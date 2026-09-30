/**
 * The header's word on the platform itself — for a Super Admin, and only when
 * something is wrong.
 *
 * Silent when every process is working: a permanent green "System OK" is a
 * light people stop seeing, which is how it would fail on the day it mattered.
 * When anything is not fine it names the first problem and links to System
 * Health, so a dead ingest worker is on every screen, not only on the one page
 * somebody has to think of opening.
 */

import { Link } from "react-router-dom";
import { usePlatformHealth } from "@/api/hooks";
import { usePermission } from "@/auth/usePermission";
import { PROCESS_LABEL, STATE_WORD, problems } from "@/admin/platformHealth";

export function SystemHealthPill(): JSX.Element | null {
  const isPlatformAdmin = usePermission("system.admin");
  const query = usePlatformHealth(isPlatformAdmin);
  const health = query.data;
  if (!isPlatformAdmin) return null;

  // The API not answering at all is itself the news.
  if (query.isError) {
    return (
      <Link
        to="/admin/health"
        data-testid="system-health-pill"
        className="inline-flex items-center gap-2 rounded border border-bad/40 bg-bad/10 px-2 py-1 text-xs font-medium text-bad"
        title="The platform's health could not be read."
      >
        <span className="h-2 w-2 rounded-full bg-bad" />
        System health unavailable
      </Link>
    );
  }
  if (!health || health.overall === "ok") return null;

  const issues = problems(health);
  const worst = health.processes.find((p) => p.tone === health.overall);
  const label =
    issues.length === 1 && worst
      ? `${PROCESS_LABEL[worst.name] ?? worst.name} ${(STATE_WORD[worst.state] ?? worst.state).toLowerCase()}`
      : issues.length === 1
        ? "1 system problem"
        : `${issues.length} system problems`;
  const bad = health.overall === "bad";
  return (
    <Link
      to="/admin/health"
      data-testid="system-health-pill"
      className={`inline-flex items-center gap-2 rounded border px-2 py-1 text-xs font-medium ${
        bad ? "border-bad/40 bg-bad/10 text-bad" : "border-warn/40 bg-warn/10 text-warn"
      }`}
      title={issues.map((issue) => issue.text).join("\n")}
    >
      <span className={`h-2 w-2 rounded-full ${bad ? "bg-bad" : "bg-warn"}`} />
      {label}
    </Link>
  );
}
