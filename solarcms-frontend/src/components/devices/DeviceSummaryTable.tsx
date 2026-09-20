/**
 * The "Inverter Summary" table of the reference screens — for any Device Type.
 *
 * Both of the client's reference dashboards carry a compact table: one row per
 * Inverter, half a dozen columns, at a glance. The obvious way to build it is a
 * component that knows what an Inverter is. That is exactly what Guardrail 2
 * forbids, and it is also what would have to be rewritten the first time a
 * Client wanted the same table for their meters.
 *
 * So the columns are configuration (`device_table_columns`, by Device Type) and
 * this renders whatever it is handed. A Client who decides their operators need
 * winding temperature on the Transformer table changes a row, not a release.
 *
 * Distinct from `DeviceTypePanels`, which shows *everything* a Device publishes.
 * That is the right view when diagnosing one machine; this is the right view
 * when scanning twelve. An Inverter is bound to eighty Tags once its PV strings
 * are counted, and a table eighty columns wide answers nothing.
 *
 * A Device reporting nothing shows "—", never 0 — zero is a claim about the
 * equipment and silence is the absence of one.
 *
 * The column count is configuration and therefore unbounded, so the table is
 * given a minimum width and allowed to scroll inside its wrapper rather than
 * compressing to fit. `w-full` alone could never overflow, which meant the
 * `overflow-x-auto` around it had nothing to do and a Transformer table with
 * ten configured columns crushed every one of them. The Device column stays put
 * while the rest scrolls — a row of figures whose Device code has scrolled out
 * of view identifies nothing.
 */

import type { DeviceListItem, DeviceTableColumn } from "@/api/schemas";
import { CommStatusBadge } from "@/components/domain";
import { UNDEFINED_DISPLAY, formatDigital, formatNumber } from "@/format/value";
import { EmptyState } from "@/components/state";

export function DeviceSummaryTable({
  devices,
  columns,
  liveValues,
}: {
  devices: DeviceListItem[];
  columns: DeviceTableColumn[];
  /** device id → (tag id → value), straight from the live socket. */
  liveValues: Record<number, Record<string, number> | undefined>;
}): JSX.Element {
  if (devices.length === 0) {
    return (
      <EmptyState
        title="No Devices of this type"
        detail="This Plant has none registered."
      />
    );
  }
  if (columns.length === 0) {
    return (
      <p className="text-xs text-ink-faint">
        No summary columns are configured for this Device Type.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table
        className="w-full text-sm"
        // Device + Status + one per configured column.
        style={{ minWidth: 220 + columns.length * 104 }}
      >
        <thead>
          <tr className="border-b border-line text-left text-xs text-ink-muted">
            <th className="sticky left-0 z-10 bg-surface-raised py-2 pr-3 font-medium">
              Device
            </th>
            <th className="py-2 pr-3 font-medium">Status</th>
            {columns.map((column) => (
              <th
                key={column.tag_id}
                className="py-2 pr-3 text-right font-medium"
                title={`${column.name} · ${column.tag_code}`}
              >
                {column.name}
                {/* The unit is read from the registry, never inferred from the
                    Tag's name: the client's own sheet mixes kWh and MWh inside
                    one Device. */}
                {column.unit ? (
                  <span className="ml-1 font-normal text-ink-faint">
                    ({column.unit})
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {devices.map((device) => {
            const frame = liveValues[device.id];
            return (
              <tr key={device.id}>
                <td className="sticky left-0 z-10 bg-surface-raised py-1.5 pr-3">
                  <span className="font-medium text-ink">{device.code}</span>
                  <span className="ml-2 text-ink-muted">{device.name}</span>
                </td>
                <td className="py-1.5 pr-3">
                  <CommStatusBadge status={device.comm_status} />
                </td>
                {columns.map((column) => {
                  const value = frame?.[String(column.tag_id)];
                  const missing = value === undefined || !Number.isFinite(value);
                  return (
                    <td
                      key={column.tag_id}
                      className={`py-1.5 pr-3 text-right font-mono text-xs ${
                        missing ? "text-ink-faint" : "text-ink"
                      }`}
                      title={missing ? "No live value for this Tag." : undefined}
                    >
                      {missing
                        ? UNDEFINED_DISPLAY
                        : // A Digital Input is a two-state contact, not a
                          // quantity (§4.5). Rendering a trip contact as "1.00"
                          // hides the only thing that matters about it.
                          column.category === "status"
                          ? formatDigital(value)
                          : formatNumber(value, { digits: 2 })}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
