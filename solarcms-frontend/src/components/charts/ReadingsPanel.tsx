/**
 * The time-series panel.
 *
 * §0.3 in practice: a "chart of AC Active Power" is really "a chart of whichever
 * Tags this Device is bound to". The Tag list comes from
 * `GET /devices/{id}/bindings` joined against `GET /catalog/tags` — never a
 * hard-coded list per Device Type, so a new Device Type renders with no
 * frontend change (F-12).
 *
 * Digital Inputs are split out and drawn as a transition timeline rather than a
 * line (§4.5): a trip contact plotted as a numeric series hides the only thing
 * that matters about it.
 */

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useReadings, useTags } from "@/api/hooks";
import { qk } from "@/api/queryKeys";
import * as devicesApi from "@/api/endpoints/devices";
import * as readingsApi from "@/api/endpoints/readings";
import type { DeviceListItem, Tag } from "@/api/schemas";
import { usePermission } from "@/auth/usePermission";
import { isApiError } from "@/api/problem";
import { Badge, Button, Panel, inputClass } from "@/components/ui";
import { EmptyState, ErrorState, LoadingState } from "@/components/state";
import { TimeSeriesChart, toChartSeries } from "./TimeSeriesChart";
import { StatusTimeline } from "./DigitalStatus";
import { triggerDownload } from "@/api/client";
import { DEFAULT_TIMEZONE } from "@/format/datetime";

const RANGES = [
  { label: "1h", hours: 1 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
  { label: "1y", hours: 24 * 365 },
] as const;

/**
 * Which Tags these Devices actually publish.
 *
 * Bindings are guarded by `config.modify`. A plain viewer therefore cannot read
 * them, and the fallback is the whole Tag catalogue — stated in the UI rather
 * than silently substituted, because the two lists mean different things.
 */
function useDeviceTagCodes(deviceIds: number[]): {
  codes: Set<string> | null;
  source: "bindings" | "catalogue";
} {
  const canConfigure = usePermission("config.modify");
  const results = useQueries({
    queries: deviceIds.map((deviceId) => ({
      queryKey: qk.bindings(deviceId),
      queryFn: () => devicesApi.getBindings(deviceId),
      enabled: canConfigure,
      retry: false,
      staleTime: 60_000,
    })),
  });

  if (!canConfigure) return { codes: null, source: "catalogue" };
  const anyLoaded = results.some((result) => result.data);
  if (!anyLoaded) return { codes: null, source: "catalogue" };

  const codes = new Set<string>();
  for (const result of results) {
    for (const binding of result.data ?? []) {
      if (binding.enabled) codes.add(binding.tag_code);
    }
  }
  return { codes, source: "bindings" };
}

export function ReadingsPanel({
  devices,
  timezone = DEFAULT_TIMEZONE,
  title = "Readings",
}: {
  devices: DeviceListItem[];
  timezone?: string;
  title?: string;
}): JSX.Element {
  const canExport = usePermission("data.export");
  const tagsQuery = useTags();
  // Memoised so the Tag-selection memo below does not recompute every render.
  const allTags = useMemo(() => tagsQuery.data ?? [], [tagsQuery.data]);

  const [deviceIds, setDeviceIds] = useState<number[]>(() =>
    devices.slice(0, 1).map((device) => device.id),
  );
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [rangeHours, setRangeHours] = useState<number>(24);
  const [exporting, setExporting] = useState(false);

  const { codes: boundCodes, source } = useDeviceTagCodes(deviceIds);

  /** Tags offered for selection: the Device's bindings, else the catalogue. */
  const availableTags = useMemo<Tag[]>(() => {
    if (boundCodes && boundCodes.size > 0) {
      return allTags.filter((tag) => boundCodes.has(tag.code));
    }
    return allTags;
  }, [allTags, boundCodes]);

  const range = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - rangeHours * 3600 * 1000);
    return { from, to };
  }, [rangeHours]);

  const query = useMemo(
    () => ({
      deviceIds,
      tagIds: tagIds.length > 0 ? tagIds : undefined,
      from: range.from,
      to: range.to,
      // Let the server pick the tier. Requesting `readings` for a month is
      // refused with 422 rather than scanning billions of rows (§9).
      resolution: "auto" as const,
    }),
    [deviceIds, tagIds, range],
  );

  const readingsQuery = useReadings(query, deviceIds.length > 0 && tagIds.length > 0);

  const selectedTags = allTags.filter((tag) => tagIds.includes(tag.id));
  const digitalTagIds = new Set(
    selectedTags.filter((tag) => tag.category === "status").map((tag) => tag.id),
  );

  const points = readingsQuery.data?.items ?? [];
  const analoguePoints = points.filter((point) => !digitalTagIds.has(point.tag_id));
  const digitalPoints = points.filter((point) => digitalTagIds.has(point.tag_id));

  const analogueSeries = toChartSeries(analoguePoints, allTags);
  const digitalSeries = [...digitalTagIds].map((tagId) => {
    const tag = allTags.find((candidate) => candidate.id === tagId);
    return {
      tagId,
      name: tag?.name ?? String(tagId),
      points: digitalPoints.filter((point) => point.tag_id === tagId),
    };
  });

  const toggle = <T,>(list: T[], item: T): T[] =>
    list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await readingsApi.exportReadings(query);
      triggerDownload(blob, `readings_${rangeHours}h.csv`);
    } finally {
      setExporting(false);
    }
  };

  const pointCapError =
    readingsQuery.isError && isApiError(readingsQuery.error) && readingsQuery.error.isPointCap
      ? readingsQuery.error
      : null;

  return (
    <Panel
      title={title}
      subtitle={
        source === "catalogue"
          ? "Tag list is the full catalogue — Device bindings need the config.modify permission to read."
          : "Tag list comes from this Device's bindings."
      }
      actions={
        canExport && deviceIds.length > 0 && tagIds.length > 0 ? (
          <Button onClick={() => void exportCsv()} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
        ) : null
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-[14rem]">
            <div className="mb-1 text-[11px] font-medium text-ink-muted">Devices</div>
            <div className="max-h-28 space-y-1 overflow-y-auto rounded border border-line p-2">
              {devices.length === 0 ? (
                <p className="text-xs text-ink-faint">No Devices in this Plant.</p>
              ) : (
                devices.map((device) => (
                  <label key={device.id} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={deviceIds.includes(device.id)}
                      onChange={() => setDeviceIds((previous) => toggle(previous, device.id))}
                    />
                    <span className="truncate">
                      {device.code}
                      <span className="ml-1 text-ink-faint">{device.type_code}</span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          <div className="min-w-[16rem] flex-1">
            <div className="mb-1 text-[11px] font-medium text-ink-muted">
              Tags{" "}
              <span className="text-ink-faint">
                ({availableTags.length} available — units come from the API)
              </span>
            </div>
            <select
              multiple
              value={tagIds.map(String)}
              onChange={(event) =>
                setTagIds(
                  Array.from(event.target.selectedOptions).map((option) =>
                    Number(option.value),
                  ),
                )
              }
              className={`${inputClass} h-28`}
            >
              {availableTags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name} — {tag.unit}
                  {tag.category === "status" ? " (digital)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="mb-1 text-[11px] font-medium text-ink-muted">Range</div>
            <div className="inline-flex rounded border border-line">
              {RANGES.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  onClick={() => setRangeHours(option.hours)}
                  className={`px-2.5 py-1 text-xs transition ${
                    rangeHours === option.hours
                      ? "bg-accent/15 text-accent"
                      : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {deviceIds.length === 0 || tagIds.length === 0 ? (
          <EmptyState
            title="Choose a Device and at least one Tag"
            detail="Which Tags are available depends on what the Device is bound to, not on its Device Type."
          />
        ) : pointCapError ? (
          // §9: a point cap is not a retry. Narrow something.
          <div className="rounded border border-warn/30 bg-warn/10 p-4">
            <p className="text-sm font-medium text-warn">Range too wide</p>
            <p className="mt-1 text-xs text-ink-muted">{pointCapError.problem.detail}</p>
            <p className="mt-2 text-xs text-ink-faint">
              Narrow the range, select fewer Devices, or select fewer Tags. Retrying
              the same query returns the same answer.
            </p>
          </div>
        ) : readingsQuery.isError ? (
          <ErrorState
            error={readingsQuery.error}
            retry={() => void readingsQuery.refetch()}
          />
        ) : readingsQuery.isLoading ? (
          <LoadingState label="Loading readings" />
        ) : points.length === 0 ? (
          <EmptyState
            title="No Readings in this range"
            detail="Nothing was recorded for the selected Devices and Tags over this window. This is a gap in data, not a gap in retention — the tier that served the query is shown when data is present."
          />
        ) : (
          <div className="space-y-4">
            {analogueSeries.length > 0 ? (
              <TimeSeriesChart
                series={analogueSeries}
                tier={readingsQuery.data!.tier}
                timezone={timezone}
              />
            ) : null}

            {digitalSeries.length > 0 ? (
              <div>
                <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-muted">
                  Digital Inputs
                  <Badge
                    tone="info"
                    title="Digital Inputs are rendered as state and transitions. A contact plotted as a numeric series hides when it changed, which is the only thing that matters about it."
                  >
                    state, not a line
                  </Badge>
                </div>
                <StatusTimeline series={digitalSeries} timezone={timezone} />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}
