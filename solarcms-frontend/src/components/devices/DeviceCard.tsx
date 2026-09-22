/**
 * One Device as a card — the form the client's reference dashboard uses for
 * its Inverter row.
 *
 * ── Which figures appear is configuration, not code ─────────────────────────
 * The obvious build is a component that knows an Inverter has voltage, current
 * and a power factor. That is what Guardrail 2 forbids, and it is also what
 * would need rewriting the first time somebody wanted the same card for a
 * Transformer. The figures come from `device_table_columns` for the Device's
 * own Type — the same catalogue rows that drive the summary tables — so a card
 * for a Device Type nobody anticipated appears with no release.
 *
 * The card shows the first `maxFigures` of those columns, because a card is a
 * glance and the full list is what the detail view is for. The catalogue's
 * `position` already puts the most important first.
 *
 * ── Values come from the live socket, and silence is not zero ───────────────
 * A Device that has not sent a frame renders "—". Rendering 0 would be a claim
 * about the machine, and there is no basis for it: the Device may be off, the
 * datalogger may be down, or the Tag may simply be throttled and not due yet.
 */

import type { CommStatus, DeviceListItem, DeviceTableColumn } from "@/api/schemas";
import { DeviceArt } from "./DeviceArt";
import { UNDEFINED_DISPLAY, formatNumber } from "@/format/value";
import { formatAge, ageSeconds } from "@/format/datetime";

/**
 * Communication status → the card's frame.
 *
 * ⚠ Communication, never equipment condition. A Device whose Collector has
 * failed is `offline` here and may be generating perfectly; the platform cannot
 * tell and must not imply that it can (Guardrail 16).
 */
const STATUS: Record<
  CommStatus,
  { frame: string; dot: string; label: string; note: string }
> = {
  online: {
    frame: "border-ok/30",
    dot: "bg-ok",
    label: "online",
    note: "Reporting within its expected interval.",
  },
  degraded: {
    frame: "border-warn/45",
    dot: "bg-warn",
    label: "degraded",
    note: "Late — past its expected interval but not yet silent.",
  },
  offline: {
    frame: "border-bad/45",
    dot: "bg-bad",
    label: "offline",
    note:
      "Not reporting. This is a communication fact, not an equipment one — " +
      "the machine may be running and unable to tell us.",
  },
  unknown: {
    frame: "border-line",
    dot: "bg-ink-faint",
    label: "unknown",
    note: "No health record yet. Normal for a Device registered moments ago.",
  },
};

export function DeviceCard({
  device,
  columns,
  values,
  maxFigures = 4,
  onSelect,
  selected,
}: {
  device: DeviceListItem;
  /** The Device Type's curated columns, from the catalogue. */
  columns: DeviceTableColumn[];
  /** Live frame values, keyed by tag id as a string (§5.1). */
  values: Record<string, number> | undefined;
  maxFigures?: number;
  onSelect?: (device: DeviceListItem) => void;
  selected?: boolean;
}): JSX.Element {
  const status = STATUS[device.comm_status ?? "unknown"];
  const shown = columns.slice(0, maxFigures);
  const age = ageSeconds(device.last_seen_at);

  const body = (
    <>
      <div className="flex items-start gap-2">
        <DeviceArt typeCode={device.type_code} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-xs font-semibold text-ink">{device.code}</span>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.dot}`} />
          </div>
          <div className="truncate text-[10px] text-ink-faint" title={status.note}>
            {device.rated_capacity_kw != null
              ? `${formatNumber(device.rated_capacity_kw)} kW · ${status.label}`
              : status.label}
          </div>
        </div>
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
        {shown.map((column) => {
          const value = values?.[String(column.tag_id)];
          return (
            <div key={column.tag_id} className="min-w-0">
              <dt
                className="truncate text-[9px] uppercase tracking-wide text-ink-faint"
                title={column.name}
              >
                {column.tag_code.replace(/_/g, " ")}
              </dt>
              <dd
                className={`truncate font-mono text-[11px] tabular-nums ${
                  value === undefined ? "text-ink-faint" : "text-ink"
                }`}
                title={
                  value === undefined
                    ? "No live value for this Tag. Silence is not zero."
                    : `${column.name}${column.unit ? ` (${column.unit})` : ""}`
                }
              >
                {value === undefined ? UNDEFINED_DISPLAY : formatNumber(value)}
                {value !== undefined && column.unit ? (
                  <span className="ml-0.5 text-[9px] text-ink-muted">{column.unit}</span>
                ) : null}
              </dd>
            </div>
          );
        })}
        {shown.length === 0 ? (
          <p className="col-span-2 text-[10px] text-ink-faint">
            No summary figures are configured for {device.type_code}.
          </p>
        ) : null}
      </dl>

      {age !== null ? (
        <div
          className="mt-1.5 text-[9px] text-ink-faint"
          title={`Staleness for this Device is judged against its own ${device.expected_interval_s}s interval, never a fixed clock.`}
        >
          seen {formatAge(age)}
        </div>
      ) : null}
    </>
  );

  const className =
    `w-[176px] rounded-card border bg-surface-raised p-2.5 text-left transition ` +
    `${status.frame} ${selected ? "ring-2 ring-accent/40" : ""} ` +
    `${onSelect ? "cursor-pointer hover:border-accent/50" : ""}`;

  if (!onSelect) return <div className={className}>{body}</div>;
  return (
    <button type="button" onClick={() => onSelect(device)} className={className}>
      {body}
    </button>
  );
}
