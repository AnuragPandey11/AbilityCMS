/**
 * `inverter_monitoring` — per-Inverter comparison and ranking (tender §8, §6.5).
 *
 * ⚠ **Rank only within an Inverter variant** (OPEN-13, Guardrail 9).
 * `device_models.variant` is `central` or `string`; the two have different Tag
 * sets and different expected outputs, and ranking across them is meaningless.
 * Devices are grouped by variant, ranked inside each group, and the grouping is
 * labelled so the ranking cannot be misread as fleet-wide.
 *
 * ⚠ **There are no Inverters in the live data yet** (§0.4). This screen is
 * contracted and built; its empty state explains that rather than spinning.
 *
 * On Guardrail 1: this filters on a Device *Type* code, which is a catalogue row
 * — not on any Client, Plant or Device identity. A new Device Type still needs
 * no change here; this dashboard is simply the one that is about Inverters.
 *
 * ── Three shapes, because "compare seventeen Inverters" is three questions ──
 * The screen used to be one table of seventeen rows, every cell reading "—"
 * because the only value source was the live socket and a Device publishes
 * every 86 seconds. Three things changed:
 *
 *   comparison bars   which ones are behind? — the whole fleet on one measure,
 *                     sorted, with the silent ones kept visible as empty bars
 *                     rather than dropped out of the ranking
 *   card carousel     what is each one doing? — the reference dashboard's own
 *                     form, across rather than down
 *   ranked table      the systematic pass, unchanged, now collapsed
 *
 * and values are seeded from stored readings (`useLatestValues`) so a card is
 * populated on arrival instead of after the next frame.
 *
 * ⚠ The ranking rule is untouched: **within a variant only** (OPEN-13,
 * Guardrail 9). The comparison chart is drawn per variant group for exactly
 * that reason — one chart of central and string Inverters together would rank
 * across the two by implication, which is the thing the grouping exists to
 * prevent.
 */

import { useMemo, useState, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { useDeviceTableColumns, usePlant, usePlantDevices, useTagsById } from "@/api/hooks";
import { useLatestValues } from "@/api/useLatestValues";
import { qk } from "@/api/queryKeys";
import * as devicesApi from "@/api/endpoints/devices";
import type { DeviceDetail, DeviceListItem } from "@/api/schemas";
import { Panel, InfoHint, SelectBox } from "@/components/ui";
import {AwaitingDeviceDataState, EmptyState, ErrorState, SkeletonKpiRow, SkeletonTable} from "@/components/state";
import { CommStatusBadge, LastSeen, PlantPicker } from "@/components/domain";
import { DataTable, type Column } from "@/components/tables/DataTable";
import { useScrollPager } from "@/components/ui/Carousel";
import { DeviceInspector } from "@/components/devices/DeviceInspector";
import { Drawer } from "@/components/ui";
import { ComparisonBars, type ComparisonRow } from "@/components/charts/ComparisonBars";
import { RailFigure, RailText, RailTile } from "@/components/charts/RailTile";
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconInverter,
  IconPortfolio,
  IconPower,
  IconSignal,
} from "@/components/icons";
import { UNDEFINED_DISPLAY, formatNumber, formatValue } from "@/format/value";
import { DeviceFigureCard } from "@/components/devices/DeviceFigureCard";
import { useFilteredPlantScope } from "@/state/usePlantScope";
import { DEFAULT_TIMEZONE } from "@/format/datetime";
import { useLiveSocket } from "@/live/LiveSocket";
import { STALE_INTERVAL_MULTIPLIER } from "@/live/useLiveDevice";

const INVERTER_TYPE_CODE = "INVERTER";

interface RankedInverter {
  device: DeviceListItem;
  /** The live electrical value this Device is bound to, with its own unit. */
  liveValue: number | null;
  liveUnit: string | null;
  ratedCapacityKw: number | null;
  /**
   * Live output ÷ rated capacity. The only figure comparable *within* a variant
   * when the Inverters differ in size. Null whenever either input is missing —
   * never zero (§4.3).
   */
  specificOutput: number | null;
  stale: boolean;
  rank: number | null;
}

const VARIANT_LABEL: Record<string, string> = {
  central: "Central Inverters",
  string: "String Inverters",
  unspecified: "Inverters with no variant recorded",
};

const VARIANT_NOTE: Record<string, string> = {
  central:
    "Ranked among central Inverters only. A central and a string Inverter have different Tag sets and different expected outputs.",
  string:
    "Ranked among string Inverters only. A central and a string Inverter have different Tag sets and different expected outputs.",
  unspecified:
    "These Devices have no variant on their Device Model, so they cannot be ranked against either group. Set the variant to include them.",
};

/** INVERTER_2 before INVERTER_10: codes carry numbers, and people count. */
const byCode = (a: RankedInverter, b: RankedInverter) =>
  a.device.code.localeCompare(b.device.code, undefined, { numeric: true });

/**
 * A variant group's cards: two rows, paged sideways, with the paging buttons in
 * the section header rather than over the cards.
 *
 * Column-major (`grid-flow-col`), so a page reads down then across and paging
 * moves whole columns — never half a card. Columns per page follow the width
 * the grid actually has: three when the cards have the full panel, two beside
 * the chart on a mid-size screen, three again when that is wide.
 */
function CardPages({
  title,
  children,
  count,
}: {
  title: string;
  children: ReactNode;
  count: number;
}): JSX.Element {
  const pager = useScrollPager<HTMLDivElement>(undefined, count);
  const pageBy = (direction: -1 | 1) => {
    const track = pager.ref.current;
    if (!track) return;
    // One full page: the visible width plus the gap that follows it.
    track.scrollBy({ left: direction * (track.clientWidth + 16), behavior: "smooth" });
  };
  return (
    <div className="min-w-0">
      <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
        <span className="tile-label">
          {title}
        </span>
        {pager.overflows ? (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => pageBy(-1)}
              disabled={pager.atStart}
              aria-label="Previous Inverters"
              className="surface-tile flex h-9 w-9 items-center justify-center rounded-control border border-line text-ink-muted transition hover:text-ink disabled:opacity-40"
            >
              <IconChevronLeft size={15} />
            </button>
            <button
              type="button"
              onClick={() => pageBy(1)}
              disabled={pager.atEnd}
              aria-label="Next Inverters"
              className="surface-tile flex h-9 w-9 items-center justify-center rounded-control border border-line text-ink-muted transition hover:text-ink disabled:opacity-40"
            >
              <IconChevronRight size={15} />
            </button>
          </div>
        ) : null}
      </div>
      <div
        ref={pager.ref}
        role="group"
        aria-label={title}
        className={`grid snap-x snap-mandatory auto-cols-[100%] grid-flow-col gap-4 overflow-x-auto scroll-smooth pb-1 [scrollbar-width:none] sm:auto-cols-[calc((100%-1rem)/2)] lg:auto-cols-[calc((100%-2rem)/3)] xl:auto-cols-[calc((100%-1rem)/2)] 2xl:auto-cols-[calc((100%-2rem)/3)] ${
          count > 1 ? "grid-rows-2" : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function InverterMonitoringDashboard(): JSX.Element {
  const { plants, plantId, setPlantId, hasNoPlants } = useFilteredPlantScope();
  const devicesQuery = usePlantDevices(plantId);
  const tagsById = useTagsById();
  const { devices: liveDevices } = useLiveSocket();
  const columnsQuery = useDeviceTableColumns();
  // Timestamps render in the Plant's zone, never the browser's (Guardrail 11).
  const plantQuery = usePlant(plantId);
  const timezone = plantQuery.data?.timezone ?? DEFAULT_TIMEZONE;

  /**
   * Which measure the bars compare, as a Tag id.
   *
   * The options are the Device Type's curated columns from the catalogue, not
   * a list written here — so a Client who decides their operators compare
   * device temperature rather than AC power changes a row, and Guardrail 2
   * holds. `null` means "the first one", resolved below once the catalogue has
   * loaded; storing the resolved id in state instead would freeze whichever
   * column happened to be first on the render the catalogue arrived.
   */
  const [metricTagId, setMetricTagId] = useState<number | null>(null);
  /** The Device whose full detail is open. A card is a glance; this is the rest. */
  const [inspecting, setInspecting] = useState<DeviceListItem | null>(null);
  const inverterColumns = columnsQuery.data?.[INVERTER_TYPE_CODE] ?? [];
  const metric =
    inverterColumns.find((column) => column.tag_id === metricTagId) ?? inverterColumns[0];

  /** id → Device, so the inspector names a parent rather than printing `#38`. */
  const deviceById = useMemo(
    () => new Map((devicesQuery.data ?? []).map((device) => [device.id, device])),
    [devicesQuery.data],
  );

  const inverters = useMemo(
    () =>
      (devicesQuery.data ?? []).filter(
        (device) => device.type_code === INVERTER_TYPE_CODE,
      ),
    [devicesQuery.data],
  );

  /**
   * The last stored value per Inverter, so a card is populated the moment the
   * screen opens rather than after that Device's next frame. The socket
   * overwrites each one as it reports; see `useLatestValues`.
   */
  const latest = useLatestValues(
    inverters.map((device) => device.id),
    inverterColumns.map((column) => column.tag_id),
    inverters.length > 0 && inverterColumns.length > 0,
  );

  /** Live frame over stored reading, merged per Tag — see the dashboard note. */
  const valuesFor = (deviceId: number): Record<string, number> | undefined => {
    const stored = latest.byDevice[deviceId];
    const live = liveDevices[deviceId]?.values;
    if (!stored && !live) return undefined;
    return { ...stored, ...live };
  };

  // Rated capacity is not on the list endpoint, so it is fetched per Device.
  // Without it the comparison is raw output, which is only meaningful between
  // identically sized Inverters — so it is fetched rather than assumed.
  const detailQueries = useQueries({
    queries: inverters.map((device) => ({
      queryKey: qk.device(device.id),
      queryFn: () => devicesApi.getDevice(device.id),
      staleTime: 300_000,
    })),
  });

  const grouped = useMemo(() => {
    const rows: RankedInverter[] = inverters.map((device, index) => {
      const detail = detailQueries[index]?.data as DeviceDetail | undefined;
      const frame = liveDevices[device.id];

      let liveValue: number | null = null;
      let liveUnit: string | null = null;
      if (frame) {
        for (const [tagId, value] of Object.entries(frame.values)) {
          const tag = tagsById.get(Number(tagId));
          // Whichever electrical Tag this Device is bound to — not a Tag chosen
          // by name (§0.3, Guardrail 2). Its unit comes from the catalogue.
          if (tag && tag.category === "electrical") {
            liveValue = value;
            liveUnit = tag.unit;
            break;
          }
        }
      }

      const ratedCapacityKw = detail?.rated_capacity_kw ?? null;
      const stale = frame
        ? (Date.now() - Date.parse(frame.at)) / 1000 >
          device.expected_interval_s * STALE_INTERVAL_MULTIPLIER
        : false;

      return {
        device,
        liveValue,
        liveUnit,
        ratedCapacityKw,
        specificOutput:
          liveValue !== null && ratedCapacityKw !== null && ratedCapacityKw > 0
            ? liveValue / ratedCapacityKw
            : null,
        stale,
        rank: null,
      };
    });

    const groups = new Map<string, RankedInverter[]>();
    for (const row of rows) {
      const variant = row.device.variant ?? "unspecified";
      const bucket = groups.get(variant);
      if (bucket) bucket.push(row);
      else groups.set(variant, [row]);
    }

    // Rank inside each group and nowhere else (Guardrail 9).
    for (const [variant, members] of groups) {
      if (variant === "unspecified") continue;
      const rankable = members
        .filter((row) => row.specificOutput !== null)
        .sort((a, b) => (b.specificOutput ?? 0) - (a.specificOutput ?? 0));
      rankable.forEach((row, index) => {
        row.rank = index + 1;
      });
    }

    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [inverters, detailQueries, liveDevices, tagsById]);

  if (hasNoPlants) {
    return (
      <EmptyState
        title="No Plants are visible"
        detail="Plant Assignments are granted explicitly; zero assignments means zero Plants."
      />
    );
  }
  if (devicesQuery.isLoading) {
    return (
      <div className="space-y-6">
        <SkeletonKpiRow tiles={4} />
        <SkeletonTable rows={8} columns={6} />
      </div>
    );
  }
  if (devicesQuery.isError) {
    return <ErrorState error={devicesQuery.error} retry={() => void devicesQuery.refetch()} />;
  }

  const columns = (variant: string): Column<RankedInverter>[] => [
    {
      key: "rank",
      header: "Rank",
      align: "right",
      width: "70px",
      render: (row) =>
        row.rank === null ? (
          <span
            className="text-ink-faint"
            title={
              variant === "unspecified"
                ? "Not ranked: no Inverter variant is recorded on this Device Model."
                : "Not ranked: no live output, or no rated capacity to normalise it by."
            }
          >
            —
          </span>
        ) : (
          <span className={row.rank === 1 ? "text-ok" : "text-ink"}>#{row.rank}</span>
        ),
      sortValue: (row) => row.rank,
    },
    {
      key: "code",
      header: "Inverter",
      render: (row) => (
        <span className={row.stale ? "opacity-60" : undefined}>
          <span className="font-medium">{row.device.code}</span>
          <span className="ml-2 text-ink-muted">{row.device.name}</span>
        </span>
      ),
      sortValue: (row) => row.device.code,
      filterValue: (row) => `${row.device.code} ${row.device.name}`,
    },
    {
      key: "comm",
      header: "Comms",
      width: "110px",
      render: (row) => <CommStatusBadge status={row.device.comm_status} />,
      sortValue: (row) => row.device.comm_status ?? "unknown",
    },
    {
      key: "output",
      header: "Live output",
      align: "right",
      width: "140px",
      render: (row) =>
        row.liveValue === null ? (
          <span className="text-ink-faint" title="No live frame for this Device.">
            {UNDEFINED_DISPLAY}
          </span>
        ) : (
          <span className={row.stale ? "text-warn" : "text-info"}>
            {formatValue(row.liveValue, row.liveUnit)}
          </span>
        ),
      sortValue: (row) => row.liveValue,
    },
    {
      key: "rated",
      header: "Rated",
      align: "right",
      width: "110px",
      render: (row) => formatValue(row.ratedCapacityKw, "kW", { digits: 1 }),
      sortValue: (row) => row.ratedCapacityKw,
    },
    {
      key: "specific",
      header: "Output / rated",
      align: "right",
      width: "130px",
      render: (row) =>
        row.specificOutput === null ? (
          <span
            className="text-ink-faint"
            title="Needs both a live output and a rated capacity. Undefined, not zero."
          >
            {UNDEFINED_DISPLAY}
          </span>
        ) : (
          formatNumber(row.specificOutput, { digits: 3 })
        ),
      sortValue: (row) => row.specificOutput,
    },
    {
      key: "seen",
      header: "Last seen",
      width: "110px",
      render: (row) => (
        <LastSeen
          at={row.device.last_seen_at}
          expectedIntervalS={row.device.expected_interval_s}
        />
      ),
      sortValue: (row) =>
        row.device.last_seen_at ? Date.parse(row.device.last_seen_at) : null,
    },
  ];

  /** One bar per Device, on the selected measure. */
  const barsFor = (rows: RankedInverter[]): ComparisonRow[] =>
    rows.map((row) => {
      const value = metric ? valuesFor(row.device.id)?.[String(metric.tag_id)] : undefined;
      return {
        id: row.device.id,
        label: row.device.code,
        // `undefined` from the lookup means "no reading", which is not zero.
        value: value ?? null,
        // Marked from communication status, never from the measure itself: a
        // low bar is a question, an unreachable Device is a fact.
        attention: row.device.comm_status === "offline" || row.device.comm_status === "degraded",
        attentionReason:
          row.device.comm_status === "offline"
            ? "Not reporting — this is a communication fact, not an equipment one."
            : row.device.comm_status === "degraded"
              ? "Late: past its expected interval but not yet silent."
              : undefined,
      };
    });

  const onlineCount = inverters.filter((device) => device.comm_status === "online").length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="page-title">Inverter Monitoring</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            Comparison and ranking, within each Inverter variant.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 lg:shrink-0 lg:justify-end">
          {/*
            One filter row, above everything it scopes. The measure applies to
            every comparison chart on the screen at once — a per-chart picker
            would let two variant groups be compared on different measures and
            still look like one ranking.
          */}
          {inverterColumns.length > 1 ? (
            <SelectBox
              label="Compare on"
              value={String(metric?.tag_id ?? "")}
              onChange={(next) => setMetricTagId(Number(next))}
              display={
                metric ? `${metric.name}${metric.unit ? ` (${metric.unit})` : ""}` : UNDEFINED_DISPLAY
              }
            >
              {inverterColumns.map((column) => (
                <option key={column.tag_id} value={column.tag_id}>
                  {column.name}
                  {column.unit ? ` (${column.unit})` : ""}
                </option>
              ))}
            </SelectBox>
          ) : null}
          <PlantPicker plants={plants} value={plantId} onChange={setPlantId} label="Plant" size="lg" />
        </div>
      </header>

      {inverters.length === 0 ? (
        <AwaitingDeviceDataState
          screen="Inverter Monitoring"
          detail="No Inverters are registered in this Plant. Register them through Plants & Devices, giving each an expected interval taken from observation."
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <RailTile tone="info" icon={IconInverter} label="Inverters">
              <RailFigure value={inverters.length} digits={0} />
            </RailTile>
            <RailTile
              tone="ok"
              icon={IconSignal}
              label="Reporting"
              figureTone={onlineCount === inverters.length ? "ok" : "warn"}
              footnote={
                onlineCount === inverters.length
                  ? "All within their expected interval."
                  : `${inverters.length - onlineCount} late or silent. Communication, not equipment.`
              }
            >
              <RailFigure value={onlineCount} digits={0} />
            </RailTile>
            <RailTile
              tone="violet"
              icon={IconPortfolio}
              label="Variants"
              footnote="Ranking happens inside a variant and nowhere else — the two have different Tag sets and different expected outputs."
            >
              <RailFigure value={grouped.length} digits={0} />
            </RailTile>
            <RailTile
              tone="blue"
              icon={IconPower}
              label="Comparing on"
              footnote={
                metric
                  ? `From the catalogue's columns for ${INVERTER_TYPE_CODE}.`
                  : "No summary columns are configured for this Device Type."
              }
            >
              <RailText value={metric?.name ?? UNDEFINED_DISPLAY} />
            </RailTile>
          </div>

          {grouped.map(([variant, rows]) => {
            const unspecified = variant === "unspecified";
            const bars = barsFor(rows);
            const reported = bars.filter(
              (bar): bar is ComparisonRow & { value: number } => bar.value !== null,
            );
            const mean =
              reported.length > 0
                ? reported.reduce((sum, bar) => sum + bar.value, 0) / reported.length
                : null;
            // The card's "#n" is its place on the chart beside it — the same
            // order, never a second ranking with rules of its own.
            const position = new Map(
              [...reported]
                .sort((x, y) => y.value - x.value)
                .map((bar, index) => [bar.id, index + 1] as const),
            );
            const groupOnline = rows.filter((row) => row.device.comm_status === "online").length;
            const metricName = metric?.name ?? "the measure";
            return (
              <Panel
                key={variant}
                padding="p-5"
                tray
                title={
                  <span className="flex items-center gap-3 text-lg">
                    {VARIANT_LABEL[variant] ?? `Inverters — ${variant}`}
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                        unspecified
                          ? "border-warn/50 bg-warn/10 text-warn"
                          : "border-accent/50 bg-accent/10 text-accent"
                      }`}
                    >
                      {variant}
                    </span>
                    <InfoHint text={VARIANT_NOTE[variant] ?? VARIANT_NOTE.central} />
                  </span>
                }
                subtitle={
                  <span className="text-sm">
                    {rows.length} Device(s). {VARIANT_NOTE[variant] ?? VARIANT_NOTE.central}
                  </span>
                }
              >
                <div className="grid gap-6 xl:grid-cols-12">
                  {/* ⚠ One chart per variant group, never one across all of
                      them: a single sorted chart of central and string
                      Inverters together ranks across the two by implication,
                      which is the thing the grouping exists to prevent
                      (Guardrail 9). */}
                  <div className="min-w-0 xl:col-span-5">
                    <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
                      <span className="tile-label">
                        {/* "Sorted", not "Ranked", where the variant is unknown:
                            the order is real, the like-for-like claim is not. */}
                        {unspecified ? "Sorted" : "Ranked"} · {metricName}
                      </span>
                      {mean !== null && metric ? (
                        <span
                          className="text-xs text-ink-muted"
                          title="The mean of the Inverters in this group that reported, on this measure — the dashed line. A reference, not a target."
                        >
                          Group avg{" "}
                          <span className="font-mono text-ink">{formatNumber(mean)}</span>{" "}
                          <span className="font-mono">{metric.unit ?? ""}</span>
                        </span>
                      ) : null}
                    </div>
                    {metric ? (
                      <ComparisonBars
                        rows={bars}
                        unit={metric.unit}
                        metricLabel={metric.name}
                        appearance="gradient"
                        mean={mean}
                        height={Math.max(160, Math.min(rows.length * 34 + 40, 460))}
                      />
                    ) : (
                      <p className="text-xs text-ink-faint">
                        No summary columns are configured for {INVERTER_TYPE_CODE}, so there
                        is nothing to compare on.
                      </p>
                    )}
                  </div>

                  <div className="min-w-0 xl:col-span-7">
                    <CardPages
                      title={`Devices · ${groupOnline} online`}
                      count={rows.length}
                    >
                      {[...rows].sort(byCode).map((row) => {
                        const place = position.get(row.device.id) ?? null;
                        return (
                          <div key={row.device.id} className="min-w-0 snap-start">
                            <DeviceFigureCard
                              device={row.device}
                              columns={inverterColumns}
                              values={valuesFor(row.device.id)}
                              highlightTagId={metric?.tag_id}
                              position={place}
                              positionNote={
                                place === null
                                  ? `No value for ${metricName}, so it has no place in the order. Not a reading of zero.`
                                  : `${place} of ${reported.length} on ${metricName} in this group${
                                      unspecified
                                        ? " — an ordering, not a like-for-like rank: these Inverters have no variant recorded."
                                        : "."
                                    }`
                              }
                              onSelect={setInspecting}
                              selected={inspecting?.id === row.device.id}
                            />
                          </div>
                        );
                      })}
                    </CardPages>
                  </div>
                </div>

                {/* The systematic pass. Collapsed, because it answers a
                    different question from the two views above it — "work
                    through every one" rather than "which one is behind". */}
                <details className="group mt-6 border-t border-line pt-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold text-ink-muted hover:text-ink">
                    Ranked table — rank, live output, rated capacity, output ÷ rated
                    <IconChevronDown size={16} className="shrink-0 transition group-open:rotate-180" />
                  </summary>
                  <div className="mt-3">
                    <DataTable
                      rows={rows}
                      columns={columns(variant)}
                      rowKey={(row) => row.device.id}
                      filterPlaceholder="Filter Inverters…"
                      onRowClick={(row) => setInspecting(row.device)}
                    />
                  </div>
                </details>
              </Panel>
            );
          })}
        </>
      )}

      <Drawer
        open={inspecting !== null}
        onClose={() => setInspecting(null)}
        title={inspecting ? `${inspecting.code} — ${inspecting.name}` : ""}
      >
        {inspecting ? (
          <DeviceInspector
            device={inspecting}
            values={valuesFor(inspecting.id)}
            timezone={timezone}
            deviceLookup={deviceById}
          />
        ) : null}
      </Drawer>
    </div>
  );
}
