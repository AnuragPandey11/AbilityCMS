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
 * clock says. The custom range is the Plant's own dates and clock times too,
 * and its "today" and "now" limits are read in the Plant's zone for the same
 * reason. It stops at the end time; 23:59 is the end of that day, so a whole
 * day typed by hand reads exactly as the same day chosen as Yesterday.
 *
 * Below the preview, a Client's scheduled Reports (`ClientReportRuns`) — a
 * different job: every Plant in one workbook, including the settlement Report
 * that only the ABT Meter may produce.
 */

import { useState } from "react";
import { usePlant, useReportTable } from "@/api/hooks";
import * as reportsApi from "@/api/endpoints/reports";
import type { ReportFormat, ReportKind, ReportPeriod } from "@/api/endpoints/reports";
import { triggerDownload } from "@/api/client";
import { isApiError } from "@/api/problem";
import { usePermission } from "@/auth/usePermission";
import { usePlantScope } from "@/state/usePlantScope";
import { PlantPicker } from "@/components/domain";
import { Button, Panel, SegmentedControl } from "@/components/ui";
import { EmptyState, ForbiddenState } from "@/components/state";
import { IconExport } from "@/components/icons";
import { DEFAULT_TIMEZONE, toDateTimeInput } from "@/format/datetime";
import { customRangeEnd, customRangeProblem } from "./reports/format";
import { MAX_CUSTOM_DAYS, ReportPeriodPicker } from "./reports/ReportPeriodPicker";
import { printHtml } from "./reports/printHtml";
import { ClientReportRuns } from "./reports/ClientReportRuns";
import { ReportPreview } from "./reports/ReportPreview";
import { CustomReportBuilder } from "./reports/CustomReportBuilder";

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

type Notice = { tone: "info" | "bad"; text: string };

export function ReportsDashboard(): JSX.Element {
  const canGenerate = usePermission("report.generate");
  const { plants, plantId, setPlantId, hasNoPlants } = usePlantScope();
  const plantQuery = usePlant(plantId);
  const zone = plantQuery.data?.timezone ?? DEFAULT_TIMEZONE;
  // The Plant's wall clock, `YYYY-MM-DDTHH:MM`, which the inputs also hold.
  const now = toDateTimeInput(Date.now(), zone);

  const [kind, setKind] = useState<ReportKind>("daily_plant");
  const [period, setPeriod] = useState<ReportPeriod>("today");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  // The whole of both days until the reader narrows them.
  const [fromTime, setFromTime] = useState("00:00");
  const [toTime, setToTime] = useState("23:59");
  const [exporting, setExporting] = useState<ReportFormat | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  /**
   * The ready-made reports, or one built from any Devices' readings. Standard
   * first and by default: the common case should not have to see a builder.
   */
  const [mode, setMode] = useState<"standard" | "custom">("standard");

  const choosePeriod = (next: ReportPeriod) => {
    setPeriod(next);
    setNotice(null);
  };

  const range = { fromDate, fromTime, toDate, toTime };
  const rangeProblem =
    period === "custom" ? customRangeProblem(range, now, MAX_CUSTOM_DAYS) : null;
  const query: reportsApi.ReportTableQuery | null =
    mode === "standard" && canGenerate && plantId !== null && rangeProblem === null
      ? { kind, plantId, period, ...(period === "custom" ? range : {}) }
      : null;
  // Today's row is still being written; a range that has already stopped is not.
  const live = period !== "yesterday" && (period !== "custom" || customRangeEnd(range) > now);
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
            {mode === "standard"
              ? "Generate and export Plant reports (CSV / Excel / PDF)."
              : "Any readings from any of your Plants' Devices, at the interval you choose."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
          <SegmentedControl
            label="Kind of report"
            size="lg"
            value={mode}
            onChange={(next) => {
              setMode(next);
              setNotice(null);
            }}
            options={[
              { value: "standard", label: "Standard", hint: "The ready-made Plant reports." },
              {
                value: "custom",
                label: "Build your own",
                hint: "Choose Plants, Devices, readings and the interval yourself.",
              },
            ]}
          />
          {mode === "standard" ? (
            <PlantPicker
              plants={plants}
              value={plantId}
              onChange={setPlantId}
              label="Plant"
              size="lg"
            />
          ) : null}
        </div>
      </header>

      {hasNoPlants ? (
        <EmptyState
          title="No Plants assigned"
          detail="A report is about one Plant, and this account has none. An administrator assigns Plants under Users."
        />
      ) : mode === "custom" ? (
        <CustomReportBuilder plants={plants} startPlantId={plantId} />
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
                  <ReportPeriodPicker
                    period={period}
                    onPeriod={choosePeriod}
                    range={range}
                    onRange={(next) => {
                      setFromDate(next.fromDate);
                      setFromTime(next.fromTime);
                      setToDate(next.toDate);
                      setToTime(next.toTime);
                    }}
                    now={now}
                    zone={zone}
                    problem={rangeProblem}
                    noteId="report-range-note"
                  />
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

      {mode === "standard" ? <ClientReportRuns /> : null}
    </div>
  );
}

function describe(error: unknown): string {
  return isApiError(error) ? error.displayMessage : "Could not download the report.";
}
