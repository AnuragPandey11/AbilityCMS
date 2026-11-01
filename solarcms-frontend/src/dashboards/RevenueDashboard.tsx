/**
 * `revenue` — what a Plant's exported energy earned (the client's requirement
 * sheet, 1 Nov 2026; ⚠ every rule PROPOSED — `services/revenue.py`).
 *
 * Three periods side by side — today, this month, this financial year (April
 * to March) — each with energy generated, exported and imported, revenue,
 * expected revenue and revenue lost to Inverter downtime; the trend by day,
 * month or financial year; and every Plant side by side.
 *
 * ── What every figure carries ───────────────────────────────────────────────
 * - **Its basis.** Revenue is export × tariff, and export is the ABT Meter's —
 *   the settlement instrument — or, on a Plant without one, the MFM's. The
 *   second is an *estimate*, and the screen says so beside the figures and on
 *   every Plant row (the user's choice; I-11 keeps Financial Reports on the ABT
 *   Meter alone).
 * - **A reason, never ₹0.** No tariff recorded, or no register read twice, is
 *   "—" with the reason (§4.3): a Plant that earned nothing and one nobody can
 *   price mean opposite things.
 * - **kWh, never rescaled** to MWh — `formatHeadline` compacts the numeral
 *   above a million instead (§4.1).
 */

import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { useFleetRevenue, usePlantRevenue, useRevenueTrend } from "@/api/hooks";
import type {
  FleetRevenueRow,
  RevenueGranularity,
  RevenuePeriod,
  RevenuePeriodCode,
  RevenueSource,
} from "@/api/endpoints/revenue";
import { Badge, Panel, SegmentedControl } from "@/components/ui";
import { EmptyState, ErrorState, Skeleton, SkeletonChart } from "@/components/state";
import { PlantPicker } from "@/components/domain";
import { PageLink } from "@/components/layout/PageLink";
import {
  IconCalendar,
  IconEnergy,
  IconRevenue,
  IconWarning,
  type IconProps,
} from "@/components/icons";
import { iconWell } from "@/components/icons/wells";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { UNDEFINED_DISPLAY, formatHeadline, formatNumber, formatRupees } from "@/format/value";
import { formatDateTime } from "@/format/datetime";
import { RevenueBars, type RevenueMeasure } from "./revenue/RevenueBars";

const PERIOD_TITLES: Record<RevenuePeriodCode, string> = {
  today: "Daily Revenue",
  month: "Monthly Revenue",
  year: "Yearly Revenue",
};

const GRANULARITY_OPTIONS: { value: RevenueGranularity; label: string; hint: string }[] = [
  { value: "day", label: "Daily", hint: "The last 30 Plant days." },
  { value: "month", label: "Monthly", hint: "The last 12 months." },
  { value: "year", label: "Yearly", hint: "Financial years, April to March." },
];

const FLEET_PERIODS: { value: RevenuePeriodCode; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "month", label: "This month" },
  { value: "year", label: "This FY" },
];

function kwh(value: number | null | undefined): string {
  if (value === null || value === undefined) return UNDEFINED_DISPLAY;
  const headline = formatHeadline(value, { digits: Math.abs(value) < 100 ? 1 : 0 });
  return `${headline.text} kWh`;
}

/** The basis in words, as a chip: settlement, or an estimate from the MFM. */
function BasisBadge({ source }: { source: RevenueSource }): JSX.Element | null {
  if (source.basis === null) return null;
  return source.basis === "settlement" ? (
    <Badge tone="neutral">
      <span title={source.words ?? undefined}>Settlement · ABT Meter</span>
    </Badge>
  ) : (
    <Badge tone="warn">
      <span title={source.words ?? undefined}>Estimate · MFM, not the settlement meter</span>
    </Badge>
  );
}

function Row({
  label,
  value,
  note,
  tone = "ink",
}: {
  label: string;
  value: string;
  note?: ReactNode;
  tone?: "ink" | "warn" | "faint";
}): JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] text-ink-muted">{label}</div>
        {note ? <div className="text-[11px] leading-snug text-ink-faint">{note}</div> : null}
      </div>
      <div
        className={`figure shrink-0 text-sm font-semibold tabular-nums ${
          tone === "warn" ? "text-warn" : tone === "faint" ? "text-ink-faint" : "text-ink"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function Tile({
  icon: Icon,
  label,
  children,
}: {
  icon: ComponentType<IconProps>;
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="surface-card flex min-w-0 flex-col rounded-card border border-line p-4">
      <div className="flex min-h-7 items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control ${iconWell(Icon)}`}>
          <Icon size={15} />
        </span>
        <span className="tile-label min-w-0">{label}</span>
      </div>
      {children}
    </div>
  );
}

function PeriodCard({ code, period }: { code: RevenuePeriodCode; period: RevenuePeriod }): JSX.Element {
  const expected = period.expected;
  const loss = period.loss;
  const revenue = period.revenue_inr;
  return (
    <Tile icon={IconRevenue} label={PERIOD_TITLES[code]}>
      <div className="mt-3 flex items-baseline justify-between gap-2">
        <span
          className={`figure text-[1.9rem] font-semibold leading-none tracking-tight ${
            revenue === null ? "text-ink-faint" : "text-ink"
          }`}
          title={revenue === null ? period.revenue_reason ?? undefined : undefined}
        >
          {formatRupees(revenue)}
        </span>
        <span className="text-xs font-medium text-ink-muted">{period.label}</span>
      </div>
      <p className="mt-1 min-h-4 text-[11px] leading-snug text-ink-faint">
        {revenue === null
          ? sentence(period.revenue_reason)
          : period.source.basis === "estimate"
            ? "Estimate — from the MFM's export"
            : "Exported energy × tariff"}
      </p>
      <div className="mt-2">
        <Row label="Total Energy Generated" value={kwh(period.generated_kwh)}
          note={period.source.generation_device_type_code && period.source.generation_device_type_code !== "INVERTER"
            ? "No Inverter register — the meter's export" : undefined} />
        <Row label="Energy Exported" value={kwh(period.exported_kwh)} />
        <Row label="Energy Imported" value={kwh(period.imported_kwh)} />
        <Row
          label="Expected Revenue"
          value={formatRupees(expected.revenue_inr)}
          tone={expected.revenue_inr === null ? "faint" : "ink"}
          note={
            expected.revenue_inr === null
              ? sentence(expected.reason)
              : code === "today"
                ? "So far, plus the forecast for the rest of today"
                : `So far, plus ${expected.days_carried} more typical day${expected.days_carried === 1 ? "" : "s"}`
          }
        />
        <Row
          label="Revenue Loss"
          value={loss.value === null ? UNDEFINED_DISPLAY : `${loss.floor ? "≥ " : ""}${formatRupees(loss.value)}`}
          tone={loss.value === null ? "faint" : loss.value > 0 ? "warn" : "ink"}
          note={
            loss.value === null
              ? sentence(loss.reason)
              : loss.floor
                ? `Inverter downtime · ${loss.missing.join(", ")} down with no AC rating`
                : `Inverter downtime${
                    loss.downtime_hours ? ` · ${formatNumber(loss.downtime_hours, { digits: 1 })} h` : ""
                  }`
          }
        />
      </div>
      {period.refused_steps > 0 ? (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-warn">
          <IconWarning size={12} /> {period.refused_steps} counter step(s) refused — figures may be low
        </p>
      ) : null}
    </Tile>
  );
}

function sentence(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

/** Plants by revenue; a Plant with no figure is listed, never ranked (Guardrail 30). */
function FleetTable({ rows, period }: { rows: FleetRevenueRow[]; period: RevenuePeriodCode }): JSX.Element {
  const priced = rows.filter((row) => row.revenue_inr !== null).sort((a, b) => (b.revenue_inr ?? 0) - (a.revenue_inr ?? 0));
  const unpriced = rows.filter((row) => row.revenue_inr === null);
  const top = Math.max(0, ...priced.map((row) => row.revenue_inr ?? 0));
  const total = priced.reduce((sum, row) => sum + (row.revenue_inr ?? 0), 0);
  const head = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-faint";
  const cell = "px-3 py-2 align-middle";
  const line = (row: FleetRevenueRow, rank: number | null) => (
    <tr key={row.plant_id} className="border-t border-line-soft">
      <td className={`${cell} w-8 text-xs text-ink-faint`}>{rank ?? ""}</td>
      <td className={cell}>
        <div className="text-sm font-medium text-ink">{row.name}</div>
        <div className="text-[11px] text-ink-faint">
          <span className="font-mono">{row.code}</span>
          {row.client_name ? ` · ${row.client_name}` : ""}
        </div>
      </td>
      <td className={`${cell} figure text-right text-sm tabular-nums text-ink`}>{kwh(row.exported_kwh)}</td>
      <td className={`${cell} figure text-right text-sm tabular-nums text-ink-muted`}>
        {row.tariff_inr_per_kwh === null ? UNDEFINED_DISPLAY : `₹${formatNumber(row.tariff_inr_per_kwh, { digits: 2 })}`}
      </td>
      <td className={`${cell} w-[34%]`}>
        {row.revenue_inr === null ? (
          <span className="text-xs text-ink-faint">{sentence(row.revenue_reason)}</span>
        ) : (
          <div className="flex items-center gap-2">
            <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-line">
              <div
                className="h-full rounded bg-chart"
                style={{ width: `${top > 0 ? (row.revenue_inr / top) * 100 : 0}%` }}
              />
            </div>
            <span className="figure w-24 shrink-0 text-right text-sm font-semibold tabular-nums text-ink">
              {formatRupees(row.revenue_inr)}
            </span>
          </div>
        )}
      </td>
      <td className={`${cell} text-right`}>
        <BasisBadge source={row.source} />
      </td>
    </tr>
  );
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px]">
        <thead>
          <tr>
            <th className={head} />
            <th className={head}>Plant</th>
            <th className={`${head} text-right`}>Exported</th>
            <th className={`${head} text-right`}>Tariff / kWh</th>
            <th className={`${head} text-right`}>Revenue</th>
            <th className={`${head} text-right`}>Basis</th>
          </tr>
        </thead>
        <tbody>
          {priced.map((row, index) => line(row, index + 1))}
          {unpriced.map((row) => line(row, null))}
        </tbody>
      </table>
      <p className="mt-2 px-3 text-[11px] leading-snug text-ink-faint">
        {priced.length > 0
          ? `${formatRupees(total)} across ${priced.length} Plant${priced.length === 1 ? "" : "s"} ${
              period === "today" ? "today" : period === "month" ? "this month" : "this financial year"
            }.`
          : "No Plant has a revenue figure for this period."}
        {unpriced.length > 0
          ? ` ${unpriced.length} Plant${unpriced.length === 1 ? " is" : "s are"} listed without a rank: no figure, never ₹0.`
          : ""}
      </p>
    </div>
  );
}

export function RevenueDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const summary = usePlantRevenue(plantId);
  const [granularity, setGranularity] = useState<RevenueGranularity>("day");
  const trend = useRevenueTrend(plantId, granularity);
  const [fleetPeriod, setFleetPeriod] = useState<RevenuePeriodCode>("month");
  const fleet = useFleetRevenue(fleetPeriod);

  const tariff = summary.data?.tariff_inr_per_kwh ?? null;
  // Revenue cannot be drawn without a tariff; export can.
  const [chosenMeasure, setMeasure] = useState<RevenueMeasure>("revenue");
  const measure: RevenueMeasure = tariff === null ? "exported" : chosenMeasure;
  const points = useMemo(() => trend.data?.points ?? [], [trend.data]);
  const source = summary.data?.periods.year.source ?? null;

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Revenue</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Exported energy × the Plant's tariff — today, this month and this financial year (April to March).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
          <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" size="lg" />
        </div>
      </header>

      {/* What every figure below stands on: the tariff and the meter. */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {summary.data ? (
          tariff === null ? (
            <span className="inline-flex flex-wrap items-center gap-2 text-warn">
              <IconWarning size={14} /> No tariff is recorded for this Plant, so no revenue can be worked out.
              <PageLink page="admin_plant_setup" to="/admin/plant-setup" className="font-semibold underline">
                Record it under Plants &amp; Devices
              </PageLink>
            </span>
          ) : (
            <span className="text-ink-muted">
              Tariff <span className="figure font-semibold text-ink">₹{formatNumber(tariff, { digits: 2 })}</span> per kWh
            </span>
          )
        ) : null}
        {source ? <BasisBadge source={source} /> : null}
        {summary.data ? (
          <span className="text-xs text-ink-faint" title={Object.values(summary.data.rule).join(" ")}>
            Worked out {formatDateTime(summary.data.computed_at, summary.data.timezone)} · provisional
          </span>
        ) : null}
      </div>

      {summary.isError ? (
        <ErrorState error={summary.error} retry={() => void summary.refetch()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {summary.data
            ? (["today", "month", "year"] as const).map((code) => (
                <PeriodCard key={code} code={code} period={summary.data.periods[code]} />
              ))
            : Array.from({ length: 3 }, (_, index) => (
                <Skeleton key={index} className="rounded-card" style={{ minHeight: 330 }} />
              ))}
        </div>
      )}

      <Panel
        title={
          <span className="inline-flex items-center gap-2 text-base">
            <IconCalendar size={16} /> Revenue Trend
          </span>
        }
        subtitle={
          measure === "revenue"
            ? "Revenue per period, at today's tariff. A lighter bar is a period still under way; a missing bar is a period nothing was read in, never ₹0."
            : tariff === null
              ? "Exported energy per period. Revenue needs a tariff, and none is recorded."
              : "Exported energy per period. A missing bar is a period nothing was read in, never zero."
        }
        actions={
          <>
            <SegmentedControl<RevenueMeasure>
              label="Measure"
              value={measure}
              onChange={setMeasure}
              options={[
                {
                  value: "revenue",
                  label: "₹ Revenue",
                  hint: tariff === null ? "No tariff is recorded for this Plant." : "Exported energy × tariff.",
                },
                { value: "exported", label: "kWh Exported", hint: "What the meter exported." },
              ]}
            />
            <SegmentedControl<RevenueGranularity>
              label="Trend granularity"
              value={granularity}
              onChange={setGranularity}
              options={GRANULARITY_OPTIONS}
            />
          </>
        }
        padding="p-4"
      >
        {trend.isError ? (
          <ErrorState error={trend.error} retry={() => void trend.refetch()} />
        ) : trend.data ? (
          <>
            <RevenueBars key={`${granularity}-${measure}`} points={points} measure={measure} />
            {trend.data.notes.length > 0 ? (
              <ul className="mt-2 space-y-0.5 text-[11px] leading-snug text-ink-faint">
                {trend.data.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <SkeletonChart height={300} />
        )}
      </Panel>

      <Panel
        title={
          <span className="inline-flex items-center gap-2 text-base">
            <IconEnergy size={16} /> Plant-wise Revenue
          </span>
        }
        subtitle="Every active Plant you can see, by revenue. An estimate from an MFM is marked as one."
        actions={
          <SegmentedControl<RevenuePeriodCode>
            label="Plant-wise period"
            value={fleetPeriod}
            onChange={setFleetPeriod}
            options={FLEET_PERIODS}
          />
        }
        padding="py-2"
      >
        {fleet.isError ? (
          <ErrorState error={fleet.error} retry={() => void fleet.refetch()} />
        ) : fleet.data ? (
          <FleetTable rows={fleet.data.plants} period={fleetPeriod} />
        ) : (
          <div className="p-4">
            <Skeleton className="h-40 rounded-card" />
          </div>
        )}
      </Panel>
    </div>
  );
}
