/**
 * Everything recorded about one Device, in one card.
 *
 * Opened by clicking a box in the Single Line Diagram or a row in the hierarchy
 * editor. Both are places where the next question is always the same — *what is
 * this thing and why is it behaving like that* — and answering it used to mean
 * leaving the diagram for the device list, the bindings screen and the health
 * page in turn.
 *
 * Three things it is careful about:
 *
 * - **The three groupings are shown as three separate rows, labelled with what
 *   each one means** (MASTER §3.4). "Feeds into", "sits in" and "transmitted
 *   by" are three different facts, and the whole reason they are separate
 *   columns is that collapsing any two makes both unanswerable. Showing them
 *   under one heading would undo that in the UI.
 * - **A Collector is named, never linked.** It is not a Device, so there is
 *   nothing to navigate to. It reads as an enclosure because it is one.
 * - **An absent value is a dash, never a zero** (§4.3). No rated capacity and a
 *   rated capacity of zero are different statements about a machine.
 */

import type { DeviceListItem, Tag } from "@/api/schemas";
import type { DeviceLiveState } from "@/live/LiveSocket";
import { Badge, Panel } from "@/components/ui";
import { CommStatusBadge } from "@/components/domain";
import { formatValue, UNDEFINED_DISPLAY } from "@/format/value";
import { formatAge, formatDate } from "@/format/datetime";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt className="shrink-0 text-ink-muted" title={hint}>
        {label}
      </dt>
      <dd className="min-w-0 break-words text-right text-ink">{children}</dd>
    </div>
  );
}

const dash = (value: unknown): string =>
  value === null || value === undefined || value === ""
    ? UNDEFINED_DISPLAY
    : String(value);

export function DeviceDetailCard({
  device,
  devicesById,
  live,
  tagsById,
  onClose,
}: {
  device: DeviceListItem;
  /** Used to name a parent or a transmitting Device by its code, not its id. */
  devicesById: Map<number, DeviceListItem>;
  live: DeviceLiveState | null;
  tagsById: Map<number, Tag>;
  onClose?: () => void;
}): JSX.Element {
  const nameOf = (id: number | null): string => {
    if (id === null) return UNDEFINED_DISPLAY;
    // The id as a fallback rather than nothing: a parent in another Plant or a
    // decommissioned one is absent from this list, and "#41" is at least
    // something to search for.
    return devicesById.get(id)?.code ?? `#${id}`;
  };

  // The live frame, most useful readings first. Sorted by the Tag's own
  // category, never by a Tag named in this file (§0.3).
  const readings = live
    ? Object.entries(live.values)
        .map(([tagId, value]) => ({ tag: tagsById.get(Number(tagId)), value }))
        .filter((row): row is { tag: Tag; value: number } => row.tag !== undefined)
        .sort((a, b) => a.tag.code.localeCompare(b.tag.code))
    : [];

  return (
    <Panel
      title={device.code}
      subtitle={device.name}
      actions={
        onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] text-ink-muted hover:text-ink hover:underline"
          >
            Close
          </button>
        ) : undefined
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <CommStatusBadge status={device.comm_status} />
        <Badge tone="neutral">{device.type_code}</Badge>
        {device.variant ? <Badge tone="neutral">{device.variant}</Badge> : null}
        {device.in_power_path ? (
          <Badge tone="info" title="Carries current, so it appears in the electrical diagram.">
            in power path
          </Badge>
        ) : (
          <Badge
            tone="neutral"
            title="Real and monitored, but no current flows through it — it is deliberately absent from the electrical diagram."
          >
            no current
          </Badge>
        )}
        {device.status !== "active" ? (
          <Badge tone="warn">{device.status}</Badge>
        ) : null}
      </div>

      <dl className="divide-y divide-line text-xs">
        {/* ── Identity ───────────────────────────────────────────────────── */}
        <Row label="Type">
          {device.type_name ? `${device.type_name} (${device.type_code})` : device.type_code}
        </Row>
        <Row label="Model">
          {device.model_code
            ? `${device.manufacturer ?? ""} ${device.model_code}`.trim()
            : UNDEFINED_DISPLAY}
        </Row>
        <Row label="Serial">{dash(device.serial_number)}</Row>
        <Row label="Rated capacity">
          {device.rated_capacity_kw === null || device.rated_capacity_kw === undefined
            ? UNDEFINED_DISPLAY
            : `${device.rated_capacity_kw} kW`}
        </Row>
        <Row
          label="PV strings"
          hint="How many inputs of the Model's repeating group this unit has. A fact about the unit, not the Model — with none recorded, none of the group is bound."
        >
          {dash(device.string_count)}
        </Row>
        <Row label="Installed">
          {device.installed_on ? formatDate(device.installed_on) : UNDEFINED_DISPLAY}
        </Row>

        {/* ── The three groupings (MASTER §3.4) ──────────────────────────── */}
        <Row
          label="Feeds into"
          hint="Electrical. What this Device is wired into — this, and only this, builds the Single Line Diagram."
        >
          {device.parent_device_id === null ? (
            <span title="Feeds into nothing — this is where the Plant meets the grid.">
              ⏚ grid
            </span>
          ) : (
            nameOf(device.parent_device_id)
          )}
        </Row>
        <Row
          label="In collector"
          hint="The enclosure this Device sits in — an MCR, an ICR, a panel. A Collector is not a Device: nothing is wired through it, and it is drawn as a box around its Devices."
        >
          {device.collector_code ? (
            <span className="rounded border border-dashed border-line-strong px-1.5 py-0.5">
              {device.collector_code}
            </span>
          ) : (
            <span title="This Device sits in no enclosure. Normal — its topic has no collector segment.">
              {UNDEFINED_DISPLAY}
            </span>
          )}
        </Row>
        <Row
          label="Transmitted by"
          hint="Communication. Another Device that relays this one's data. This is what separates a communication loss from equipment downtime."
        >
          {device.reports_via_device_id === null
            ? "publishes directly"
            : nameOf(device.reports_via_device_id)}
        </Row>
        <Row
          label="Block"
          hint="Geographic. Where the Device physically is — never drawn in the electrical diagram."
        >
          {device.block_id === null ? UNDEFINED_DISPLAY : `#${device.block_id}`}
        </Row>

        {/* ── Ingest and health ──────────────────────────────────────────── */}
        <Row label="Topic" hint="The MQTT topic this Device publishes on. The sole authority for where its data comes from.">
          <span className="font-mono text-[11px] leading-tight">
            {dash(device.source_address)}
          </span>
        </Row>
        <Row
          label="Expected every"
          hint="Health thresholds multiply this. Set from observation at commissioning, never left at the assumed default."
        >
          <span className="font-mono">{device.expected_interval_s}s</span>
        </Row>
        <Row label="Last seen">
          {device.last_seen_at
            ? formatAge((Date.now() - Date.parse(device.last_seen_at)) / 1000)
            : "never"}
        </Row>
        <Row
          label="Frozen Tags"
          hint="Tags whose value has not moved across consecutive Readings — the Device is reporting, but something behind it has stopped."
        >
          {dash(device.frozen_tag_count)}
        </Row>
        <Row label="24h completeness">
          {device.completeness_24h === null || device.completeness_24h === undefined
            ? UNDEFINED_DISPLAY
            : `${Math.round(device.completeness_24h * 100)}%`}
        </Row>
        <Row
          label="Bound Tags"
          hint="How many signals this Device decodes. Zero means it may be publishing and storing nothing."
        >
          {dash(device.binding_count)}
        </Row>
      </dl>

      {readings.length > 0 ? (
        <div className="mt-3 border-t border-line pt-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            Live now
          </p>
          <div className="grid grid-cols-2 gap-1">
            {readings.map(({ tag, value }) => (
              <div
                key={tag.id}
                className="flex items-baseline justify-between gap-1 rounded bg-surface-sunken px-1.5 py-1"
                title={tag.name}
              >
                <span className="truncate text-[10px] text-ink-muted">{tag.code}</span>
                <span className="shrink-0 font-mono text-[11px] text-ink">
                  {/* The unit is the catalogue's, rendered verbatim — never
                      converted (§4.1). */}
                  {formatValue(value, tag.unit)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
