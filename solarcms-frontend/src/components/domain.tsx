/**
 * Small Client-agnostic domain widgets.
 *
 * Everything here branches on a *type* or a *status* — both data — and never on
 * a Client, Plant or Device identity (Guardrail 1, F-14).
 */

import type { ReactNode } from "react";
import type { Alarm, CommStatus, DeviceHealth, KpiPeriod } from "@/api/schemas";
import { KPI_PERIODS } from "@/api/schemas";
import { Badge, type BadgeTone, SelectBox, inputClass } from "@/components/ui";
import { formatAge, formatDateTime } from "@/format/datetime";

// ── Plant status ────────────────────────────────────────────────────────────

export const PLANT_STATUS_TONE: Record<string, BadgeTone> = {
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

const STATUS_PILL: Record<BadgeTone, { frame: string; dot: string }> = {
  ok: { frame: "border-ok/40 bg-ok/10 text-ok", dot: "bg-ok" },
  warn: { frame: "border-warn/40 bg-warn/10 text-warn", dot: "bg-warn" },
  bad: { frame: "border-bad/40 bg-bad/10 text-bad", dot: "bg-bad" },
  info: { frame: "border-info/40 bg-info/10 text-info", dot: "bg-info" },
  accent: { frame: "border-accent/40 bg-accent/10 text-accent", dot: "bg-accent" },
  neutral: { frame: "border-line-strong bg-surface-sunken text-ink-muted", dot: "bg-ink-faint" },
};

/** The Plant's status as a rounded pill with a dot — for a card or a title band. */
export function PlantStatusPill({
  status,
  title,
}: {
  status: string;
  title?: string;
}): JSX.Element {
  const style = STATUS_PILL[PLANT_STATUS_TONE[status] ?? "neutral"];
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-semibold ${style.frame}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {status}
    </span>
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
  size = "sm",
}: {
  value: KpiPeriod;
  onChange: (period: KpiPeriod) => void;
  /** `lg` for a page's title band, where it sits beside header cells. */
  size?: "sm" | "lg";
}): JSX.Element {
  // The same anatomy as `SegmentedControl` — a sunken track, the choice a
  // raised pill in the accent — so every "pick one of these" on a screen looks
  // like one control. The accent, never green: a selection is not a status,
  // and green here said "healthy" about a date range.
  if (size === "lg") {
    return (
      <div
        role="radiogroup"
        aria-label="Period"
        className="inline-flex gap-1 rounded-control border border-line bg-surface-sunken p-1"
      >
        {KPI_PERIODS.map((period) => (
          <button
            key={period}
            type="button"
            // Announced like the Window control beside it: which one is
            // chosen was otherwise visible and never said.
            role="radio"
            aria-checked={value === period}
            onClick={() => onChange(period)}
            className={`rounded-control px-3.5 py-1.5 text-sm font-semibold capitalize transition ${
              value === period
                ? "bg-surface-raised text-accent shadow-soft"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            {period}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div
      role="radiogroup"
      aria-label="Period"
      className="inline-flex rounded-control border border-line bg-surface-sunken p-0.5"
    >
      {KPI_PERIODS.map((period) => (
        <button
          key={period}
          type="button"
          role="radio"
          aria-checked={value === period}
          onClick={() => onChange(period)}
          className={`rounded-control px-2.5 py-1 text-xs font-medium capitalize transition ${
            value === period
              ? "bg-surface-raised text-accent shadow-soft"
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
  size = "sm",
}: {
  plants: { id: number; code: string; name: string }[];
  value: number | null;
  onChange: (plantId: number | null) => void;
  allowAll?: boolean;
  label?: ReactNode;
  /** `lg` for a page's title band: the code in mono and colour beside the name. */
  size?: "sm" | "lg";
}): JSX.Element {
  const options = (
    <>
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
    </>
  );
  if (size === "lg") {
    const current = plants.find((plant) => plant.id === value);
    return (
      <SelectBox
        label={label}
        value={value === null ? "" : String(value)}
        onChange={(next) => onChange(next === "" ? null : Number(next))}
        className="min-w-[15rem]"
        display={
          current ? (
            <>
              <span className="font-mono font-semibold text-accent">{current.code}</span>
              <span className="text-ink-muted"> — </span>
              {current.name}
            </>
          ) : (
            <span className="text-ink-muted">
              {allowAll ? "All Plants" : plants.length === 0 ? "No Plants assigned" : "Choose a Plant"}
            </span>
          )
        }
      >
        {options}
      </SelectBox>
    );
  }
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
        {options}
      </select>
    </label>
  );
}
