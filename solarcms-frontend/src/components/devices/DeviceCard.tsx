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
import { UNDEFINED_DISPLAY, formatDigital, formatNumber } from "@/format/value";
import { formatAge, ageSeconds } from "@/format/datetime";

/**
 * Communication status → the card's frame.
 *
 * ⚠ Communication, never equipment condition. A Device whose Collector has
 * failed is `offline` here and may be generating perfectly; the platform cannot
 * tell and must not imply that it can (Guardrail 16).
 */
export const COMM_CARD_STYLE: Record<
  CommStatus,
  { frame: string; dot: string; label: string; note: string }
> = {
  online: {
    frame: "border-ok/30",
    dot: "bg-ok lamp-ok",
    label: "online",
    note: "Reporting within its expected interval.",
  },
  degraded: {
    frame: "border-warn/45",
    dot: "bg-warn lamp-warn",
    label: "degraded",
    note: "Late — past its expected interval but not yet silent.",
  },
  offline: {
    frame: "border-bad/45",
    dot: "bg-bad lamp-bad",
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
  const status = COMM_CARD_STYLE[device.comm_status ?? "unknown"];
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
          /*
            A Digital Input is a contact, not a quantity (§4.5). Rendered
            through the numeric path it came out as "0.00 bool" — which is
            three ways wrong at once: it invites arithmetic on a state, it
            implies a precision a contact cannot have, and `bool` is a type
            name leaking onto an operator's screen as though it were a unit.
            Roughly a third of Tags are Digital Inputs and the whole of VCB and
            TRANSFORMER is, so this is most of what those cards show.
          */
          const digital = column.category === "status";
          return (
            <div key={column.tag_id} className="min-w-0">
              <dt
                className="truncate text-[9px] uppercase tracking-wide text-ink-faint"
                title={column.name}
              >
                {column.tag_code.replace(/_/g, " ")}
              </dt>
              <dd
                className={`flex items-center gap-1 truncate text-[11px] ${
                  digital ? "" : "font-mono tabular-nums"
                } ${value === undefined ? "text-ink-faint" : "text-ink"}`}
                title={
                  value === undefined
                    ? "No live value for this Tag. Silence is not zero."
                    : `${column.name}${!digital && column.unit ? ` (${column.unit})` : ""}`
                }
              >
                {digital ? (
                  <>
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        value === undefined
                          ? "bg-ink-faint"
                          : value !== 0
                            ? "bg-ok"
                            : "bg-ink-faint"
                      }`}
                    />
                    {value === undefined ? UNDEFINED_DISPLAY : formatDigital(value)}
                  </>
                ) : (
                  <>
                    {value === undefined ? UNDEFINED_DISPLAY : formatNumber(value)}
                    {value !== undefined && column.unit ? (
                      <span className="text-[9px] text-ink-muted">{column.unit}</span>
                    ) : null}
                  </>
                )}
              </dd>
            </div>
          );
        })}
        {shown.length === 0 ? (
          /*
            Two different silences, and telling them apart is the whole value
            of the message.
            
            A Device with no bindings decodes every message it sends into
            nothing — it looks registered, healthy and online while carrying no
            readable value at all, and the fix is in Tag Mapping. A Device with
            bindings but no configured columns is fine; nobody has curated a
            summary for its Type, and the fix is nowhere because the inspector
            already shows everything. Saying "no summary figures are
            configured" for the first case sends somebody to the wrong screen.
          */
          <p className="col-span-2 text-[10px] leading-snug text-ink-faint">
            {device.binding_count === 0
              ? "No Tags are bound, so every message this Device sends decodes into nothing. Map its payload keys in Tag Mapping."
              : `No summary figures are configured for ${device.type_code}. Open the card for everything it reports.`}
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
    `surface-tile w-[176px] rounded-card border p-2.5 text-left ` +
    `${status.frame} ${selected ? "ring-2 ring-accent/40" : ""} ` +
    `${onSelect ? "surface-interactive cursor-pointer hover:border-accent/55" : ""}`;

  if (!onSelect) return <div className={className}>{body}</div>;
  return (
    <button type="button" onClick={() => onSelect(device)} className={className}>
      {body}
    </button>
  );
}
