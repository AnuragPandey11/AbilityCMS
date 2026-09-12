/**
 * A sortable, filterable table with CSV export and row virtualisation.
 *
 * Virtualisation matters at the F-2 ceiling of 150+ Devices, where a Device list
 * carrying live values is a real render cost (§9). Rows above ~200 render
 * through a windowed viewport rather than all at once.
 *
 * Export is gated by the caller, not here: `data.export` is a separate
 * permission from viewing (MASTER §4.3).
 */

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Button, inputClass } from "@/components/ui";

export interface Column<T> {
  key: string;
  header: string;
  /** Rendered cell. Keep display formatting here, never in the row data. */
  render: (row: T) => ReactNode;
  /** Value used for sorting and CSV. Omit to make a column unsortable. */
  sortValue?: (row: T) => string | number | null;
  /** Text a free-text filter searches. Defaults to `sortValue`. */
  filterValue?: (row: T) => string;
  align?: "left" | "right";
  width?: string;
}

const VIRTUALISE_ABOVE = 200;
const ROW_HEIGHT = 34;
const OVERSCAN = 8;

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  emptyMessage = "No rows.",
  onRowClick,
  filterPlaceholder = "Filter…",
  exportFilename,
  toolbar,
  maxHeight = 520,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  emptyMessage?: ReactNode;
  onRowClick?: (row: T) => void;
  filterPlaceholder?: string;
  /** Supplied only when the caller holds `data.export`. */
  exportFilename?: string;
  toolbar?: ReactNode;
  maxHeight?: number;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      columns.some((column) => {
        const text =
          column.filterValue?.(row) ?? String(column.sortValue?.(row) ?? "");
        return text.toLowerCase().includes(needle);
      }),
    );
  }, [rows, columns, query]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const column = columns.find((candidate) => candidate.key === sortKey);
    if (!column?.sortValue) return filtered;
    const factor = sortDirection === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const left = column.sortValue!(a);
      const right = column.sortValue!(b);
      // Nulls sort last in both directions: an undefined figure is not "lowest",
      // and letting it lead a descending sort misreports the worst performer.
      if (left === null && right === null) return 0;
      if (left === null) return 1;
      if (right === null) return -1;
      if (typeof left === "number" && typeof right === "number") {
        return (left - right) * factor;
      }
      return String(left).localeCompare(String(right)) * factor;
    });
  }, [filtered, columns, sortKey, sortDirection]);

  const toggleSort = (key: string) => {
    if (sortKey === key) {
      setSortDirection((previous) => (previous === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDirection("asc");
    }
  };

  const virtualise = sorted.length > VIRTUALISE_ABOVE;
  const viewportHeight = maxHeight;
  const startIndex = virtualise
    ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
    : 0;
  const visibleCount = virtualise
    ? Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
    : sorted.length;
  const visible = sorted.slice(startIndex, startIndex + visibleCount);
  const padTop = startIndex * ROW_HEIGHT;
  const padBottom = Math.max(
    0,
    (sorted.length - startIndex - visible.length) * ROW_HEIGHT,
  );

  const exportCsv = () => {
    const escape = (value: unknown) => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const header = columns.map((column) => escape(column.header)).join(",");
    const body = sorted
      .map((row) =>
        columns
          .map((column) => escape(column.sortValue?.(row) ?? column.filterValue?.(row) ?? ""))
          .join(","),
      )
      .join("\n");
    const blob = new Blob([`${header}\n${body}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFilename ?? "export.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={filterPlaceholder}
          className={`${inputClass} max-w-xs`}
        />
        <span className="text-xs text-ink-faint">
          {sorted.length} of {rows.length}
          {virtualise ? " · virtualised" : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {toolbar}
          {exportFilename ? (
            <Button onClick={exportCsv} title="Download the rows as shown">
              Export CSV
            </Button>
          ) : null}
        </div>
      </div>

      <div
        ref={viewportRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="overflow-auto rounded-card border border-line"
        style={{ maxHeight: viewportHeight }}
      >
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface-sunken">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  style={{ width: column.width }}
                  onClick={() => (column.sortValue ? toggleSort(column.key) : undefined)}
                  className={`border-b border-line px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-muted ${
                    column.align === "right" ? "text-right" : "text-left"
                  } ${column.sortValue ? "cursor-pointer select-none hover:text-ink" : ""}`}
                >
                  {column.header}
                  {sortKey === column.key ? (
                    <span className="ml-1 text-accent">
                      {sortDirection === "asc" ? "▲" : "▼"}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-3 py-8 text-center text-sm text-ink-muted"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              <>
                {padTop > 0 ? <tr style={{ height: padTop }} /> : null}
                {visible.map((row) => (
                  <tr
                    key={rowKey(row)}
                    onClick={() => onRowClick?.(row)}
                    style={{ height: ROW_HEIGHT }}
                    className={`border-b border-line/60 ${
                      onRowClick ? "cursor-pointer hover:bg-surface-raised" : ""
                    }`}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={`px-3 py-1.5 text-ink ${
                          column.align === "right" ? "text-right font-mono" : ""
                        }`}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                ))}
                {padBottom > 0 ? <tr style={{ height: padBottom }} /> : null}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
