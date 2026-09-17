/**
 * The live equipment view, rendered entirely from the catalogue.
 *
 * This is guardrail 2 in its most visible form: **no panel here is written for a
 * Device Type.** There is no `if (type === "INVERTER")` and no per-Plant layout.
 * The component reads which Devices exist, which Tags each one is bound to, and
 * what those Tags mean — and lays the result out. A Client who adds Module
 * Trackers tomorrow gets a Module Tracker panel with no release, because the
 * panel was never about inverters in the first place.
 *
 * Two rendering rules, both taken from the Tag's own `category`:
 *
 * * `status` Tags are Digital Inputs — a two-state contact — and are drawn as
 *   indicators. Plotting a trip contact as a number hides the only thing that
 *   matters about it, which is *when it changed*.
 * * Everything else is a measurement, drawn as a value with the unit the
 *   registry gives it. The unit is never inferred from the Tag's name: the
 *   client's own sheet mixes kWh and MWh inside one Device.
 *
 * A Device that has published nothing shows as silent rather than as zero. Zero
 * is a claim about the equipment; silence is the absence of one, and an operator
 * must never be shown the first when the second is true.
 */

import { useMemo, useState } from "react";
import type { DeviceListItem, Tag } from "@/api/schemas";
import { useTagsById } from "@/api/hooks";
import { useLiveSocket } from "@/live/LiveSocket";
import { STALE_INTERVAL_MULTIPLIER } from "@/live/useLiveDevice";
import { ageSeconds } from "@/format/datetime";
import { formatValue } from "@/format/value";
import { Badge, Panel } from "@/components/ui";
import { EmptyState } from "@/components/state";

/** Category order: what an operator looks at first, first. */
const CATEGORY_ORDER = [
  "performance",
  "electrical",
  "environmental",
  "status",
  "diagnostic",
] as const;

interface DeviceValues {
  values: Record<number, number>;
  at: string | null;
}

export function DeviceTypePanels({
  devices,
  timezone,
}: {
  devices: DeviceListItem[];
  /** Kept for callers that show timestamps beside these panels. */
  timezone?: string;
}): JSX.Element {
  const tagsById = useTagsById();
  const { devices: live } = useLiveSocket();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Grouped by Device Type, in catalogue order rather than alphabetically: the
  // order Devices appear in is the order the client's own Device List uses.
  const groups = useMemo(() => {
    const byType = new Map<string, DeviceListItem[]>();
    for (const device of devices) {
      const existing = byType.get(device.type_code);
      if (existing) existing.push(device);
      else byType.set(device.type_code, [device]);
    }
    return [...byType.entries()].map(([typeCode, members]) => ({
      typeCode,
      devices: [...members].sort((a, b) => a.code.localeCompare(b.code)),
    }));
  }, [devices]);

  if (devices.length === 0) {
    return (
      <EmptyState
        title="No Devices registered"
        detail="Register this Plant's equipment through onboarding. Each Device's panel appears here automatically once it has a Model and a topic — nothing here is configured per Plant."
      />
    );
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const isCollapsed = collapsed[group.typeCode] ?? false;
        const online = group.devices.filter(
          (device) => device.comm_status === "online",
        ).length;
        return (
          <Panel
            key={group.typeCode}
            title={`${group.typeCode.replace(/_/g, " ")} · ${group.devices.length}`}
            subtitle={`${online} of ${group.devices.length} reporting`}
            actions={
              <button
                type="button"
                onClick={() =>
                  setCollapsed((previous) => ({
                    ...previous,
                    [group.typeCode]: !isCollapsed,
                  }))
                }
                className="text-[11px] text-ink-muted hover:text-ink hover:underline"
              >
                {isCollapsed ? "Show" : "Hide"}
              </button>
            }
          >
            {isCollapsed ? null : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {group.devices.map((device) => (
                  <DeviceCard
                    key={device.id}
                    device={device}
                    frame={live[device.id] ?? null}
                    tagsById={tagsById}
                    timezone={timezone}
                  />
                ))}
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function DeviceCard({
  device,
  frame,
  tagsById,
}: {
  device: DeviceListItem;
  frame: DeviceValues | null;
  tagsById: Map<number, Tag>;
  timezone?: string;
}): JSX.Element {
  const age = frame?.at ? ageSeconds(frame.at) : null;
  const stale =
    age !== null && age > device.expected_interval_s * STALE_INTERVAL_MULTIPLIER;
  const silent = frame === null;

  // Whatever this Device actually reports, grouped by what kind of thing it is.
  // The list is not declared anywhere: it is the Tags that arrived.
  const rows = useMemo(() => {
    if (!frame) return [];
    return Object.entries(frame.values)
      .map(([tagId, value]) => ({ tag: tagsById.get(Number(tagId)), value }))
      .filter(
        (row): row is { tag: Tag; value: number } => row.tag !== undefined,
      )
      .sort((a, b) => {
        const byCategory =
          CATEGORY_ORDER.indexOf(a.tag.category as (typeof CATEGORY_ORDER)[number]) -
          CATEGORY_ORDER.indexOf(b.tag.category as (typeof CATEGORY_ORDER)[number]);
        return byCategory !== 0 ? byCategory : a.tag.code.localeCompare(b.tag.code);
      });
  }, [frame, tagsById]);

  const measurements = rows.filter((row) => row.tag.category !== "status");
  const contacts = rows.filter((row) => row.tag.category === "status");

  return (
    <div
      className={`rounded-lg border bg-surface p-3 ${
        silent
          ? "border-line"
          : stale
            ? "border-warn/40"
            : "border-ok/30"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{device.code}</p>
          <p className="truncate text-[11px] text-ink-muted">{device.name}</p>
        </div>
        <Badge
          tone={silent ? "neutral" : stale ? "warn" : "ok"}
          title={
            silent
              ? "No live frame has arrived for this Device."
              : `Last frame ${Math.round(age ?? 0)}s ago. Stale past ${
                  device.expected_interval_s * STALE_INTERVAL_MULTIPLIER
                }s.`
          }
        >
          {silent ? "silent" : stale ? "stale" : "live"}
        </Badge>
      </div>

      {silent ? (
        <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          Nothing received yet. This is not a reading of zero — the Device has
          published nothing on{" "}
          <span className="font-mono">{device.source_address ?? "no topic"}</span>.
        </p>
      ) : (
        <>
          {measurements.length > 0 ? (
            <dl className="mt-3 space-y-1">
              {measurements.slice(0, 8).map((row) => (
                <div
                  key={row.tag.id}
                  className="flex items-baseline justify-between gap-2"
                >
                  <dt
                    className="truncate text-[11px] text-ink-muted"
                    title={row.tag.code}
                  >
                    {row.tag.name}
                    {row.tag.formula ? (
                      <span
                        className="ml-1 text-accent"
                        title={`Computed: ${row.tag.formula}`}
                      >
                        ƒ
                      </span>
                    ) : null}
                  </dt>
                  <dd className="shrink-0 font-mono text-xs text-ink">
                    {formatValue(row.value, row.tag.unit)}
                  </dd>
                </div>
              ))}
              {measurements.length > 8 ? (
                <p className="pt-1 text-[11px] text-ink-faint">
                  +{measurements.length - 8} more
                </p>
              ) : null}
            </dl>
          ) : null}

          {contacts.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1 border-t border-line pt-2">
              {contacts.map((row) => (
                <span
                  key={row.tag.id}
                  title={`${row.tag.code} — ${row.value !== 0 ? "closed" : "open"}`}
                  className="inline-flex items-center gap-1 rounded border border-line px-1 py-0.5 text-[10px] text-ink-muted"
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      row.value !== 0 ? "bg-ok" : "bg-ink-faint"
                    }`}
                  />
                  {row.tag.name}
                </span>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
