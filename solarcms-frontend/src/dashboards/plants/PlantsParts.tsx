/**
 * The Plants screen's presentational pieces: the Plant card, and the legend
 * that explains the card's rail. The summary tiles are `RailTile`, shared.
 *
 * No data access. Every figure arrives from `PlantsDashboard`, which reads it
 * from `usePlantFleet`; the only arithmetic here is a Plant's share of the
 * capacity on screen, which is two registered nameplate figures divided — not
 * a measurement, and labelled as what it is.
 */

import type { KpiPeriod } from "@/api/schemas";
import { IconAlarm, IconSignal } from "@/components/icons";
import { COMM_TITLE, PlantStatusPill, SeverityBadge } from "@/components/domain";
import {
  UNDEFINED_DISPLAY,
  formatHeadline,
  formatRatioAsPercent,
  implausibleRatioReason,
  ratioIsImplausible,
  variantNote,
} from "@/format/value";
import type { PlantFleetEntry } from "../usePlantFleet";

// ── The card's rail, and its legend ─────────────────────────────────────────

export type PlantRail = "healthy" | "offline" | "alarm";

/**
 * The worst thing true of a Plant, from states the platform is sure of.
 *
 * An open Alarm outranks a quiet Device because a Plant going silent is
 * itself alarmed by the health sweep (`COMM_LOST`, `PLANT_SILENT`) — so a
 * Device that has been dark long enough to matter turns the rail red by that
 * route, and amber means "late, not yet alarmed".
 */
export function plantRail(entry: PlantFleetEntry): PlantRail {
  if (entry.alarms.length > 0) return "alarm";
  if (entry.health.some((row) => row.comm_status === "offline" || row.comm_status === "degraded")) {
    return "offline";
  }
  return "healthy";
}

const RAIL_CLASS: Record<PlantRail, string> = {
  healthy: "border-l-ok",
  offline: "border-l-warn",
  alarm: "border-l-bad",
};

const LEGEND: { rail: PlantRail; label: string; dot: string; detail: string }[] = [
  {
    rail: "healthy",
    label: "Healthy",
    dot: "bg-ok",
    detail: "Every Device reporting within its interval, and no Alarm open.",
  },
  {
    rail: "offline",
    label: "Device offline",
    dot: "bg-warn",
    detail: "At least one Device is late or offline, and nothing has been alarmed yet.",
  },
  {
    rail: "alarm",
    label: "Open alarm",
    dot: "bg-bad",
    detail: "At least one Alarm is open on this Plant.",
  },
];

export function RailLegend(): JSX.Element {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-muted">
      {LEGEND.map((item) => (
        <li key={item.rail} className="flex items-center gap-2" title={item.detail}>
          <span className={`h-2.5 w-2.5 rounded-full ${item.dot}`} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

// ── Plant card ──────────────────────────────────────────────────────────────

function CardFigure({
  label,
  value,
  unit,
  title,
  tone = "ink",
}: {
  label: string;
  value: string;
  unit?: string | null;
  title?: string;
  tone?: "ink" | "faint" | "warn";
}): JSX.Element {
  const colour = tone === "faint" ? "text-ink-faint" : tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="min-w-0">
      <div className="field-label truncate">
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5 truncate" title={title}>
        <span className={`figure truncate text-xl font-semibold ${colour}`}>{value}</span>
        {unit ? <span className="shrink-0 text-xs font-medium text-ink-muted">{unit}</span> : null}
      </div>
    </div>
  );
}

/**
 * Online / late / offline, as pills. Only the states that are present: a pill
 * reading "0 offline" on every healthy Plant is one people stop reading.
 */
function CommPills({ entry }: { entry: PlantFleetEntry }): JSX.Element {
  if (entry.health.length === 0) {
    return (
      <span className="rounded-control border border-line px-2.5 py-1 text-xs text-ink-faint">
        No Devices registered
      </span>
    );
  }
  const counts = { online: 0, degraded: 0, offline: 0, unknown: 0 };
  for (const row of entry.health) counts[row.comm_status] += 1;
  const pills: { key: string; text: string; frame: string; title: string }[] = [
    { key: "online", text: `${counts.online} online`, frame: "border-ok/40 bg-ok/10 text-ok", title: COMM_TITLE.online },
    { key: "degraded", text: `${counts.degraded} late`, frame: "border-warn/40 bg-warn/10 text-warn", title: COMM_TITLE.degraded },
    { key: "offline", text: `${counts.offline} offline`, frame: "border-bad/40 bg-bad/10 text-bad", title: COMM_TITLE.offline },
    { key: "unknown", text: `${counts.unknown} unknown`, frame: "border-line-strong text-ink-muted", title: COMM_TITLE.unknown },
  ].filter((pill) => pill.key === "online" || counts[pill.key as keyof typeof counts] > 0);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {pills.map((pill, index) => (
        <span
          key={pill.key}
          title={pill.title}
          className={`inline-flex items-center gap-1.5 rounded-control border px-2.5 py-1 text-sm font-semibold ${pill.frame}`}
        >
          {index === 0 ? <IconSignal size={14} /> : null}
          {pill.text}
        </span>
      ))}
    </span>
  );
}

export function PlantCard({
  entry,
  period,
  capacityShare,
  onOpen,
}: {
  entry: PlantFleetEntry;
  period: KpiPeriod;
  /** This Plant's DC capacity over the Plants on screen; null when unknown. */
  capacityShare: number | null;
  onOpen: () => void;
}): JSX.Element {
  const { plant, kpis, alarms, worstSeverity } = entry;
  const pr = kpis?.performance_ratio;
  const capacity = formatHeadline(plant.dc_capacity_kwp);
  const energy = formatHeadline(kpis?.energy_kwh);
  // A ratio outside its physical range is shown unaltered and flagged, never
  // clamped — the coverage explains it, and a clamped figure hides the gap.
  const implausible = ratioIsImplausible(pr?.value);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`surface-card flex w-full flex-col rounded-card border border-l-[3px] border-line ${RAIL_CLASS[plantRail(entry)]} p-5 text-left transition hover:border-accent/45 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-lg font-semibold text-ink">{plant.name}</div>
          <div className="mt-0.5 truncate font-mono text-xs uppercase tracking-wide text-ink-faint">
            {plant.code}
            {plant.region_code ? ` · ${plant.region_code}` : ""}
          </div>
        </div>
        <PlantStatusPill status={plant.status} />
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <CardFigure
          label="Capacity"
          value={capacity.text}
          unit={plant.dc_capacity_kwp === null ? null : "kWp"}
          title={capacity.compacted ? `${capacity.exact} kWp` : undefined}
          tone={plant.dc_capacity_kwp === null ? "faint" : "ink"}
        />
        <CardFigure
          // Just "Energy": three figures share a card, and `Energy · lifetime`
          // truncated in every card at every width. The period is on the
          // tile row above and on the tooltip.
          label="Energy"
          value={kpis ? energy.text : "…"}
          unit={kpis ? "kWh" : null}
          title={`Energy over ${period}${energy.compacted ? `: ${energy.exact} kWh` : ""}`}
          tone={kpis ? "ink" : "faint"}
        />
        <CardFigure
          label="PR"
          value={
            !kpis ? "…" : pr?.value == null ? UNDEFINED_DISPLAY : formatRatioAsPercent(pr.value)
          }
          title={
            pr?.value == null
              ? (pr?.undefined_reason ?? undefined)
              : implausible
                ? implausibleRatioReason(pr.value, "PR")
                : variantNote(pr.variant)
          }
          tone={pr?.value == null ? "faint" : implausible ? "warn" : "ink"}
        />
      </div>

      <div className="mt-5" title="Registered DC capacity over the Plants on screen — nameplate, not output.">
        <div className="flex items-baseline justify-between text-sm text-ink-muted">
          <span>Share of fleet capacity</span>
          <span className="figure text-xs font-medium text-ink">
            {capacityShare === null ? UNDEFINED_DISPLAY : `${(capacityShare * 100).toFixed(1)}%`}
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
          {capacityShare !== null && capacityShare > 0 ? (
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `max(${Math.min(1, capacityShare) * 100}%, 0.75rem)` }}
            />
          ) : null}
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-line pt-4">
        <CommPills entry={entry} />
        {alarms.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 text-sm text-ink">
            {worstSeverity ? <SeverityBadge severity={worstSeverity} /> : null}
            {alarms.length} open
          </span>
        ) : (
          <span className="flex shrink-0 items-center gap-1.5 text-sm text-ink-muted">
            <IconAlarm size={15} />
            No open Alarms
          </span>
        )}
      </div>
    </button>
  );
}
