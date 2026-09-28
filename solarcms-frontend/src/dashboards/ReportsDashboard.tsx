/**
 * `reports` (§6.7).
 *
 * Laid out after the client's reference screen: pick a report type and a
 * period — today, yesterday, the last 7 or 30 days, or a custom range — and the
 * preview below answers at once; CSV, Excel and PDF download the same table.
 *
 * ── The preview is the file ─────────────────────────────────────────────────
 * The server builds the preview and every download from one computation
 * (`services/report_tables`), and a download is computed afresh rather than
 * assembled from the rows this browser holds. So the file carries the same
 * figures, units and precision as the screen, and nothing the server did not
 * make. The preview decides only how a cell looks (`reports/format.ts`).
 *
 * ── Periods are the Plant's days ────────────────────────────────────────────
 * The period is sent by name and resolved on the server in the Plant's zone:
 * "today" at a Plant in Kolkata began at its midnight, whatever the browser's
 * clock says. The custom range is the Plant's own dates too, and its "today"
 * limit is read in the Plant's zone for the same reason.
 *
 * Below the preview, a Client's scheduled Reports (`ClientReportRuns`) — a
 * different job: every Plant in one workbook, including the settlement Report
 * that only the ABT Meter may produce.
 */

import { useMemo, useState } from "react";
import { usePlant, useReportTable } from "@/api/hooks";
import * as reportsApi from "@/api/endpoints/reports";
import type { ReportFormat, ReportKind, ReportPeriod } from "@/api/endpoints/reports";
import type { ReportCellValue, ReportColumn, ReportTable } from "@/api/schemas";
import { triggerDownload } from "@/api/client";
import { isApiError } from "@/api/problem";
import { usePermission } from "@/auth/usePermission";
import { usePlantScope } from "@/state/usePlantScope";
import { PlantPicker } from "@/components/domain";
import { Button, Panel, SegmentedControl, inputClass } from "@/components/ui";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { EmptyState, ErrorState, ForbiddenState, SkeletonTable } from "@/components/state";
import { IconExport, IconWarning } from "@/components/icons";
import { DEFAULT_TIMEZONE, dateInputInZone, timezoneLabel } from "@/format/datetime";
import {
  columnHeading,
  customRangeProblem,
  formatDayRange,
  formatReportCell,
  isNumericColumn,
  shiftDate,
} from "./reports/format";
import { printHtml } from "./reports/printHtml";
import { ClientReportRuns } from "./reports/ClientReportRuns";

const KINDS: { value: ReportKind; label: string; hint: string }[] = [
  {
    value: "daily_plant",
    label: "Daily Plant Report",
    hint: "One row per day: power, energy, import and grid frequency.",
  },
  {
    value: "monthly_plant",
    label: "Monthly Plant Report",
    hint: "One row per month: energy, irradiation, PR and CUF.",
  },
  {
    value: "inverter",
    label: "Inverter Report",
    hint: "One row per Inverter: energy, peaks, temperature and availability.",
  },
  {
    value: "weather",
    label: "Weather Report",
    hint: "One row per day from the Weather Station.",
  },
  { value: "alarm", label: "Alarm Report", hint: "Every Alarm opened in the period." },
];

const PERIODS: { value: ReportPeriod; label: string; hint?: string }[] = [
  { value: "today", label: "Today", hint: "Since the Plant's midnight." },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 Days", hint: "Today and the six days before it." },
  { value: "last_30_days", label: "Last 30 Days", hint: "Today and the 29 days before it." },
  { value: "custom", label: "Custom" },
];

// Mirrors `domain/periods.MAX_REPORT_DAYS`; the server enforces it regardless.
const MAX_CUSTOM_DAYS = 366;

const FORMATS: { format: ReportFormat; label: string; hint: string }[] = [
  { format: "csv", label: "CSV", hint: "The rows only — opens as a table anywhere." },
  { format: "xlsx", label: "Excel", hint: "The table, with its Plant, period and notes." },
  { format: "pdf", label: "PDF", hint: "A printable page of the table and its notes." },
];

// A segment's label never breaks inside its pill; on a narrow screen the
// track scrolls sideways instead ("Last / 7 / Days" read as three options).
function unbroken<T extends { label: string }>(options: T[]): (T & { label: JSX.Element })[] {
  return options.map((option) => ({
    ...option,
    label: <span className="whitespace-nowrap">{option.label}</span>,
  }));
}

const KIND_OPTIONS = unbroken(KINDS);
const PERIOD_OPTIONS = unbroken(PERIODS);

interface PreviewRow {
  index: number;
  cells: Record<string, ReportCellValue>;
  flags: Record<string, string>;
}

type Notice = { tone: "info" | "bad"; text: string };

export function ReportsDashboard(): JSX.Element {
  const canGenerate = usePermission("report.generate");
  const { plants, plantId, setPlantId, hasNoPlants } = usePlantScope();
  const plantQuery = usePlant(plantId);
  const zone = plantQuery.data?.timezone ?? DEFAULT_TIMEZONE;
  const today = dateInputInZone(Date.now(), zone);

  const [kind, setKind] = useState<ReportKind>("daily_plant");
  const [period, setPeriod] = useState<ReportPeriod>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [exporting, setExporting] = useState<ReportFormat | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const choosePeriod = (next: ReportPeriod) => {
    // Custom opens on the last seven days rather than two empty inputs: a
    // range to adjust is quicker than one to invent.
    if (next === "custom" && (!fromDate || !toDate)) {
      setToDate(today);
      setFromDate(shiftDate(today, -6));
    }
    setPeriod(next);
    setNotice(null);
  };

  const rangeProblem =
    period === "custom" ? customRangeProblem(fromDate, toDate, today, MAX_CUSTOM_DAYS) : null;
  const query: reportsApi.ReportTableQuery | null =
    canGenerate && plantId !== null && rangeProblem === null
      ? { kind, plantId, period, ...(period === "custom" ? { fromDate, toDate } : {}) }
      : null;
  // Today's row is still being written; a past range is not.
  const live = period !== "yesterday" && (period !== "custom" || toDate >= today);
  const tableQuery = useReportTable(query, live);
  const table = tableQuery.data;
  // A table for the previous choice, kept on screen while this one loads.
  const stale = tableQuery.isPlaceholderData;

  const download = async (format: ReportFormat) => {
    if (!query || !table || stale) return;
    setExporting(format);
    setNotice(null);
    try {
      const blob = await reportsApi.exportReportTable(query, format);
      triggerDownload(blob, reportsApi.reportFilename(table, format));
    } catch (error) {
      if (format === "pdf" && isApiError(error) && error.status === 503) {
        // No PDF renderer on the server. The printable page it would have
        // rendered goes to the browser's print dialog instead — same table.
        try {
          printHtml(await reportsApi.reportTablePage(query));
          setNotice({
            tone: "info",
            text: "This server has no PDF renderer installed, so the report opened in your browser's print dialog — choose “Save as PDF” as the destination.",
          });
        } catch (inner) {
          setNotice({ tone: "bad", text: describe(inner) });
        }
      } else {
        setNotice({ tone: "bad", text: describe(error) });
      }
    } finally {
      setExporting(null);
    }
  };

  if (!canGenerate) {
    return <ForbiddenState detail="Reports require the report.generate permission." />;
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Reports</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Generate and export Plant reports (CSV / Excel / PDF).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
          <PlantPicker
            plants={plants}
            value={plantId}
            onChange={setPlantId}
            label="Plant"
            size="lg"
          />
        </div>
      </header>

      {hasNoPlants ? (
        <EmptyState
          title="No Plants assigned"
          detail="A report is about one Plant, and this account has none. An administrator assigns Plants under Users."
        />
      ) : (
        <>
          <Panel title="Report generator">
            <div className="space-y-5">
              <div>
                <p className="field-label mb-2">Report type</p>
                <div className="max-w-full overflow-x-auto">
                  <SegmentedControl
                    label="Report type"
                    value={kind}
                    onChange={(next) => {
                      setKind(next);
                      setNotice(null);
                    }}
                    options={KIND_OPTIONS}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <p className="field-label mb-2">Period</p>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="max-w-full overflow-x-auto">
                      <SegmentedControl
                        label="Period"
                        value={period}
                        onChange={choosePeriod}
                        options={PERIOD_OPTIONS}
                      />
                    </div>
                    {period === "custom" ? (
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Sized by a wrapper: the shared input class is full-width. */}
                        <div className="w-40">
                          <input
                            type="date"
                            aria-label="First day"
                            value={fromDate}
                            max={toDate || today}
                            onChange={(event) => setFromDate(event.target.value)}
                            className={inputClass}
                          />
                        </div>
                        <span className="text-xs text-ink-muted">to</span>
                        <div className="w-40">
                          <input
                            type="date"
                            aria-label="Last day"
                            value={toDate}
                            min={fromDate || undefined}
                            max={today}
                            onChange={(event) => setToDate(event.target.value)}
                            className={inputClass}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                  {rangeProblem ? (
                    <p className="mt-2 text-xs text-bad">{rangeProblem}</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2 lg:shrink-0">
                  {FORMATS.map(({ format, label, hint }) => (
                    <Button
                      key={format}
                      onClick={() => void download(format)}
                      disabled={!table || stale || exporting !== null || query === null}
                      title={hint}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-sm"
                    >
                      <IconExport size={15} />
                      {exporting === format ? "Preparing…" : label}
                    </Button>
                  ))}
                </div>
              </div>

              {notice ? (
                <p
                  role={notice.tone === "bad" ? "alert" : "status"}
                  className={`rounded-control border px-3 py-2 text-xs ${
                    notice.tone === "bad"
                      ? "border-bad/30 bg-bad/10 text-bad"
                      : "border-line bg-surface-sunken text-ink-muted"
                  }`}
                >
                  {notice.text}
                </p>
              ) : null}
            </div>
          </Panel>

          <ReportPreview
            table={table}
            loading={tableQuery.isLoading}
            fetching={tableQuery.isFetching}
            stale={stale}
            error={tableQuery.isError ? tableQuery.error : null}
            retry={() => void tableQuery.refetch()}
            waitingForRange={rangeProblem !== null}
          />
        </>
      )}

      <ClientReportRuns />
    </div>
  );
}

function describe(error: unknown): string {
  return isApiError(error) ? error.displayMessage : "Could not download the report.";
}

function ReportPreview({
  table,
  loading,
  fetching,
  stale,
  error,
  retry,
  waitingForRange,
}: {
  table: ReportTable | undefined;
  loading: boolean;
  fetching: boolean;
  stale: boolean;
  error: unknown;
  retry: () => void;
  waitingForRange: boolean;
}): JSX.Element {
  const zone = table?.plant.timezone ?? DEFAULT_TIMEZONE;

  const rows = useMemo<PreviewRow[]>(() => {
    if (!table) return [];
    const flags = new Map<number, Record<string, string>>();
    for (const flag of table.flags) {
      flags.set(flag.row, { ...(flags.get(flag.row) ?? {}), [flag.key]: flag.reason });
    }
    return table.rows.map((cells, index) => ({ index, cells, flags: flags.get(index) ?? {} }));
  }, [table]);

  const columns = useMemo<Column<PreviewRow>[]>(
    () =>
      (table?.columns ?? []).map((column) => ({
        key: column.key,
        header: columnHeading(column),
        align: isNumericColumn(column) ? "right" : "left",
        render: (row) => (
          <ReportCell
            column={column}
            value={row.cells[column.key]}
            flag={row.flags[column.key]}
            zone={zone}
          />
        ),
        sortValue: (row) => row.cells[column.key] ?? null,
        filterValue: (row) => formatReportCell(column, row.cells[column.key], zone),
      })),
    [table, zone],
  );

  const count = table?.rows.length ?? 0;
  const title = table
    ? `${table.title} — preview (${count} ${count === 1 ? "row" : "rows"})`
    : "Preview";
  const subtitle = table
    ? `${table.plant.name} (${table.plant.code}) · ${formatDayRange(
        table.first_day,
        table.last_day,
      )} · ${timezoneLabel(table.plant.timezone)} time`
    : undefined;

  let body: JSX.Element;
  if (error && !table) {
    body = (
      <div className="p-4">
        <ErrorState error={error} retry={retry} />
      </div>
    );
  } else if (!table) {
    body = waitingForRange ? (
      <p className="p-4 text-xs text-ink-faint">Choose a valid range to see the report.</p>
    ) : loading ? (
      <div className="p-4">
        <SkeletonTable rows={6} columns={6} />
      </div>
    ) : (
      <p className="p-4 text-xs text-ink-faint">Choose a Plant to see the report.</p>
    );
  } else {
    body = (
      <>
        {error ? (
          // The last good table stays, marked as not the one asked for.
          <div className="border-b border-line p-4">
            <ErrorState error={error} retry={retry} />
          </div>
        ) : null}
        <div
          className={`p-4 transition-opacity ${stale ? "opacity-50" : ""}`}
          aria-busy={stale}
        >
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(row) => row.index}
            emptyMessage="No rows for this period."
            filterPlaceholder="Filter rows…"
            minColumnWidth={120}
          />
        </div>
        {table.notes.length > 0 ? (
          <div className="border-t border-line px-4 py-3">
            <p className="text-xs font-medium text-ink-muted">How these figures were made</p>
            <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-snug text-ink-faint">
              {table.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      padding="p-0"
      actions={
        fetching ? (
          <span className="text-xs text-ink-faint" role="status">
            Updating…
          </span>
        ) : null
      }
    >
      {body}
    </Panel>
  );
}

function ReportCell({
  column,
  value,
  flag,
  zone,
}: {
  column: ReportColumn;
  value: ReportCellValue | undefined;
  flag: string | undefined;
  zone: string;
}): JSX.Element {
  const text = formatReportCell(column, value, zone);
  const numeric = isNumericColumn(column);
  if (value === null || value === undefined) {
    return (
      <span className="whitespace-nowrap text-ink-faint" title="Nothing to read — not zero.">
        {text}
      </span>
    );
  }
  if (flag) {
    // Shown unaltered and marked, never clamped (Guardrail 33).
    return (
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap text-warn tabular-nums"
        title={flag}
      >
        <IconWarning size={12} />
        {text}
      </span>
    );
  }
  // Figures, dates and times never break across lines; only a long sentence
  // (an Alarm's message) wraps, at a width it can be read at.
  const layout = numeric
    ? "whitespace-nowrap tabular-nums"
    : column.kind === "text" && text.length > 40
      ? "block min-w-[18rem] whitespace-normal"
      : "whitespace-nowrap";
  return <span className={layout}>{text}</span>;
}
