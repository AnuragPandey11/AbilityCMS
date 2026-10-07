/**
 * A report's table on screen — the standard reports and custom ones alike.
 *
 * The server builds the table; this decides only how a cell looks
 * (`format.ts`). A missing value is "—", never 0; a figure outside what its
 * quantity can be is shown unaltered and marked (Guardrail 33); the notes say
 * how the figures were made.
 */

import { useMemo } from "react";
import type { ReportCellValue, ReportColumn, ReportTable } from "@/api/schemas";
import { Panel } from "@/components/ui";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { ErrorState, SkeletonTable } from "@/components/state";
import { IconWarning } from "@/components/icons";
import { DEFAULT_TIMEZONE, timezoneLabel } from "@/format/datetime";
import { columnHeading, formatReportCell, formatReportPeriod, isNumericColumn } from "./format";

interface PreviewRow {
  index: number;
  cells: Record<string, ReportCellValue>;
  flags: Record<string, string>;
}

export function ReportPreview({
  table,
  loading,
  fetching,
  stale,
  error,
  retry,
  waitingForRange,
  emptyHint = "Choose a Plant to see the report.",
  waitingHint = "Choose a valid range to see the report.",
}: {
  table: ReportTable | undefined;
  loading: boolean;
  fetching: boolean;
  stale: boolean;
  error: unknown;
  retry: () => void;
  waitingForRange: boolean;
  /** What to say before anything has been asked for. */
  emptyHint?: string;
  /** What to say while the choices cannot be run yet. */
  waitingHint?: string;
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
    ? `${table.kind === "custom" ? table.plant.name : `${table.plant.name} (${table.plant.code})`} · ${formatReportPeriod(table)} · ${timezoneLabel(
        table.plant.timezone,
      )} time`
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
      <p className="p-4 text-xs text-ink-faint">{waitingHint}</p>
    ) : loading ? (
      <div className="p-4">
        <SkeletonTable rows={6} columns={6} />
      </div>
    ) : (
      <p className="p-4 text-xs text-ink-faint">{emptyHint}</p>
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
