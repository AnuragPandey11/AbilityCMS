/**
 * `plant_overview` — one card per Plant (§6.2).
 *
 * The middle altitude of the three the tender names. `portfolio` answers *how
 * is the fleet doing* with totals and no per-Plant detail; `plant_list` answers
 * *work through the Plants* with a sortable, filterable, exportable table. This
 * answers the question between them — **which Plant needs me right now** — and
 * so it is scanned, not read: status, alarms and health first, figures second.
 *
 * ⚠ The tender lists Overview and List as separate dashboards but never says
 * how they differ (MASTER §7 traceability, tender §7). This split is **our
 * proposal** and is recorded as OPEN-23; if the client meant something else,
 * this component is what changes.
 *
 * Cards are ordered by *need for attention*, not alphabetically. A fleet that
 * fits on one screen makes the ordering invisible; a fleet of eighty makes it
 * the entire value of the screen. Sorting by name is what `plant_list` is for.
 *
 * Every figure obeys §4.3: `null` renders as "—" with its reason, never as 0.
 * No figure appears here that the table does not already show — this screen
 * changes the *shape* of the presentation, not what the platform claims to know
 * (OPEN-14, OPEN-15, OPEN-16 remain open).
 */

import { useNavigate } from "react-router-dom";
import type { KpiPeriod } from "@/api/schemas";
import { Badge, Panel } from "@/components/ui";
import { EmptyState, ErrorState, Skeleton } from "@/components/state";
import {
  DeviceHealthStrip,
  PeriodPicker,
  PlantStatusBadge,
  SeverityBadge,
  isOnboarding,
} from "@/components/domain";
import {
  UNDEFINED_DISPLAY,
  formatHeadline,
  formatNumber,
  formatRatioAsPercent,
  variantNote,
} from "@/format/value";
import { useSelection } from "@/state/selection";
import { FittedFigure } from "@/components/charts/FittedFigure";
import { usePlantFleet, type PlantFleetEntry } from "./usePlantFleet";

/**
 * How loudly a card asks to be looked at. Lower sorts first.
 *
 * Deliberately driven by Alarms and communication health — both *states the
 * platform is sure of* — and never by a KPI. An undefined PR is the normal
 * night-time condition on every Plant in the fleet; ranking on it would put the
 * whole estate at the top of the screen at dusk and teach operators that the
 * ordering means nothing.
 */
const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function attentionRank(entry: PlantFleetEntry): number {
  if (entry.worstSeverity !== null) {
    return SEVERITY_RANK[entry.worstSeverity] ?? 4;
  }
  // No open Alarm, but nothing is reporting either: a Plant whose Devices are
  // all offline raises no threshold Alarm precisely because no value arrives.
  const offline = entry.health.filter((device) => device.comm_status === "offline").length;
  if (entry.health.length > 0 && offline === entry.health.length) return 4;
  if (offline > 0) return 5;
  return 6;
}

/** The card's left border — the only colour that carries meaning at a glance. */
function accentClass(entry: PlantFleetEntry): string {
  if (entry.worstSeverity === "critical" || entry.worstSeverity === "high") {
    return "border-l-bad";
  }
  if (entry.worstSeverity) return "border-l-warn";
  if (entry.health.some((device) => device.comm_status === "offline")) {
    return "border-l-warn";
  }
  if (entry.health.length === 0) return "border-l-line";
  return "border-l-ok";
}

/**
 * One figure on a card. Small, monospaced, and dashed when undefined — the same
 * contract `KpiTile` enforces, at card scale rather than tile scale.
 */
function CardFigure({
  label,
  value,
  unit,
  title,
  muted,
}: {
  label: string;
  value: string;
  unit?: string | null;
  title?: string;
  muted?: boolean;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-ink-muted">{label}</div>
      <FittedFigure
        value={value}
        unit={unit}
        className={`font-mono text-sm ${muted ? "text-ink-faint" : "text-ink"}`}
        unitClassName="text-[11px] text-ink-muted"
        title={title}
      />
    </div>
  );
}

function PlantCard({
  entry,
  period,
  onOpen,
}: {
  entry: PlantFleetEntry;
  period: KpiPeriod;
  onOpen: () => void;
}): JSX.Element {
  const { plant, kpis, alarms, worstSeverity, liveDeviceCount } = entry;
  const pr = kpis?.performance_ratio;
  const capacity = formatHeadline(plant.dc_capacity_kwp);
  const energy = formatHeadline(kpis?.energy_kwh);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full flex-col gap-3 rounded-card border border-l-4 border-line ${accentClass(entry)} bg-surface-raised p-4 text-left shadow-soft transition hover:border-accent/40 hover:shadow-card focus:outline-none focus:ring-2 focus:ring-accent/30`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-ink">{plant.name}</div>
          <div className="mt-0.5 font-mono text-[11px] text-ink-muted">
            {plant.code}
            {plant.region_code ? ` · ${plant.region_code}` : ""}
          </div>
        </div>
        <PlantStatusBadge status={plant.status} />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <CardFigure
          label="DC capacity"
          value={capacity.text}
          unit={plant.dc_capacity_kwp === null ? null : "kWp"}
          title={capacity.compacted ? `${capacity.exact} kWp` : undefined}
          muted={plant.dc_capacity_kwp === null}
        />
        <CardFigure
          label={`Energy (${period})`}
          // The API returns kWh for this figure; the unit is stated, not inferred.
          //
          // Compacted, not shrunk: three figures share the width of one card, so
          // a lifetime total rendered in full used to scale down to roughly 8px
          // — present, and unreadable. `1.24M kWh` is still kWh (§4.1).
          value={kpis ? energy.text : "…"}
          unit={kpis ? "kWh" : null}
          title={energy.compacted ? `${energy.exact} kWh` : undefined}
          muted={!kpis}
        />
        <CardFigure
          label="PR"
          value={pr ? formatRatioAsPercent(pr.value) : "…"}
          muted={!pr || pr.value === null}
          title={
            pr
              ? pr.value === null
                ? (pr.undefined_reason ?? "Undefined for this period.")
                : variantNote(pr.variant)
              : undefined
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <DeviceHealthStrip health={entry.health} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-soft pt-2">
        <span className="flex items-center gap-1.5">
          {alarms.length === 0 ? (
            <span className="text-[11px] text-ink-faint">No open Alarms</span>
          ) : (
            <>
              {worstSeverity ? <SeverityBadge severity={worstSeverity} /> : null}
              <span className="text-[11px] text-ink-muted">
                {alarms.length} open Alarm{alarms.length === 1 ? "" : "s"}
              </span>
            </>
          )}
        </span>
        <span
          className="text-[11px] text-ink-faint"
          title={
            liveDeviceCount === 0
              ? "No live frames received for this Plant in this session. Values may still exist over REST."
              : "Devices that have sent a live frame in this browser session."
          }
        >
          {liveDeviceCount === 0
            ? `${UNDEFINED_DISPLAY} live`
            : `${formatNumber(liveDeviceCount, { digits: 0 })} live`}
        </span>
      </div>
    </button>
  );
}

/** A grid of card-shaped skeletons, so arriving Plants fill boxes already there. */
function SkeletonCardGrid({ cards = 8 }: { cards?: number }): JSX.Element {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      aria-hidden="true"
    >
      {Array.from({ length: cards }, (_, index) => (
        <div
          key={index}
          className="rounded-card border border-l-4 border-line bg-surface-raised p-4"
        >
          <Skeleton className="h-3 w-32" />
          <Skeleton className="mt-2 h-2.5 w-20" />
          <div className="mt-4 flex gap-3">
            <Skeleton className="h-6 flex-1" />
            <Skeleton className="h-6 flex-1" />
            <Skeleton className="h-6 flex-1" />
          </div>
          <Skeleton className="mt-4 h-3 w-40" />
        </div>
      ))}
    </div>
  );
}

function CardGrid({
  entries,
  period,
  onOpen,
}: {
  entries: PlantFleetEntry[];
  period: KpiPeriod;
  onOpen: (plantId: number) => void;
}): JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {entries.map((entry) => (
        <PlantCard
          key={entry.plant.id}
          entry={entry}
          period={period}
          onOpen={() => onOpen(entry.plant.id)}
        />
      ))}
    </div>
  );
}

export function PlantOverviewDashboard(): JSX.Element {
  const navigate = useNavigate();
  const { period, setPeriod, setPlantId } = useSelection();
  const fleet = usePlantFleet(period);

  if (fleet.isLoading) return <SkeletonCardGrid />;
  if (fleet.isError) return <ErrorState error={fleet.error} retry={fleet.refetch} />;
  if (fleet.plants.length === 0) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const openPlant = (plantId: number) => {
    setPlantId(plantId);
    navigate("/d/single_plant");
  };

  const sorted = [...fleet.entries].sort((a, b) => {
    const rank = attentionRank(a) - attentionRank(b);
    if (rank !== 0) return rank;
    // Then by how many Alarms are open, then by name so the order is stable
    // between polls rather than shuffling as equal-ranked Plants tie.
    if (a.alarms.length !== b.alarms.length) return b.alarms.length - a.alarms.length;
    return a.plant.name.localeCompare(b.plant.name);
  });

  const active = sorted.filter((entry) => !isOnboarding(entry.plant.status));
  const onboarding = sorted.filter((entry) => isOnboarding(entry.plant.status));
  const needingAttention = active.filter((entry) => attentionRank(entry) < 6).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Plant Overview</h1>
          <p className="text-xs text-ink-muted">
            {fleet.plants.length} visible Plant(s), ordered by need for attention.
            Click a card to open it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {needingAttention > 0 ? (
            <Badge
              tone="warn"
              title="Plants with an open Alarm or an offline Device. Ordered first."
            >
              {needingAttention} needing attention
            </Badge>
          ) : (
            <Badge tone="ok" title="No open Alarms and no offline Devices.">
              All quiet
            </Badge>
          )}
          <PeriodPicker value={period} onChange={setPeriod} />
        </div>
      </div>

      {active.length === 0 ? (
        <EmptyState
          title="No active Plants"
          detail="Every visible Plant is still in draft or commissioning."
        />
      ) : (
        <CardGrid entries={active} period={period} onOpen={openPlant} />
      )}

      {onboarding.length > 0 ? (
        <Panel
          title="Onboarding"
          subtitle="Draft and commissioning Plants. Excluded from portfolio totals."
        >
          <CardGrid entries={onboarding} period={period} onOpen={openPlant} />
        </Panel>
      ) : null}
    </div>
  );
}
