/**
 * Small Client-agnostic domain widgets.
 *
 * Everything here branches on a *type* or a *status* — both data — and never on
 * a Client, Plant or Device identity (Guardrail 1, F-14).
 */

import type { ReactNode } from "react";
import type { Alarm, CommStatus, DeviceHealth, KpiPeriod } from "@/api/schemas";
import { KPI_PERIODS } from "@/api/schemas";
import { Badge, type BadgeTone, inputClass } from "@/components/ui";
import { formatAge, formatDateTime } from "@/format/datetime";

// ── Plant status ────────────────────────────────────────────────────────────

const PLANT_STATUS_TONE: Record<string, BadgeTone> = {
  active: "ok",
  commissioning: "warn",
  draft: "neutral",
  suspended: "bad",
  decommissioned: "neutral",
};

/**
 * `draft` and `commissioning` Plants are excluded from portfolio totals — a
 * half-mapped Plant would otherwise drag fleet PR down (§6.1, MASTER §6.5).
 */
export const ONBOARDING_STATUSES = new Set(["draft", "commissioning"]);

export function isOnboarding(status: string): boolean {
  return ONBOARDING_STATUSES.has(status);
}

export function PlantStatusBadge({ status }: { status: string }): JSX.Element {
  return (
    <Badge
      tone={PLANT_STATUS_TONE[status] ?? "neutral"}
      title={
        isOnboarding(status)
          ? "Excluded from portfolio totals until the Plant is active — a partly mapped Plant would distort fleet figures."
          : undefined
      }
    >
      {status}
    </Badge>
  );
}

// ── Communication status ────────────────────────────────────────────────────

const COMM_TONE: Record<CommStatus, BadgeTone> = {
  online: "ok",
  degraded: "warn",
  offline: "bad",
  unknown: "neutral",
};

export const COMM_TITLE: Record<CommStatus, string> = {
  online: "Reporting within its expected interval.",
  degraded: "Late — past the expected interval but under the offline threshold.",
  offline:
    "Not reporting. Check whether the Collector that carries it is also offline — " +
    "a communication loss is not equipment downtime.",
  unknown: "No health record yet; the Device has not reported since registration.",
};

export function CommStatusBadge({
  status,
}: {
  status: CommStatus | null | undefined;
}): JSX.Element {
  const value = status ?? "unknown";
  return (
    <Badge tone={COMM_TONE[value]} title={COMM_TITLE[value]}>
      {value}
    </Badge>
  );
}

/**
 * A one-line health summary for a Plant.
 *
 * Communication loss and equipment downtime are counted separately, because a
 * failed Collector recorded as generation downtime corrupts availability.
 */
export function DeviceHealthStrip({
  health,
}: {
  health: DeviceHealth[] | undefined;
}): JSX.Element {
  if (!health || health.length === 0) {
    return <span className="text-xs text-ink-faint">No Devices registered</span>;
  }
  const counts = { online: 0, degraded: 0, offline: 0, unknown: 0 };
  let frozen = 0;
  for (const device of health) {
    counts[device.comm_status] += 1;
    if ((device.frozen_tag_count ?? 0) > 0) frozen += 1;
  }
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge tone="ok" title="Reporting within the expected interval.">
        {counts.online} online
      </Badge>
      {counts.degraded > 0 ? (
        <Badge tone="warn" title={COMM_TITLE.degraded}>
          {counts.degraded} degraded
        </Badge>
      ) : null}
      {counts.offline > 0 ? (
        <Badge tone="bad" title={COMM_TITLE.offline}>
          {counts.offline} offline
        </Badge>
      ) : null}
      {counts.unknown > 0 ? (
        <Badge tone="neutral" title={COMM_TITLE.unknown}>
          {counts.unknown} unknown
        </Badge>
      ) : null}
      {frozen > 0 ? (
        <Badge
          tone="warn"
          title="The value has not changed across many consecutive Readings. The link is up; the sensor may not be."
        >
          {frozen} frozen
        </Badge>
      ) : null}
    </span>
  );
}

// ── Alarms ──────────────────────────────────────────────────────────────────

export const SEVERITY_TONE: Record<string, BadgeTone> = {
  critical: "bad",
  high: "bad",
  medium: "warn",
  low: "info",
};

export function SeverityBadge({ severity }: { severity: string }): JSX.Element {
  return <Badge tone={SEVERITY_TONE[severity] ?? "neutral"}>{severity}</Badge>;
}

export function AlarmStateBadge({ state }: { state: string }): JSX.Element {
  const tone: BadgeTone =
    state === "active" ? "bad" : state === "acknowledged" ? "warn" : "ok";
  return <Badge tone={tone}>{state}</Badge>;
}

/** Tender §18 keeps communication and equipment separate, so the UI must too. */
export function ClassificationBadge({
  classification,
}: {
  classification: string | null;
}): JSX.Element | null {
  if (!classification) return null;
  return (
    <Badge
      tone={classification === "communication" ? "info" : "neutral"}
      title={
        classification === "communication"
          ? "A transport failure, not equipment downtime. Counting it as downtime corrupts availability."
          : "An equipment condition — the Device itself, not the link that carries it."
      }
    >
      {classification}
    </Badge>
  );
}

/** An Alarm at L2 has already woken somebody. Worth saying, not just showing. */
export function EscalationBadge({ level }: { level: number }): JSX.Element | null {
  if (level <= 0) return null;
  return (
    <Badge
      tone={level >= 2 ? "bad" : "warn"}
      title={
        level >= 2
          ? "Escalated to level 2 or beyond — someone has already been notified out of hours."
          : "Escalated to level 1."
      }
    >
      L{level}
    </Badge>
  );
}

export function alarmSortValue(alarm: Alarm): number {
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return order[alarm.severity] ?? 9;
}

// ── Freshness ───────────────────────────────────────────────────────────────

/**
 * "Last seen", with staleness measured at `expected_interval_s × 2` — the same
 * threshold the health sweeper uses, so the UI and the Alarm agree (§5.2).
 */
export function LastSeen({
  at,
  expectedIntervalS,
  timezone,
}: {
  at: string | null;
  expectedIntervalS: number;
  timezone?: string;
}): JSX.Element {
  if (!at) return <span className="text-ink-faint">never</span>;
  const age = (Date.now() - Date.parse(at)) / 1000;
  const stale = age > expectedIntervalS * 2;
  return (
    <span
      className={stale ? "text-warn" : "text-ink-muted"}
      title={`${formatDateTime(at, timezone)} · expected every ${expectedIntervalS}s`}
    >
      {formatAge(age)}
    </span>
  );
}

// ── Pickers ─────────────────────────────────────────────────────────────────

export function PeriodPicker({
  value,
  onChange,
}: {
  value: KpiPeriod;
  onChange: (period: KpiPeriod) => void;
}): JSX.Element {
  return (
    <div className="inline-flex rounded border border-line">
      {KPI_PERIODS.map((period) => (
        <button
          key={period}
          type="button"
          onClick={() => onChange(period)}
          className={`px-2.5 py-1 text-xs capitalize transition ${
            value === period
              ? "bg-accent/15 text-accent"
              : "text-ink-muted hover:text-ink"
          }`}
        >
          {period}
        </button>
      ))}
    </div>
  );
}

/** Lists only the Plants in `/auth/me` → `plants[]` (A-2). */
export function PlantPicker({
  plants,
  value,
  onChange,
  allowAll,
  label,
}: {
  plants: { id: number; code: string; name: string }[];
  value: number | null;
  onChange: (plantId: number | null) => void;
  allowAll?: boolean;
  label?: ReactNode;
}): JSX.Element {
  return (
    <label className="inline-flex items-center gap-2">
      {label ? <span className="text-xs text-ink-muted">{label}</span> : null}
      <select
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : Number(event.target.value))
        }
        className={`${inputClass} w-auto min-w-[12rem]`}
      >
        {allowAll ? <option value="">All Plants</option> : null}
        {plants.length === 0 ? (
          <option value="" disabled>
            No Plants assigned
          </option>
        ) : null}
        {plants.map((plant) => (
          <option key={plant.id} value={plant.id}>
            {plant.code} — {plant.name}
          </option>
        ))}
      </select>
    </label>
  );
}
