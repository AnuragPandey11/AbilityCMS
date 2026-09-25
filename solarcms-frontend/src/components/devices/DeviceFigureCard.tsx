/**
 * One Device as a card of large figures, for the Single Plant carousel.
 * Inverter Monitoring uses `InverterCard`, the client's reference card, which
 * is built around an Inverter's output against its rating.
 *
 * Wider than `DeviceCard` (which stays for the dense Device-type panels): two
 * columns of large figures, an optional place on whatever measure the screen is
 * comparing, and the figure *being* compared drawn in the chart's colour, so the
 * eye can go from a bar to its card and find the same number.
 *
 * The figures are the Device Type's columns from the catalogue — or a Device's
 * own bindings where nobody curated the Type — so what the card shows is
 * configuration, not code (Guardrail 2). Silence is "—", never 0.
 *
 * The icon is `DeviceIcon`, the single-colour glyph: it sits in a small tinted
 * chip beside the Device's code, which is the case that glyph exists for. Where
 * the picture is the only label, `DeviceArt` is the right drawing instead.
 */

import type { CommStatus, DeviceListItem, DeviceTableColumn } from "@/api/schemas";
import { COMM_CARD_STYLE } from "./DeviceCard";
import { DeviceIcon } from "./DeviceIcon";
import { UNDEFINED_DISPLAY, formatDigital, formatNumber } from "@/format/value";
import { ageSeconds, formatAge } from "@/format/datetime";

const STATUS_TEXT: Record<CommStatus, string> = {
  online: "text-ok",
  degraded: "text-warn",
  offline: "text-bad",
  unknown: "text-ink-faint",
};

const STATUS_DOT: Record<CommStatus, string> = {
  online: "bg-ok",
  degraded: "bg-warn",
  offline: "bg-bad",
  unknown: "bg-ink-faint",
};

export function DeviceFigureCard({
  device,
  columns,
  values,
  highlightTagId,
  position,
  positionNote,
  onSelect,
  selected,
  maxFigures = 6,
}: {
  device: DeviceListItem;
  columns: DeviceTableColumn[];
  /** Keyed by tag id as a string (§5.1). */
  values: Record<string, number> | undefined;
  /** The Tag the chart is comparing on; its value takes the chart's colour. */
  highlightTagId?: number;
  /**
   * Place on the compared measure within this group; null when it reported
   * nothing. Omitted entirely where the screen compares nothing.
   */
  position?: number | null;
  positionNote?: string;
  onSelect: (device: DeviceListItem) => void;
  selected?: boolean;
  maxFigures?: number;
}): JSX.Element {
  const comm = device.comm_status ?? "unknown";
  const style = COMM_CARD_STYLE[comm];
  const shown = columns.slice(0, maxFigures);
  const age = ageSeconds(device.last_seen_at);

  return (
    <button
      type="button"
      onClick={() => onSelect(device)}
      className={`surface-card flex h-full w-full min-w-0 flex-col rounded-card border p-4 text-left transition hover:border-accent/55 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${style.frame} ${
        selected ? "ring-2 ring-accent/40" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control icon-well">
          <DeviceIcon typeCode={device.type_code} size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-base font-semibold text-ink">{device.code}</div>
          <div
            className={`mt-0.5 flex items-center gap-1.5 text-sm font-medium ${STATUS_TEXT[comm]}`}
            title={style.note}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[comm]}`} />
            {style.label}
          </div>
        </div>
        {position !== undefined ? (
          <span
            className="shrink-0 rounded-md bg-surface-sunken px-2 py-0.5 font-mono text-xs text-ink-muted"
            title={positionNote}
          >
            {position === null ? UNDEFINED_DISPLAY : `#${position}`}
          </span>
        ) : null}
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3">
        {shown.map((column) => {
          const value = values?.[String(column.tag_id)];
          // A Digital Input is a contact, not a quantity (§4.5): never "0.00 bool".
          const digital = column.category === "status";
          const highlighted = column.tag_id === highlightTagId;
          return (
            <div key={column.tag_id} className="min-w-0">
              <dt
                className="truncate text-[10.5px] font-semibold uppercase tracking-[0.03em] text-ink-muted"
                title={column.name}
              >
                {column.tag_code.replace(/_/g, " ")}
              </dt>
              <dd
                className="mt-0.5 flex items-baseline gap-1 truncate"
                title={
                  value === undefined
                    ? "No value for this Tag yet. Silence is not zero."
                    : `${column.name}${!digital && column.unit ? ` (${column.unit})` : ""}`
                }
              >
                {digital ? (
                  <span className={`text-sm ${value === undefined ? "text-ink-faint" : "text-ink"}`}>
                    {value === undefined ? UNDEFINED_DISPLAY : formatDigital(value)}
                  </span>
                ) : (
                  <>
                    <span
                      className={`figure truncate text-lg font-semibold ${
                        value === undefined
                          ? "text-ink-faint"
                          : highlighted
                            ? "text-accent"
                            : "text-ink"
                      }`}
                    >
                      {value === undefined ? UNDEFINED_DISPLAY : formatNumber(value)}
                    </span>
                    {value !== undefined && column.unit ? (
                      <span className="shrink-0 text-xs font-medium text-ink-muted">{column.unit}</span>
                    ) : null}
                  </>
                )}
              </dd>
            </div>
          );
        })}
        {shown.length === 0 ? (
          // Two different silences, and which one it is decides where to go.
          <p className="col-span-2 text-xs leading-snug text-ink-faint">
            {device.binding_count === 0
              ? "No Tags are bound, so every message this Device sends decodes into nothing. Map its payload keys in Tag Mapping."
              : `No summary figures are configured for ${device.type_code}. Open the card for everything it reports.`}
          </p>
        ) : null}
      </dl>

      {/* Pinned to the bottom, so cards in one row keep their rules aligned. */}
      <div className="mt-auto pt-4">
        <div
          className="border-t border-line pt-3 text-xs text-ink-faint"
          title={`Staleness is judged against this Device's own ${device.expected_interval_s}s interval, never a fixed clock.`}
        >
          {age === null ? "never seen" : `seen ${formatAge(age)}`}
        </div>
      </div>
    </button>
  );
}
