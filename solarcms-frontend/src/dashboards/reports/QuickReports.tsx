/**
 * Quick reports: up to five saved custom reports the reader keeps at the top
 * of Reports, each downloadable in one click (the user's request of 13 Nov
 * 2026: "so that every time we don't have to do the same selection").
 *
 * A download sends the saved definition as it is, and the server resolves its
 * period on the Plant's clock now — "Last 7 days" is this week's seven days,
 * never the week it was saved in. Open puts the report in the builder, where
 * it can be changed, saved again, or unpinned.
 *
 * A pin is the reader's own; nobody else's row changes. The saved report is
 * still shared within the Client, and deleting it takes it out of every row.
 */

import { useState } from "react";
import type { ReportFormat, SavedReport } from "@/api/endpoints/reports";
import type { MePlant } from "@/api/schemas";
import { isApiError } from "@/api/problem";
import { Button, Panel } from "@/components/ui";
import { IconClose, IconExport } from "@/components/icons";
import { describeExport, downloadCustomReport } from "./exportCustom";
import {
  QUICK_REPORT_LIMIT,
  asDefinition,
  definitionWords,
  plantWords,
  quickReportFilename,
} from "./quickReportRules";
import { useQuickReports } from "./useQuickReports";

const FORMATS: { format: ReportFormat; label: string; hint: string }[] = [
  { format: "csv", label: "CSV", hint: "The rows only — opens as a table anywhere." },
  { format: "xlsx", label: "Excel", hint: "The table, with its period and notes." },
  { format: "pdf", label: "PDF", hint: "A printable page of the table and its notes." },
];

type Notice = { tone: "info" | "bad"; text: string };

export function QuickReports({
  plants,
  onOpen,
}: {
  plants: MePlant[];
  /** Show this saved report in the builder. */
  onOpen: (reportId: number) => void;
}): JSX.Element | null {
  const quick = useQuickReports();
  const [unpinError, setUnpinError] = useState<string | null>(null);

  // Before the list arrives, or when it could not be read, the row says
  // nothing: the builder below says what went wrong with saved reports.
  if (!quick.loaded) return null;

  if (quick.pinned.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-line px-4 py-3 text-xs text-ink-muted">
        <span className="font-semibold text-ink">Quick reports</span> —{" "}
        {quick.saved.length === 0
          ? `save a report under Build your own, then pin it to download it from here in one click. Up to ${QUICK_REPORT_LIMIT}.`
          : `open a saved report under Build your own and press Pin to download it from here in one click. Up to ${QUICK_REPORT_LIMIT}.`}
      </p>
    );
  }

  const unpin = async (report: SavedReport) => {
    setUnpinError(null);
    try {
      await quick.unpin(report.id);
    } catch (error) {
      setUnpinError(isApiError(error) ? error.displayMessage : "Could not unpin the report.");
    }
  };

  return (
    <Panel
      title="Quick reports"
      subtitle={`Your pinned reports (${quick.pinned.length} of ${QUICK_REPORT_LIMIT}). Each download is worked out afresh (a fixed custom range keeps its dates); Open shows it in the builder.`}
      tray
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        {quick.pinned.map((report) => (
          <QuickReportCard
            key={report.id}
            report={report}
            plants={plants}
            onOpen={() => onOpen(report.id)}
            onUnpin={() => void unpin(report)}
            unpinning={quick.busy}
          />
        ))}
      </div>
      {unpinError ? (
        <p role="alert" className="mt-3 text-xs text-bad">
          {unpinError}
        </p>
      ) : null}
    </Panel>
  );
}

function QuickReportCard({
  report,
  plants,
  onOpen,
  onUnpin,
  unpinning,
}: {
  report: SavedReport;
  plants: MePlant[];
  onOpen: () => void;
  onUnpin: () => void;
  unpinning: boolean;
}): JSX.Element {
  const definition = asDefinition(report.definition);
  const [exporting, setExporting] = useState<ReportFormat | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const download = async (format: ReportFormat) => {
    if (!definition) return;
    setExporting(format);
    setNotice(null);
    try {
      const note = await downloadCustomReport(
        definition,
        format,
        quickReportFilename(report.name, format, new Date()),
      );
      if (note) setNotice({ tone: "info", text: note });
    } catch (error) {
      setNotice({ tone: "bad", text: describeExport(error) });
    } finally {
      setExporting(null);
    }
  };

  const plantLine = definition ? plantWords(definition, plants) : null;
  const detail = definition ? definitionWords(definition) : null;

  return (
    <article
      aria-label={report.name}
      className="flex min-w-0 flex-col gap-1.5 rounded-card border border-line bg-surface-raised p-3 shadow-card"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate text-sm font-semibold text-ink" title={report.name}>
          {report.name}
        </h3>
        <button
          type="button"
          onClick={onUnpin}
          disabled={unpinning}
          aria-label={`Unpin ${report.name}`}
          title="Unpin — the saved report stays under Build your own"
          className="-mr-1 -mt-0.5 shrink-0 rounded-control p-1 text-ink-faint transition hover:text-ink disabled:opacity-40"
        >
          <IconClose size={14} />
        </button>
      </div>
      {definition ? (
        <>
          <p className="truncate text-xs text-ink-muted" title={plantLine ?? undefined}>
            {plantLine}
          </p>
          <p className="text-xs leading-snug text-ink-faint">{detail}</p>
        </>
      ) : (
        <p className="text-xs text-bad">This saved report could not be read. Open it to rebuild it.</p>
      )}
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1.5">
        {FORMATS.map(({ format, label, hint }) => (
          <Button
            key={format}
            onClick={() => void download(format)}
            disabled={!definition || exporting !== null}
            title={hint}
            className="inline-flex items-center gap-1"
          >
            <IconExport size={13} />
            {exporting === format ? "Preparing…" : label}
          </Button>
        ))}
        <Button variant="ghost" onClick={onOpen}>
          Open
        </Button>
      </div>
      {notice ? (
        <p
          role={notice.tone === "bad" ? "alert" : "status"}
          className={`text-xs ${notice.tone === "bad" ? "text-bad" : "text-ink-muted"}`}
        >
          {notice.text}
        </p>
      ) : null}
    </article>
  );
}
