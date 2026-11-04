/**
 * `performance_history` — a Plant's days over any period up to a year: which
 * were good, which were not, and why, at a glance.
 *
 * A line chart of a year of hourly points answers "what was the trend" and
 * hides "which days were bad". This screen is built for the second question:
 *
 * 1. **Figures for the period** — energy, specific yield, PR, irradiation,
 *    peak and days measured, each against the comparison period where one is
 *    chosen, PR always beside the share of the energy it stood on.
 * 2. **The calendar** — every day shaded by the figure chosen, with what was
 *    not measured, partly measured or impossible drawn as shape, never as a
 *    shade of the scale (`history/CalendarHeatmap`). The best and worst whole
 *    days are named; what could not be ranked is counted (Guardrail 30).
 * 3. **Day by day, or month by month** — the same figure as bars, or against
 *    the previous period or the same dates last year as two lines on one axis.
 * 4. **The months** — the Monthly Plant Report's own rows (the server builds
 *    them with its code), so a downloaded Report always agrees.
 *
 * Any day opens in a drawer (`history/DayDetail`): its figures, its power
 * under the sunlight, its Alarms — and from there Energy Analytics for that
 * day, zoomable to the minute.
 *
 * The period is the history screens' shared one (`useHistoryPeriod`), so March
 * chosen here is March on Energy Analytics and the equipment screens too.
 *
 * ⚠ No money here: revenue is for those given the Revenue tab. ⚠ No Plant
 * availability: it is folded minute by minute and a year of it would not
 * answer while the reader waits — Single Plant and Reports have it.
 */

import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { usePlant } from "@/api/hooks";
import type { HistoryDay, PlantHistory } from "@/api/endpoints/history";
import {
  COMPARE_MODES,
  comparisonPeriod,
  periodDates,
  periodLabel,
  periodToParams,
  resolvePeriod,
  daysPeriod,
  type CompareMode,
} from "@/api/historyPeriod";
import { usePlantHistory } from "@/api/useHistory";
import type { TrendPoint } from "@/api/useSlotTrend";
import { useDashboard } from "@/auth/useDashboard";
import { usePermission } from "@/auth/usePermission";
import { Badge, Button, Drawer, InfoHint, Panel, SegmentedControl, SelectBox } from "@/components/ui";
import { EmptyState, ErrorState, Skeleton, SkeletonChart } from "@/components/state";
import { PlantPicker } from "@/components/domain";
import { HistoryPeriodBar } from "@/components/history/HistoryPeriodBar";
import { TrendChart } from "@/components/charts/TrendChart";
import { OverlayTrendChart } from "@/components/charts/OverlayTrendChart";
import { downloadCsv, exportStem, rowsCsv } from "@/components/charts/csv";
import {
  IconCalendar,
  IconEnergy,
  IconGauge,
  IconIrradiance,
  IconPower,
  IconCapacity,
  IconExport,
  type IconProps,
} from "@/components/icons";
import { iconWell } from "@/components/icons/wells";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { useHistoryPeriod } from "@/state/useHistoryPeriod";
import { fromDateTimeInput } from "@/format/datetime";
import { formatHeadline, formatNumber } from "@/format/value";
import { CalendarHeatmap } from "./history/CalendarHeatmap";
import { DayDetail } from "./history/DayDetail";
import {
  METRICS,
  alignByIndex,
  bestAndWorst,
  change,
  displayDate,
  displayMonth,
  metricOf,
  rankable,
  unattributedEnergy,
  valueOf,
  type MetricKey,
} from "./history/metrics";

/** The server's limit, as the Reports have it (`domain/periods.MAX_REPORT_DAYS`). */
const MAX_DAYS = 366;
/** Past this many days the chart defaults to months: 366 bars are a texture, not a reading. */
const MONTHS_BY_DEFAULT_ABOVE = 92;

type Granularity = "day" | "month";

function Tile({
  icon: Icon,
  label,
  value,
  unit,
  note,
  tone = "ink",
  hint,
}: {
  icon: (props: IconProps) => JSX.Element;
  label: string;
  value: string;
  unit?: string | null;
  note?: string | null;
  tone?: "ink" | "faint" | "warn";
  hint?: string;
}): JSX.Element {
  return (
    <div className="surface-card flex min-w-0 flex-col rounded-card border border-line p-4">
      <div className="flex min-h-7 items-center gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-control ${iconWell(Icon)}`}>
          <Icon size={15} />
        </span>
        <span className="tile-label min-w-0 truncate">{label}</span>
        {hint ? <InfoHint text={hint} /> : null}
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span
          className={`figure text-[1.6rem] font-semibold leading-none tracking-tight ${
            tone === "faint" ? "text-ink-faint" : tone === "warn" ? "text-warn" : "text-ink"
          }`}
        >
          {value}
        </span>
        {unit && tone !== "faint" ? <span className="text-xs font-medium text-ink-muted">{unit}</span> : null}
      </div>
      <p className="mt-1.5 min-h-4 text-[11px] leading-snug text-ink-faint">{note}</p>
    </div>
  );
}

/** "+5.2% vs previous period", "−3.1 points vs last year" — or null. */
function changeNote(
  current: number | null,
  previous: number | null,
  unit: string,
  against: string | null,
): string | null {
  if (!against) return null;
  const delta = change(current, previous, unit);
  if (!delta) return previous === null ? `${against}: not measured` : null;
  const sign = delta.value > 0 ? "+" : delta.value < 0 ? "−" : "±";
  const magnitude = Math.abs(delta.value);
  return delta.kind === "points"
    ? `${sign}${formatNumber(magnitude, { digits: 1 })} points vs ${against}`
    : `${sign}${formatNumber(magnitude * 100, { digits: 1 })}% vs ${against}`;
}

/** A day's or month's date as an instant on the Plant's clock, for the chart's time axis. */
function instantOf(date: string, timezone: string): string {
  const ms = fromDateTimeInput(`${date.length === 7 ? `${date}-01` : date}T00:00`, timezone);
  return new Date(ms).toISOString();
}

function Summary({
  history,
  compare,
  compareLabel,
}: {
  history: PlantHistory;
  compare: PlantHistory | null;
  compareLabel: string | null;
}): JSX.Element {
  const totals = history.totals;
  const other = compare?.totals ?? null;
  const energy = formatHeadline(totals.energy_kwh);
  const unattributed = unattributedEnergy(totals.energy_kwh, history.days);
  const prShare = totals.pr_energy_share;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
      <Tile
        icon={IconEnergy}
        label="Energy"
        value={energy.text}
        unit={totals.energy_kwh === null ? null : "kWh"}
        tone={totals.energy_kwh === null ? "faint" : "ink"}
        note={
          [
            changeNote(totals.energy_kwh, other?.energy_kwh ?? null, "kWh", compareLabel),
            unattributed !== null
              ? `${formatNumber(unattributed, { digits: 0 })} kWh of it accrued across a gap and belongs to no single day`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") ||
          (totals.energy_kwh === null ? "No energy register was read twice in the period." : history.energy_label)
        }
      />
      <Tile
        icon={IconCapacity}
        label="Specific yield"
        value={formatNumber(totals.specific_yield, { digits: 2 })}
        unit="kWh/kWp"
        tone={totals.specific_yield === null ? "faint" : "ink"}
        note={
          changeNote(totals.specific_yield, other?.specific_yield ?? null, "kWh/kWp", compareLabel) ??
          (history.dc_capacity_kwp ? `Over ${formatNumber(history.dc_capacity_kwp, { digits: 0 })} kWp DC` : "No DC capacity on record")
        }
      />
      <Tile
        icon={IconGauge}
        label="PR"
        value={formatNumber(totals.performance_ratio, { digits: 1 })}
        unit="%"
        tone={totals.performance_ratio === null ? "faint" : totals.performance_ratio_flagged ? "warn" : "ink"}
        hint="Pooled over every 15-minute period of the whole stretch in which both the energy and the sunlight were measured — not a mean of the days. Provisional pending the client's formula (OPEN-16)."
        note={
          totals.performance_ratio_flagged
            ? "Outside what PR can physically be — see the notes below."
            : [
                changeNote(totals.performance_ratio, other?.performance_ratio ?? null, "%", compareLabel),
                prShare !== null && prShare < 0.995 ? `from ${formatNumber(prShare * 100, { digits: 0 })}% of the energy` : null,
              ]
                .filter(Boolean)
                .join(" · ") || null
        }
      />
      <Tile
        icon={IconIrradiance}
        label="Irradiation"
        value={formatNumber(totals.irradiation_kwh_m2, { digits: 1 })}
        unit="kWh/m²"
        tone={totals.irradiation_kwh_m2 === null ? "faint" : "ink"}
        note={
          changeNote(totals.irradiation_kwh_m2, other?.irradiation_kwh_m2 ?? null, "kWh/m²", compareLabel) ??
          "GHI, the stations measuring"
        }
      />
      <Tile
        icon={IconPower}
        label="Peak power"
        value={formatNumber(totals.peak_power_kw, { digits: 1 })}
        unit="kW"
        tone={totals.peak_power_kw === null ? "faint" : "ink"}
        note={changeNote(totals.peak_power_kw, other?.peak_power_kw ?? null, "kW", compareLabel) ?? "Highest 15-minute average"}
      />
      <Tile
        icon={IconCalendar}
        label="Days measured"
        value={`${totals.days_with_energy}`}
        unit={`of ${totals.days}`}
        tone={totals.days_with_energy === 0 ? "faint" : "ink"}
        note={
          totals.days_with_energy < totals.days
            ? `${totals.days - totals.days_with_energy} day(s) with nothing to read — never counted as zero`
            : "Every day has an energy reading"
        }
      />
    </div>
  );
}

export function PerformanceHistoryDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const plantQuery = usePlant(plantId);
  const timezone = plantQuery.data?.timezone;
  const { period, setPeriod } = useHistoryPeriod();
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;
  const navigate = useNavigate();
  const hasAnalytics = useDashboard("energy_analytics");
  const canExport = usePermission("data.export");
  const canReadMaintenance = usePermission("plant.manage");

  const [metricKey, setMetricKey] = useState<MetricKey>("energy_kwh");
  const metric = metricOf(metricKey);
  const [compareMode, setCompareMode] = useState<CompareMode>("none");
  const [granularityChoice, setGranularityChoice] = useState<Granularity | null>(null);
  const [openDay, setOpenDay] = useState<HistoryDay | null>(null);

  const resolved = timezone ? resolvePeriod(period, nowMs, timezone) : null;
  const periodError = resolved && "error" in resolved ? resolved.error : null;
  const dates = timezone && !periodError ? periodDates(period, nowMs, timezone) : null;
  const dayCount = dates ? Math.round((Date.parse(dates.last) - Date.parse(dates.first)) / 86_400_000) + 1 : 0;
  const tooLong = dayCount > MAX_DAYS;
  const live = resolved !== null && !("error" in resolved) && resolved.live;

  const history = usePlantHistory(plantId, tooLong ? null : dates, { live });

  const comparison = timezone ? comparisonPeriod(period, compareMode, nowMs, timezone) : null;
  const comparisonDates = comparison && timezone ? periodDates(comparison, nowMs, timezone) : null;
  const compareHistory = usePlantHistory(plantId, tooLong ? null : comparisonDates, {
    live: false,
    enabled: compareMode !== "none",
  });
  const compareLabel =
    compareMode === "none" || !comparison || !timezone
      ? null
      : compareMode === "previous"
        ? `previous (${periodLabel(comparison, nowMs, timezone)})`
        : `last year (${periodLabel(comparison, nowMs, timezone)})`;
  const compareData = compareMode !== "none" ? (compareHistory.data ?? null) : null;

  const data = history.data ?? null;
  const days = useMemo(() => data?.days ?? [], [data]);
  const granularity: Granularity = granularityChoice ?? (days.length > MONTHS_BY_DEFAULT_ABOVE ? "month" : "day");
  const extremes = bestAndWorst(days, metricKey);
  const left = rankable(days, metricKey);

  // ── The chart's series
  const chart = useMemo(() => {
    if (!data || !timezone) return null;
    if (granularity === "month") {
      const current: TrendPoint[] = data.months.map((month) => ({
        at: instantOf(month.month, timezone),
        value: valueOf(month, metricKey),
        contributors: 1,
      }));
      const other = alignByIndex(
        data.months.map((month) => ({ date: month.month })),
        compareData?.months ?? [],
      ).map(({ date, other: month }) => ({
        at: instantOf(date, timezone),
        value: month ? valueOf(month, metricKey) : null,
        contributors: month ? 1 : 0,
      }));
      return { current, other };
    }
    const current: TrendPoint[] = days.map((day) => ({
      at: instantOf(day.date, timezone),
      value: valueOf(day, metricKey),
      contributors: 1,
    }));
    const other = alignByIndex(days, compareData?.days ?? []).map(({ date, other: day }) => ({
      at: instantOf(date, timezone),
      value: day ? valueOf(day, metricKey) : null,
      contributors: day ? 1 : 0,
    }));
    return { current, other };
  }, [data, compareData, days, granularity, metricKey, timezone]);

  const exportDays = () => {
    if (!data) return;
    const header = ["Date", ...METRICS.map((m) => `${m.label} (${m.unit})`), "Today, so far"];
    const rows = data.days.map((day) => [
      displayDate(day.date),
      ...METRICS.map((m) => valueOf(day, m.key)),
      day.in_progress ? "yes" : "",
    ]);
    downloadCsv(
      `${exportStem(plantQuery.data?.code, "history", data.first_day, data.last_day)}.csv`,
      rowsCsv(header, rows),
    );
  };

  const openInAnalytics = (day: HistoryDay) => {
    const params = new URLSearchParams(periodToParams(daysPeriod(day.date, day.date)));
    setPeriod(daysPeriod(day.date, day.date));
    navigate(`/d/energy_analytics?${params.toString()}`);
  };

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }

  const body = (() => {
    if (plantQuery.isError) return <ErrorState error={plantQuery.error} retry={() => void plantQuery.refetch()} />;
    if (!timezone) {
      return (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-28" />
          <SkeletonChart height={320} />
        </div>
      );
    }
    if (periodError) return <EmptyState title="No period to show" detail={periodError} />;
    if (tooLong) {
      return (
        <EmptyState
          title="Choose a period of a year or less"
          detail={`This period is ${dayCount} days. Performance History shows at most ${MAX_DAYS} days at a time — one calendar year — so each day stays readable. Use ◀ and ▶ to move through longer stretches a year at a time.`}
        />
      );
    }
    if (history.isError) return <ErrorState error={history.error} retry={() => void history.refetch()} />;
    if (!data) {
      return (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-28" />
          <SkeletonChart height={320} />
        </div>
      );
    }
    return (
      <div className={`flex flex-col gap-6 transition-opacity ${history.isFetching && history.isPlaceholderData ? "opacity-60" : ""}`}>
        <Summary history={data} compare={compareData} compareLabel={compareLabel} />
        {compareMode !== "none" && compareHistory.isError ? (
          <p className="-mt-3 text-xs text-bad">The comparison period could not be loaded.</p>
        ) : null}

        <Panel
          title={<span className="text-base">{metric.label} on the calendar</span>}
          subtitle={<span className="text-sm">{metric.hint} Click any day to open it.</span>}
          actions={
            canExport ? (
              <Button variant="secondary" onClick={exportDays} title="Every day's figures as a CSV file">
                <span className="flex items-center gap-1">
                  <IconExport size={13} /> CSV
                </span>
              </Button>
            ) : null
          }
          padding="p-4"
        >
          <CalendarHeatmap days={days} metric={metric} selected={openDay?.date ?? null} onOpen={setOpenDay} />
          <p className="mt-4 text-xs text-ink-muted">
            {extremes ? (
              <>
                Best whole day{" "}
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => setOpenDay(extremes.best)}>
                  {displayDate(extremes.best.date)}
                </button>{" "}
                ({formatNumber(valueOf(extremes.best, metricKey), { digits: metric.digits })} {metric.unit}); worst{" "}
                <button type="button" className="font-medium text-accent hover:underline" onClick={() => setOpenDay(extremes.worst)}>
                  {displayDate(extremes.worst.date)}
                </button>{" "}
                ({formatNumber(valueOf(extremes.worst, metricKey), { digits: metric.digits })} {metric.unit}).{" "}
              </>
            ) : metric.better === null ? (
              `${metric.label} describes the day rather than judging the Plant, so no day is called best or worst. `
            ) : (
              "Fewer than two whole, measured days — nothing to rank. "
            )}
            {metric.better !== null && left.partial + left.unmeasured + left.flagged + left.inProgress > 0 ? (
              <span className="text-ink-faint">
                Not ranked:{" "}
                {[
                  left.unmeasured ? `${left.unmeasured} with nothing measured` : null,
                  left.partial ? `${left.partial} partly measured` : null,
                  left.flagged ? `${left.flagged} outside what the figure can be` : null,
                  left.inProgress ? "today, still running" : null,
                ]
                  .filter(Boolean)
                  .join(", ")}
                .
              </span>
            ) : null}
          </p>
        </Panel>

        <Panel
          title={<span className="text-base">{metric.label} {granularity === "month" ? "by month" : "by day"}</span>}
          subtitle={
            <span className="text-sm">
              {compareLabel
                ? `Against the ${compareLabel}: its ${granularity === "month" ? "months" : "days"} are drawn on this period's, first on first. A gap is a ${granularity} nothing measured.`
                : `A gap is a ${granularity} nothing measured — never drawn as zero.`}
            </span>
          }
          actions={
            <SegmentedControl<Granularity>
              label="Group the chart by"
              value={granularity}
              onChange={setGranularityChoice}
              options={[
                { value: "day", label: "Days" },
                { value: "month", label: "Months" },
              ]}
            />
          }
          padding="p-4"
        >
          {chart === null ? null : compareLabel ? (
            <OverlayTrendChart
              series={[
                { key: "current", label: periodLabel(period, nowMs, timezone), points: chart.current },
                {
                  key: "compare",
                  label: comparison ? periodLabel(comparison, nowMs, timezone) : "Comparison",
                  points: chart.other,
                  unavailableReason: compareHistory.isLoading ? "loading" : null,
                },
              ]}
              unit={metric.unit}
              tier="agg_1d"
              timezone={timezone}
              height={300}
              isLoading={compareHistory.isLoading}
            />
          ) : (
            <TrendChart
              points={chart.current}
              unit={metric.unit}
              label={metric.label}
              tier="agg_1d"
              resolution={{
                label: granularity === "month" ? "Plant months" : "Plant days",
                title:
                  "Each bar is one of the Plant's own days or months, midnight to midnight on its clock, worked out exactly as the Reports work them out.",
              }}
              timezone={timezone}
              height={300}
              shape="bar"
              markPeak={false}
              exportName={canExport ? exportStem(plantQuery.data?.code, metric.key, data.first_day, data.last_day) : null}
            />
          )}
        </Panel>

        {data.months.length > 0 ? (
          <Panel
            title={<span className="text-base">Months</span>}
            subtitle={<span className="text-sm">The Monthly Plant Report's rows for these months — the same figures a downloaded Report carries.</span>}
            padding="p-0"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[44rem] text-xs">
                <thead className="bg-surface-sunken text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Month</th>
                    <th className="px-3 py-2 text-right font-medium">Days</th>
                    <th className="px-3 py-2 text-right font-medium">Energy (kWh)</th>
                    <th className="px-3 py-2 text-right font-medium">Irradiation (kWh/m²)</th>
                    <th className="px-3 py-2 text-right font-medium">Specific yield (kWh/kWp)</th>
                    <th className="px-3 py-2 text-right font-medium">PR (%)</th>
                    <th className="px-3 py-2 text-right font-medium">CUF (%)</th>
                    <th className="px-3 py-2 text-right font-medium">Peak (kW)</th>
                    <th className="px-3 py-2 text-right font-medium">Coverage (%)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.months.map((month) => (
                    <tr key={month.month} className="border-t border-line-soft">
                      <td className="px-3 py-2 font-medium text-ink">{displayMonth(month.month)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{month.days}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(month.energy_kwh, { digits: 1 })}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(month.irradiation_kwh_m2, { digits: 2 })}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(month.specific_yield, { digits: 2 })}</td>
                      <td className={`px-3 py-2 text-right tabular-nums ${month.performance_ratio_flagged ? "text-warn" : ""}`}>
                        {formatNumber(month.performance_ratio, { digits: 1 })}
                        {month.performance_ratio_flagged ? " !" : ""}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums ${month.cuf_flagged ? "text-warn" : ""}`}>
                        {formatNumber(month.cuf, { digits: 1 })}
                        {month.cuf_flagged ? " !" : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatNumber(month.peak_power_kw, { digits: 1 })}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-muted">{formatNumber(month.coverage, { digits: 0 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}

        <details className="rounded-card border border-line bg-surface-raised p-4 text-xs text-ink-muted">
          <summary className="cursor-pointer font-medium text-ink">How these figures are worked out</summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {data.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      </div>
    );
  })();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Performance History</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Every day of a period up to a year, at a glance — which days were good, which were not, and why.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
          <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" size="lg" />
        </div>
      </header>

      <HistoryPeriodBar
        period={period}
        onChange={(next) => {
          setPeriod(next);
          setOpenDay(null);
        }}
        timezone={timezone}
        nowMs={nowMs}
        note={tooLong ? null : dayCount === 1 ? "One day: click it to see its curve." : null}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl<MetricKey>
          label="Colour the days by"
          value={metricKey}
          onChange={setMetricKey}
          options={METRICS.map((m) => ({ value: m.key, label: m.label, hint: m.hint }))}
        />
        <SelectBox
          label="Compare with"
          size="sm"
          value={compareMode}
          onChange={(value) => setCompareMode(value as CompareMode)}
          display={COMPARE_MODES.find((mode) => mode.value === compareMode)?.label ?? "No comparison"}
        >
          {COMPARE_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>
              {mode.label}
            </option>
          ))}
        </SelectBox>
        {compareMode !== "none" && compareData && compareData.totals.days_with_energy < compareData.totals.days ? (
          <Badge tone="neutral" title="The comparison is only as complete as its readings — days nothing measured are left out of it, never counted as zero.">
            Comparison measured on {compareData.totals.days_with_energy} of {compareData.totals.days} days
          </Badge>
        ) : null}
      </div>

      {body}

      <Drawer
        open={openDay !== null}
        onClose={() => setOpenDay(null)}
        size="wide"
        title={openDay ? displayDate(openDay.date) : ""}
        subtitle={plantQuery.data ? `${plantQuery.data.name} · the Plant's own day, midnight to midnight` : undefined}
        footer={
          openDay && hasAnalytics ? (
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => openInAnalytics(openDay)}>
                Open this day in Energy Analytics
              </Button>
            </div>
          ) : undefined
        }
      >
        {openDay && plantId !== null && timezone ? (
          <DayDetail
            plantId={plantId}
            plantCode={plantQuery.data?.code ?? null}
            day={openDay}
            timezone={timezone}
            nowMs={nowMs}
            canReadMaintenance={canReadMaintenance}
            canExport={canExport}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
