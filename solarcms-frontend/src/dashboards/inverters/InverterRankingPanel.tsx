/**
 * Inverter ranking — every Inverter of the Plant over a period, side by side:
 * generation, availability, PR, downtime, no-data time and what the stops cost.
 *
 * The figures are the server's (`GET /plants/{id}/inverter-ranking`); the order
 * is `ranking.ts`, within each variant only. Three things this panel will not do:
 *
 * - **Estimate a size or a price.** PR and loss need each Inverter's DC size
 *   and the Plant's tariff; where either is missing the cell is "—" with the
 *   reason, and the panel says what to record and where (Guardrail 26).
 * - **Call silence downtime.** No data is its own column (Guardrail 16).
 * - **Show a figure without its coverage.** How much of the period anything
 *   was heard is stated under the table (Guardrail 18): an afternoon of data
 *   reads "100% available" for the afternoon, and must not pass for the day.
 */

import { useMemo, useState } from "react";
import { useInverterRanking } from "@/api/hooks";
import type { InverterRankingQuery } from "@/api/endpoints/plants";
import type { RankedInverterRow } from "@/api/schemas";
import { usePermission } from "@/auth/usePermission";
import { Badge, Button, InfoHint, Panel, SelectBox } from "@/components/ui";
import { ErrorState, SkeletonTable } from "@/components/state";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { IconWarning } from "@/components/icons";
import { formatDateTime, formatTime, toDateTimeInput } from "@/format/datetime";
import {
  UNDEFINED_DISPLAY,
  formatHours,
  formatNumber,
  formatRatioAsPercent,
  formatRupees,
  formatValue,
  implausibleRatioReason,
  ratioIsImplausible,
} from "@/format/value";
import { ReportPeriodPicker } from "@/dashboards/reports/ReportPeriodPicker";
import {
  customRangeEnd,
  customRangeProblem,
  type CustomRange,
} from "@/dashboards/reports/format";
import {
  MEASURES,
  MEASURE_ORDER,
  defaultMeasure,
  rankWithinVariants,
  totals,
  type RankMeasure,
  type RankedGroup,
  type RankedRow,
} from "./ranking";
import { RankingSetupDrawer } from "./RankingSetupDrawer";

/** Mirrors `services/inverter_ranking.MAX_DAYS`; the server enforces it. */
export const MAX_RANKING_DAYS = 31;

const GROUP_LABEL: Record<string, string> = {
  string: "String Inverters",
  central: "Central Inverters",
  unspecified: "Inverters with no variant recorded",
};

/** Below this share of the period heard, the coverage line turns to a warning. */
const COVERAGE_WARN_BELOW = 0.95;

export function InverterRankingPanel({
  plantId,
  plantName,
  timezone,
  plantDcKwp,
  onSelect,
}: {
  plantId: number;
  plantName: string;
  timezone: string;
  /** The Plant's recorded DC capacity — the setup drawer checks sizes against it. */
  plantDcKwp: number | null;
  /** Open one Inverter in full. */
  onSelect: (deviceId: number) => void;
}): JSX.Element {
  const canManage = usePermission("plant.manage");
  const now = toDateTimeInput(Date.now(), timezone);
  const [period, setPeriod] = useState<InverterRankingQuery["period"]>("today");
  const [range, setRange] = useState<CustomRange>({
    fromDate: "",
    fromTime: "00:00",
    toDate: "",
    toTime: "23:59",
  });
  /** Null until chosen: then PR where any Inverter has one, else availability. */
  const [chosen, setChosen] = useState<RankMeasure | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);

  const problem =
    period === "custom" ? customRangeProblem(range, now, MAX_RANKING_DAYS) : null;
  const query: InverterRankingQuery | null =
    problem !== null ? null : period === "custom" ? { period, ...range } : { period };
  const live = period !== "yesterday" && (period !== "custom" || customRangeEnd(range) > now);
  const rankingQuery = useInverterRanking(plantId, query, live);
  const data = rankingQuery.data;
  const rows = useMemo(() => data?.inverters ?? [], [data]);

  const measure: RankMeasure = chosen ?? defaultMeasure(rows);
  const groups = useMemo(() => rankWithinVariants(rows, measure), [rows, measure]);
  const sums = useMemo(() => totals(rows), [rows]);
  const tariff = data?.tariff_inr_per_kwh ?? null;
  const zone = data?.timezone ?? timezone;

  const missingSetup = sums.unsized > 0 || tariff === null;

  return (
    <>
    <Panel
      padding="p-5"
      title={
        <span className="flex items-center gap-2 text-lg">
          Inverter ranking
          <InfoHint text="Every Inverter of this Plant over the chosen period, ranked only against Inverters of the same variant. Downtime is time it stood still while the others generated; time it sent nothing is shown as no data, never as downtime." />
        </span>
      }
      subtitle={
        <span className="text-sm">
          Ranked by {MEASURES[measure].label.toLowerCase()}, then{" "}
          {MEASURES[MEASURES[measure].then].label.toLowerCase()}, within each variant
          {rows.length > 0 ? ` · ${rows.length} Inverter${rows.length === 1 ? "" : "s"}` : ""}
        </span>
      }
      actions={
        canManage ? (
          <Button onClick={() => setSetupOpen(true)} title="Each Inverter's DC size and the Plant's tariff">
            Sizes &amp; tariff
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="field-label mb-2">Period</p>
          <ReportPeriodPicker
            period={period}
            onPeriod={setPeriod}
            range={range}
            onRange={setRange}
            now={now}
            zone={zone}
            problem={problem}
            noteId="inverter-ranking-range"
            subject="ranking"
          />
        </div>
        <div className="lg:shrink-0">
          <SelectBox
            size="sm"
            label="Rank by"
            value={measure}
            onChange={(next) => setChosen(next as RankMeasure)}
            display={MEASURES[measure].label}
          >
            {MEASURE_ORDER.map((code) => (
              <option key={code} value={code}>
                {MEASURES[code].label}
              </option>
            ))}
          </SelectBox>
        </div>
      </div>

      {rankingQuery.isLoading ? (
        <div className="mt-5">
          <SkeletonTable rows={6} columns={7} />
        </div>
      ) : rankingQuery.isError && !data ? (
        <div className="mt-5">
          <ErrorState error={rankingQuery.error} retry={() => void rankingQuery.refetch()} />
        </div>
      ) : data ? (
        <div className={`mt-5 space-y-5 transition-opacity ${rankingQuery.isPlaceholderData ? "opacity-60" : ""}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Generation"
              value={formatValue(sums.generationKwh.value, "kWh")}
              foot={partial(sums.generationKwh.missing, "no register reading")}
            />
            <Stat
              label="Downtime"
              value={formatHours(sums.downtimeHours.value)}
              tone={(sums.downtimeHours.value ?? 0) > 0 ? "warn" : undefined}
              foot={`${sums.stops} stop${sums.stops === 1 ? "" : "s"} while others generated`}
            />
            <Stat
              label="Energy lost"
              value={formatEnergy(sums.lostKwh.value)}
              foot={partial(sums.lostKwh.missing, "not worked out") ?? "During downtime only"}
            />
            <Stat
              label="Loss"
              value={tariff === null ? UNDEFINED_DISPLAY : formatRupees(sums.lossInr.value)}
              foot={
                tariff === null
                  ? "No tariff recorded"
                  : partial(sums.lossInr.missing, "not worked out") ??
                    `At ₹${formatNumber(tariff, { digits: 2 })} per kWh`
              }
            />
          </div>

          {missingSetup ? (
            <SetupCallout
              unsized={sums.unsized}
              total={rows.length}
              tariffMissing={tariff === null}
              canManage={canManage}
              onSetup={() => setSetupOpen(true)}
            />
          ) : null}

          {groups.map((group) => (
            <GroupTable
              key={group.variant}
              group={group}
              measure={measure}
              showHeading={groups.length > 1 || !group.ranked}
              timezone={zone}
              tariffKnown={tariff !== null}
              onSelect={onSelect}
            />
          ))}

          <Coverage
            periodHours={data.coverage.period_hours}
            heardHours={data.coverage.heard_hours}
            generatingHours={data.coverage.generating_hours}
            computedAt={data.computed_at}
            timezone={zone}
          />
          <Method
            producingAboveKw={data.rule.producing_above_kw}
            minStopMinutes={data.rule.min_stop_minutes}
          />
        </div>
      ) : null}
    </Panel>

    {/* Beside the card, never inside it: the drawer is a fixed overlay, and a
        card's own styling can become the box a fixed element is placed in. */}
    {canManage ? (
      <RankingSetupDrawer
        open={setupOpen}
        onClose={() => setSetupOpen(false)}
        plantId={plantId}
        plantName={plantName}
        plantDcKwp={plantDcKwp}
        tariff={tariff}
        inverters={rows}
      />
    ) : null}
    </>
  );
}

/**
 * kWh at a precision the estimate has: none above 100, one decimal below. The
 * magnitude rule gives a zero two decimals — "0.00 kWh" — which claims a
 * precision a stop priced from a neighbour's output does not have.
 */
function formatEnergy(kwh: number | null): string {
  if (kwh === null) return UNDEFINED_DISPLAY;
  return formatValue(kwh, "kWh", { digits: Math.abs(kwh) >= 100 ? 0 : 1 });
}

/** A name worth printing beside the code — not "Inverter 1" under INVERTER_1. */
function distinctName(name: string, code: string): string | null {
  const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return name && plain(name) !== plain(code) ? name : null;
}

function partial(missing: number, why: string): string | undefined {
  return missing > 0 ? `${missing} Inverter${missing === 1 ? "" : "s"} ${why}` : undefined;
}

function Stat({
  label,
  value,
  foot,
  tone,
}: {
  label: string;
  value: string;
  foot?: string;
  tone?: "warn";
}): JSX.Element {
  return (
    <div className="surface-tile rounded-card border border-line px-4 py-3">
      <p className="tile-label">{label}</p>
      <p className={`figure mt-1 text-xl font-semibold ${tone === "warn" ? "text-warn" : "text-ink"}`}>
        {value}
      </p>
      {foot ? <p className="mt-0.5 text-xs text-ink-muted">{foot}</p> : null}
    </div>
  );
}

function SetupCallout({
  unsized,
  total,
  tariffMissing,
  canManage,
  onSetup,
}: {
  unsized: number;
  total: number;
  tariffMissing: boolean;
  canManage: boolean;
  onSetup: () => void;
}): JSX.Element {
  const needs: string[] = [];
  if (unsized > 0) {
    needs.push(
      unsized === total
        ? "each Inverter's DC size (none is recorded)"
        : `the DC size of ${unsized} of ${total} Inverters`,
    );
  }
  if (tariffMissing) needs.push("this Plant's tariff");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface-sunken/70 px-4 py-3">
      <p className="min-w-0 text-sm text-ink-muted">
        <span className="font-medium text-ink">PR and loss need {needs.join(" and ")}.</span>{" "}
        They are never estimated, so until then those cells read "—".
        {canManage ? "" : " An administrator records them under Tag Mapping and the Plant's settings."}
      </p>
      {canManage ? (
        <Button variant="primary" onClick={onSetup}>
          Record them
        </Button>
      ) : null}
    </div>
  );
}

/** A thin bar beside the ranked measure: the group's largest is full width. */
function MeasureBar({ value, max }: { value: number | null; max: number }): JSX.Element | null {
  if (value === null || max <= 0) return null;
  const share = Math.max(0, Math.min(1, value / max));
  return (
    <span aria-hidden="true" className="ml-auto mt-1 block h-1 w-20 overflow-hidden rounded-full bg-surface-sunken">
      <span className="block h-full rounded-full bg-chart" style={{ width: `${share * 100}%` }} />
    </span>
  );
}

function Cell({
  text,
  title,
  tone,
  sub,
  bar,
}: {
  text: string;
  title?: string;
  tone?: "warn" | "muted";
  sub?: string;
  bar?: JSX.Element | null;
}): JSX.Element {
  const colour = tone === "warn" ? "text-warn" : tone === "muted" ? "text-ink-muted" : "text-ink";
  return (
    <span className="inline-flex flex-col items-end" title={title}>
      <span className={colour}>{text}</span>
      {sub ? <span className="font-sans text-[11px] text-ink-faint">{sub}</span> : null}
      {bar}
    </span>
  );
}

function stopsTitle(row: RankedInverterRow, timezone: string): string | undefined {
  if (row.stops.length === 0) return undefined;
  const lines = row.stops.map((stop) => {
    const end = stop.ongoing ? "still stopped at the period's end" : formatTime(stop.end, timezone).slice(0, 5);
    const lost = stop.lost_kwh === null ? "" : `, ${formatValue(stop.lost_kwh, "kWh")} lost`;
    return `${formatDateTime(stop.start, timezone).slice(0, 16)} to ${end} (${stop.minutes} min${lost})`;
  });
  const more = row.stop_count > row.stops.length ? `\n…and ${row.stop_count - row.stops.length} earlier` : "";
  return `Stops while the other Inverters were generating:\n${lines.join("\n")}${more}`;
}

function GroupTable({
  group,
  measure,
  showHeading,
  timezone,
  tariffKnown,
  onSelect,
}: {
  group: RankedGroup;
  measure: RankMeasure;
  showHeading: boolean;
  timezone: string;
  tariffKnown: boolean;
  onSelect: (deviceId: number) => void;
}): JSX.Element {
  const spec = MEASURES[measure];
  const max = Math.max(0, ...group.rows.map((entry) => spec.value(entry.row) ?? 0));
  const barFor = (key: RankMeasure, row: RankedInverterRow) =>
    key === measure ? <MeasureBar value={spec.value(row)} max={max} /> : null;

  const columns: Column<RankedRow>[] = [
    {
      key: "inverter",
      header: "Inverter",
      width: "220px",
      render: ({ row, rank }) => (
        <span className="flex items-center gap-2.5">
          <RankChip rank={rank} ranked={group.ranked} reason={spec.value(row) === null ? reasonFor(measure, row) : null} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-ink">{row.code}</span>
            <span className="block truncate text-[11px] text-ink-muted">
              {row.dc_capacity_kwp !== null
                ? `${formatNumber(row.dc_capacity_kwp, { digits: 0 })} kWp`
                : "DC size not recorded"}
              {distinctName(row.name, row.code) ? ` · ${row.name}` : ""}
            </span>
          </span>
        </span>
      ),
      sortValue: ({ rank }) => rank,
      filterValue: ({ row }) => `${row.code} ${row.name}`,
    },
    {
      key: "generation",
      header: "Generation",
      align: "right",
      render: ({ row }) => (
        <Cell
          text={formatValue(row.generation_kwh, "kWh")}
          title={
            row.generation_kwh === null
              ? `Not worked out: ${row.generation_reason ?? "no reading"}.`
              : row.refused_steps > 0
                ? `${row.refused_steps} step(s) of its energy register were refused as generation, so this is short.`
                : "From its own lifetime energy register, counted as the Inverter Report counts it."
          }
          tone={row.refused_steps > 0 ? "warn" : undefined}
          sub={row.refused_steps > 0 ? `${row.refused_steps} reading${row.refused_steps === 1 ? "" : "s"} refused` : undefined}
          bar={barFor("generation", row)}
        />
      ),
      sortValue: ({ row }) => row.generation_kwh,
    },
    {
      key: "availability",
      header: "Availability",
      align: "right",
      render: ({ row }) => (
        <Cell
          text={formatRatioAsPercent(row.availability.value)}
          title={
            row.availability.value === null
              ? `Not worked out: ${row.availability.undefined_reason}.`
              : `Over ${formatHours(row.generating_hours)} while the other Inverters were generating` +
                (row.planned_hours > 0 ? `; ${formatHours(row.planned_hours)} of planned work set aside` : "") +
                ". Stops shorter than the rule's minimum count as available."
          }
          bar={barFor("availability", row)}
        />
      ),
      sortValue: ({ row }) => row.availability.value,
    },
    {
      key: "pr",
      header: "PR",
      align: "right",
      render: ({ row }) => {
        const value = row.performance_ratio.value;
        const implausible = ratioIsImplausible(value);
        return (
          <Cell
            text={formatRatioAsPercent(value)}
            tone={implausible ? "warn" : undefined}
            title={
              value === null
                ? `Not worked out: ${row.performance_ratio.undefined_reason}.`
                : implausible
                  ? implausibleRatioReason(value, "This PR")
                  : "Its energy over the Plant's irradiation and its own DC size — the Plant PR's rule, per Inverter. Not temperature-corrected."
            }
            bar={barFor("pr", row)}
          />
        );
      },
      sortValue: ({ row }) => row.performance_ratio.value,
    },
    {
      key: "downtime",
      header: "Downtime",
      align: "right",
      render: ({ row }) => (
        <Cell
          text={formatHours(row.downtime_hours)}
          tone={(row.downtime_hours ?? 0) > 0 ? "warn" : undefined}
          sub={row.stop_count > 0 ? `${row.stop_count} stop${row.stop_count === 1 ? "" : "s"}` : undefined}
          title={
            row.downtime_hours === null
              ? `Not worked out: ${row.availability.undefined_reason}.`
              : stopsTitle(row, timezone) ?? "It did not stand still while the other Inverters were generating."
          }
          bar={barFor("downtime", row)}
        />
      ),
      sortValue: ({ row }) => row.downtime_hours,
    },
    {
      key: "nodata",
      header: "No data",
      align: "right",
      render: ({ row }) => (
        <Cell
          text={formatHours(row.no_data_hours)}
          tone="muted"
          title="Time it sent nothing while the other Inverters were generating. A communication gap, never counted as downtime — silence does not show the machine stopped."
        />
      ),
      sortValue: ({ row }) => row.no_data_hours,
    },
    {
      key: "loss",
      header: "Loss",
      align: "right",
      render: ({ row }) => {
        const kwh = row.lost_kwh.value;
        if (kwh === null) {
          return <Cell text={UNDEFINED_DISPLAY} tone="muted" title={`Not worked out: ${row.lost_kwh.undefined_reason}.`} />;
        }
        const inr = row.loss_inr.value;
        return (
          <Cell
            text={tariffKnown && inr !== null ? formatRupees(inr) : formatEnergy(kwh)}
            sub={tariffKnown && inr !== null ? formatEnergy(kwh) : "no tariff recorded"}
            tone={kwh > 0 ? "warn" : undefined}
            title="Energy lost while it stood still: in each down minute, what the typical generating neighbour made per kWp, times this Inverter's DC size — priced at the Plant's tariff."
            bar={barFor("loss", row)}
          />
        );
      },
      sortValue: ({ row }) => row.lost_kwh.value,
    },
  ];

  return (
    <section className="min-w-0">
      {showHeading ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">
            {GROUP_LABEL[group.variant] ?? `Inverters — ${group.variant}`}
          </h3>
          <Badge tone={group.ranked ? "accent" : "warn"}>{group.variant}</Badge>
          <span className="text-xs text-ink-muted">
            {group.ranked
              ? "Ranked among themselves only."
              : "Ordered, not ranked: set each one's Model to String or Central under Tag Mapping to rank it."}
          </span>
        </div>
      ) : null}
      <DataTable
        rows={group.rows}
        columns={columns}
        rowKey={({ row }) => row.device_id}
        filterPlaceholder="Filter Inverters…"
        onRowClick={({ row }) => onSelect(row.device_id)}
        minColumnWidth={112}
        maxHeight={640}
      />
    </section>
  );
}

function reasonFor(measure: RankMeasure, row: RankedInverterRow): string {
  switch (measure) {
    case "pr":
      return row.performance_ratio.undefined_reason ?? "no PR";
    case "availability":
    case "downtime":
      return row.availability.undefined_reason ?? "not judged";
    case "loss":
      return row.lost_kwh.undefined_reason ?? "not worked out";
    case "generation":
      return row.generation_reason ?? "no reading";
  }
}

function RankChip({
  rank,
  ranked,
  reason,
}: {
  rank: number | null;
  ranked: boolean;
  reason: string | null;
}): JSX.Element {
  const base =
    "inline-flex h-6 min-w-[1.75rem] shrink-0 items-center justify-center rounded-control border px-1.5 font-mono text-xs font-semibold";
  if (rank === null) {
    return (
      <span
        className={`${base} border-dashed border-line text-ink-faint`}
        title={
          !ranked
            ? "Not ranked: no Inverter variant is recorded on this Device Model."
            : `Not ranked: ${reason ?? "no figure for this measure"}.`
        }
      >
        –
      </span>
    );
  }
  return (
    <span className={`${base} border-line bg-surface-sunken text-ink`} title={`Rank ${rank} in this group`}>
      {rank}
    </span>
  );
}

function Coverage({
  periodHours,
  heardHours,
  generatingHours,
  computedAt,
  timezone,
}: {
  periodHours: number;
  heardHours: number;
  generatingHours: number;
  computedAt: string;
  timezone: string;
}): JSX.Element {
  const share = periodHours > 0 ? heardHours / periodHours : 1;
  const short = share < COVERAGE_WARN_BELOW;
  return (
    <div
      className={`flex flex-wrap items-start gap-2 rounded-card border px-4 py-3 text-xs ${
        short ? "border-warn/40 bg-warn/5 text-ink" : "border-line text-ink-muted"
      }`}
    >
      {short ? <IconWarning size={15} className="mt-px shrink-0 text-warn" /> : null}
      <p className="min-w-0 flex-1 leading-relaxed">
        Inverters were heard for{" "}
        <span className="figure font-semibold text-ink">{formatHours(heardHours)}</span> of the{" "}
        <span className="figure">{formatHours(periodHours)}</span> so far in this period
        {short ? ` (${formatRatioAsPercent(share, 0)})` : ""}, and generating for{" "}
        <span className="figure font-semibold text-ink">{formatHours(generatingHours)}</span>.{" "}
        {short
          ? "Readings are missing for the rest, so every figure above covers only what was heard — a gap the whole Plant shared is nobody's downtime and nobody's no-data time."
          : "Availability and downtime are judged only while the other Inverters were generating."}
      </p>
      <span className="shrink-0 text-ink-faint" title="Worked out on the server, and kept for up to a minute.">
        Worked out at {formatTime(computedAt, timezone).slice(0, 5)}
      </span>
    </div>
  );
}

function Method({
  producingAboveKw,
  minStopMinutes,
}: {
  producingAboveKw: number;
  minStopMinutes: number;
}): JSX.Element {
  return (
    <details className="group text-xs text-ink-muted">
      <summary className="cursor-pointer list-none font-medium hover:text-ink">
        How these figures are worked out <span className="text-ink-faint">· proposed, pending the client&apos;s definitions</span>
      </summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 leading-relaxed">
        <li>
          <span className="text-ink">Downtime</span>: minutes it was reporting at or below{" "}
          {formatNumber(producingAboveKw, { digits: 1 })} kW while more than half of the other reporting Inverters
          were above it, in stops of at least {minStopMinutes} minutes. Shorter stops count as available —
          Inverters wake a few minutes apart.
        </li>
        <li>
          <span className="text-ink">No data</span>: minutes it sent nothing while the others generated. Never
          downtime: silence does not show the machine stopped.
        </li>
        <li>
          <span className="text-ink">Availability</span>: the share of those generating minutes, with data, that
          were not downtime. Planned maintenance is set aside.
        </li>
        <li>
          <span className="text-ink">Energy lost</span>: during downtime only, the typical generating
          neighbour&apos;s output per kWp times this Inverter&apos;s DC size. <span className="text-ink">Loss</span>{" "}
          prices it at the Plant&apos;s tariff.
        </li>
        <li>
          <span className="text-ink">Generation</span> and <span className="text-ink">PR</span>: each
          Inverter&apos;s own energy register, as the Inverter Report counts it, over the Plant&apos;s irradiation
          and its own DC size. Not temperature-corrected.
        </li>
      </ul>
    </details>
  );
}
